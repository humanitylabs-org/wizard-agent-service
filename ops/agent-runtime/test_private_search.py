"""Search is an extension of the legacy per-agent proxy, not an agent network migration."""
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar


class PrivateSearchTests(unittest.TestCase):
    def agent(self, privacy='private', provider='tinfoil'):
        return {'id': 'synthetic', 'privacy': privacy, 'model': {'provider': provider},
                'runtime': {'app_id': 'agent-synthetic', 'port': 18650}}

    def test_official_attested_search_has_no_independent_uplink_or_key(self):
        agent = self.agent()
        doc = json.loads(ar.compose_doc(agent, image='stock-hermes', proxy_image=ar.DEFAULT_PROXY_IMAGE,
                                       home_source='/synthetic', uid=1000, gid=1000, ports=True))
        s = doc['services']['agent-synthetic-search']
        self.assertEqual(s, ar.private_search_service(agent, ar.DEFAULT_PROXY_IMAGE))
        self.assertEqual(s['network_mode'], 'service:agent-synthetic-tinfoil')
        self.assertNotIn('ports', s)
        self.assertNotIn('networks', s)
        self.assertNotIn('environment', s)
        self.assertNotIn('volumes', s)
        self.assertEqual(s['cap_drop'], ['ALL'])
        self.assertTrue(s['read_only'])
        command=s['command']
        self.assertEqual(command[command.index('--host')+1], 'websearch.tinfoil.sh')
        self.assertEqual(command[command.index('--repo')+1], 'tinfoilsh/confidential-websearch')
        self.assertEqual(command[command.index('--port')+1], '3302')
        self.assertNotIn('--verbose', command)
        self.assertNotIn('--trace', command)
        main=doc['services']['agent-synthetic']
        self.assertIn('agent-synthetic-search', main['depends_on'])
        self.assertEqual(main['environment'], {'HERMES_UID': '1000', 'HERMES_GID': '1000'})
        self.assertEqual(main['volumes'], ['/synthetic:/opt/data'])

    def test_standard_and_other_providers_do_not_get_search(self):
        for privacy, provider in [('standard','tinfoil'),('private','local'),('standard','anthropic')]:
            doc = json.loads(ar.compose_doc(self.agent(privacy,provider), image='stock', proxy_image='p',
                                           home_source='/synthetic', uid=1000,gid=1000,ports=False))
            self.assertNotIn('agent-synthetic-search',doc['services'])

    def test_installed_legacy_recipe_gets_same_service_via_final_owner_override(self):
        from unittest.mock import Mock
        driver=object.__new__(ar.RuntipiDriver)
        driver.home_mount='stock'
        driver.proxy_image=ar.DEFAULT_PROXY_IMAGE
        state={'dockerCompose': json.dumps({'services': {'agent-synthetic': {'environment': {'KEEP':'yes'}, 'depends_on':['existing']}, 'unrelated': {'image':'keep'}}}), 'appEnv':'KEEP=1\n'}
        def req(method, path, payload=None):
            if method == 'PUT':
                assert payload is not None
                state.update(payload)
            return dict(state)
        rt=Mock()
        rt.req.side_effect=req
        driver._override(self.agent(),rt)
        args=rt.req.call_args_list[1].args
        self.assertEqual(args[:2], ('PUT','/user-config/agent-synthetic:wizardapps'))
        doc=json.loads(args[2]['dockerCompose'])
        self.assertEqual(doc['services']['agent-synthetic-search'],ar.private_search_service(self.agent(),ar.DEFAULT_PROXY_IMAGE))
        self.assertEqual(doc['services']['agent-synthetic']['depends_on'], ['existing','agent-synthetic-search'])
        self.assertEqual(doc['services']['agent-synthetic']['environment'], {'KEEP':'yes'})
        self.assertEqual(doc['services']['unrelated'], {'image':'keep'})
        self.assertEqual(args[2]['appEnv'], 'KEEP=1\n')
        driver._override(self.agent(),rt)  # idempotent

    def test_runtipi_trailing_newline_on_readback_still_verifies(self):
        # Live Runtipi returns each stored field with one extra "\n"; that must not refuse apply.
        from unittest.mock import Mock
        driver=object.__new__(ar.RuntipiDriver)
        driver.home_mount='stock'; driver.proxy_image=ar.DEFAULT_PROXY_IMAGE
        state={'dockerCompose': json.dumps({'services': {}}), 'appEnv':'KEEP=1\n'}
        def req(method, path, payload=None):
            if method == 'PUT':
                state.update({k: v + '\n' for k, v in payload.items()})
            return dict(state)
        rt=Mock(); rt.req.side_effect=req
        driver._override(self.agent(),rt)
        driver._override(self.agent(),rt)  # second apply reads the padded copy back
        self.assertEqual(state['appEnv'].rstrip('\n'), 'KEEP=1')
        self.assertIn('agent-synthetic-search', json.loads(state['dockerCompose'])['services'])
        bad=Mock(); bad.req.side_effect=lambda m,p,payload=None: {'dockerCompose': json.dumps({'services': {}}), 'appEnv':''}
        with self.assertRaises(ar.RuntimeFailure): driver._override(self.agent(),bad)

    def test_custom_yaml_conflict_is_refused_before_put(self):
        from unittest.mock import Mock
        driver=object.__new__(ar.RuntipiDriver)
        driver.home_mount='stock'; driver.proxy_image=ar.DEFAULT_PROXY_IMAGE
        rt=Mock(); rt.req.return_value={'dockerCompose': 'services:\n  unknown: {}\n', 'appEnv':''}
        with self.assertRaises(ar.RuntimeFailure): driver._override(self.agent(),rt)
        self.assertEqual(rt.req.call_count,1)


if __name__ == '__main__': unittest.main()
