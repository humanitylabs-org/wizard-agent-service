#!/usr/bin/env python3
"""Execute on Thales only: real RPC, process, restart and shared-lock semantics."""
import importlib.util
import json
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

    def submit(self, code):
        job_id = 'heavy_' + uuid.uuid4().hex
        self.ids.append(job_id)
        spec = {'cwd': str(self.base), 'argv': [sys.executable, '-c', code], 'timeout_seconds': 15}
        self.rpc('submit', job_id, spec)
        return job_id, spec

    def wait(self, job_id, states):
        deadline = time.monotonic() + 20
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
        with sqlite3.connect(self.root / 'jobs.sqlite3') as db:
            child = db.execute('SELECT pid FROM jobs WHERE id=?', (a,)).fetchone()[0]
        parent = int(subprocess.check_output(['/bin/ps', '-o', 'ppid=', '-p', str(child)], text=True).strip())
        os.kill(parent, signal.SIGKILL)
        self.rpc('submit', a, spec_a)
        b, _ = self.submit("print('after crash')")
        self.assertEqual(self.rpc('status', b)['state'], 'queued')
        self.wait(a, ('interrupted',))
        self.wait(b, ('completed',))
        self.rpc('submit', a, spec_a)
        self.assertEqual((self.base / 'once').read_text(), 'x')

    def test_android_helper_uses_inherited_lock_not_recursive_wait(self):
        helper = SCRIPT.parent / 'android-build-thales.py'
        module = importlib.util.spec_from_file_location('android_helper', helper)
        loaded = importlib.util.module_from_spec(module); module.loader.exec_module(loaded)
        self.assertTrue(callable(loaded.shared_worker_lock))
        code = f"import importlib.util; s=importlib.util.spec_from_file_location('a',{str(helper)!r}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.BASE={str(self.base)!r};\nwith m.shared_worker_lock(True): print('inherited lock acquired')"
        a, _ = self.submit(code)
        self.assertEqual(self.wait(a, ('completed', 'failed'))['state'], 'completed')


if __name__ == '__main__':
    unittest.main(verbosity=2)
