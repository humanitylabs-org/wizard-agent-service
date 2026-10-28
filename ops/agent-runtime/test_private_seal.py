import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar
import private_seal as seal


def fixture():
    return {'id': 'synthetic', 'privacy': 'private', 'model': {'provider': 'tinfoil'},
            'runtime': {'app_id': 'agent-synthetic', 'port': 18650,
                        'network_policy': seal.POLICY,
                        'sealed_networks': {'agent': '10.246.91.0/28', 'provider': '10.247.91.0/28'}}}


def compose(agent):
    return json.loads(ar.compose_doc(agent, image='stock-hermes', proxy_image=ar.DEFAULT_PROXY_IMAGE,
                                    home_source='/synthetic', uid=1000, gid=1000, ports=True))


class PrivateSealTests(unittest.TestCase):
    def test_explicit_opt_in_only(self):
        agent = fixture(); del agent['runtime']['network_policy']
        doc = compose(agent)
        self.assertNotIn('networks', doc)
        self.assertEqual(doc['services']['agent-synthetic']['ports'], ['127.0.0.1:18650:8642'])

    def test_unknown_or_unsupported_policy_fails_closed(self):
        for field, value in [('privacy', 'standard'), ('model', {'provider': 'anthropic'})]:
            agent = fixture(); agent[field] = value
            with self.assertRaises(ar.RuntimeFailure): compose(agent)
        agent = fixture(); agent['runtime']['network_policy'] = 'typo'
        with self.assertRaises(ar.RuntimeFailure): compose(agent)

    def test_subnets_are_explicit_narrow_and_reserved(self):
        for bad in ['0.0.0.0/0', '10.246.91.0/24', '10.246.91.1/28', '::/0', '192.168.0.0/28']:
            agent = fixture(); agent['runtime']['sealed_networks']['agent'] = bad
            with self.assertRaises(ar.RuntimeFailure): compose(agent)

    def test_only_edge_has_uplink_no_socket_or_data_mount(self):
        doc = compose(fixture()); services = doc['services']
        client = services['agent-synthetic']; proxy = services['agent-synthetic-tinfoil']
        self.assertEqual(client['volumes'], ['/synthetic:/opt/data'])
        self.assertEqual(client['ports'], [])
        self.assertEqual(list(client['networks']), ['agent-synthetic-seal'])
        self.assertEqual(client['dns'], ['127.0.0.1'])
        self.assertNotIn('NET_ADMIN', client['cap_add'])
        self.assertNotIn('NET_RAW', client['cap_add'])
        for name in client['networks']:
            self.assertTrue(doc['networks'][name]['internal'])
            self.assertEqual(doc['networks'][name]['driver_opts']['com.docker.network.bridge.inhibit_ipv4'], 'true')
        self.assertEqual(set(proxy['networks']), {'agent-synthetic-seal', 'agent-synthetic-provider'})
        self.assertEqual(proxy['environment']['HTTPS_PROXY'], 'http://10.247.91.3:3128')
        edge = services['agent-synthetic-edge']
        self.assertNotIn('volumes', edge)
        self.assertEqual(edge['ports'], ['127.0.0.1:18650:8642'])
        self.assertEqual(json.loads(edge['environment']['ALLOWED_HOSTS']), list(seal.HOSTS))
        self.assertEqual(json.loads(edge['environment']['INGRESS_ROUTES']), [[8642, '10.246.91.2', 8642]])
        self.assertEqual(services['agent-synthetic-search']['network_mode'], 'service:agent-synthetic-tinfoil')
        self.assertEqual(services['agent-synthetic-search']['command'][1], '10.246.91.3')

    def test_unrehearsed_installed_recipe_is_not_silently_migrated(self):
        driver = object.__new__(ar.RuntipiDriver); rt = Mock()
        with self.assertRaises(ar.RuntimeFailure) as caught: driver._override(fixture(), rt)
        self.assertEqual(caught.exception.code, 'private_sealed_recipe_not_admitted')
        rt.req.assert_not_called()
        driver.agents = Mock(); driver.cli = Mock()
        for action in ('apply','start'):
            with self.assertRaises(ar.RuntimeFailure):getattr(driver,action)(fixture())
        driver.agents.add_provider_keys.assert_not_called()
        driver.cli.Config.assert_not_called()


if __name__ == '__main__': unittest.main()
