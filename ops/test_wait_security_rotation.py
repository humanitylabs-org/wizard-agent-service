"""Focused synthetic control-plane tests; no live maintenance or credentials."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('waiter', Path(__file__).with_name('wait_security_rotation.py'))
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class WaitTests(unittest.TestCase):
    def test_pid_reuse_fails_before_poll(self):
        expected = {'pid': 42, 'start_ticks': 1, 'boot_id': 'fixture'}
        with patch.object(m.os, 'pidfd_open', return_value=9), patch.object(m.os, 'close') as close, \
                patch.object(m, 'identity', return_value={**expected, 'start_ticks': 2}), \
                patch.object(m.select, 'poll') as poll:
            with self.assertRaisesRegex(m.r.Gate, 'backup_pid_identity_changed'):
                m.wait_exit(expected, 1, Mock())
            poll.assert_not_called()
            close.assert_called_once_with(9)

    def test_timeout_is_one_bounded_kernel_wait(self):
        expected = {'pid': 42, 'start_ticks': 1, 'boot_id': 'fixture'}
        poller = Mock()
        poller.poll.return_value = []
        with patch.object(m.os, 'pidfd_open', return_value=9), patch.object(m.os, 'close'), \
                patch.object(m, 'identity', return_value=expected), \
                patch.object(m.select, 'poll', return_value=poller):
            with self.assertRaisesRegex(m.r.Gate, 'backup_exit_wait_timeout'):
                m.wait_exit(expected, 3, Mock())
            poller.poll.assert_called_once_with(3000)

    def test_real_pidfd_exit(self):
        child = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.buffer.read()'], stdin=subprocess.PIPE)
        try:
            expected = m.identity(child.pid)
            child.stdin.close()
            statuses = []
            m.wait_exit(expected, 3, statuses.append)
            self.assertEqual(statuses[-1], 'backup_process_exited')
        finally:
            child.wait(timeout=3)

    def exercise(self, busy, wait_failure=False, holder=42):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root = Path(tmp)
            controller = root / 'controller.py'
            controller.write_text('# synthetic fixture\n')
            expected = {'pid': 42, 'start_ticks': 1, 'boot_id': 'fixture'}
            events = []
            def probe(seconds):
                events.append(('probe', seconds))
                return seconds == 600 or not busy
            def wait(*_):
                events.append(('wait',))
                if wait_failure:
                    raise m.r.Gate('backup_exit_wait_timeout')
            def rotate(*_):
                events.append(('rotate',))
                (root / 'result.json').write_text(json.dumps({'old_proof_revoked': True, 'rotation_status': 'verified'}))
                return 0
            with patch.object(m.r, 'protect'), patch.object(m, 'probe', side_effect=probe), \
                    patch.object(m, 'holders', return_value=[holder]), \
                    patch.object(m.maintenance, 'owner_status', return_value={'operation': 'encrypted-backup', 'pid': 42}), \
                    patch.object(m, 'wait_exit', side_effect=wait), \
                    patch.object(m, 'refresh_and_rotate', side_effect=rotate), contextlib.redirect_stdout(io.StringIO()):
                rc = m.run(root, root / 'plan.json', controller, expected, 2)
                state = json.loads((root / 'lease-release-continuation.json').read_text())
            return rc, state, events

    def test_busy_never_rotates_before_exact_exit_and_probe(self):
        rc, state, events = self.exercise(True)
        self.assertEqual(rc, 0)
        self.assertEqual(events, [('probe', 0), ('wait',), ('probe', 600), ('rotate',)])
        self.assertEqual(state['activation_attempts'], 1)

    def test_wait_timeout_never_rotates(self):
        rc, state, events = self.exercise(True, wait_failure=True)
        self.assertEqual(rc, 1)
        self.assertEqual(state['activation_attempts'], 0)
        self.assertNotIn(('rotate',), events)

    def test_waiter_fd_not_actual_holder_fails_closed(self):
        rc, state, events = self.exercise(True, holder=99)
        self.assertEqual(rc, 1)
        self.assertEqual(state['failure'], 'backup_not_actual_lease_holder')
        self.assertEqual(events, [('probe', 0)])

    def test_free_real_lock_ignores_stale_owner_and_process(self):
        rc, state, events = self.exercise(False)
        self.assertEqual(rc, 0)
        self.assertEqual(events, [('probe', 0), ('rotate',)])


if __name__ == '__main__':
    unittest.main()
