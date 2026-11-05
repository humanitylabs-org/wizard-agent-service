#!/usr/bin/env python3
"""One bounded pidfd release continuation; reuse the protected rotation unchanged."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('rotation_wrapper', Path(__file__).with_name('run_security_rotation.py'))
assert spec is not None and spec.loader is not None
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
r = w.r
sys.path.insert(0, str(r.SCRIPTS))
import hermes_state_maintenance_lock as maintenance


def identity(pid):
    text = Path('/proc', str(pid), 'stat').read_text()
    fields = text[text.rindex(')') + 2:].split()
    return {'pid': pid, 'start_ticks': int(fields[19]),
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}


def holders():
    st = maintenance.LOCK_PATH.stat()
    device = f'{os.major(st.st_dev):02x}:{os.minor(st.st_dev):02x}:{st.st_ino}'
    result = []
    for line in Path('/proc/locks').read_text().splitlines():
        fields = line.split()
        if device in fields and '->' not in fields:
            result.append(int(fields[fields.index(device) - 1]))
    return result


def probe(seconds):
    # Canonical OS-backed acquisition/release; never hold it across the wrapper.
    result = subprocess.run([sys.executable, str(r.SCRIPTS / 'hermes_state_maintenance_lock.py'),
                             'probe', '--timeout-seconds', str(seconds)],
                            capture_output=True, timeout=seconds + 10)
    r.require(result.returncode in (0, 75), 'maintenance_probe_failed')
    return result.returncode == 0


def wait_exit(expected, seconds, publish):
    # Open before checking start identity: a reused numeric PID cannot wake apply.
    try:
        fd = os.pidfd_open(expected['pid'])
    except ProcessLookupError:
        publish('backup_already_exited')
        return
    try:
        try:
            actual = identity(expected['pid'])
        except FileNotFoundError:
            # pidfd pins the already-exited process; subsequent probe is authority.
            actual = expected
        r.require(actual == expected, 'backup_pid_identity_changed')
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        publish('passive_pidfd_wait')
        events = poller.poll(int(seconds * 1000))  # one kernel wait, no retry loop
        r.require(bool(events), 'backup_exit_wait_timeout')
        r.require(all(mask & select.POLLIN and not mask & select.POLLNVAL for _, mask in events),
                  'backup_pidfd_invalid_event')
        publish('backup_process_exited')
    finally:
        os.close(fd)


def refresh_and_rotate(root, plan, controller):
    # Snapshot *after* release, not the earlier apps/Service world. apply CAS-checks
    # this plan again under its own host + deploy leases immediately before writes.
    r.cmd([sys.executable, controller, 'prepare', '--plan', plan], timeout=60)
    r.cmd([sys.executable, controller, 'check', '--plan', plan], timeout=90)
    return w.run(root, plan, controller, lease_wait_seconds=0)


def run(root, plan, controller, expected, seconds):
    r.protect()
    r.require(0 < seconds <= 3600, 'invalid_passive_wait_budget')
    path = root / 'lease-release-continuation.json'
    state = {'status': 'starting', 'started_unix': time.time(),
             'expected_backup': expected, 'wait_seconds': seconds,
             'wait_deadline_unix': time.time() + seconds,
             'wrapper_sha256': r.hashfile(Path(__file__).with_name('run_security_rotation.py')),
             'controller_sha256': r.hashfile(controller), 'self_sha256': r.hashfile(__file__),
             'activation_attempts': 0}

    def publish(status):
        state.update(status=status, updated_unix=time.time())
        r.write_json(path, state)

    # A separate control-only singleton, not the maintenance lease. No recursive
    # lease ownership and no second watcher if this one is already active/terminal.
    with (root / 'lease-release-continuation.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 75
        if path.exists():
            print(json.dumps({'status': 'continuation_already_recorded', 'result': str(path)}))
            return 75
        try:
            publish('checking_real_lease')
            if not probe(0):
                owner = maintenance.owner_status() or {}
                actual_holders = holders()
                state['observed_holder'] = {k: owner.get(k) for k in
                                            ('operation', 'pid', 'ppid', 'started_at_utc')}
                state['kernel_holder_pids'] = actual_holders
                r.require(actual_holders == [expected['pid']] and owner.get('pid') == expected['pid']
                          and owner.get('operation') == 'encrypted-backup', 'backup_not_actual_lease_holder')
                wait_exit(expected, seconds, publish)
                publish('canonical_release_probe')
                r.require(probe(600), 'maintenance_lease_still_busy_after_backup_exit')
            else:
                publish('lease_already_free')
            # Fixed scripts only, never old configuration or artifacts restored.
            r.require(r.hashfile(controller) == state['controller_sha256']
                      and r.hashfile(Path(__file__).with_name('run_security_rotation.py')) == state['wrapper_sha256'],
                      'continuation_source_drift')
            publish('refreshing_current_plan')
            state['activation_attempts'] = 1
            rc = refresh_and_rotate(root, plan, controller)
            state['rotation_returncode'] = rc
            result = json.loads((root / 'result.json').read_bytes())
            state.update(rotation_status=result.get('rotation_status'),
                         old_proof_revoked=result.get('old_proof_revoked', False))
            r.require(rc == 0 and result.get('old_proof_revoked') is True, 'rotation_requires_readback')
            publish('security_rotation_verified')
            return 0
        except BaseException as exc:
            state['failure'] = str(exc) if isinstance(exc, r.Gate) else type(exc).__name__
            publish('terminal_incomplete')
            return 1
        finally:
            state['finished_unix'] = time.time()
            r.write_json(path, state)
            print(json.dumps({k: state[k] for k in ('status', 'activation_attempts', 'failure',
                                                    'old_proof_revoked') if k in state}))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--plan', type=Path, required=True)
    p.add_argument('--controller', type=Path, required=True)
    p.add_argument('--pid', type=int, required=True)
    p.add_argument('--start-ticks', type=int, required=True)
    p.add_argument('--boot-id', required=True)
    p.add_argument('--wait-seconds', type=int, default=3600)
    p.add_argument('--audited-scoped-apply', action='store_true', required=True)
    a = p.parse_args()
    return run(a.root, a.plan, a.controller,
               {'pid': a.pid, 'start_ticks': a.start_ticks, 'boot_id': a.boot_id}, a.wait_seconds)


if __name__ == '__main__':
    raise SystemExit(main())
