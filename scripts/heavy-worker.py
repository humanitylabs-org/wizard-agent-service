#!/usr/bin/env python3
"""Durable remote-only command spool. RPC on stdin; logs never leave the worker.

The dispatcher owns a process lock; the shared build lock is held across the
whole child process group. A lost dispatcher never blindly retries a command.
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
    return db


def public(row):
    if not row:
        return None
    return {'job_id': row['id'], 'state': row['state'], 'reason': row['reason'],
            'receipt': json.loads(row['receipt']) if row['receipt'] else None}


def validate(spec):
    cwd = Path(spec['cwd']).resolve(strict=True)
    if not cwd.is_relative_to('/Volumes/ThalesMedia') or not cwd.is_dir():
        raise ValueError('work directory must be on the external volume')
    argv = spec['argv']
    if not isinstance(argv, list) or not 1 <= len(argv) <= 100 or any(
            not isinstance(x, str) or not x or '\0' in x or len(x) > 8192 for x in argv):
        raise ValueError('invalid command')
    if not isinstance(spec.get('timeout_seconds'), int) or not 1 <= spec['timeout_seconds'] <= 86400:
        raise ValueError('invalid deadline')
    return {**spec, 'cwd': str(cwd)}


def alive(pid):
    if not pid:
        return False
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


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
            # Never repeat it. If its process group lives, retain the worker lane.
            orphan = db.execute("SELECT * FROM jobs WHERE state='running' ORDER BY created LIMIT 1").fetchone()
            if orphan:
                if alive(orphan['pid']):
                    db.execute("UPDATE jobs SET reason='orphan_process' WHERE id=?", (orphan['id'],))
                    time.sleep(1)
                    continue
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
                if shutil.disk_usage(root).free < 20 * 1024**3:
                    db.execute("UPDATE jobs SET reason='disk_pressure' WHERE id=?", (row['id'],))
                    time.sleep(5)
                    continue
                db.execute('BEGIN IMMEDIATE')
                current = db.execute('SELECT * FROM jobs WHERE id=?', (row['id'],)).fetchone()
                if current['cancel']:
                    db.execute('COMMIT')
                    continue
                db.execute("UPDATE jobs SET state='running',reason='',updated=? WHERE id=?", (time.time(), row['id']))
                db.execute('COMMIT')
                process = None
                try:
                    spec = validate(json.loads(row['spec']))
                    with (root / (row['id'] + '.log')).open('ab', buffering=0) as log:
                        env = {**os.environ, 'WIZARD_HEAVY_LOCK_FD': str(worker_lock.fileno())}
                        process = subprocess.Popen(spec['argv'], cwd=spec['cwd'], stdout=log, env=env,
                            stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            start_new_session=True, pass_fds=(worker_lock.fileno(),))
                        db.execute('UPDATE jobs SET pid=? WHERE id=?', (process.pid, row['id']))
                        deadline = time.monotonic() + spec['timeout_seconds']
                        state, reason = 'completed', ''
                        while process.poll() is None:
                            cancelled = db.execute('SELECT cancel FROM jobs WHERE id=?', (row['id'],)).fetchone()[0]
                            if cancelled or time.monotonic() >= deadline:
                                state, reason = ('cancelled', '') if cancelled else ('failed', 'deadline')
                                os.killpg(process.pid, signal.SIGTERM)
                                try:
                                    process.wait(timeout=5)
                                except subprocess.TimeoutExpired:
                                    pass
                                # Kill descendants even if the direct child exits first.
                                try:
                                    os.killpg(process.pid, signal.SIGKILL)
                                except ProcessLookupError:
                                    pass
                                process.wait()
                                break
                            time.sleep(0.2)
                        # Commands must not detach grandchildren. Clean their group
                        # before releasing the exclusive worker resource.
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        if state == 'completed' and process.returncode:
                            state = 'failed'
                        finish(db, root, row, state, process.returncode, reason)
                except Exception:
                    if process and process.poll() is None:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
                    finish(db, root, row, 'failed', reason='worker_execution_error')


def rpc(root, lock_path, value):
    db = connect(root)
    job_id = value.get('job_id', '')
    if not re.fullmatch(r'heavy_[0-9a-f]{32}', job_id):
        raise ValueError('invalid job identity')
    action = value['action']
    if action == 'submit':
        spec = json.dumps(validate(value['spec']), sort_keys=True, separators=(',', ':'))
        db.execute('INSERT OR IGNORE INTO jobs(id,spec,state,created,updated) VALUES (?,?,\'queued\',?,?)',
                   (job_id, spec, time.time(), time.time()))
        row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        if row['spec'] != spec:
            raise ValueError('idempotency conflict')
    elif action == 'cancel':
        db.execute('UPDATE jobs SET cancel=1,updated=? WHERE id=?', (time.time(), job_id))
    elif action != 'status':
        raise ValueError('invalid action')
    row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
    db.close()
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--root', str(root),
                      '--lock', str(lock_path), '--dispatch'], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return public(row)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--lock', required=True, type=Path)
    parser.add_argument('--dispatch', action='store_true')
    args = parser.parse_args()
    if not args.root.resolve().is_relative_to('/Volumes/ThalesMedia') or not args.lock.resolve().is_relative_to('/Volumes/ThalesMedia'):
        raise SystemExit('worker storage must be on external volume')
    if args.dispatch:
        dispatch(args.root, args.lock)
    else:
        try:
            print(json.dumps(rpc(args.root, args.lock, json.load(sys.stdin))))
        except Exception:
            print(json.dumps({'error': 'worker_rpc_failed'}))
            sys.exit(1)
