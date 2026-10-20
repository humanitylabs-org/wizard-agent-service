#!/usr/bin/env python3
"""Lightweight policy/scanner tests; no Docker, VM, provider, or live secrets."""
import contextlib
import hashlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('check', Path(__file__).parent / 'checks/check.py')
assert spec is not None and spec.loader is not None
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.secret = b'test-only-not-a-real-provider-key-0123456789'
        self.fp = hashlib.sha256(self.secret).hexdigest()

    def test_fingerprint_plain_env_yaml_json_and_docker_env(self):
        samples = [self.secret, self.secret + b'\n', b'API_KEY=' + self.secret,
                   b'API_KEY="' + self.secret + b'"\n', b'key: ' + self.secret,
                   b'{"secret":"' + self.secret + b'"}',
                   b'{"Config":{"Env":["API_KEY=' + self.secret + b'"]}}']
        for sample in samples:
            with self.subTest(sample_format=sample[:8]):
                self.assertTrue(check.fingerprint_match(sample, self.fp))
        self.assertFalse(check.fingerprint_match(b'unrelated', self.fp))

    def test_key_across_chunk_boundary(self):
        p = self.root / 'boundary'
        p.write_bytes(b'\x00' * (1024 * 1024 - 4) + self.secret + b'\x00')
        self.assertTrue(check.scan_key(p, self.fp))

    def test_codeword_across_chunk_boundary(self):
        p = self.root / 'data'
        word = b'PRIVPROBE-FIXTURE'
        p.write_bytes(b'x' * (1024 * 1024 - 3) + word + b'y')
        self.assertTrue(check.contains(p, word))
        self.assertFalse(check.contains(p, b'ABSENT-CODEWORD'))

    def test_missing_roots_fail_closed(self):
        with self.assertRaises(RuntimeError):
            list(check.files([self.root / 'absent']))

    def test_symlink_escape_fails_closed(self):
        (self.root / 'escape').symlink_to('/etc/passwd')
        with self.assertRaises(RuntimeError):
            list(check.files([self.root]))

    def test_tls_http_reset_and_tool_failure_are_not_network_seal(self):
        for rc in [0, 22, 35, 52, 56, 90]:
            with patch.object(check, 'probe', return_value=rc):
                with self.assertRaises(RuntimeError):
                    check.blocked('fixture', 'https://example.com')
        for rc in [6, 7, 28]:
            with patch.object(check, 'probe', return_value=rc), contextlib.redirect_stdout(io.StringIO()):
                check.blocked('fixture', 'https://example.com')

    def test_stop_probe_restores_after_wrong_error(self):
        a = SimpleNamespace(trigger='/fixture', timeout=1)
        calls = []
        def dock(*argv, **kw):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, b'', b'')
        results = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 1)]
        states = [{'State': {'Running': False}}, {'State': {'Running': True}}]
        with patch.object(check, 'provider_containers', return_value=[{'Id': 'fixture'}]), \
             patch.object(check, 'run', side_effect=results), patch.object(check, 'docker', side_effect=dock), \
             patch.object(check, 'inspect', side_effect=states):
            with self.assertRaises(RuntimeError):
                check.stop_provider(a)
        self.assertIn(('start', 'fixture'), calls)

    def test_client_explicit_compose_name_keeps_all_network_assertions(self):
        a = SimpleNamespace(agent='pp-test-fixture', client_container='project-client-1',
                            provider_app='wizard-tinfoil', relay_port=8090, deny_url=[])
        c = {'Id': 'client', 'NetworkSettings': {'Networks': {'sandbox': {}, 'wizard-relay-wizard-tinfoil': {}}}}
        with patch.object(check, 'container', return_value=c) as target, \
             patch.object(check, 'inspect', return_value={'Internal': True}), \
             patch.object(check, 'probe', return_value=0), patch.object(check, 'blocked') as blocked, \
             contextlib.redirect_stdout(io.StringIO()):
            check.client(a)
        target.assert_called_once_with('project-client-1')
        self.assertEqual(blocked.call_count, 4)

    def test_baseline_failure_never_stops_provider(self):
        a = SimpleNamespace(trigger='/fixture', timeout=1)
        with patch.object(check, 'provider_containers', return_value=[{'Id': 'fixture'}]), \
             patch.object(check, 'run', return_value=subprocess.CompletedProcess([], 42)), \
             patch.object(check, 'docker') as docker:
            with self.assertRaises(RuntimeError):
                check.stop_provider(a)
            docker.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
