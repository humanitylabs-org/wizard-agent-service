"""Supported-plugin contract, without installing in any live Hermes home."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

secrets = {}
sys.modules.setdefault('agent', types.ModuleType('agent'))
secret_scope = types.ModuleType('agent.secret_scope')
secret_scope.get_secret = lambda k: secrets.get(k)
sys.modules['agent.secret_scope'] = secret_scope
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('supervisor_plugin', ROOT / 'hermes-plugin/wizard-supervisor-tools/__init__.py')
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class TestSupervisorPlugin(unittest.TestCase):
    def setUp(self):
        secrets.clear()

    def test_registers_six_tools_without_model_identity(self):
        class Context:
            def __init__(self): self.tools = []
            def register_tool(self, **kw): self.tools.append(kw)
        ctx = Context(); plugin.register(ctx)
        self.assertEqual([t['name'] for t in ctx.tools], ['supervisor_report','supervisor_ask','supervisor_answer','supervisor_build','supervisor_lessons','supervisor_close'])
        for t in ctx.tools:
            for name in ['session_id','agent_id','thread_id','run_id','depth','parent_id','privacy']:
                self.assertNotIn(name, t['schema']['parameters']['properties'])
        with patch.object(plugin, 'call', return_value='ok') as call:
            ctx.tools[0]['handler']({'title':'hello'}, session_id='injected')
            call.assert_called_once_with('report', {'title':'hello'}, session_id='injected')

    def test_main_loopback_only_and_no_redirects(self):
        for origin in ['https://127.0.0.1:8787','http://example.com','http://127.0.0.1:8787/other','http://user@127.0.0.1:8787','http://127.0.0.1:8787?x=1']:
            secrets.update(WIZARD_HEAVY_ORIGIN=origin, WIZARD_HEAVY_TOKEN='fixture')
            self.assertEqual(plugin.endpoint(),(None,None))
        secrets['WIZARD_HEAVY_ORIGIN']='http://127.0.0.1:8787'
        self.assertEqual(plugin.endpoint(),('http://127.0.0.1:8787/wizard/internal/supervisor/','fixture'))
        self.assertIsNone(plugin.NoRedirect().redirect_request(None,None,302,'',{},'http://other'))

    def test_injected_session_overwrites_even_rogue_args_and_uses_own_capability(self):
        secrets.update(WIZARD_HEAVY_ORIGIN='http://127.0.0.1:8787', WIZARD_HEAVY_TOKEN='fixture')
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b'{"accepted":true}'
        class Opener:
            def open(self, req, timeout):
                self.req=req
                return Response()
        opener=Opener()
        with patch.object(plugin,'build_opener',return_value=opener):
            result=plugin.call('report',{'session_id':'forged','title':'hello'},session_id='actual')
        self.assertTrue(json.loads(result)['accepted'])
        self.assertEqual(json.loads(opener.req.data)['session_id'],'actual')
        self.assertEqual(opener.req.full_url,'http://127.0.0.1:8787/wizard/internal/supervisor/report')

    def test_oversized_response_is_explicit_not_truncated_json(self):
        secrets.update(WIZARD_HEAVY_ORIGIN='http://127.0.0.1:8787', WIZARD_HEAVY_TOKEN='fixture')
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b'x' * size
        opener = types.SimpleNamespace(open=lambda *a, **kw: Response())
        with patch.object(plugin, 'build_opener', return_value=opener):
            result = json.loads(plugin.call('lessons', {}, session_id='review'))
        self.assertIn('too large', result['error'])

    def test_missing_session_and_private_profile_refuse_without_network(self):
        with patch.object(plugin,'build_opener') as opener:
            self.assertIn('required', plugin.call('report',{}))
            self.assertIn('privacy-sealed',plugin.call('report',{},session_id='private'))
            opener.assert_not_called()

    def test_gateway_uses_configured_edge_and_per_agent_key(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ,{'HERMES_HOME':home}):
            Path(home,'config.yaml').write_text('mcp_servers:\n  wizard:\n    url: http://edge:8923/wizard/mcp\n')
            secrets['WIZARD_MCP_TOKEN']='agent-key'
            self.assertEqual(plugin.endpoint(),('http://edge:8923/wizard/mcp','agent-key'))


if __name__ == '__main__':
    unittest.main()
