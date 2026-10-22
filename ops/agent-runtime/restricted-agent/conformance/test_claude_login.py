"""Docker Compose rendering only; synthetic token, no application containers."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def render(granted=False, hosts=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('AGENT_', 'EDGE_', 'EGRESS_', 'COMPOSE_', 'CLAUDE_'))}
    env.update(AGENT_API_KEY='synthetic-api-key', EDGE_TOKEN_SHA256='0' * 64,
               CLAUDE_TOKEN_FILE='/synthetic/agent/claude.token',
               AGENT_GATEWAY_DIR='/synthetic/agent/gateway', AGENT_EDGE_UID='1000', AGENT_EDGE_GID='1000')
    args = ['docker', 'compose', '--project-name', 'claude-grant-fixture', '-f', str(ROOT / 'compose.yml')]
    if granted:
        args += ['-f', str(ROOT / 'compose.claude-token.yml')]
    with tempfile.TemporaryDirectory() as folder:
        if hosts:
            spec = importlib.util.spec_from_file_location('passthrough', ROOT / 'passthrough.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            path = Path(folder) / 'aliases.yml'
            path.write_text(module.compose_override(hosts))
            args += ['-f', str(path)]
        return json.loads(subprocess.run([*args, 'config', '--format', 'json'], env=env,
                                         capture_output=True, text=True, check=True).stdout)


class ClaudeComposeTest(unittest.TestCase):
    def test_base_has_no_login_or_token(self):
        doc = render()
        self.assertNotIn('claude-login', doc.get('volumes', {}))
        for service in doc['services'].values():
            self.assertNotIn('CLAUDE_CODE_OAUTH_TOKEN', service.get('environment', {}))
            self.assertNotIn('CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR', service.get('environment', {}))
            self.assertFalse(any(v['target'] == '/claude' for v in service.get('volumes', [])))

    def test_token_only_in_memory_config(self):
        doc = render(True)
        for service in doc['services'].values():
            self.assertNotIn('CLAUDE_CODE_OAUTH_TOKEN', service.get('environment', {}))
        agent = doc['services']['agent']
        self.assertEqual(agent['environment']['CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR'], '/run/claude-login')
        self.assertNotIn('/run/secrets/claude.token', [v['target'] for v in agent['volumes']])
        init = doc['services']['claude-init']
        self.assertEqual(init['network_mode'], 'none')
        self.assertTrue(init['read_only'])
        self.assertEqual(init['volumes'][0]['source'], '/synthetic/agent/claude.token')
        self.assertTrue(init['volumes'][0]['read_only'])
        self.assertFalse(init['volumes'][0]['bind']['create_host_path'])
        self.assertEqual(doc['volumes']['claude-session']['driver_opts']['type'], 'tmpfs')
        self.assertNotIn('claude-login', doc.get('volumes', {}))

    def test_grant_preserves_hardening(self):
        base, grant = render(), render(True)
        for name in ('edge', 'egress', 'home-init'):
            self.assertEqual(base['services'][name], grant['services'][name])
        a, b = base['services']['agent'], grant['services']['agent']
        for key in set(a) - {'environment', 'volumes', 'depends_on'}:
            self.assertEqual(a[key], b[key], key)
        self.assertEqual(a['volumes'], [v for v in b['volumes'] if v['target'] != '/run/claude-login'])
        self.assertEqual(a['depends_on'], {k: v for k, v in b['depends_on'].items() if k != 'claude-init'})
        self.assertEqual(b['user'], '10000:10000')
        self.assertEqual(b['cap_drop'], ['ALL'])
        self.assertTrue(b['read_only'])
        self.assertTrue(base['networks']['sandbox']['internal'])

    def test_default_aliases_are_exact_and_allowlisted(self):
        doc = render()
        egress = doc['services']['egress']
        aliases = set(egress['networks']['sandbox']['aliases'])
        self.assertEqual(aliases, {'api.anthropic.com', 'platform.claude.com'})
        self.assertEqual(aliases, set(egress['environment']['EGRESS_PASSTHROUGH_HOSTS'].split()))
        self.assertTrue(aliases <= set(egress['environment']['EGRESS_ALLOWLIST_HOSTS'].split()))
        self.assertNotIn('ports', egress)
        self.assertNotIn('statsig.anthropic.com', egress['environment']['EGRESS_ALLOWLIST_HOSTS'])

    def test_socket_ingress_and_provider_alias_egress_are_independent(self):
        for granted in (False, True):
            with self.subTest(granted=granted):
                services = render(granted)['services']
                edge, egress = services['edge'], services['egress']
                self.assertEqual(set(edge['networks']), {'sandbox'})
                self.assertEqual(set(egress['networks']), {'sandbox', 'uplink'})
                self.assertNotIn('ports', edge)
                self.assertNotIn('ports', egress)
                self.assertEqual(edge['environment']['EDGE_UPSTREAM_SOCKET'], '/run/agent-gateway/gateway.sock')
                self.assertEqual([v['target'] for v in edge['volumes']], ['/run/agent-gateway'])
                self.assertFalse(edge['volumes'][0]['bind']['create_host_path'])
                self.assertNotIn('volumes', egress)
                self.assertEqual(set(egress['networks']['sandbox']['aliases']),
                                 {'api.anthropic.com', 'platform.claude.com'})

    def test_custom_aliases_replace_not_merge(self):
        egress = render(hosts='platform.claude.com')['services']['egress']
        self.assertEqual(egress['networks']['sandbox']['aliases'], ['platform.claude.com'])
        self.assertEqual(egress['environment']['EGRESS_PASSTHROUGH_HOSTS'], 'platform.claude.com')
        self.assertEqual(egress['environment']['EGRESS_PASSTHROUGH_ALIASES'], 'platform.claude.com')


if __name__ == '__main__':
    unittest.main()
