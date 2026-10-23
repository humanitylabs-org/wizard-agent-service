"""Hermetic recovery preparation contracts; no real credentials, units or services."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location('recovery_home', ROOT / 'ops/agent-runtime/recovery_home.py')
assert SPEC and SPEC.loader
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.root = Path(self.tmp.name)
        self.owner = self.root / 'owner'
        self.source = self.owner / '.hermes'
        self.source.mkdir(parents=True)
        self.home = self.owner / '.hermes-recovery'
        self.runtime = self.owner / '.local/share/wizard-recovery'
        self.env = patch.dict(os.environ, {'HOME': str(self.owner), 'HERMES_HOME': str(self.source),
            'WIZARD_OS_HOME': str(self.owner / '.wizard-os'), 'TMPDIR': str(self.root)})
        self.env.start()
        (self.source / 'config.yaml').write_text(yaml.safe_dump({
            'model': {'provider': 'anthropic', 'default': 'fixture-claude'},
            'terminal': {'backend': 'docker'}, 'mcp_servers': {'unsafe': {'command': '/host/tool'}},
            'fallback_model': {'provider': 'different-provider'}, 'plugins': {'enabled': ['unsafe']},
            'gateway': {'platforms': {'telegram': {'enabled': True}}}}))
        (self.source / 'auth.json').write_text(json.dumps({'version': 2, 'providers': {'openai-codex': {'access_token': 'wrong-provider'}},
            'credential_pool': {'anthropic': [{'source': 'claude_code', 'auth_type': 'oauth'}],
                                'openai-codex': [{'access_token': 'do-not-copy'}]}}))
        (self.source / '.env').write_text('TELEGRAM_BOT_TOKEN=do-not-copy\nWIZARD_ADMIN_KEY=do-not-copy\nANTHROPIC_TOKEN="fixture-value-$NO_EXPAND"\n')
        for name in r.SKILLS:
            directory = self.source / 'skills' / 'category' / name
            directory.mkdir(parents=True)
            (directory / 'SKILL.md').write_text('maintenance skill: ' + name)
        (self.source / 'skills/unrelated').mkdir()
        (self.source / 'cron').mkdir()
        (self.source / 'cron/jobs.json').write_text('{"jobs":[{"enabled":true}]}')
        (self.source / 'state.db').write_text('never copied')
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            self.port = s.getsockname()[1]

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def prepare(self, **kwargs):
        kwargs.setdefault('runtime_builder', lambda install, runtime: 'a' * 40)
        return r.prepare(self.source, self.home, self.runtime, port=self.port, acknowledge_host_access=True, **kwargs)

    def test_minimal_identity_provider_and_host_tools(self):
        before = (self.source / 'config.yaml').read_bytes()
        receipt = self.prepare()
        config = yaml.safe_load((self.home / 'config.yaml').read_text())
        self.assertEqual(config['model'], {'provider': 'anthropic', 'default': 'fixture-claude'})
        self.assertEqual(config['terminal']['backend'], 'local')
        self.assertEqual(config['gateway']['platforms'], {})
        self.assertIsNone(config['fallback_model'])
        self.assertEqual(config['mcp_servers'], {})
        self.assertEqual(config['plugins']['enabled'], [])
        self.assertFalse((self.home / 'cron').exists())
        self.assertFalse((self.home / 'state.db').exists())
        self.assertEqual(sorted(p.name for p in (self.home / 'skills').iterdir()), sorted(r.SKILLS))
        for name in ('auth.json', '.env', 'config.yaml'):
            self.assertEqual(stat.S_IMODE((self.home / name).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.home.stat().st_mode), 0o700)
        self.assertEqual(before, (self.source / 'config.yaml').read_bytes())
        auth = json.loads((self.home / 'auth.json').read_text())
        self.assertEqual(set(auth['credential_pool']), {'anthropic'})
        self.assertNotIn('do-not-copy', (self.home / '.env').read_text())
        self.assertNotIn('wrong-provider', json.dumps(auth))
        self.assertNotIn('fixture-value', json.dumps(receipt))
        from dotenv import dotenv_values
        self.assertEqual(dotenv_values(self.home / '.env', interpolate=False)['ANTHROPIC_TOKEN'], 'fixture-value-$NO_EXPAND')
        self.assertIn('HERMES_ORIGIN=http://127.0.0.1:', (self.runtime / 'agent-service.env').read_text())
        self.assertFalse((self.owner / '.config/systemd').exists())
        self.assertIn('System Recovery', (self.home / 'SOUL.md').read_text())

    def test_move_does_not_move_recovery_or_runtime(self):
        receipt = self.prepare()
        moved = self.owner / '.wizard-os/agents/archimedes/home'
        moved.parent.mkdir(parents=True)
        self.source.rename(moved)
        self.assertTrue(Path(receipt['home']).is_dir())
        self.assertTrue((self.runtime / 'listener.py').is_file())
        self.assertFalse(self.source.exists())

    def test_no_acknowledgement_no_writes(self):
        with self.assertRaisesRegex(r.RecoveryError, 'acknowledgement'):
            r.prepare(self.source, self.home, self.runtime)
        self.assertFalse(self.home.exists())

    def test_preexisting_targets_are_never_overwritten(self):
        self.home.mkdir()
        (self.home / 'keep').write_text('owner state')
        with self.assertRaisesRegex(r.RecoveryError, 'exists'):
            self.prepare()
        self.assertEqual((self.home / 'keep').read_text(), 'owner state')

    def test_targets_inside_source_or_managed_agents_refused(self):
        for target in (self.source / 'profiles/recovery', self.owner / '.wizard-os/agents/recovery/home'):
            with self.subTest(target=target), self.assertRaises(r.RecoveryError):
                r.prepare(self.source, target, self.runtime, port=self.port, acknowledge_host_access=True)
            self.assertFalse(target.exists())

    def test_symlink_and_shared_secret_refused(self):
        secret = self.source / 'auth.json'
        os.link(secret, self.root / 'alias')
        with self.assertRaisesRegex(r.RecoveryError, 'unsafe_source_file'):
            self.prepare()
        (self.root / 'alias').unlink()
        skill = self.source / 'skills/category/hermes-agent'
        (skill / 'escape').symlink_to(self.root / 'alias')
        with self.assertRaisesRegex(r.RecoveryError, 'skill_symlink'):
            self.prepare()
        self.assertFalse(self.home.exists())

    def test_unknown_provider_does_not_fallback(self):
        (self.source / 'config.yaml').write_text('model:\n  provider: unknown\n  default: unknown\n')
        with self.assertRaisesRegex(r.RecoveryError, 'explicit_credential_support'):
            self.prepare()
        self.assertFalse(self.home.exists())

    def test_failed_dependency_install_cleans_new_paths_only(self):
        def fail(*_):
            raise r.RecoveryError('fixture install failure')
        with self.assertRaisesRegex(r.RecoveryError, 'fixture install failure'):
            self.prepare(runtime_builder=fail)
        self.assertFalse(self.home.exists())
        self.assertFalse(self.runtime.exists())
        self.assertTrue(self.source.exists())

    def test_busy_port_fails_before_copy(self):
        with socket.socket() as s:
            s.bind(('127.0.0.1', self.port))
            with self.assertRaisesRegex(r.RecoveryError, 'port_in_use'):
                self.prepare()
        self.assertFalse(self.home.exists())

    def test_listener_scrubs_inherited_bot_and_profile_environment(self):
        self.prepare()
        spec = importlib.util.spec_from_file_location('recovery_listener', self.runtime / 'listener.py')
        assert spec and spec.loader
        listener = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(listener)
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': 'bad', 'HERMES_HOME': 'wrong', 'OPENAI_API_KEY': 'bad'}, clear=False):
            listener.configure(json.loads((self.runtime / 'recovery.json').read_text()))
            self.assertEqual(os.environ['HOME'], str(self.owner))
            self.assertEqual(os.environ['HERMES_HOME'], str(self.home))
            self.assertNotIn('TELEGRAM_BOT_TOKEN', os.environ)
            self.assertNotIn('OPENAI_API_KEY', os.environ)
            self.assertEqual(os.environ['ANTHROPIC_TOKEN'], 'fixture-value-$NO_EXPAND')


if __name__ == '__main__':
    unittest.main()
