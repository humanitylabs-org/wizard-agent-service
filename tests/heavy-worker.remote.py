#!/usr/bin/env python3
"""Portable lightweight fixtures: real RPC, process, restart and shared-lock semantics."""
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
import unittest.mock
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/heavy-worker.py'


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='heavy-tests-')
        self.base = Path(self.temp.name)
        self.env = unittest.mock.patch.dict(os.environ, {'WIZARD_HEAVY_ROOT': str(self.base)})
        self.env.start()
        self.addCleanup(self.env.stop)
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

    def test_forum_host_is_preserved_in_spec_and_receipt(self):
        job = 'heavy_' + uuid.uuid4().hex
        self.ids.append(job)
        spec = {'cwd': str(self.base), 'argv': [sys.executable, '-c', "print('forum receipt')"],
                'timeout_seconds': 10, 'host': 'forum'}
        self.rpc('submit', job, spec)
        result = self.wait(job, ('completed',))
        self.assertEqual(result['receipt']['host'], 'forum')
        self.assertEqual(result['receipt']['exit_code'], 0)
        import hashlib
        self.assertEqual(result['receipt']['log_sha256'],
                         hashlib.sha256(Path(result['receipt']['log_path']).read_bytes()).hexdigest())
        self.assertEqual(self.raw_rpc({'action': 'submit', 'job_id': 'heavy_' + uuid.uuid4().hex,
                                     'spec': {**spec, 'host': 'other'}}).returncode, 1)

    def test_configured_worker_host_receipt_without_host_in_spec(self):
        for host in ('forum', 'thales'):
            with unittest.mock.patch.dict(os.environ, {'WIZARD_HEAVY_HOST': host}):
                # Each configured host has its own dispatcher/spool, as in production.
                self.root = self.base / host / 'spool'
                job, spec = self.submit("print('configured host')")
                result = self.wait(job, ('completed',))
                self.assertEqual(result['receipt']['host'], host)
                import hashlib
                self.assertEqual(result['receipt']['spec_sha256'],
                                 hashlib.sha256(json.dumps(spec, separators=(',', ':'), sort_keys=True).encode()).hexdigest())
                self.ids.remove(job)
        with unittest.mock.patch.dict(os.environ, {'WIZARD_HEAVY_HOST': ''}):
            self.root = self.base / 'legacy' / 'spool'
            job, _ = self.submit("print('legacy host')")
            self.assertEqual(self.wait(job, ('completed',))['receipt']['host'], 'thales')

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

class ConfigurationTests(unittest.TestCase):
    def test_host_supervisor_recovers_all_existing_spools_with_the_same_locks(self):
        module = importlib.util.spec_from_file_location('worker_supervisor', SCRIPT)
        worker = importlib.util.module_from_spec(module); module.loader.exec_module(worker)
        with tempfile.TemporaryDirectory(prefix='heavy-supervisor-') as temp:
            root = Path(temp) / 'spool'; lock = Path(temp) / 'worker.lock'
            lanes = (root, worker.light_root(root), worker.agent_spool(root),
                     worker.light_root(worker.agent_spool(root)))
            for lane in lanes:
                with closing(worker.connect(lane)):
                    pass
            with unittest.mock.patch.object(worker, 'spawn_dispatcher') as spawn:
                worker.ensure_dispatchers(root, lock)
                self.assertEqual(spawn.call_args_list, [
                    unittest.mock.call(root, lock), unittest.mock.call(lanes[1], worker.light_lock(root)),
                    unittest.mock.call(lanes[2], lock), unittest.mock.call(lanes[3], worker.light_lock(root))])

    def test_missing_configuration_refuses_before_creating_storage(self):
        with tempfile.TemporaryDirectory(prefix='heavy-config-') as temp:
            root = Path(temp) / 'spool'
            env = {k: v for k, v in os.environ.items() if k not in ('WIZARD_HEAVY_ROOT', 'WIZARD_WORK_ROOT')}
            result = subprocess.run([sys.executable, str(SCRIPT), '--root', str(root), '--lock', temp + '/lock'],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stderr.strip(), 'heavy lane not configured: set WIZARD_HEAVY_ROOT')
            self.assertFalse(root.exists())

    def test_fallback_and_canonical_path_boundaries(self):
        module = importlib.util.spec_from_file_location('worker_config', SCRIPT)
        worker = importlib.util.module_from_spec(module); module.loader.exec_module(worker)
        with tempfile.TemporaryDirectory(prefix='heavy-boundary-') as temp:
            base = Path(temp).resolve(); allowed = base / 'allowed'; allowed.mkdir()
            outside = base / 'outside'; outside.mkdir()
            (allowed / 'escape').symlink_to(outside, target_is_directory=True)
            spec = {'cwd': str(allowed), 'argv': ['true'], 'timeout_seconds': 1}
            with unittest.mock.patch.dict(os.environ, {'WIZARD_HEAVY_ROOT': '', 'WIZARD_WORK_ROOT': str(allowed)}):
                self.assertEqual(worker.validate(spec)['cwd'], str(allowed))
                for cwd in (outside, allowed / '../outside', allowed / 'escape'):
                    with self.assertRaisesRegex(ValueError, 'configured heavy root'):
                        worker.validate({**spec, 'cwd': str(cwd)})
                for root, lock in ((outside / 'spool', allowed / 'lock'), (allowed / 'spool', outside / 'lock')):
                    result = subprocess.run([sys.executable, str(SCRIPT), '--root', str(root), '--lock', str(lock)],
                                            capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('configured heavy root', result.stderr)
                    self.assertFalse(root.exists())

    def test_android_preparation_uses_configured_host_root_and_sdk_without_building(self):
        import contextlib
        import io
        helper = SCRIPT.parent / 'android-build-thales.py'
        with tempfile.TemporaryDirectory(prefix='android-config-') as temp:
            base = Path(temp); project = base / 'project'; project.mkdir()
            (project / 'gradlew').touch()
            root = str(base / 'remote worker')
            env = {'WIZARD_HEAVY_ROOT': root, 'WIZARD_BUILD_HOST': 'build-fixture',
                   'ANDROID_HOME': '/opt/fixture sdk', 'HERMES_HOME': str(base / 'hermes')}
            with unittest.mock.patch.dict(os.environ, env):
                spec = importlib.util.spec_from_file_location('android_config', helper)
                assert spec is not None and spec.loader is not None
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                self.assertEqual(module.BASE, root + '/AndroidBuilds')
                argv = [str(helper), '--project', str(project), '--output', str(base / 'output'), '--prepare-only', '--', 'assembleDebug']
                with unittest.mock.patch.object(module.sys, 'argv', argv), \
                     unittest.mock.patch.object(module, 'run') as remote, \
                     unittest.mock.patch.object(module, 'snapshot', return_value={}), \
                     unittest.mock.patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'fixture-sha')), \
                     contextlib.redirect_stdout(io.StringIO()) as output:
                    old_umask = os.umask(0o077)
                    try:
                        module.main()
                    finally:
                        os.umask(old_umask)
                prepared = json.loads(output.getvalue())
                self.assertEqual(prepared['host'], 'build-fixture')
                self.assertTrue(prepared['cwd'].startswith(root + '/AndroidBuilds/jobs/'))
                self.assertIn('WIZARD_HEAVY_ROOT=' + root, prepared['argv'])
                self.assertIn('WIZARD_BUILD_HOST=build-fixture', prepared['argv'])
                self.assertIn('ANDROID_HOME=/opt/fixture sdk', prepared['argv'])
                self.assertEqual(prepared, json.loads((base / 'output/job.json').read_text()))
                commands = [call.args[0] for call in remote.call_args_list]
                self.assertEqual(commands[0][-2], 'build-fixture')
                self.assertIn("test -d '" + root + "'", commands[0][-1])
                self.assertEqual(commands[-1][-1], 'build-fixture:' + prepared['cwd'] + '/')
                self.assertEqual(len(commands), 3)  # preflight, stage mkdir, copy; never Gradle

    def test_linux_health_keeps_disk_memory_pressure_and_unknown_guards(self):
        module = importlib.util.spec_from_file_location('worker_health', SCRIPT)
        worker = importlib.util.module_from_spec(module); module.loader.exec_module(worker)
        with unittest.mock.patch.object(worker.sys, 'platform', 'linux'), \
             unittest.mock.patch.object(worker.shutil, 'disk_usage') as disk, \
             unittest.mock.patch.object(worker.Path, 'read_text') as read:
            disk.return_value.free = 30 * 1024**3
            read.side_effect = ['MemAvailable: 1048576 kB', 'full avg10=0.00 avg60=0.00 total=0']
            self.assertEqual(worker.resource_wait(Path('.')), '')
            read.side_effect = ['MemAvailable: 1 kB', 'full avg10=0.00 avg60=0.00 total=0']
            self.assertEqual(worker.resource_wait(Path('.')), 'memory_pressure')
            read.side_effect = ['MemAvailable: 1048576 kB', 'full avg10=20.00 avg60=0.00 total=0']
            self.assertEqual(worker.resource_wait(Path('.')), 'memory_pressure')
            read.side_effect = OSError('health unavailable')
            self.assertEqual(worker.resource_wait(Path('.')), 'worker_health_unknown')
            disk.return_value.free = 1
            self.assertEqual(worker.resource_wait(Path('.')), 'disk_pressure')


if __name__ == '__main__':
    unittest.main(verbosity=2)
