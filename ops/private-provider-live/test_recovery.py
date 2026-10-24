"""Small safety regressions; these do not claim VM/provider acceptance."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('rig_recover', HERE / 'rig-recover.py')
assert spec is not None and spec.loader is not None
recover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recover)


class RecoverySafety(unittest.TestCase):
    def exercise(self, results):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'private-providers'
            disk = root / 'rig/lima/pp-rig/disk'
            disk.parent.mkdir(parents=True)
            disk.write_bytes(b'fixture-disk-do-not-replace')
            calls = []
            def run(argv, **kwargs):
                self.assertEqual(kwargs['env']['LIMA_HOME'], str(root / 'rig/lima'))
                self.assertIn('pp-rig', argv)
                calls.append(argv)
                return subprocess.CompletedProcess(argv, next(results), '', '')
            with patch.object(sys, 'platform', 'darwin'), patch.object(sys, 'argv', ['rig-recover.py', '--project-root', str(root)]), patch.object(recover.subprocess, 'run', side_effect=run), contextlib.redirect_stdout(io.StringIO()):
                code = recover.main()
            receipt = json.loads((root / 'pp-launch/live/RIG-RECOVERY.json').read_text())
            self.assertEqual(disk.read_bytes(), b'fixture-disk-do-not-replace')
            self.assertFalse(any('delete' in c or '--reset' in c for c in calls))
            return code, receipt, calls

    def test_running_guest_needs_no_forced_stop(self):
        code, receipt, calls = self.exercise(iter([0, 0]))
        self.assertEqual(code, 0)
        self.assertEqual(receipt['status'], 'passed')
        self.assertFalse(any('stop' in c for c in calls))

    def test_broken_hostagent_gets_one_bounded_repair(self):
        code, receipt, calls = self.exercise(iter([1, 0, 0, 0]))
        self.assertEqual(code, 0)
        self.assertEqual(sum('start' in c for c in calls), 2)
        self.assertEqual(sum('stop' in c for c in calls), 1)

    def test_second_failure_preserves_disk_and_stops(self):
        code, receipt, calls = self.exercise(iter([1, 0, 1]))
        self.assertEqual(code, 1)
        self.assertEqual(receipt['status'], 'blocked')
        self.assertEqual(sum('start' in c for c in calls), 2)
        self.assertIn('two attempts', receipt['reason'])


if __name__ == '__main__':
    unittest.main()
