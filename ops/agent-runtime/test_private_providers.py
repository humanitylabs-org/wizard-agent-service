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

            def owner_write(self):
                if self.headers.get('Origin') != test.origin or self.headers.get('X-Wizard-Request') != '1':
                    self.send_response(403); self.end_headers(); return False
                return True

            def do_POST(self):
                if not self.owner_write(): return
                value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                test.calls.append(('POST', self.path, value))
                token = secrets.token_urlsafe(32)
                test.tokens[value['agent']] = token
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'token': token, 'relay_url': f"http://{test.app_id}-relay:8090"}).encode())

            def do_DELETE(self):
                if not self.owner_write(): return
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
                      'private_inference': {'kind': 'attested-relay', 'relay_port': 8090, 'egress': ['inference.tinfoil.sh', 'atc.tinfoil.sh']}}
        self.apps.write_text(json.dumps({'apps': [self.entry]}))
        self.agents = ar.Agents(self.root / 'agents', apps_path=self.apps)
        self.provider = self.agents.providers
        self.image_patch = patch.object(self.provider, 'require_client_image')
        self.image_patch.start()
        self.provider.docker = lambda *a, **kw: subprocess.CompletedProcess(a, 0, '', '')
        self.network = patch.object(self.provider, 'network', return_value='wzpr-probe')
        self.network.start()
        self.egress_patch = patch('private_providers.ProviderEgress.reconcile')
        self.egress_patch.start()
        self.cleanup_patch = patch.object(self.provider, 'remove_network')
        self.cleanup_patch.start()
        self.address_patch = patch.object(self.provider, 'addresses', return_value={'sandbox_ip': '10.251.0.19', 'relay_ip': '10.252.0.3', 'provider_ip': '10.252.0.2', 'relay_port': 8090})
        self.address_patch.start()
        self.agent = {'id': 'probe', 'privacy': 'private', 'model': {'provider': 'wizard-tinfoil', 'allowed_models': ['probe-model'], 'model': 'probe-model'},
                      'runtime': {'kind': 'container', 'app_id': 'agent-probe', 'port': 18650, 'private_client': True,
                                  'network': {'uplink': '10.250.0.16/28', 'sandbox': '10.251.0.16/28'}}}

    def tearDown(self):
        self.network.stop()
        self.image_patch.stop()
        self.cleanup_patch.stop()
        self.egress_patch.stop()
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
        commands = []
        self.provider.docker = lambda args, **kw: (commands.append(args), subprocess.CompletedProcess(args, 0, '', ''))[1]
        link = self.provider.prepare(self.agent)
        helper = commands[0]
        self.assertTrue(helper[helper.index('-v') + 1].endswith(':/relay-token'))
        self.assertNotIn(':/tokens', ' '.join(helper))
        self.assertEqual(helper[-1], 'chown 1000:1000 /relay-token')
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
        self.entry['private_inference']['egress'] = []
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
        self.entry['private_inference']['egress'] = []
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
        name = self.provider.network_name(self.agent)
        doc = {'Name': name, 'Driver': 'bridge', 'Internal': True, 'EnableIPv6': False, 'Labels': {'wizard.private-provider': self.app_id, 'wizard.private-agent': self.agent['id']},
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
        self.assertEqual(self.provider.network(self.entry, self.agent), name)
        create = next(c for c in calls if c[:2] == ['network', 'create'])
        self.assertIn('--internal', create)
        self.assertEqual(create[create.index('--subnet') + 1], '10.252.0.0/24')
        self.assertIn(['network', 'connect', '--alias', self.app_id + '-relay', name, 'provider-container'], calls)

    def test_boot_reconciles_each_linked_agent_and_reports_failure(self):
        folder = self.agents.root / self.agent['id']
        folder.mkdir(parents=True)
        (folder / 'agent.json').write_text(json.dumps(self.agent))
        with patch.object(self.provider, 'network') as network:
            self.assertEqual(self.provider.reconcile_installed(), [])
            network.assert_called_once_with(self.entry, self.agent)
        with patch.object(self.provider, 'network', side_effect=ar.RuntimeFailure('egress_blocked',409)):
            self.assertEqual(self.provider.reconcile_installed(), [{'app':'wizard-tinfoil','error':'egress_blocked'}])

    def test_unsafe_existing_relay_network_is_refused(self):
        self.network.stop()
        self.provider.docker = lambda args, **kwargs: subprocess.CompletedProcess(args, 0, json.dumps([{'Internal': False}]), '')
        with self.assertRaises(ar.RuntimeFailure) as error:
            self.provider.network(self.entry, self.agent)
        self.assertEqual(error.exception.code, 'relay_network_unsafe')

    def test_addresses_uses_full_docker_id_and_fails_closed_on_missing_peer(self):
        self.address_patch.stop()
        cid = 'a' * 64
        network = 'wizard-relay-wizard-tinfoil'
        doc = {'IPAM': {'Config': [{'Subnet': '10.252.0.0/24'}]},
               'Containers': {cid: {'IPv4Address': '10.252.0.2/24'}}}
        (self.agents.root / 'probe/runtime').mkdir(parents=True)
        def engine(args, **kwargs):
            if args[0] == 'ps':
                self.assertIn('--no-trunc', args)
                result = cid
            else:
                result = json.dumps([doc])
            return subprocess.CompletedProcess(args, 0, result, '')
        self.provider.docker = engine
        self.assertEqual(self.provider.addresses(self.agent, self.entry, network)['provider_ip'], '10.252.0.2')
        doc['Containers'] = {}
        with self.assertRaises(ar.RuntimeFailure) as error:
            self.provider.addresses(self.agent, self.entry, network)
        self.assertEqual(error.exception.code, 'relay_network_attach_failed')

    def test_relay_identity_is_per_agent_not_provider(self):
        self.assertNotEqual(self.provider.network_name(self.agent), self.provider.network_name({'id':'other'}))
        self.assertTrue(self.provider.network_name(self.agent).startswith('wzpr-'))

    def test_client_binds_api_only_to_its_sandbox_interface(self):
        from private_providers import client_service
        link = self.provider.prepare(self.agent)
        self.assertEqual(client_service(link, ar.CLIENT_IMAGE)['environment']['LISTEN_HOST'], link['sandbox_ip'])
        self.assertNotIn('NET_ADMIN', json.dumps(client_service(link, ar.CLIENT_IMAGE)))

    def test_network_rejects_another_agent_and_unknown_peers(self):
        name = self.provider.network_name(self.agent)
        value = {'Name':name,'Driver':'bridge','Internal':True,'EnableIPv6':False,
                 'Labels':{'wizard.private-provider':self.app_id,'wizard.private-agent':self.agent['id']},
                 'Options':{'com.docker.network.bridge.inhibit_ipv4':'true'},
                 'IPAM':{'Config':[{'Subnet':'10.252.1.0/24'}]},'Containers':{'peer':{}}}
        for service, project in [('agent-other-client','agent-other'), ('agent-probe-client','wrong')]:
            self.provider.docker = lambda *a, **kw: subprocess.CompletedProcess(a,0,json.dumps([{'Config':{'Labels':{'com.docker.compose.service':service,'com.docker.compose.project':project}}}]),'')
            with self.assertRaises(ar.RuntimeFailure) as e: self.provider.validate_network(value,self.entry,self.agent)
            self.assertEqual(e.exception.code,'relay_network_unexpected_peer')
        value['Containers'] = {}
        value['Labels']['wizard.private-agent'] = 'other'
        with self.assertRaises(ar.RuntimeFailure): self.provider.validate_network(value,self.entry,self.agent)

    def test_revoke_removes_exact_per_agent_network(self):
        self.provider.prepare(self.agent)
        self.provider.revoke(self.agent)
        self.provider.remove_network.assert_called_once_with(self.provider.network_name(self.agent), 'probe', self.app_id)

    def test_orphan_cleanup_removes_only_owned_client_and_provider_attachment(self):
        self.cleanup_patch.stop()
        name = self.provider.network_name(self.agent)
        value = {'Name':name,'Driver':'bridge','Internal':True,'EnableIPv6':False,
                 'Labels':{'wizard.private-provider':self.app_id,'wizard.private-agent':self.agent['id']},
                 'Options':{'com.docker.network.bridge.inhibit_ipv4':'true'},
                 'IPAM':{'Config':[{'Subnet':'10.252.0.0/24'}]},'Containers':{'provider':{},'client':{}}}
        calls = []
        def docker(args, **kw):
            calls.append(args)
            if args[:2] == ['network','inspect']: result = [value]
            elif args[:2] == ['inspect','provider']:
                result = [{'Config':{'Labels':{'com.docker.compose.service':self.app_id}}}]
            elif args[:2] == ['inspect','client']:
                result = [{'Config':{'Labels':{'com.docker.compose.service':'agent-probe-client','com.docker.compose.project':'agent-probe'}}}]
            else: result = []
            return subprocess.CompletedProcess(args,0,json.dumps(result),'')
        self.provider.docker = docker
        self.provider.remove_network(name, 'probe', self.app_id)
        self.assertIn(['network','disconnect','-f',name,'provider'], calls)
        self.assertIn(['rm','-f','client'], calls)
        self.assertIn(['network','rm',name], calls)
        self.assertNotIn(['rm','-f','provider'], calls)

    def test_older_client_images_fail_before_network_or_token_work(self):
        self.image_patch.stop()
        self.provider.docker = lambda args, **kw: subprocess.CompletedProcess(args,0,json.dumps([{'Config':{'Labels':{'wizard.private-client.sandbox-bind':'v1'}}}]),'')
        self.provider.require_client_image()
        for value in ([{'Config':{'Labels':{}}}], [], [{'Config':{'Labels':{'wizard.private-client.sandbox-bind':'v0'}}}]):
            self.provider.docker = lambda args, **kw: subprocess.CompletedProcess(args,0,json.dumps(value),'')
            with self.assertRaises(ar.RuntimeFailure) as error:
                self.provider.prepare(self.agent)
            self.assertEqual(error.exception.code,'private_client_image_unsafe')
        self.provider.network.assert_not_called()

    def test_private_runtime_has_no_bridge_firewall_dependency(self):
        text = (Path(__file__).parent / 'agent_runtime.py').read_text()
        self.assertNotIn('providers.firewall', text)
        self.assertNotIn('private-firewall', text)

    def test_both_runtime_drivers_dispatch_private_without_fallback(self):
        for driver in [object(), object()]:
            sealed = object()
            self.assertIs(ar.driver_for(self.agent, driver, sealed), sealed)
            with self.assertRaises(ar.RuntimeFailure):
                ar.driver_for(self.agent, driver, None)


if __name__ == '__main__':
    unittest.main()
