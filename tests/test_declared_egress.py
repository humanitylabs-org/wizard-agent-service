#!/usr/bin/env python3
"""Policy, fixed-relay argv and scoped-firewall regressions; never touches host rules."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

RUNTIME = Path(__file__).resolve().parents[1] / 'ops/agent-runtime'
sys.path.insert(0, str(RUNTIME))
import declared_egress as d
import agent_runtime as rt

ENTRY = {'alias': 'builder', 'address': '100.100.100.100', 'port': 22, 'relay_port': 18222}
RECORD = {'id': 'fixture', 'imported': {'schema': 1}, 'model': {'provider': 'anthropic'},
          'runtime': {'isolation': 'restricted', 'port': 18721,
                      'network': {'uplink': '10.250.0.16/28', 'sandbox': '10.251.0.16/28'}, 'declared_tcp': [ENTRY]}}


class DeclaredTests(unittest.TestCase):
    def test_policy_and_fixed_no_shell_argv(self):
        entry, net = d.declaration(RECORD, 'builder')
        self.assertEqual(str(net.network_address + 1), '10.250.0.17')
        self.assertEqual(d.argv('/owner/tailscale', '/owner/socket', entry),
                         ['/owner/tailscale', '--socket=/owner/socket', 'nc', '100.100.100.100', '22'])
        for alias in ('other', '*', 'builder:23'):
            with self.assertRaises(ValueError):
                d.declaration(RECORD, alias)
        for field, value in [('address', '127.0.0.1'), ('address', '10.0.0.1'), ('port', 443),
                             ('port', True), ('alias', '*.builder'), ('relay_port', 22)]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                d.validate([dict(ENTRY, **{field: value})])
        for value in ('10.250.0.0/16', '10.251.0.16/28', '127.0.0.0/28'):
            with self.assertRaises(ValueError):
                d.network(value)

    def test_import_only_and_env_is_exact(self):
        agents = Mock()
        agents.secret.return_value = 'fixture-nonsecret'
        driver = rt.RestrictedDriver(agents, rt.RESTRICTED_DIR, 'fixture:image', 8929)
        env = driver.env(RECORD)
        self.assertEqual(json.loads(env['EGRESS_DECLARED_TCP']), [ENTRY])
        self.assertEqual(env['EGRESS_TCP_RELAY_HOST'], '10.250.0.17')
        record = copy.deepcopy(RECORD)
        record['runtime'].pop('declared_tcp')
        self.assertEqual(driver.env(record)['EGRESS_DECLARED_TCP'], '[]')
        record = copy.deepcopy(RECORD)
        record.pop('imported')
        with self.assertRaisesRegex(rt.RuntimeFailure, 'declared_tcp_import_required'):
            driver.env(record)

    def test_old_image_fails_before_any_start(self):
        agents = Mock()
        agents.secret.return_value = 'fixture-nonsecret'
        driver = rt.RestrictedDriver(agents, rt.RESTRICTED_DIR, 'fixture:image', 8929)
        with patch.object(rt, 'docker', return_value=Mock(stdout='old hash')) as docker:
            with self.assertRaisesRegex(rt.RuntimeFailure, 'declared_tcp_image_mismatch'):
                driver._prepare(RECORD)
        self.assertEqual(docker.call_count, 1)
        self.assertIn('none', docker.call_args.args[0])
        self.assertNotIn('compose', docker.call_args.args[0])

    def test_scoped_firewall_add_check_remove_and_invalid_inputs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            state, log = root / 'state', root / 'log'
            fake = root / 'iptables'
            fake.write_text('#!' + sys.executable + '\n' + '''import json,os,sys
from pathlib import Path
a=sys.argv[1:]; p=Path(os.environ['FAKE_FW_STATE']); log=Path(os.environ['FAKE_FW_LOG'])
with log.open('a') as f: f.write(json.dumps(a)+'\\n')
if a[:2]==['-C','INPUT']: sys.exit(0)
if a[0]=='-C': sys.exit(0 if p.exists() else 1)
if a[0]=='-I': p.touch(); sys.exit(0)
if a[0]=='-D': p.unlink(); sys.exit(0)
sys.exit(2)
''')
            fake.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'],
                       FAKE_FW_STATE=str(state), FAKE_FW_LOG=str(log))
            def run(action, subnet='10.250.0.16/28', port='18222'):
                return subprocess.run(['sh', str(RUNTIME / 'agent-firewall.sh'), action, subnet, port],
                                      capture_output=True, text=True, env=env)
            self.assertEqual(run('declared-add').returncode, 0)
            self.assertEqual(run('declared-add').returncode, 0)
            self.assertEqual(run('declared-check').returncode, 0)
            self.assertEqual(run('declared-remove').returncode, 0)
            self.assertNotEqual(run('declared-check').returncode, 0)
            commands = [json.loads(x) for x in log.read_text().splitlines()]
            changes = [x for x in commands if x[0] in ('-I', '-D')]
            self.assertEqual(len(changes), 2)
            for args in changes:
                self.assertEqual(args[1], 'WIZARD-AGENTS')
                self.assertEqual(args[args.index('-s') + 1], '10.250.0.16/28')
                self.assertEqual(args[args.index('-d') + 1], '10.250.0.17/32')
                self.assertEqual(args[args.index('--dport') + 1], '18222')
            before = log.read_text()
            for subnet, port in [('10.250.0.0/16', '18222'), ('10.251.0.16/28', '18222'),
                                 ('10.250.0.17/28', '18222'), ('10.250.0.16/28', '22'),
                                 ('10.250.0.16/28', '018222'), ('10.250.0.16/28', '18222; id')]:
                self.assertNotEqual(run('declared-add', subnet, port).returncode, 0)
            self.assertEqual(log.read_text(), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
