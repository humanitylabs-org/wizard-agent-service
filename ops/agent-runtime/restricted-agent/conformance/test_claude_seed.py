"""Synthetic app login only: projection, rotation, logout and no writeback."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'sidecars/claude-init.py'
spec = importlib.util.spec_from_file_location('claude_init', SCRIPT)
assert spec and spec.loader
seeder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seeder)


class SeedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source, self.target = self.root / 'claude', self.root / 'config'
        self.source.mkdir(mode=0o700); self.target.mkdir()
        self.path = self.source / '.credentials.json'
        self.auth = {'accessToken': 'SYNTHETIC-app-access', 'refreshToken': 'SYNTHETIC-never-copy',
                     'expiresAt': time.time() * 1000 + 3600000, 'scopes': ['user:inference', 'user:profile'],
                     'subscriptionType': 'max', 'rateLimitTier': 'default_claude_max_5x', 'extra': 'not granted'}
        self.write()
        for name in ('chown', 'fchown'):
            m = mock.patch.object(seeder.os, name); m.start(); self.addCleanup(m.stop)

    def write(self):
        self.path.write_text(json.dumps({'claudeAiOauth': self.auth, 'otherAccount': 'not granted'}))
        self.path.chmod(0o600)

    def seed(self):
        return seeder.seed(self.source, self.target)

    def test_minimal_access_only_and_source_untouched(self):
        before = (self.path.read_bytes(), self.path.stat().st_mode, self.path.stat().st_uid, self.path.stat().st_ino)
        self.assertTrue(self.seed())
        path = self.target / '.credentials.json'
        auth = json.loads(path.read_text())['claudeAiOauth']
        self.assertEqual(auth, {k: self.auth[k] for k in ('accessToken','expiresAt','scopes','subscriptionType','rateLimitTier')})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o700)
        self.assertEqual(before, (self.path.read_bytes(), self.path.stat().st_mode, self.path.stat().st_uid, self.path.stat().st_ino))
        self.assertFalse(list(self.target.glob('.seed-*')))

    def test_source_atomic_rotation_and_logout(self):
        self.seed()
        replacement = self.source / 'new'
        self.auth['accessToken'] = 'SYNTHETIC-rotated'
        replacement.write_text(json.dumps({'claudeAiOauth': self.auth})); replacement.chmod(0o600)
        replacement.replace(self.path)
        self.assertTrue(self.seed())
        self.assertEqual(json.loads((self.target / '.credentials.json').read_text())['claudeAiOauth']['accessToken'], 'SYNTHETIC-rotated')
        self.path.unlink()
        self.assertFalse(self.seed())
        self.assertFalse((self.target / '.credentials.json').exists())
        self.write(); self.assertTrue(self.seed())

    def test_expired_invalid_or_unsafe_login_revokes_projection(self):
        for changes in ({'expiresAt': 1}, {'expiresAt': float('nan')}, {'expiresAt': True},
                        {'accessToken': ''}, {'accessToken': 'a b'}, {'accessToken': 'x'*16385}, {'scopes': None}):
            self.write(); self.seed()
            original = self.auth.copy(); self.auth.update(changes); self.write()
            self.assertFalse(self.seed()); self.assertFalse((self.target / '.credentials.json').exists())
            self.auth = original

    def test_source_symlinks_fifo_public_mode_and_bad_json_refused(self):
        self.path.unlink(); self.path.symlink_to(self.root / 'outside')
        self.assertFalse(self.seed())
        self.path.unlink(); os.mkfifo(self.path, 0o600)
        self.assertFalse(self.seed())
        self.path.unlink(); self.write(); self.path.chmod(0o644)
        self.assertFalse(self.seed())
        self.write(); self.path.write_bytes(b'\xff'); self.assertFalse(self.seed())
        link = self.root / 'directory-link'; link.symlink_to(self.source)
        with self.assertRaises(OSError): seeder.credential(link)

    def test_atomic_output_never_follows_symlink(self):
        other = self.root / 'other'; other.write_text('unchanged')
        (self.target / '.credentials.json').symlink_to(other)
        self.seed(); self.assertEqual(other.read_text(), 'unchanged')
        self.assertFalse((self.target / '.credentials.json').is_symlink())

    def test_check_missing_is_quiet_and_does_not_initialize(self):
        run = subprocess.run([sys.executable, str(SCRIPT), '--check'], capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 1); self.assertEqual(run.stdout + run.stderr, '')

    def test_conformance_refuses_gateway_token_without_masking_it(self):
        run = subprocess.run([sys.executable, str(SCRIPT.parents[1] / 'conformance/in_agent.py')],
                             env={**os.environ, 'CLAUDE_CODE_OAUTH_TOKEN': 'SYNTHETIC-no-mask'},
                             capture_output=True, text=True, timeout=10)
        self.assertNotEqual(run.returncode, 0); self.assertIn('would persist', run.stderr)
        self.assertNotIn('SYNTHETIC-no-mask', run.stdout + run.stderr)


if __name__ == '__main__': unittest.main()
