"""Private provider contract; real loopback provider HTTP, fake Docker only."""
import json
import os
import secrets
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import agent_runtime as ar
from private_providers import PrivateProviders, migrate_provider


class PrivateProviderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calls, self.tokens = [], {}
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_POST(self):
                value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                test.calls.append(('POST', self.path, value))
                token = secrets.token_urlsafe(32)
                test.tokens[value['agent']] = token
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'token': token, 'relay_url': f"http://{test.app_id}-relay:8090"}).encode())

            def do_DELETE(self):
                test.calls.append(('DELETE', self.path))
                test.tokens.pop(self.path.rsplit('/', 1)[-1], None)
                self.send_response(204)
                self.end_headers()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.app_id = 'wizard-tinfoil'
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.apps = self.root / 'apps.json'
        self.entry = {'id': self.app_id, 'status': 'running', 'view': {'local': self.origin},
                      'private_inference': {'kind': 'attested-relay', 'relay_port': 8090}}
        self.apps.write_text(json.dumps({'apps': [self.entry]}))
        self.agents = ar.Agents(self.root / 'agents', apps_path=self.apps)
        self.provider = self.agents.providers
        self.provider.docker = lambda *a, **kw: subprocess.CompletedProcess(a, 0, '', '')
        self.network = patch.object(self.provider, 'network', return_value='wizard-relay-wizard-tinfoil')
        self.network.start()
        self.address_patch = patch.object(self.provider, 'addresses', return_value={'sandbox_ip': '10.251.0.19', 'relay_ip': '10.252.0.3', 'provider_ip': '10.252.0.2', 'relay_port': 8090})
        self.address_patch.start()
        self.agent = {'id': 'probe', 'privacy': 'private', 'model': {'provider': 'wizard-tinfoil', 'allowed_models': ['probe-model'], 'model': 'probe-model'},
                      'runtime': {'kind': 'container', 'app_id': 'agent-probe', 'port': 18650, 'private_client': True,
                                  'network': {'uplink': '10.250.0.16/28', 'sandbox': '10.251.0.16/28'}}}

    def tearDown(self):
        self.network.stop()
        self.address_patch.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def test_legacy_ids_migrate_only_at_read(self):
        self.assertEqual(migrate_provider('tinfoil'), 'wizard-tinfoil')
        self.assertEqual(migrate_provider('local'), 'wizard-local-model')
        self.assertEqual(migrate_provider('another-app'), 'another-app')

    def test_mint_rotate_revoke_real_http_and_token_outside_home(self):
        link = self.provider.prepare(self.agent)
        target = Path(link['token_file'])
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o400)
        self.assertEqual(target.parent, self.root / 'agents/probe/runtime')
        self.assertEqual(target.read_text(), self.tokens['probe'])
        old = target.read_text()
        self.provider.prepare(self.agent)
        self.assertNotEqual(target.read_text(), old)
        self.provider.revoke(self.agent)
        self.assertFalse(target.exists())
        self.assertFalse(self.tokens)
        self.assertEqual([c[0] for c in self.calls], ['POST', 'POST', 'DELETE'])

    def test_stopped_provider_is_unavailable_without_mint(self):
        self.entry['status'] = 'stopped'
        self.apps.write_text(json.dumps({'apps': [self.entry]}))
        with self.assertRaises(ar.RuntimeFailure) as error:
            self.provider.prepare(self.agent)
        self.assertEqual(error.exception.code, 'private_provider_unavailable')
        self.assertEqual(self.calls, [])

    def test_missing_provider_no_public_fallback(self):
        self.apps.write_text('{"apps":[]}')
        with self.assertRaises(ar.RuntimeFailure):
            self.provider.prepare(self.agent)
        self.assertEqual(self.calls, [])

    def test_switch_revokes_original_before_mint(self):
        self.provider.prepare(self.agent)
        self.app_id = 'other-local-app'
        self.entry['id'] = self.app_id
        self.entry['private_inference']['kind'] = 'local'
        self.apps.write_text(json.dumps({'apps': [self.entry]}))
        self.agent['model']['provider'] = self.app_id
        link = self.provider.prepare(self.agent)
        self.assertEqual(link['kind'], 'local')
        self.assertEqual([c[0] for c in self.calls], ['POST', 'DELETE', 'POST'])

    def test_revoke_after_uninstall_uses_saved_control_origin(self):
        self.provider.prepare(self.agent)
        self.apps.write_text('{"apps":[]}')
        self.provider.revoke(self.agent)
        self.assertFalse(self.tokens)

    def test_mint_rejects_arbitrary_relay_origin_and_revokes_token(self):
        real = self.provider.request
        self.provider.request = lambda app, method, path, body=None: ({'token': secrets.token_urlsafe(32), 'relay_url': 'http://evil:8090'}
                                                                    if method == 'POST' else real(app, method, path, body))
        with self.assertRaises(ar.RuntimeFailure) as error:
            self.provider.prepare(self.agent)
        self.assertEqual(error.exception.code, 'private_provider_response_invalid')
        self.assertFalse((self.root / 'agents/probe/runtime/relay-token').exists())
        self.assertEqual(self.calls[-1][0], 'DELETE')

    def test_compose_both_driver_service_names_have_no_egress_or_provider_key(self):
        link = self.provider.prepare(self.agent)
        for main in ['agent-probe', 'agent']:
            with self.subTest(main=main):
                doc = json.loads(ar.compose_doc(self.agent, image=ar.DEFAULT_IMAGE, proxy_image=ar.CLIENT_IMAGE,
                                               home_source='/isolated/home', uid=os.getuid(), gid=os.getgid(), ports=True,
                                               private_link=link, main_service=main))
                self.assertEqual(set(doc['services']), {main, 'agent-probe-client', 'agent-probe-edge'})
                hermes, client = doc['services'][main], doc['services']['agent-probe-client']
                self.assertEqual(list(hermes['networks']), ['sandbox'])
                self.assertNotIn('ports', hermes)
                self.assertEqual(list(client['networks']), ['sandbox', 'relay'])
                self.assertEqual(client['environment']['PROFILE'], 'tinfoil')
                self.assertEqual(client['environment']['RELAY_TOKEN_FILE'], '/run/wizard/relay-token')
                self.assertEqual(client['user'], '1000:1000')
                self.assertTrue(client['read_only'])
                self.assertTrue(doc['networks']['sandbox']['internal'])
                self.assertEqual(doc['networks']['relay'], {'external': True, 'name': link['network']})
                self.assertNotIn('TINFOIL_API_KEY', json.dumps(doc))
                self.assertNotIn(self.tokens['probe'], json.dumps(doc))

    def test_local_passthrough_profile(self):
        self.entry['private_inference']['kind'] = 'local'
        self.apps.write_text(json.dumps({'apps': [self.entry]}))
        from private_providers import client_service
        self.assertEqual(client_service(self.provider.prepare(self.agent), ar.CLIENT_IMAGE)['environment']['PROFILE'], 'passthrough')

    def test_deprecated_key_file_is_never_read_or_copied(self):
        key = self.root / 'deprecated.env'
        key.write_text('TINFOIL_API_KEY=fixture-never-copy\n')
        agents = ar.Agents(self.root / 'agents', key, self.apps)
        home = agents.home('probe')
        home.mkdir(parents=True)
        (home / '.env').write_text('API_SERVER_KEY=agent-own\nTINFOIL_API_KEY=legacy-fixture\n')
        agents.add_provider_keys(self.agent)
        self.assertEqual((home / '.env').read_text(), 'API_SERVER_KEY=agent-own\n')
        self.assertEqual(agents.tinfoil_key(), '')

    def test_network_creates_internal_reserved_subnet_and_attaches_alias(self):
        self.network.stop()
        calls, created, attached = [], [], []
        name = 'wizard-relay-wizard-tinfoil'
        doc = {'Internal': True, 'EnableIPv6': False, 'Labels': {'wizard.private-provider': self.app_id},
               'Options': {'com.docker.network.bridge.inhibit_ipv4': 'true'}, 'IPAM': {'Config': [{'Subnet': '10.252.0.0/24'}]}}
        def engine(args, **kwargs):
            calls.append(args)
            code, value = 0, ''
            if args[:2] == ['network', 'inspect']:
                code, value = (0, json.dumps([doc])) if created else (1, '')
            elif args[:2] == ['network', 'create']:
                created.append(True)
            elif args[0] == 'ps':
                value = 'provider-container\n'
            elif args[0] == 'inspect':
                value = json.dumps([{'NetworkSettings': {'Networks': {name: {'Aliases': [self.app_id + '-relay']}} if attached else {}}}])
            elif args[:2] == ['network', 'connect']:
                attached.append(True)
            return subprocess.CompletedProcess(args, code, value, '')
        self.provider.docker = engine
        self.assertEqual(self.provider.network(self.entry), name)
        create = next(c for c in calls if c[:2] == ['network', 'create'])
        self.assertIn('--internal', create)
        self.assertEqual(create[create.index('--subnet') + 1], '10.252.0.0/24')
        self.assertIn(['network', 'connect', '--alias', self.app_id + '-relay', name, 'provider-container'], calls)

    def test_unsafe_existing_relay_network_is_refused(self):
        self.network.stop()
        self.provider.docker = lambda args, **kwargs: subprocess.CompletedProcess(args, 0, json.dumps([{'Internal': False}]), '')
        with self.assertRaises(ar.RuntimeFailure) as error:
            self.provider.network(self.entry)
        self.assertEqual(error.exception.code, 'relay_network_unsafe')

    def test_firewall_helper_has_no_token_and_only_host_netadmin(self):
        calls = []
        self.provider.docker = lambda args, **kwargs: calls.append(args)
        self.provider.firewall(self.agent, {'sandbox_ip': '10.251.0.19', 'relay_ip': '10.252.0.3', 'provider_ip': '10.252.0.2', 'relay_port': 8090})
        self.assertNotIn('--privileged', calls[0])
        self.assertIn('NET_ADMIN', calls[0])
        self.assertIn('host', calls[0])
        self.assertNotIn('relay-token', json.dumps(calls))
        script = (Path(__file__).parent / 'private-client-firewall.sh').read_text()
        self.assertIn('--ctstate ESTABLISHED,RELATED -j ACCEPT', script)
        self.assertIn('-d "$PROVIDER" -p tcp --dport "$PORT" -j ACCEPT', script)
        self.assertIn('-A "$CHAIN" -j DROP', script)

    def test_both_runtime_drivers_dispatch_private_without_fallback(self):
        for driver in [object(), object()]:
            sealed = object()
            self.assertIs(ar.driver_for(self.agent, driver, sealed), sealed)
            with self.assertRaises(ar.RuntimeFailure):
                ar.driver_for(self.agent, driver, None)


if __name__ == '__main__':
    unittest.main()
