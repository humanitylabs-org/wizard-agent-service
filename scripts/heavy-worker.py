#!/usr/bin/env python3
"""Durable remote-only command spool. RPC on stdin; logs never leave the worker.

The dispatcher owns a process lock; the shared build lock is held across the
whole child process group. A lost dispatcher never blindly retries a command.

Lanes: a job without ``lane`` (or ``lane: heavy``) runs under the shared
Android/VM worker lock exactly as before. ``lane: light`` is for short packaging
work (image packaging from prebuilt binaries, static app builds, canaries) capped
at LIGHT_MAX_SECONDS. Light jobs live in their own spool (``<root>/light``) with
their own exclusive lock, so they never wait behind heavy work and a heavy-only
dispatcher (including an older release) can never see, claim or repeat them.
Within each lane the original one-at-a-time, never-retry semantics are unchanged.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import time
import shutil

TERMINAL = ('completed', 'failed', 'cancelled', 'interrupted')
LANES = ('heavy', 'light')
LIGHT_MAX_SECONDS = 900


def light_root(root):
    return Path(root) / 'light'


def light_lock(root):
    return light_root(root) / 'packaging.lock'


def connect(root):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    db = sqlite3.connect(root / 'jobs.sqlite3', timeout=5, isolation_level=None)
    os.chmod(root / 'jobs.sqlite3', 0o600)
    db.row_factory = sqlite3.Row
    db.executescript('''PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, spec TEXT NOT NULL, state TEXT NOT NULL,
      created REAL NOT NULL, updated REAL NOT NULL, pid INTEGER,
      cancel INTEGER NOT NULL DEFAULT 0, receipt TEXT, reason TEXT NOT NULL DEFAULT ''
    );''')
    # Additive migration; receipts and ambiguous old claims are never replayed.
    columns = {row['name'] for row in db.execute('PRAGMA table_info(jobs)')}
    for name, kind in [('deadline', 'REAL'), ('execution_result', 'TEXT'), ('dispatcher_pid', 'INTEGER')]:
        if name not in columns:
            try:
                db.execute(f'ALTER TABLE jobs ADD COLUMN {name} {kind}')
            except sqlite3.OperationalError:
                if name not in {row['name'] for row in db.execute('PRAGMA table_info(jobs)')}:
                    raise
    return db


def public(row):
    if not row:
        return None
    return {'job_id': row['id'], 'state': row['state'], 'reason': row['reason'],
            'receipt': json.loads(row['receipt']) if row['receipt'] else None}


def heavy_root():
    value = os.environ.get('WIZARD_HEAVY_ROOT') or os.environ.get('WIZARD_WORK_ROOT')
    if not value or not Path(value).is_absolute():
        raise ValueError('heavy lane not configured: set WIZARD_HEAVY_ROOT')
    return Path(value).resolve()


def validate(spec):
    cwd = Path(spec['cwd']).resolve(strict=True)
    if not cwd.is_relative_to(heavy_root()) or not cwd.is_dir():
        raise ValueError('work directory must be under the configured heavy root')
    argv = spec['argv']
    if not isinstance(argv, list) or not 1 <= len(argv) <= 100 or any(
            not isinstance(x, str) or not x or '\0' in x or len(x) > 8192 for x in argv):
        raise ValueError('invalid command')
    if not isinstance(spec.get('timeout_seconds'), int) or not 1 <= spec['timeout_seconds'] <= 86400:
        raise ValueError('invalid deadline')
    lane = spec.get('lane', 'heavy')
    if lane not in LANES:
        raise ValueError('invalid lane')
    if lane == 'light' and spec['timeout_seconds'] > LIGHT_MAX_SECONDS:
        raise ValueError('light lane deadline too long')
    return {**spec, 'cwd': str(cwd)}


def execution_lock(root, job_id):
    return (root / (job_id + '.execution.lock')).open('a')


def execute(root, job_id, worker_fd, execution_fd):
    """Per-command group owner, independent of the replaceable dispatcher.

    The inherited locks bridge claim -> spawn without a PID-based lease. This
    process is its own session/group leader until it kills its OWN group. Neither
    recovery nor cancellation signals a persisted PID (which may have been reused).
    """
    if os.getpid() != os.getpgrp() or os.getsid(0) != os.getpid():
        raise RuntimeError('executor must own its process group')
    # Verify both inherited leases before launching anything.
    os.fstat(worker_fd)
    os.fstat(execution_fd)
    db = connect(root)
    row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
    state, code, reason = 'failed', None, 'worker_execution_error'
    try:
        spec = validate(json.loads(row['spec']))
        if row['deadline'] is None:
            raise ValueError('missing durable deadline')
        deadline = time.monotonic() + max(0, min(spec['timeout_seconds'], row['deadline'] - time.time()))
        if row['cancel']:
            state, reason = 'cancelled', ''
        elif time.monotonic() >= deadline:
            state, reason = 'failed', 'deadline'
        else:
            with (root / (job_id + '.log')).open('ab', buffering=0) as log:
                # A light job's fd is the packaging lock: helpers that verify the
                # shared Android lock inode (android-build-thales) fail closed.
                env = {**os.environ, 'WIZARD_HEAVY_LOCK_FD': str(worker_fd),
                       'WIZARD_WORKER_LANE': spec.get('lane', 'heavy')}
                # The command and all non-detached descendants stay in OUR group.
                process = subprocess.Popen(spec['argv'], cwd=spec['cwd'], stdout=log, env=env,
                    stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, pass_fds=(worker_fd,))
                while True:
                    cancelled = db.execute('SELECT cancel FROM jobs WHERE id=?', (job_id,)).fetchone()[0]
                    if cancelled:
                        state, reason = 'cancelled', ''
                        break
                    if time.monotonic() >= deadline or time.time() >= row['deadline']:
                        state, reason = 'failed', 'deadline'
                        break
                    code = process.poll()
                    if code is not None:
                        state, reason = ('completed' if code == 0 else 'failed'), ''
                        break
                    time.sleep(0.2)
    finally:
        try:
            # This is NOT a terminal receipt yet. The dispatcher finalizes only
            # after the execution lease is released by process-group termination.
            db.execute('UPDATE jobs SET execution_result=? WHERE id=?',
                       (json.dumps({'state': state, 'code': code, 'reason': reason}), job_id))
            db.close()
        finally:
            # Atomic self-group signal: the caller itself pins this PGID. No
            # check-then-kill race with a recycled PID, even after dispatcher death.
            os.killpg(os.getpgrp(), signal.SIGKILL)


def resource_wait(root):
    # Reuse the existing Android helper's 20 GiB disk floor. Let macOS define
    # critical memory pressure instead of inventing another concurrency quota.
    if shutil.disk_usage(root).free < 20 * 1024**3:
        return 'disk_pressure'
    try:
        if sys.platform.startswith('linux'):
            # Same conservative Linux floor as interactive admission; unknown
            # health still fails closed. macOS keeps its existing sysctl policy.
            memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
            available_kib = int(memory['MemAvailable'].split()[0])
            pressure_line = next(line for line in Path('/proc/pressure/memory').read_text().splitlines() if line.startswith('full '))
            full = dict(field.split('=', 1) for field in pressure_line.split()[1:])
            return 'memory_pressure' if available_kib < 512 * 1024 or float(full['avg10']) >= 20 else ''
        pressure = int(subprocess.check_output(['/usr/sbin/sysctl', '-n',
            'kern.memorystatus_vm_pressure_level'], text=True, timeout=2).strip())
        return 'memory_pressure' if pressure >= 4 else ''
    except Exception:
        return 'worker_health_unknown'


def finish(db, root, row, state, code=None, reason=''):
    log = root / (row['id'] + '.log')
    digest = hashlib.sha256()
    if log.exists():
        with log.open('rb') as stream:
            for block in iter(lambda: stream.read(65536), b''):
                digest.update(block)
    receipt = {'job_id': row['id'], 'state': state, 'exit_code': code,
               'finished_at': time.time(), 'log_path': str(log),
               'log_sha256': digest.hexdigest(), 'reason': reason,
               'spec_sha256': hashlib.sha256(row['spec'].encode()).hexdigest()}
    db.execute('UPDATE jobs SET state=?,receipt=?,reason=?,updated=? WHERE id=?',
               (state, json.dumps(receipt), reason, time.time(), row['id']))


def dispatch(root, lock_path):
    with (root / 'dispatcher.lock').open('a') as leader:
        try:
            fcntl.flock(leader, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        db = connect(root)
        while True:
            # A crash after durable claim, including before Popen, is ambiguous.
            # The executor retains both locks across dispatcher loss and still
            # enforces the durable cancellation/deadline. Never retry a claim or
            # signal its diagnostic PID: it may now belong to an unrelated process.
            orphan = db.execute("SELECT * FROM jobs WHERE state='running' ORDER BY created LIMIT 1").fetchone()
            if orphan:
                with execution_lock(root, orphan['id']) as lease:
                    try:
                        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        db.execute("UPDATE jobs SET reason='orphan_process' WHERE id=?", (orphan['id'],))
                        time.sleep(0.2)
                        continue
                    # Refresh after acquiring: executor may have committed its
                    # result between our SELECT and release of the lease.
                    orphan = db.execute('SELECT * FROM jobs WHERE id=?', (orphan['id'],)).fetchone()
                    result = json.loads(orphan['execution_result']) if orphan['execution_result'] else None
                    if result:
                        finish(db, root, orphan, result['state'], result['code'], result['reason'])
                    else:
                        finish(db, root, orphan, 'interrupted', reason='worker_restarted_no_retry')
            row = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY created,id LIMIT 1").fetchone()
            if not row:
                return  # each RPC ensures a dispatcher, including submit/exit races
            if row['cancel']:
                finish(db, root, row, 'cancelled')
                continue
            with lock_path.open('a') as worker_lock:
                try:
                    fcntl.flock(worker_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    db.execute("UPDATE jobs SET reason='worker_busy' WHERE id=?", (row['id'],))
                    time.sleep(1)
                    continue
                reason = resource_wait(root)
                if reason:
                    db.execute("UPDATE jobs SET reason=? WHERE id=?", (reason, row['id']))
                    time.sleep(5)
                    continue
                # Claim + deadline precede execution. The per-job lease is already
                # held when Popen inherits it, closing the claim/spawn recovery gap.
                with execution_lock(root, row['id']) as lease:
                    fcntl.flock(lease, fcntl.LOCK_EX)
                    db.execute('BEGIN IMMEDIATE')
                    current = db.execute('SELECT * FROM jobs WHERE id=?', (row['id'],)).fetchone()
                    if current['cancel']:
                        db.execute('COMMIT')
                        continue
                    timeout = json.loads(current['spec'])['timeout_seconds']
                    now = time.time()
                    db.execute("UPDATE jobs SET state='running',reason='',updated=?,deadline=?,dispatcher_pid=? WHERE id=?",
                               (now, now + timeout, os.getpid(), row['id']))
                    db.execute('COMMIT')
                    try:
                        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                            '--root', str(root), '--lock', str(lock_path), '--execute', row['id'],
                            '--worker-fd', str(worker_lock.fileno()), '--execution-fd', str(lease.fileno())],
                            start_new_session=True, pass_fds=(worker_lock.fileno(), lease.fileno()),
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        db.execute('UPDATE jobs SET pid=? WHERE id=?', (process.pid, row['id']))
                        process.wait()
                        # Finalize on the next iteration, through the same recovered
                        # result path. Closing (not LOCK_UN) preserves inherited leases.
                    except Exception:
                        # Unknown launch/monitor outcome must not be retried or kill
                        # an unverified PID. Recovery checks the inherited lease.
                        pass


def spawn_dispatcher(root, lock_path):
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--root', str(root),
                      '--lock', str(lock_path), '--dispatch'], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def find(root, job_id):
    """Spool holding job_id: heavy (root) first, then light. Never creates a spool."""
    for lane_root in (root, light_root(root)):
        if (lane_root / 'jobs.sqlite3').exists():
            db = connect(lane_root)
            try:
                if db.execute('SELECT 1 FROM jobs WHERE id=?', (job_id,)).fetchone():
                    return lane_root
            finally:
                db.close()
    return None


def rpc(root, lock_path, value):
    job_id = value.get('job_id', '')
    if not re.fullmatch(r'heavy_[0-9a-f]{32}', job_id):
        raise ValueError('invalid job identity')
    action = value['action']
    if action not in ('submit', 'cancel', 'status'):
        raise ValueError('invalid action')
    target = find(root, job_id)
    if action == 'submit':
        validated = validate(value['spec'])
        wanted = light_root(root) if validated.get('lane') == 'light' else root
        if target is not None and target != wanted:
            raise ValueError('idempotency conflict')
        target = wanted
        spec = json.dumps(validated, sort_keys=True, separators=(',', ':'))
        db = connect(target)
        db.execute('INSERT OR IGNORE INTO jobs(id,spec,state,created,updated) VALUES (?,?,\'queued\',?,?)',
                   (job_id, spec, time.time(), time.time()))
        row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        if row['spec'] != spec:
            raise ValueError('idempotency conflict')
    else:
        db = connect(target or root)
        if action == 'cancel':
            db.execute('UPDATE jobs SET cancel=1,updated=? WHERE id=?', (time.time(), job_id))
    row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
    db.close()
    # Every RPC ensures each existing lane has a dispatcher (submit/exit races).
    spawn_dispatcher(root, lock_path)
    if (light_root(root) / 'jobs.sqlite3').exists():
        spawn_dispatcher(light_root(root), light_lock(root))
    return public(row)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--lock', required=True, type=Path)
    parser.add_argument('--dispatch', action='store_true')
    parser.add_argument('--execute')
    parser.add_argument('--worker-fd', type=int)
    parser.add_argument('--execution-fd', type=int)
    args = parser.parse_args()
    try:
        allowed_root = heavy_root()
    except ValueError as error:
        raise SystemExit(str(error)) from None
    if not args.root.resolve().is_relative_to(allowed_root) or not args.lock.resolve().is_relative_to(allowed_root):
        raise SystemExit('worker storage must be under the configured heavy root')
    if args.execute:
        if not re.fullmatch(r'heavy_[0-9a-f]{32}', args.execute):
            raise SystemExit('invalid job identity')
        execute(args.root, args.execute, args.worker_fd, args.execution_fd)
    elif args.dispatch:
        dispatch(args.root, args.lock)
    else:
        try:
            print(json.dumps(rpc(args.root, args.lock, json.load(sys.stdin))))
        except Exception:
            print(json.dumps({'error': 'worker_rpc_failed'}))
            sys.exit(1)
