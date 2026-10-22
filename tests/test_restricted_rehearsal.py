#!/usr/bin/env python3
"""Rehearsal helper checks run only against synthetic keys and local fake services."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops/agent-runtime'))
import hermes_import_restricted_rehearsal as r
import hermes_import as h


class RehearsalTests(unittest.TestCase):
    def test_restrict_key_exact_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            (home / '.ssh').mkdir()
            authorized = home / '.ssh/authorized_keys'
            original = '# preserve comment\nssh-ed25519 synthetic-other-key other-owner\n\n'
            authorized.write_text(original)
            def local_remote(argv, *, input=None, **kw):
                command = shlex.split(argv[-1])
                self.assertEqual(command[:2], ['python3', '-c'])
                return subprocess.run([sys.executable, *command[1:]], input=input, capture_output=True, text=True,
                                      env=dict(os.environ, HOME=str(home)), check=True)
            with patch.object(r, 'command', side_effect=local_remote), patch.object(r, 'emit'):
                public = 'ssh-ed25519 synthetic-not-a-real-key ' + r.COMMENT
                r.remote_key('fixture', public)
                self.assertEqual(authorized.read_text(), original + 'restrict ' + public + '\n')
                self.assertEqual(authorized.stat().st_mode & 0o777, 0o600)
                r.remote_key('fixture')
            self.assertEqual(authorized.read_text(), original)
            self.assertEqual(list((home / '.ssh').iterdir()), [authorized])

    def test_hidden_false_stops_before_message(self):
        calls = []
        def call(service, path, *args, **kwargs):
            calls.append((path, args))
            return {'session': {'hidden': False}}
        with patch.dict(os.environ, {r.PREFIX + 'BUILD_HOST': 'builder'}), \
                patch.object(r.canary, 'hidden_session'), patch.object(r.canary, 'call', side_effect=call):
            with self.assertRaisesRegex(h.ImportFailure, 'session_not_hidden_fail_closed'):
                r.model_exercise('http://fixture', 'fixture', {'provider': 'anthropic', 'default': 'fixture'}, 'fact')
        self.assertEqual(len(calls), 1)
        self.assertFalse(any('/runs' in path for path, _ in calls))


if __name__ == '__main__':
    unittest.main(verbosity=2)
