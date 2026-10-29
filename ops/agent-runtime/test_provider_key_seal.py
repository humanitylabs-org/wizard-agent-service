"""Round 10: provider-only key location and scoped gateway for the sealed seal.

Synthetic values only. The injector is exercised over real loopback sockets.
"""
import asyncio
import copy
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import agent_runtime as ar  # noqa: E402
import private_seal as seal  # noqa: E402

spec = importlib.util.spec_from_file_location('provider_key_injector', HERE / 'provider-key-injector.py')
inj = importlib.util.module_from_spec(spec); spec.loader.exec_module(inj)
SYNTHETIC_KEY = 'synthetic-provider-key-r10-' + 'x' * 16


def fixture(**runtime):
    agent = {'id': 'synthetic', 'privacy': 'private', 'model': {'provider': 'tinfoil'},
             'runtime': {'app_id': 'agent-synthetic', 'port': 18650, 'network_policy': seal.POLICY,
                         'provider_key_location': 'provider',
                         'sealed_networks': {'agent': '10.246.91.0/28', 'provider': '10.247.91.0/28',
                                             'keyed': '10.248.91.0/28'}}}
    agent['runtime'].update(runtime)
    return agent


KEYDIR = Path(tempfile.mkdtemp(prefix='r10-service-'))
SERVICE_KEY = KEYDIR / 'tinfoil.key'
SERVICE_KEY.write_text(SYNTHETIC_KEY + '\n'); SERVICE_KEY.chmod(0o600)


def compose(agent, home='/srv/agents/synthetic/home', key=str(SERVICE_KEY)):
    return json.loads(ar.compose_doc(agent, image='stock-hermes', proxy_image=ar.DEFAULT_PROXY_IMAGE,
                                     home_source=home, uid=1234, gid=1234, ports=True, key_source=key))


class KeyLocationComposeTests(unittest.TestCase):
    def test_proxy_leaves_seal_and_only_injector_reaches_it(self):
        doc = compose(fixture()); s = doc['services']
        client, proxy, key = s['agent-synthetic'], s['agent-synthetic-tinfoil'], s['agent-synthetic-key']
        self.assertEqual(list(client['networks']), ['agent-synthetic-seal'])
        self.assertEqual(set(proxy['networks']), {'agent-synthetic-keyed', 'agent-synthetic-provider'})
        self.assertNotIn('agent-synthetic-seal', proxy['networks'])
        self.assertEqual(set(key['networks']), {'agent-synthetic-seal', 'agent-synthetic-keyed'})
        # Hermes' unchanged base URL now resolves to the injector on the seal.
        self.assertEqual(key['networks']['agent-synthetic-seal']['aliases'], ['agent-synthetic-tinfoil'])
        self.assertEqual(proxy['command'][proxy['command'].index('--bind') + 1], '10.248.91.2')
        search = s['agent-synthetic-search']['command']
        self.assertEqual(search[search.index('--bind') + 1], '10.248.91.4')
        search_service = s['agent-synthetic-search']
        self.assertNotIn('network_mode', search_service)
        self.assertEqual(search_service['networks'], {'agent-synthetic-keyed': {'ipv4_address':'10.248.91.4'},
                                                      'agent-synthetic-provider': {'ipv4_address':'10.247.91.4'}})
        self.assertEqual(search_service['extra_hosts'], proxy['extra_hosts'])
        self.assertEqual(search_service['dns'], ['127.0.0.1'])
        self.assertEqual(search_service['depends_on'], ['agent-synthetic-edge'])
        self.assertEqual(key['depends_on'], ['agent-synthetic-tinfoil','agent-synthetic-search'])
        self.assertEqual(json.loads(key['environment']['UPSTREAM_IPS']), {'3301':'10.248.91.2','3302':'10.248.91.4'})
        self.assertEqual(key['environment']['UPSTREAM_IP'], '10.248.91.2')
        self.assertTrue(doc['networks']['agent-synthetic-keyed']['internal'])
        # The Service's own key file, read-only, only in the injector, as its owner. No copy.
        self.assertEqual(key['volumes'], [f'{SERVICE_KEY}:/run/provider-key/key:ro'])
        self.assertEqual(key['user'], f'{os.getuid()}:{os.getgid()}')
        self.assertEqual(key['logging'], {'driver': 'none'})
        for name, svc in s.items():
            if name != 'agent-synthetic-key':
                self.assertNotIn(str(SERVICE_KEY), json.dumps(svc), name)
        self.assertNotIn('TINFOIL_API_KEY', json.dumps(doc))

    def test_unknown_location_or_missing_keyed_subnet_fails_closed(self):
        with self.assertRaises(ar.RuntimeFailure): compose(fixture(provider_key_location='hermes'))
        agent = fixture(); del agent['runtime']['sealed_networks']['keyed']
        with self.assertRaises(ar.RuntimeFailure): compose(agent)
        with self.assertRaises(ar.RuntimeFailure): compose(fixture(), home='/srv/agents/synthetic/data')
        with self.assertRaises(ar.RuntimeFailure) as caught: compose(fixture(), key='')
        with self.assertRaises(ar.RuntimeFailure) as caught: compose(fixture(), key=str(KEYDIR / 'absent'))
        self.assertEqual(caught.exception.code, 'provider_not_configured')
        # A key inside the agents tree (backup/export scope) or readable by others is refused.
        with self.assertRaises(ar.RuntimeFailure): compose(fixture(), key='/srv/agents/shared.key')
        loose = KEYDIR / 'loose.key'; loose.write_text('x\n'); loose.chmod(0o640)
        with self.assertRaises(ar.RuntimeFailure): compose(fixture(), key=str(loose))

    def test_legacy_location_is_unchanged(self):
        agent = fixture(provider_key_location='')
        doc = compose(agent)
        self.assertNotIn('agent-synthetic-key', doc['services'])
        self.assertIn('agent-synthetic-seal', doc['services']['agent-synthetic-tinfoil']['networks'])


class ScopedGatewayComposeTests(unittest.TestCase):
    def test_gateway_reuses_restricted_edge_without_tcp_service_route(self):
        doc = compose(fixture(sealed_gateway=True)); gw = doc['services']['agent-synthetic-gateway']
        self.assertEqual(gw['image'], seal.GATEWAY_IMAGE)
        self.assertEqual(gw['networks'], {'agent-synthetic-seal': {'ipv4_address': '10.246.91.5', 'aliases': ['edge']}})
        self.assertIn('/srv/agents/synthetic/gateway:/run/agent-gateway', gw['volumes'])
        self.assertIn('/srv/agents/synthetic/gateway-edge:/run/edge:ro', gw['volumes'])
        self.assertNotIn('ports', gw)
        self.assertNotIn('EDGE_TOKEN_SHA256', gw['environment'])

    def test_gateway_flag_must_be_boolean(self):
        with self.assertRaises(ar.RuntimeFailure): compose(fixture(sealed_gateway='yes'))
        self.assertNotIn('agent-synthetic-gateway', compose(fixture())['services'])


class ServiceOwnedMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='r10-key-'))
        (self.tmp / 'agents' / 'synthetic' / 'home').mkdir(parents=True)
        self.env = self.tmp / 'agents' / 'synthetic' / 'home' / '.env'
        self.env.write_text('API_SERVER_KEY=synthetic-api\nTINFOIL_API_KEY=' + SYNTHETIC_KEY + '\n')
        keyfile = self.tmp / 'tinfoil.key'; keyfile.write_text(SYNTHETIC_KEY + '\n')
        self.agents = ar.Agents(self.tmp / 'agents', keyfile)
        (self.tmp / 'agents' / 'synthetic' / 'gateway.key').write_text('synthetic-gateway-token\n')

    def test_migration_leaves_no_key_in_agent_tree_and_rollback_restores(self):
        agent = fixture(sealed_gateway=True)
        before = {p: p.read_bytes() for p in (self.tmp / 'agents').rglob('*') if p.is_file() and p.name != '.env'}
        self.agents.add_provider_keys(agent)
        self.assertNotIn(SYNTHETIC_KEY, self.env.read_text())
        self.assertIn('TINFOIL_API_KEY=' + seal.PLACEHOLDER_KEY, self.env.read_text())
        self.assertIn('API_SERVER_KEY=synthetic-api', self.env.read_text())
        # Backup/export scope: nothing anywhere under the agents root holds the key.
        for path in (self.tmp / 'agents').rglob('*'):
            if path.is_file():
                self.assertNotIn(SYNTHETIC_KEY.encode(), path.read_bytes(), path)
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)   # history/identity untouched
        digest = (self.tmp / 'agents' / 'synthetic' / 'gateway-edge' / 'token.sha256').read_text().strip()
        self.assertRegex(digest, r'^[0-9a-f]{64}$')
        self.agents.add_provider_keys(agent)
        self.assertEqual(self.env.read_text().count('TINFOIL_API_KEY='), 1)
        # Forced rollback: legacy location restores the bearer in the home only.
        self.agents.add_provider_keys(fixture(provider_key_location=''))
        self.assertIn('TINFOIL_API_KEY=' + SYNTHETIC_KEY, self.env.read_text())

    def test_missing_service_key_fails_before_home_write(self):
        self.agents.tinfoil_key_file = self.tmp / 'absent'
        before = self.env.read_text()
        with self.assertRaises(ar.RuntimeFailure) as caught: self.agents.add_provider_keys(fixture())
        self.assertEqual(caught.exception.code, 'provider_not_configured')
        self.assertEqual(self.env.read_text(), before)


class RuntipiSealedRecipeTests(unittest.TestCase):
    def driver(self, state):
        from unittest.mock import Mock
        driver = object.__new__(ar.RuntipiDriver)
        driver.image, driver.proxy_image, driver.home_mount = 'stock-hermes', ar.DEFAULT_PROXY_IMAGE, 'stock'
        driver.agents = ar.Agents(KEYDIR / 'agents', SERVICE_KEY)
        def req(method, path, payload=None):
            if method == 'PUT':
                state.update(payload)
            return dict(state)
        rt = Mock(); rt.req.side_effect = req
        return driver, rt

    def test_gate_stays_closed_until_evidence_admits(self):
        self.assertFalse(seal.RUNTIPI_ADMITTED)
        driver, rt = self.driver({})
        with self.assertRaises(ar.RuntimeFailure) as caught: driver._override(fixture(), rt)
        self.assertEqual(caught.exception.code, 'private_sealed_recipe_not_admitted')
        rt.req.assert_not_called()

    def admitted(self):
        from unittest.mock import patch
        return patch.object(seal, 'RUNTIPI_ADMITTED', True)

    def test_override_replaces_every_service_and_reads_back_exactly(self):
        state = {'dockerCompose': None, 'appEnv': 'KEEP=1\n', 'isEnabled': True}
        driver, rt = self.driver(state)
        with self.admitted(): driver._override(fixture(), rt)
        text = state['dockerCompose']
        self.assertTrue(text.startswith(seal.RUNTIPI_MARK))
        doc = driver._sealed_doc(fixture())
        for name in doc['services']:
            self.assertIn(f'  "{name}": !override ', text)
        self.assertIn('"runtipi.appurn": "agent-synthetic:wizardapps"', text)
        self.assertNotIn('tipi_main_network', text); self.assertNotIn('APP_PORT', text)
        self.assertNotIn(SYNTHETIC_KEY, text); self.assertNotIn('TINFOIL_API_KEY', text)
        self.assertEqual(state['appEnv'], 'KEEP=1\n')
        with self.admitted(): driver._override(fixture(), rt)   # restart/upgrade: idempotent
        self.assertEqual(state['dockerCompose'], text)

    def test_owner_override_or_disabled_user_config_refuses(self):
        driver, rt = self.driver({'dockerCompose': 'services: {mine: {}}\n', 'appEnv': '', 'isEnabled': True})
        with self.admitted(), self.assertRaises(ar.RuntimeFailure) as caught: driver._override(fixture(), rt)
        self.assertEqual(caught.exception.code, 'sealed_override_conflict')
        driver, rt = self.driver({'dockerCompose': None, 'appEnv': '', 'isEnabled': False})
        with self.admitted(), self.assertRaises(ar.RuntimeFailure) as caught: driver._override(fixture(), rt)
        self.assertEqual(caught.exception.code, 'sealed_override_unverified')

    def test_runtime_violations_flag_runtipi_bridges(self):
        doc = compose(fixture())
        good = {n: set((s.get('networks') or {}).keys()) for n, s in doc['services'].items()}
        self.assertEqual(seal.runtime_violations(doc, good), [])
        bad = copy.deepcopy(good); bad['agent-synthetic'].add('!runtipi_tipi_main_network')
        self.assertTrue(seal.runtime_violations(doc, bad))
        missing = copy.deepcopy(good); del missing['agent-synthetic-key']
        self.assertEqual(seal.runtime_violations(doc, missing), ['agent-synthetic-key:missing'])

    def test_unsealed_policy_cannot_render_an_override(self):
        with self.assertRaises(ValueError): seal.runtipi_override({'services': {}, 'networks': {}}, 'x:y')


class InjectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='r10-inj-'))
        self.key = self.tmp / 'key'; self.key.write_text(SYNTHETIC_KEY + '\n'); self.key.chmod(0o400)

    def run_case(self, raw, upstream=True, stream=False):
        async def case():
            seen = []
            async def up(reader, writer):
                head = await reader.readuntil(b'\r\n\r\n'); seen.append(head)
                n = int([l for l in head.split(b'\r\n') if l.lower().startswith(b'content-length:')][0].split(b':')[1])
                seen.append(await reader.readexactly(n))
                if stream:
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n')
                    for i in range(3):
                        writer.write(b'data: chunk%d\n\n' % i); await writer.drain(); await asyncio.sleep(0.01)
                else:
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
                await writer.drain(); writer.close()
            upstream_server = await asyncio.start_server(up, '127.0.0.1', 0)
            port = upstream_server.sockets[0].getsockname()[1]
            if not upstream:
                upstream_server.close(); await upstream_server.wait_closed()
            front = await asyncio.start_server(inj.handler('127.0.0.1', port, str(self.key)), '127.0.0.1', 0)
            fport = front.sockets[0].getsockname()[1]
            reader, writer = await asyncio.open_connection('127.0.0.1', fport)
            writer.write(raw); await writer.drain()
            reply = await asyncio.wait_for(reader.read(), 5)
            writer.close(); front.close()
            if upstream: upstream_server.close()
            return reply, seen
        return asyncio.run(case())

    def req(self, auth='Bearer ' + seal.PLACEHOLDER_KEY, extra=b'', body=b'{"x":1}', line=b'POST /v1/chat/completions HTTP/1.1'):
        return (line + b'\r\nHost: agent-synthetic-tinfoil:3301\r\nAuthorization: ' + auth.encode() +
                b'\r\nContent-Type: application/json\r\nX-Forwarded-For: 1.2.3.4\r\n' + extra +
                b'Content-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)

    def test_placeholder_is_replaced_and_key_never_returned(self):
        reply, seen = self.run_case(self.req())
        self.assertTrue(reply.startswith(b'HTTP/1.1 200'))
        self.assertNotIn(SYNTHETIC_KEY.encode(), reply)
        head = seen[0].decode()
        self.assertIn('Authorization: Bearer ' + SYNTHETIC_KEY, head)
        self.assertNotIn(seal.PLACEHOLDER_KEY, head)
        self.assertNotIn('X-Forwarded-For', head)
        self.assertIn('host: agent-synthetic-tinfoil:3301', head)
        self.assertEqual(seen[1], b'{"x":1}')

    def test_agent_holding_any_other_bearer_is_refused_unforwarded(self):
        for auth in ('Bearer ' + SYNTHETIC_KEY, 'Bearer other', ''):
            reply, seen = self.run_case(self.req(auth=auth))
            self.assertTrue(reply.startswith(b'HTTP/1.1 401'), auth); self.assertEqual(seen, [])

    def test_smuggling_shapes_are_refused(self):
        bad = [self.req(extra=b'Transfer-Encoding: chunked\r\n'),
               self.req(line=b'CONNECT inference.tinfoil.sh:443 HTTP/1.1'),
               self.req(line=b'POST http://evil/v1 HTTP/1.1'),
               self.req(line=b'POST /v1/../admin HTTP/1.1'),
               self.req(extra=b'Authorization: Bearer second\r\n'),
               self.req(extra=b'X-Bad: a\x0bb\r\n')]
        for raw in bad:
            reply, seen = self.run_case(raw)
            self.assertTrue(reply.startswith(b'HTTP/1.1 4'), raw[:60]); self.assertEqual(seen, [])

    def test_stopped_provider_is_prompt_502_and_stream_passes(self):
        reply, _ = self.run_case(self.req(), upstream=False)
        self.assertTrue(reply.startswith(b'HTTP/1.1 502'))
        self.assertIn(b'provider_unavailable', reply)
        reply, _ = self.run_case(self.req(), stream=True)
        self.assertIn(b'data: chunk2', reply)

    def test_silently_dropped_upstream_is_502_within_bound(self):
        """Round 10 forum: a stopped proxy's stale neighbour entry held the agent 10017 ms."""
        import time

        async def case():
            async def hang(*_a, **_k):
                await asyncio.sleep(30)
            real = inj.asyncio.open_connection
            inj.asyncio.open_connection = hang
            try:
                front = await asyncio.start_server(inj.handler('10.248.0.2', 3301, str(self.key), 0.3), '127.0.0.1', 0)
                reader, writer = await real('127.0.0.1', front.sockets[0].getsockname()[1])
                writer.write(self.req()); await writer.drain()
                t = time.monotonic()
                reply = await asyncio.wait_for(reader.read(), 5)
                writer.close(); front.close()
                return reply, time.monotonic() - t
            finally:
                inj.asyncio.open_connection = real
        reply, took = asyncio.run(case())
        self.assertTrue(reply.startswith(b'HTTP/1.1 502')); self.assertIn(b'provider_unavailable', reply)
        self.assertLess(took, 1.5)
        self.assertLessEqual(inj.CONNECT_TIMEOUT, 2.0)

    def test_unreadable_or_placeholder_key_is_503(self):
        self.key.chmod(0o600); self.key.write_text(seal.PLACEHOLDER_KEY + '\n')
        reply, seen = self.run_case(self.req())
        self.assertTrue(reply.startswith(b'HTTP/1.1 503')); self.assertEqual(seen, [])

    def test_placeholder_constant_matches(self):
        self.assertEqual(inj.PLACEHOLDER, seal.PLACEHOLDER_KEY)


if __name__ == '__main__':
    unittest.main()
