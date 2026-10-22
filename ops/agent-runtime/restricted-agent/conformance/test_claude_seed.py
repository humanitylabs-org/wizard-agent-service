"""Offline secret seeding: synthetic files in isolated scratch only."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'sidecars/claude-init.py'
spec = importlib.util.spec_from_file_location('claude_init', SCRIPT)
assert spec is not None and spec.loader is not None
seeder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seeder)


class SeedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source, self.target = self.root / 'claude.token', self.root / 'config'
        self.target.mkdir()
        self.source.write_text('SYNTHETIC-seed-fixture')
        self.source.chmod(0o600)
        for name in ('chown', 'fchown'):
            m = mock.patch.object(seeder.os, name)
            m.start()
            self.addCleanup(m.stop)

    def seed(self):
        seeder.seed(self.source, self.target)

    def test_mode_and_minimal_login(self):
        self.seed()
        path = self.target / '.credentials.json'
        credential = json.loads(path.read_text())['claudeAiOauth']
        self.assertEqual(credential['accessToken'], 'SYNTHETIC-seed-fixture')
        self.assertNotIn('refreshToken', credential)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o700)
        self.assertFalse(list(self.target.glob('.seed-*')))

    def test_source_symlink_refused(self):
        link = self.root / 'link'; link.symlink_to(self.source)
        with self.assertRaises(OSError):
            seeder.seed(link, self.target)

    def test_source_fifo_refused_without_blocking(self):
        self.source.unlink(); os.mkfifo(self.source, 0o600)
        with self.assertRaises(ValueError): self.seed()

    def test_public_mode_refused(self):
        self.source.chmod(0o644)
        with self.assertRaises(ValueError): self.seed()

    def test_invalid_values_refused(self):
        for value in (b'', b'a b', b'a\x00b', b'\xff', b'a' * 16385):
            self.source.write_bytes(value)
            with self.assertRaises((ValueError, UnicodeError)): self.seed()

    def test_atomic_replace_never_follows_output_symlink(self):
        other = self.root / 'other'; other.write_text('unchanged')
        (self.target / '.credentials.json').symlink_to(other)
        self.seed()
        self.assertEqual(other.read_text(), 'unchanged')
        self.assertFalse((self.target / '.credentials.json').is_symlink())

    def test_conformance_refuses_gateway_token_without_masking_it(self):
        run = subprocess.run([sys.executable, str(SCRIPT.parents[1] / 'conformance/in_agent.py')],
                             env={**os.environ, 'CLAUDE_CODE_OAUTH_TOKEN': 'SYNTHETIC-no-mask'},
                             capture_output=True, text=True, timeout=10)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('would persist', run.stderr)
        self.assertNotIn('SYNTHETIC-no-mask', run.stdout + run.stderr)

    def test_failure_does_not_echo_secret_or_path(self):
        # The default source is absent in this isolated test environment.
        run = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(run.stderr.strip(), 'Claude credential initialization failed')


if __name__ == '__main__':
    unittest.main()
