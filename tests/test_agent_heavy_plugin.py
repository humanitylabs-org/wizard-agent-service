#!/usr/bin/env python3
"""Synthetic agent-key client tests; no Service/worker/real credentials."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

scope = types.ModuleType('agent.secret_scope')
scope.get_secret = lambda name: 'synthetic-agent-gateway' if name == 'WIZARD_MCP_TOKEN' else None
sys.modules['agent'] = types.ModuleType('agent')
sys.modules['agent.secret_scope'] = scope
path = Path(__file__).resolve().parents[1] / 'ops/agent-runtime/agent-heavy-plugin/__init__.py'
spec = importlib.util.spec_from_file_location('agent_heavy_client', path)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class ClientTests(unittest.TestCase):
    def test_fixed_agent_route_key_and_session(self):
        seen = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, n): return b'{"job_id":"fixture","state":"pending"}'
        class Opener:
            def open(self, req, timeout):
                seen.append(req)
                self.assert_timeout = timeout
                return Response()
        with patch.object(client.urllib.request, 'build_opener', return_value=Opener()):
            result = json.loads(client.call('submit', {'cwd': '/worker/agents/fixture', 'argv': ['uname'],
                'key': 'fixture', 'session_id': 'forged', 'agent_id': 'foreign'}, session_id='real'))
        self.assertEqual(result['job_id'], 'fixture')
        req = seen[0]
        self.assertEqual(req.full_url, 'http://edge:8923/wizard/v1/agent-heavy/submit')
        self.assertEqual(req.headers['Authorization'], 'Bearer synthetic-agent-gateway')
        value = json.loads(req.data)
        self.assertEqual(value['session_id'], 'real')
        self.assertNotIn('agent_id', value)
        self.assertEqual(value['spec']['lane'], 'light')
        self.assertNotIn('token', json.dumps(value))

    def test_no_session_no_request(self):
        with patch.object(client.urllib.request, 'build_opener') as opener:
            self.assertIn('error', json.loads(client.call('submit', {})))
            opener.assert_not_called()

    def test_http_refusal_is_not_a_receipt(self):
        opener = types.SimpleNamespace(open=lambda *a, **kw: (_ for _ in ()).throw(
            client.urllib.error.HTTPError('http://edge', 404, 'off', {}, None)))
        with patch.object(client.urllib.request, 'build_opener', return_value=opener):
            result = json.loads(client.call('status', {'job_id': 'fixture'}, session_id='session'))
        self.assertEqual(result['status'], 404)
        self.assertNotIn('job_id', result)

    def test_no_redirect(self):
        self.assertIsNone(client.NoRedirect().redirect_request(None, None, 302, '', {}, 'http://host'))

    def test_registers_submit_status_cancel(self):
        tools = []
        client.register(types.SimpleNamespace(register_tool=lambda **kw: tools.append(kw)))
        self.assertEqual([x['name'] for x in tools], ['wizard_heavy_submit', 'wizard_heavy_status', 'wizard_heavy_cancel'])
        self.assertTrue(all(x['schema']['parameters']['additionalProperties'] is False for x in tools))


if __name__ == '__main__':
    unittest.main(verbosity=2)
