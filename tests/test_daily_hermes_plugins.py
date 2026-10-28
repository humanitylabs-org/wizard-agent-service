"""Portable, synthetic-only contracts for the supported daily Hermes plugins.

No installed Hermes, live service, owner home, network or credentials are used.
"""
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
secrets = {}
scope = types.ModuleType('agent.secret_scope')
setattr(scope, 'get_secret', lambda key: secrets.get(key))

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'hermes-plugin' / name / '__init__.py')
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {'agent': types.ModuleType('agent'), 'agent.secret_scope': scope}):
        spec.loader.exec_module(module)
    return module

schedule, agents, progress = map(load, ['wizard-schedule', 'wizard-agents', 'wizard-work-progress'])

class Response:
    def __init__(self, payload): self.payload = json.dumps(payload).encode()
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size): return self.payload[:size]

class ClientContracts(unittest.TestCase):
    def setUp(self):
        secrets.clear()
        secrets.update(WIZARD_HEAVY_ORIGIN='http://127.0.0.1:8923', WIZARD_HEAVY_TOKEN='fixture-capability')

    def test_loopback_only_and_no_redirect(self):
        for plugin in (schedule, agents):
            for origin in ('https://127.0.0.1', 'http://example.invalid', 'http://127.0.0.1.evil.invalid',
                           'http://user@localhost', 'http://localhost/path', 'http://localhost?query=1', 'http://localhost#fragment'):
                secrets['WIZARD_HEAVY_ORIGIN'] = origin
                self.assertEqual(plugin._endpoint(), (None, None), origin)
            for origin in ('http://127.0.0.1:8923', 'http://localhost:8923', 'http://[::1]:8923'):
                secrets['WIZARD_HEAVY_ORIGIN'] = origin
                self.assertEqual(plugin._endpoint(), (origin, 'fixture-capability'))
            self.assertIsNone(plugin.NoRedirect().redirect_request(None, None, 302, '', {}, 'http://elsewhere.invalid'))

    def test_missing_configuration_never_connects(self):
        secrets.clear()
        for plugin in (schedule, agents):
            self.assertFalse(plugin.configured())
            with patch.object(plugin.urllib.request, 'build_opener') as opener:
                result = schedule.call('list', {}, 'fixture') if plugin is schedule else agents.call('list', {})
                self.assertIn('not configured', json.loads(result)['error'])
                opener.assert_not_called()

    def test_schedule_session_is_injected_not_chosen_by_model(self):
        requests = []
        def open_request(req, timeout):
            requests.append(req)
            self.assertEqual(timeout, 15)
            return Response({'accepted': True})
        with patch.object(schedule.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_request)):
            self.assertTrue(json.loads(schedule.call('create', {'session_id': 'forged'}, 'actual'))['accepted'])
        request = requests[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8923/wizard/internal/schedules/create')
        self.assertEqual(request.method, 'POST')
        self.assertEqual(json.loads(request.data), {'session_id': 'actual'})
        self.assertEqual(request.headers['Authorization'], 'Bearer fixture-capability')

    def test_schedule_requires_stateful_session(self):
        with patch.object(schedule.urllib.request, 'build_opener') as opener:
            self.assertIn('required', json.loads(schedule.call('list', {}, None))['error'])
            opener.assert_not_called()

    def test_schedule_time_forms(self):
        for value, expected in [('morning', {'at': 'morning'}), ('tomorrow', {'at': 'morning'}),
                                ('overnight', {'at': 'overnight'}), ('2026-10-28T08:30:00+07:00', {'once': '2026-10-28T08:30:00+07:00'}),
                                ('cron: 0 8 * * *', {'cron': '0 8 * * *'}), ('every: 30', {'every': 30})]:
            self.assertEqual(schedule.when_value(value), expected)
        for value in ('soon', '2026-10-28T08:30', 'every: nope', None):
            self.assertIsNone(schedule.when_value(value))

    def test_schedule_handlers_explicit_values_and_no_rogue_fields(self):
        with patch.object(schedule, 'call', return_value='ok') as call:
            schedule.schedule({'name': 'Fixture', 'when': 'morning', 'kind': 'remind', 'text': 'Synthetic reminder', 'session_id': 'forged'}, session_id='actual')
            call.assert_called_once_with('create', {'name': 'Fixture', 'when': {'at': 'morning'}, 'kind': 'remind', 'text': 'Synthetic reminder'}, 'actual')
        with patch.object(schedule, 'call') as call:
            self.assertIn('error', json.loads(schedule.schedule({'when': 'soon'}, session_id='actual')))
            call.assert_not_called()
        with patch.object(schedule, 'call') as call:
            schedule.schedule_list({}, session_id='actual')
            call.assert_called_once_with('list', {'all': False, 'include_done': False}, 'actual')
        with patch.object(schedule, 'call') as call:
            schedule.schedule_cancel({'schedule_id': 'fixture'}, session_id='actual')
            call.assert_called_once_with('cancel', {'schedule_id': 'fixture', 'any_thread': False}, 'actual')

    def test_agents_read_only_routes_and_allowed_keys(self):
        tools = []
        agents.register(types.SimpleNamespace(register_tool=lambda **kw: tools.append(kw)))
        self.assertEqual([tool['name'] for tool in tools], ['wizard_agents_' + short for short in ('list', 'memory_read', 'skills_list', 'skill_read', 'notes_list', 'notes_read')])
        with patch.object(agents, 'call', return_value='source-labelled') as call:
            tools[3]['handler']({'agent': 'fixture', 'name': 'example', 'write': 'forged'}, session_id='caller')
            call.assert_called_once_with('skill_read', {'agent': 'fixture', 'name': 'example'})
        requests = []
        def open_request(req, timeout):
            requests.append(req)
            return Response({'content': [{'type': 'text', 'text': 'source-labelled'}]})
        with patch.object(agents.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_request)):
            self.assertEqual(agents.call('notes_read', {'agent': 'fixture', 'path': 'example.md'}), 'source-labelled')
        self.assertEqual(requests[0].full_url, 'http://127.0.0.1:8923/wizard/internal/agents/notes_read')
        self.assertEqual(json.loads(requests[0].data), {'agent': 'fixture', 'path': 'example.md'})

    def test_service_privacy_seal_refusal_is_not_content(self):
        with patch.object(agents.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=lambda *a, **k: Response({'isError': True, 'content': [{'text': 'private agent refuses'}]}))):
            self.assertEqual(json.loads(agents.call('memory_read', {'agent': 'fixture'})), {'error': 'private agent refuses'})

    def test_http_and_connection_errors_are_explicit(self):
        for plugin in (schedule, agents):
            error = plugin.urllib.error.HTTPError('http://localhost', 403, 'refused', {}, io.BytesIO(b'{"error":"refused"}'))
            with patch.object(plugin.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=lambda *a, **k: (_ for _ in ()).throw(error))):
                result = schedule.call('list', {}, 'fixture') if plugin is schedule else agents.call('list', {})
                self.assertIn('error', json.loads(result))
            error.close()
            with patch.object(plugin.urllib.request, 'build_opener', side_effect=OSError('offline')):
                result = schedule.call('list', {}, 'fixture') if plugin is schedule else agents.call('list', {})
                self.assertIn('unavailable', json.loads(result)['error'])

    def test_tools_do_not_expose_session_or_capability_fields(self):
        for plugin, expected in ((schedule, 3), (agents, 6)):
            tools, sections = [], []
            ctx = types.SimpleNamespace(register_tool=lambda **kw: tools.append(kw), register_system_prompt_section=lambda *a, **k: sections.append((a, k)))
            plugin.register(ctx)
            self.assertEqual(len(tools), expected)
            for tool in tools:
                params = tool['schema']['parameters']
                self.assertFalse(params['additionalProperties'])
                for field in ('session_id', 'token', 'origin'):
                    self.assertNotIn(field, params['properties'])
            self.assertTrue(sections[0][0][1](None))
            secrets.clear()
            self.assertEqual(sections[0][0][1](None), '')
            self.setUp()

class ProgressContracts(unittest.TestCase):
    def test_fresh_and_resumed_turns(self):
        for fresh in (True, False):
            self.assertEqual(progress.turn_context(session_id='wizard_123_abc', platform='api_server', is_first_turn=fresh), {'context': progress.CONTEXT})

    def test_scope(self):
        for sid, platform in [('telegram_123', 'telegram'), ('wizard_123_abc', 'subagent'), ('wizard_123_abc-child', 'api_server'), ('wizard_123_abc\n', 'api_server'), ('other', 'api_server')]:
            self.assertIsNone(progress.turn_context(session_id=sid, platform=platform))
        for sid in ('wizard-assistant-example', 'wizardop_user_example'):
            for platform in ('wizard', 'wizard-mobile', 'api_server'):
                self.assertIsNotNone(progress.turn_context(session_id=sid, platform=platform))

    def test_contract_is_private_context_not_new_human_input(self):
        self.assertTrue(progress.CONTEXT.startswith('<memory-context>'))
        self.assertTrue(progress.CONTEXT.endswith('</memory-context>'))
        self.assertIn('todo_list', progress.CONTEXT)
        self.assertIn('Never invent completion percentages', progress.CONTEXT)

    def test_registration_is_single_context_hook(self):
        calls = []
        progress.register(types.SimpleNamespace(register_hook=lambda event, fn: calls.append((event, fn))))
        self.assertEqual(calls, [('pre_llm_call', progress.turn_context)])

class LoopbackNeverUsesProxy(unittest.TestCase):
    """Oscar's review repro: an env proxy must never see the loopback bearer request."""
    def test_env_proxy_is_ignored_for_every_plugin(self):
        import http.server, os, threading
        hits = {'service': 0, 'proxy': 0}
        def handler(kind, body):
            class H(http.server.BaseHTTPRequestHandler):
                def do_POST(self):
                    hits[kind] += 1
                    self.rfile.read(int(self.headers.get('Content-Length') or 0))
                    self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                    self.wfile.write(body)
                def log_message(self, *args): pass
            return H
        service = http.server.HTTPServer(('127.0.0.1', 0), handler('service', json.dumps({'content': [{'text': 'ok'}], 'ok': True}).encode()))
        proxy = http.server.HTTPServer(('127.0.0.1', 0), handler('proxy', b'{}'))
        for server in (service, proxy):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            secrets.clear()
            secrets.update(WIZARD_HEAVY_ORIGIN='http://127.0.0.1:%d' % service.server_port, WIZARD_HEAVY_TOKEN='fixture-capability')
            env = {'http_proxy': 'http://127.0.0.1:%d' % proxy.server_port, 'HTTP_PROXY': 'http://127.0.0.1:%d' % proxy.server_port, 'no_proxy': '', 'NO_PROXY': ''}
            with patch.dict(os.environ, env):
                self.assertEqual(agents.call('list', {}), 'ok')
                schedule.call('list', {}, 'wizard_1_fixture')
            self.assertEqual(hits, {'service': 2, 'proxy': 0})
        finally:
            service.shutdown(); proxy.shutdown()

class ResponseBounds(unittest.TestCase):
    def setUp(self):
        secrets.clear()
        secrets.update(WIZARD_HEAVY_ORIGIN='http://127.0.0.1:8923', WIZARD_HEAVY_TOKEN='fixture-capability')

    def test_escaped_64k_content_is_read_whole_and_oversize_is_refused(self):
        big = '"\n' * 40000
        with patch.object(agents.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=lambda *a, **k: Response({'content': [{'text': big}]}))):
            self.assertEqual(agents.call('memory_read', {}), big)
        huge = 'x' * (agents.MAX_RESPONSE + 10)
        with patch.object(agents.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=lambda *a, **k: Response({'content': [{'text': huge}]}))):
            self.assertIn('too large', agents.call('memory_read', {}))

    def test_progress_manifest_declares_its_hook(self):
        manifest = (ROOT / 'hermes-plugin' / 'wizard-work-progress' / 'plugin.yaml').read_text()
        self.assertIn('provides_hooks:\n  - pre_llm_call', manifest)

if __name__ == '__main__':
    unittest.main(verbosity=2)
