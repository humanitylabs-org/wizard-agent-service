#!/usr/bin/env python3
"""Isolated regression for the historical bridge drop-in shadow and deploy wiring."""
import importlib.util
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load('bridge_activation', ROOT / 'ops/activate-heavy-bridge.py')
deploy = load('service_deploy', ROOT / 'ops/wizard-agent-service-deploy.py')


class BridgeActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bridge-activation-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.folder = self.home / '.config/systemd/user/wizard-heavy-rpc.service.d'
        self.folder.mkdir(parents=True)
        self.old = self.home / 'was-old'
        self.new = self.home / 'was-new'
        for release in (self.old, self.new):
            (release / 'server').mkdir(parents=True)
            (release / 'server/heavy-rpc-server.mjs').touch()
        self.command = ['/bin/node', str(self.old) + bridge.SCRIPT]
        for name in ('99-heavy-multihost.conf', 'agent-relay.conf'):
            (self.folder / name).write_text('[Service]\nEnvironment=KEEP_ME=yes\nExecStart=\nExecStart=' + ' '.join(self.command) + '\n')
        self.calls = []
        self.ignore_reload = False
        self.patches = [patch.object(Path, 'home', return_value=self.home),
                        patch.object(bridge, 'systemctl', side_effect=self.manager)]
        for p in self.patches:
            p.start(); self.addCleanup(p.stop)

    def manager(self, *args):
        self.calls.append(args)
        if args[0] == 'show':
            if 'DropInPaths' in args:
                return ' '.join(str(p) for p in sorted(self.folder.glob('*.conf')))
            return '{ path=/bin/node ; argv[]=' + ' '.join(self.command) + ' ; ignore_errors=no ; }'
        if args[0] == 'daemon-reload' and not self.ignore_reload:
            for p in sorted(self.folder.glob('*.conf')):
                for line in p.read_text().splitlines():
                    if line.startswith('ExecStart=') and line != 'ExecStart=':
                        self.command = shlex.split(line.split('=', 1)[1])
        return 'active' if args[0] == 'is-active' else ''

    def test_retargets_agent_relay_after_numeric_override_and_checks_effective_command(self):
        bridge.activate(self.new)
        self.assertEqual(self.command, ['/bin/node', str(self.new) + bridge.SCRIPT])
        for p in self.folder.glob('*.conf'):
            self.assertNotIn(str(self.old), p.read_text())
        self.assertIn('KEEP_ME=yes', (self.folder / 'agent-relay.conf').read_text())
        bridge.activate(self.new, check_only=True)
        self.assertEqual(self.calls.count(('restart', bridge.UNIT)), 1)

    def test_check_only_refuses_stale_effective_execstart_without_writes(self):
        before = {p: p.read_bytes() for p in self.folder.glob('*')}
        with self.assertRaisesRegex(RuntimeError, 'mismatch'):
            bridge.activate(self.new, check_only=True)
        self.assertEqual(before, {p: p.read_bytes() for p in self.folder.glob('*')})
        self.assertNotIn(('restart', bridge.UNIT), self.calls)

    def test_stale_manager_after_reload_fails_and_restores_dropins(self):
        before = {p: p.read_bytes() for p in self.folder.glob('*')}
        self.ignore_reload = True
        with self.assertRaisesRegex(RuntimeError, 'mismatch'):
            bridge.activate(self.new)
        self.assertEqual(before, {p: p.read_bytes() for p in self.folder.glob('*')})
        self.assertEqual(self.command[1], str(self.old) + bridge.SCRIPT)

    def test_rollback_retargets_bridge_even_when_old_release_has_no_helper(self):
        bridge.activate(self.new)
        bridge.activate(self.old)
        bridge.activate(self.old, check_only=True)
        self.assertEqual(self.command[1], str(self.old) + bridge.SCRIPT)

    def test_idle_gate_reads_queue_without_mutating_existing_jobs(self):
        import json
        import sqlite3
        path = self.home / '.hermes/state/wizard-mobile/heavy.sqlite3'
        path.parent.mkdir(parents=True)
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE heavy_jobs(id TEXT,data TEXT)')
        for state in ('queued', 'running', 'cancellation_pending', 'submitting'):
            db.execute('DELETE FROM heavy_jobs')
            db.execute('INSERT INTO heavy_jobs VALUES (?,?)', ('existing', json.dumps({'state': state})))
            db.commit()
            before = path.read_bytes()
            with patch.object(deploy, 'HOME', self.home):
                with self.assertRaisesRegex(RuntimeError, 'heavy queue not idle'):
                    deploy.require_heavy_idle()
            self.assertEqual(path.read_bytes(), before)
        db.execute('DELETE FROM heavy_jobs'); db.commit()
        with patch.object(deploy, 'HOME', self.home):
            deploy.require_heavy_idle()
        db.close()

    def test_normal_deploy_requires_activation_and_effective_check(self):
        helper = ROOT / 'ops/activate-heavy-bridge.py'
        with patch.object(deploy, 'run', return_value='loaded') as run:
            deploy.activate_bridge(self.new, ROOT)
        self.assertEqual(run.call_args_list[-2].args[1:], (str(helper), str(self.new)))
        self.assertEqual(run.call_args_list[-1].args[1:], (str(helper), str(self.new), '--check-only'))
        with patch.object(deploy, 'run', return_value='loaded'):
            with self.assertRaisesRegex(RuntimeError, 'missing bridge activation'):
                deploy.activate_bridge(self.new, self.old)


if __name__ == '__main__':
    unittest.main()
