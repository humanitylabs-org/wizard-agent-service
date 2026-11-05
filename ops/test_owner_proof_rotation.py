"""Lightweight synthetic tests; never touch a live proof, service or owner data."""
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rotation', Path(__file__).with_name('owner-proof-rotation.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RotationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch')))
        self.root = Path(self.tmp.name)
        self.proof = self.root / 'owner-proof'
        self.old = bytearray(secrets.token_hex(48).encode())
        self.new = bytearray(secrets.token_hex(48).encode())
        self.proof.write_bytes(self.old)
        self.proof.chmod(0o600)
        self.scope = patch.object(m, 'PROOF', self.proof)
        self.scope.start()

    def tearDown(self):
        self.scope.stop()
        m.wipe(self.old)
        m.wipe(self.new)
        self.tmp.cleanup()

    def test_cas_and_mode_roundtrip(self):
        m.cas_replace(m.sha(self.old), self.new)
        self.assertEqual(self.proof.read_bytes(), self.new)
        self.assertEqual(stat.S_IMODE(self.proof.stat().st_mode), 0o600)
        m.cas_replace(m.sha(self.new), self.old)
        self.assertEqual(self.proof.read_bytes(), self.old)
        self.assertEqual([x.name for x in self.root.iterdir()], ['owner-proof'])

    def test_wrong_hash_never_replaces(self):
        with self.assertRaisesRegex(m.Gate, '^cas_digest$'):
            m.cas_replace('0' * 64, self.new)
        self.assertEqual(self.proof.read_bytes(), self.old)

    def test_symlink_rejected(self):
        other = self.root / 'other'
        self.proof.rename(other)
        self.proof.symlink_to(other)
        with self.assertRaisesRegex(m.Gate, '^proof_file_protection$'):
            m.read_secret()

    def test_insecure_mode_rejected(self):
        self.proof.chmod(0o644)
        with self.assertRaisesRegex(m.Gate, '^proof_file_protection$'):
            m.read_secret()

    def test_failed_subprocess_does_not_expose_its_output(self):
        response = subprocess.CompletedProcess(['fixture'], 1, stdout=bytes(self.old), stderr=bytes(self.new))
        with patch.object(subprocess, 'run', return_value=response):
            with self.assertRaisesRegex(m.Gate, '^command_failed_fixture$') as caught:
                m.cmd(['fixture'])
        self.assertNotIn(self.old.decode(), str(caught.exception))
        self.assertNotIn(self.new.decode(), str(caught.exception))

    def test_crypto_pipes_only_ciphertext_artifact(self):
        payload = json.dumps({'old': self.old.decode(), 'new': self.new.decode()}).encode()
        ciphertext = b'not-a-real-CMS-fixture-ciphertext'
        calls = []
        def fake(argv, *, data=None, timeout=30):
            calls.append(argv)
            if '-encrypt' in argv:
                self.assertEqual(data, payload)
                return ciphertext
            self.assertEqual(data, ciphertext)
            return payload
        recovery = self.root / 'recovery.cms'
        with patch.object(m, 'cmd', side_effect=fake), patch.object(m, 'hashfile', return_value='certificate-digest'):
            result = m.crypto(self.old, self.new, recovery)
        self.assertTrue(result['roundtrip'])
        self.assertEqual(recovery.read_bytes(), ciphertext)
        for command in calls:
            self.assertNotIn(self.old.decode(), repr(command))
            self.assertNotIn(self.new.decode(), repr(command))

    def test_missing_redaction_is_a_pre_mutation_gate(self):
        live = {'release': 'release', 'revision': 'revision', 'source_hashes': {}, 'containers': {},
                'apps_count': 29, 'apps_rows_sha256': 'apps', 'settings_sha256': 'settings',
                'base_url': 'https://example.invalid', 'service': {}, 'units': {m.KEEPER: {'state': 'active'}},
                'keeper': {'pid': 123}, 'runtime_log_filter': {'loaded': False, 'matches_current_config': True}}
        plan = {'old_sha256': m.sha(self.old), 'before': live}
        with patch.object(m, 'snapshot', return_value=live), patch.object(m, 'peer') as peer:
            with self.assertRaisesRegex(m.Gate, '^runtime_proof_header_redaction_not_loaded$'):
                m.preflight(plan)
            peer.assert_not_called()
        self.assertEqual(self.proof.read_bytes(), self.old)

    def test_same_artifact_restart_uses_supported_controller(self):
        calls = []
        def command(argv, **kwargs):
            calls.append([str(x) for x in argv])
            return b''
        with patch.object(m, 'unit', return_value={'state': 'active'}), patch.object(m, 'keeper', return_value={'pid': 123}), patch.object(m, 'cmd', side_effect=command), patch.object(m, 'local', return_value=(200, b'{"status":"ok","upstream_reachable":true}')):
            m.restart()
        self.assertEqual(calls[0][1:], [str(m.SCRIPTS / 'wizard_drain_restart.py'), 'restart', 'wizard-mobile'])
        self.assertFalse(any('docker' in c or 'stop' in c for c in calls))

    def test_failed_acceptance_compensates_producer_and_verifier(self):
        import contextlib
        import sys
        import types
        (self.root / '.local/state').mkdir(parents=True)
        (self.root / '.hermes/scripts').mkdir(parents=True)
        planpath = self.root / 'plan.json'
        plan = {'old_sha256': m.sha(self.old), 'before': {'runs': [], 'base_url': 'https://example.invalid'}}
        planpath.write_text(json.dumps(plan))
        restart_calls = []
        lease = types.SimpleNamespace(maintenance_lock=lambda *a, **kw: contextlib.nullcontext())
        def check_local(path, token=None, **kw):
            return (200 if token == self.old else 403, b'{}')
        with patch.object(m, 'HOME', self.root), patch.object(m, 'SCRIPTS', self.root / '.hermes/scripts'), \
                patch.dict(sys.modules, {'hermes_state_maintenance_lock': lease}), \
                patch.object(m, 'preflight', return_value={'runs': []}), \
                patch.object(m, 'crypto', return_value={'synthetic': True}), \
                patch.object(m, 'restart', side_effect=lambda: restart_calls.append(True)), \
                patch.object(m, 'verify', return_value=({'ok': False}, {})), \
                patch.object(m, 'local', side_effect=check_local), patch.object(m, 'peer', return_value=200):
            self.assertEqual(m.operate(planpath), 1)
        result = json.loads((self.root / 'result.json').read_text())
        self.assertEqual(result['status'], 'rolled_back_consistent_security_not_contained')
        self.assertEqual(len(restart_calls), 2)
        self.assertEqual(self.proof.read_bytes(), self.old)
        self.assertNotIn(self.old.decode(), (self.root / 'result.json').read_text())

    def test_blocked_preflight_never_calls_restart_or_cas(self):
        import contextlib
        import sys
        import types
        (self.root / '.local/state').mkdir(parents=True)
        (self.root / '.hermes/scripts').mkdir(parents=True)
        planpath = self.root / 'plan.json'
        planpath.write_text(json.dumps({'old_sha256': m.sha(self.old)}))
        lease = types.SimpleNamespace(maintenance_lock=lambda *a, **kw: contextlib.nullcontext())
        with patch.object(m, 'HOME', self.root), patch.object(m, 'SCRIPTS', self.root / '.hermes/scripts'), \
                patch.dict(sys.modules, {'hermes_state_maintenance_lock': lease}), \
                patch.object(m, 'preflight', side_effect=m.Gate('runtime_proof_header_redaction_not_loaded')), \
                patch.object(m, 'cas_replace') as cas, patch.object(m, 'restart') as restart:
            self.assertEqual(m.operate(planpath), 1)
            cas.assert_not_called()
            restart.assert_not_called()
        self.assertEqual(json.loads((self.root / 'result.json').read_text())['status'], 'blocked_before_mutation')
        self.assertEqual(self.proof.read_bytes(), self.old)

    def test_wipe(self):
        m.wipe(self.old)
        self.assertFalse(any(self.old))


if __name__ == '__main__':
    unittest.main()
