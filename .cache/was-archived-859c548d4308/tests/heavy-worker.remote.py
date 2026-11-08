#!/usr/bin/env python3
"""Execute on Thales only: real RPC, process, restart and shared-lock semantics."""
import fcntl
import importlib.util
import json
from contextlib import closing
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/heavy-worker.py'


class WorkerTests(unittest.TestCase):
    def setUp(self):
        if not Path('/Volumes/ThalesMedia').is_dir():
            self.skipTest('remote volume required; never run sustained work on control plane')
        self.temp = tempfile.TemporaryDirectory(prefix='heavy-tests-', dir='/Volumes/ThalesMedia/tmp')
        self.base = Path(self.temp.name)
        self.root = self.base / 'spool'
        self.lock = self.base / 'worker.lock'
        self.ids = []

    def rpc(self, action, job_id, spec=None):
        value = {'action': action, 'job_id': job_id}
        if spec is not None:
            value['spec'] = spec
        proc = subprocess.run([sys.executable, str(SCRIPT), '--root', str(self.root), '--lock', str(self.lock)],
                              input=json.dumps(value), text=True, capture_output=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        return json.loads(proc.stdout)

    def submit(self, code, timeout=15, lane=None):
        job_id = 'heavy_' + uuid.uuid4().hex
        self.ids.append(job_id)
        spec = {'cwd': str(self.base), 'argv': [sys.executable, '-c', code], 'timeout_seconds': timeout}
        if lane:
            spec['lane'] = lane
        self.rpc('submit', job_id, spec)
        return job_id, spec

    def raw_rpc(self, value):
        return subprocess.run([sys.executable, str(SCRIPT), '--root', str(self.root), '--lock', str(self.lock)],
                              input=json.dumps(value), text=True, capture_output=True, timeout=10)

    def wait(self, job_id, states):
        deadline = time.monotonic() + 20
        result = None
        while time.monotonic() < deadline:
            result = self.rpc('status', job_id)
            if result and result['state'] in states:
                return result
            time.sleep(0.1)
        self.fail('worker did not settle: ' + str(result))

    def tearDown(self):
        for job_id in self.ids:
            row = self.rpc('cancel', job_id)
            if row and row['state'] in ('queued', 'running'):
                self.wait(job_id, ('cancelled', 'completed', 'failed', 'interrupted'))
        # Let all short RPC-launched contenders release their handles.
        time.sleep(0.2)
        self.temp.cleanup()

    def test_busy_queue_duplicate_and_receipt(self):
        a, spec_a = self.submit("import time; from pathlib import Path; Path('once').open('a').write('a'); time.sleep(2); print('first done')")
        self.wait(a, ('running',))
        b, _ = self.submit("print('second done')")
        self.assertEqual(self.rpc('status', b)['state'], 'queued')
        self.rpc('submit', a, spec_a)
        result = self.wait(a, ('completed',))
        self.assertEqual(result['receipt']['exit_code'], 0)
        self.assertEqual(len(result['receipt']['log_sha256']), 64)
        self.wait(b, ('completed',))
        self.assertEqual((self.base / 'once').read_text(), 'a')

    def test_cancel_running_group_and_queued(self):
        a, _ = self.submit("import time; time.sleep(10)")
        self.wait(a, ('running',))
        b, _ = self.submit("from pathlib import Path; Path('must-not-exist').touch()")
        self.rpc('cancel', b)
        self.rpc('cancel', a)
        self.wait(a, ('cancelled',)); self.wait(b, ('cancelled',))
        self.assertFalse((self.base / 'must-not-exist').exists())

    def test_dispatcher_crash_does_not_repeat_running_job(self):
        a, spec_a = self.submit("from pathlib import Path; import time; Path('once').open('a').write('x'); time.sleep(3)")
        self.wait(a, ('running',))
        deadline = time.monotonic() + 5
        while not (self.base / 'once').exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.crash_dispatcher(a)
        self.rpc('submit', a, spec_a)
        b, _ = self.submit("print('after crash')")
        self.assertEqual(self.rpc('status', b)['state'], 'queued')
        self.wait(a, ('completed',))
        self.wait(b, ('completed',))
        self.rpc('submit', a, spec_a)
        self.assertEqual((self.base / 'once').read_text(), 'x')

    def crash_dispatcher(self, job_id):
        with closing(sqlite3.connect(self.root / 'jobs.sqlite3')) as db, db:
            dispatcher, executor, deadline = db.execute(
                'SELECT dispatcher_pid,pid,deadline FROM jobs WHERE id=?', (job_id,)).fetchone()
        self.assertIsNotNone(deadline)
        self.assertGreater(deadline, time.time())
        self.assertNotEqual(dispatcher, executor)
        os.kill(dispatcher, signal.SIGKILL)
        return executor, deadline

    def wait_file(self, name):
        deadline = time.monotonic() + 5
        while not (self.base / name).exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue((self.base / name).exists(), name)
        return self.base / name

    def assert_group_gone(self, pgid):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        self.fail(f'execution group {pgid} is still alive')

    def recovery_job(self, timeout=15):
        # TERM-resistant grandchild proves whole-group termination, not just the
        # immediate process. This job is never permitted to reach its 60s sleep.
        descendant = "import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path('grandchild').write_text(str(os.getpid())); time.sleep(60)"
        code = f"import subprocess,sys,time; from pathlib import Path; Path('once').open('a').write('x'); subprocess.Popen([sys.executable,'-c',{descendant!r}]); time.sleep(60)"
        a, spec = self.submit(code, timeout=timeout)
        self.wait(a, ('running',)); self.wait_file('grandchild')
        b, _ = self.submit("from pathlib import Path; Path('next-ran').write_text('yes')")
        self.assertEqual(self.rpc('status', b)['state'], 'queued')
        return a, b, spec

    def test_crash_then_cancel_kills_group_and_advances_without_duplicate(self):
        a, b, spec = self.recovery_job()
        executor, _ = self.crash_dispatcher(a)
        # Deliberately poison the persisted diagnostic PID with an unrelated
        # live session leader. Recovery must never signal a database PID.
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        try:
            with closing(sqlite3.connect(self.root / 'jobs.sqlite3')) as db, db:
                db.execute('UPDATE jobs SET pid=? WHERE id=?', (unrelated.pid, a))
            began = time.monotonic()
            self.rpc('cancel', a)
            self.assertEqual(self.wait(a, ('cancelled',))['receipt']['state'], 'cancelled')
            self.wait(b, ('completed',))
            self.assertLess(time.monotonic() - began, 6)
            self.assert_group_gone(executor)
            self.assertIsNone(unrelated.poll())
            self.rpc('submit', a, spec)
            self.assertEqual((self.base / 'once').read_text(), 'x')
            self.assertEqual((self.base / 'next-ran').read_text(), 'yes')
        finally:
            unrelated.kill(); unrelated.wait()

    def test_recovered_deadline_kills_group_and_starts_next(self):
        a, b, spec = self.recovery_job(timeout=8)
        executor, deadline = self.crash_dispatcher(a)
        # A status RPC starts the replacement dispatcher, not another command.
        self.rpc('status', a)
        result = self.wait(a, ('failed',))
        self.assertEqual(result['reason'], 'deadline')
        self.assertEqual(result['receipt']['reason'], 'deadline')
        self.assertGreaterEqual(result['receipt']['finished_at'], deadline)
        self.assertLess(result['receipt']['finished_at'] - deadline, 6)
        self.assert_group_gone(executor)
        self.wait(b, ('completed',))
        self.rpc('submit', a, spec)
        self.assertEqual((self.base / 'once').read_text(), 'x')
        with closing(sqlite3.connect(self.root / 'jobs.sqlite3')) as db, db:
            self.assertEqual(db.execute('SELECT deadline FROM jobs WHERE id=?', (a,)).fetchone()[0], deadline)

    def test_ambiguous_claim_with_reused_pid_is_never_signalled_or_reexecuted(self):
        # Reproduce a pre-spawn crash using the OLD schema as well: migration is
        # additive and never interprets an unverified PID as process ownership.
        self.root.mkdir()
        a = 'heavy_' + uuid.uuid4().hex
        self.ids.append(a)
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        try:
            with closing(sqlite3.connect(self.root / 'jobs.sqlite3')) as db, db:
                db.execute("CREATE TABLE jobs(id TEXT PRIMARY KEY,spec TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,pid INTEGER,cancel INTEGER NOT NULL DEFAULT 0,receipt TEXT,reason TEXT NOT NULL DEFAULT '')")
                spec = {'cwd': str(self.base), 'argv': [sys.executable, '-c', "from pathlib import Path; Path('must-not-run').touch()"], 'timeout_seconds': 1}
                db.execute('INSERT INTO jobs(id,spec,state,created,updated,pid,cancel) VALUES(?,?,?,?,?,?,?)',
                           (a, json.dumps(spec), 'running', time.time() - 10, time.time() - 10, unrelated.pid, 1))
            self.rpc('status', a)
            self.wait(a, ('interrupted',))
            b, _ = self.submit("print('after ambiguous claim')")
            self.wait(b, ('completed',))
            self.assertIsNone(unrelated.poll())
            self.assertFalse((self.base / 'must-not-run').exists())
        finally:
            unrelated.kill(); unrelated.wait()

    def test_android_helper_uses_inherited_lock_not_recursive_wait(self):
        helper = SCRIPT.parent / 'android-build-thales.py'
        module = importlib.util.spec_from_file_location('android_helper', helper)
        assert module is not None and module.loader is not None
        loaded = importlib.util.module_from_spec(module); module.loader.exec_module(loaded)
        self.assertTrue(callable(loaded.shared_worker_lock))
        code = f"import importlib.util; s=importlib.util.spec_from_file_location('a',{str(helper)!r}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.BASE={str(self.base)!r};\nwith m.shared_worker_lock(True): print('inherited lock acquired')"
        a, _ = self.submit(code)
        self.assertEqual(self.wait(a, ('completed', 'failed'))['state'], 'completed')


    # --- light lane -------------------------------------------------------
    def hold_shared_lock(self):
        self.base.mkdir(parents=True, exist_ok=True)
        holder = self.lock.open('a')
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return holder

    def test_light_job_runs_while_shared_lock_is_held_and_heavy_waits(self):
        holder = self.hold_shared_lock()
        try:
            heavy, _ = self.submit("from pathlib import Path; Path('heavy-ran').touch()")
            light, _ = self.submit("from pathlib import Path; Path('light-ran').touch(); print('light done')", lane='light')
            result = self.wait(light, ('completed',))
            self.assertEqual(result['receipt']['exit_code'], 0)
            self.assertTrue((self.base / 'light-ran').exists())
            time.sleep(1.5)
            row = self.rpc('status', heavy)
            self.assertEqual((row['state'], row['reason']), ('queued', 'worker_busy'))
            self.assertFalse((self.base / 'heavy-ran').exists())
        finally:
            holder.close()
        self.wait(heavy, ('completed',))

    def test_light_jobs_stay_out_of_the_heavy_spool(self):
        light, spec = self.submit("print('x')", lane='light')
        self.wait(light, ('completed',))
        with closing(sqlite3.connect(self.root / 'jobs.sqlite3')) as db:
            self.assertIsNone(db.execute('SELECT 1 FROM jobs WHERE id=?', (light,)).fetchone())
        with closing(sqlite3.connect(self.root / 'light' / 'jobs.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT state FROM jobs WHERE id=?', (light,)).fetchone()[0], 'completed')
        # Duplicate submit is idempotent and never re-executes.
        self.assertEqual(self.rpc('submit', light, spec)['state'], 'completed')

    def test_light_lane_is_one_at_a_time_and_fifo(self):
        a, _ = self.submit("import time; from pathlib import Path; Path('order').open('a').write('a'); time.sleep(1.5)", lane='light')
        self.wait(a, ('running',))
        b, _ = self.submit("from pathlib import Path; Path('order').open('a').write('b')", lane='light')
        self.assertEqual(self.rpc('status', b)['state'], 'queued')
        self.wait(a, ('completed',)); self.wait(b, ('completed',))
        self.assertEqual((self.base / 'order').read_text(), 'ab')

    def test_light_lane_limits_and_identity(self):
        job = 'heavy_' + uuid.uuid4().hex
        base = {'cwd': str(self.base), 'argv': [sys.executable, '-c', 'print(1)']}
        for spec in ({**base, 'timeout_seconds': 901, 'lane': 'light'},
                     {**base, 'timeout_seconds': 60, 'lane': 'gpu'}):
            proc = self.raw_rpc({'action': 'submit', 'job_id': job, 'spec': spec})
            self.assertEqual(proc.returncode, 1)
            self.assertEqual(json.loads(proc.stdout), {'error': 'worker_rpc_failed'})
        # Same identity cannot move between lanes.
        light, spec = self.submit("print('x')", lane='light')
        heavy_spec = {k: v for k, v in spec.items() if k != 'lane'}
        self.assertEqual(self.raw_rpc({'action': 'submit', 'job_id': light, 'spec': heavy_spec}).returncode, 1)

    def test_light_cancel_routes_to_light_spool(self):
        holder = self.hold_shared_lock()
        try:
            a, _ = self.submit("import time; time.sleep(10)", lane='light')
            self.wait(a, ('running',))
            b, _ = self.submit("from pathlib import Path; Path('must-not-exist').touch()", lane='light')
            self.rpc('cancel', b); self.rpc('cancel', a)
            self.wait(a, ('cancelled',)); self.wait(b, ('cancelled',))
            self.assertFalse((self.base / 'must-not-exist').exists())
        finally:
            holder.close()

    def test_light_job_cannot_borrow_the_android_shared_lock(self):
        helper = SCRIPT.parent / 'android-build-thales.py'
        code = f"import importlib.util; s=importlib.util.spec_from_file_location('a',{str(helper)!r}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.BASE={str(self.base)!r};\nwith m.shared_worker_lock(True): print('ACQUIRED-' + 'MARK')"
        self.base.mkdir(parents=True, exist_ok=True); self.lock.touch()
        a, _ = self.submit(code, lane='light')
        result = self.wait(a, ('completed', 'failed'))
        self.assertEqual(result['state'], 'failed')
        log = Path(result['receipt']['log_path']).read_text()
        self.assertIn('inherited lock identity mismatch', log)
        self.assertNotIn('ACQUIRED-MARK', log)

if __name__ == '__main__':
    unittest.main(verbosity=2)
