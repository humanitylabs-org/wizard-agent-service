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
    def test_current_baseline_is_explicit_and_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            (source / 'config.yaml').write_text('fixture current configuration')
            current = h.file_hash(source / 'config.yaml')
            with patch.dict(os.environ, {r.PREFIX + 'CONFIG_SHA256': current}):
                self.assertEqual(r.config_baseline(source), current)
                (source / 'config.yaml').write_text('changed during rehearsal')
                with self.assertRaisesRegex(h.ImportFailure, 'live_config_hash_mismatch'):
                    r.config_baseline(source)
            for invalid in ['', 'old-pin', 'a' * 63]:
                with patch.dict(os.environ, {r.PREFIX + 'CONFIG_SHA256': invalid}):
                    with self.assertRaisesRegex(h.ImportFailure, 'config_baseline_required'):
                        r.config_baseline(source)

    def test_no_root_tcp_or_ssh_key_path(self):
        source = Path(r.__file__).read_text()
        for forbidden in ['sudo', 'iptables', 'remote_key(', 'ProxyCommand', 'declared_' + 'tcp', 'ssh-keygen']:
            self.assertNotIn(forbidden, source)

    def test_heavy_failed_or_missing_submission_is_not_a_pass(self):
        with patch.object(r, 'emit'):
            self.assertFalse(r.verify_heavy('fixture', [], '/worker/agents/fixture'))
            self.assertFalse(r.verify_heavy('fixture', [{'arguments': {}, 'receipt': {'error': 'refused', 'status': 404}}], '/worker/agents/fixture'))

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
