"""Private first relay (wizard-agent-service issue 545): python3 -I test_private_first_api.py -v.

Loaded from test_plugin_api.py, which CI runs. The Agent Service is a real loopback HTTP server here; the stock
Hermes model setter is a fake.
"""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault('WIZARD_CLAUDE_COOLDOWN_RECOVERY', '0')
import plugin_api as api  # noqa: E402

pf = api._private_first
PREFIX = '/api/plugins/wizard-os/private-first'
TOKEN = 'private-first-token-0123456789abcdef'


class FakeService:
    def __init__(self):
        self.calls = []
        self.answers = {}
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):  # noqa: A002 - quiet test server
                pass

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
                action = self.path.rsplit('/', 1)[-1]
                service.calls.append((self.path, self.headers.get('Authorization'), body))
                status, answer = service.answers.get(action, (404, {'error': 'not_found'}))
                raw = json.dumps(answer).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f'http://127.0.0.1:{self.server.server_address[1]}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class PrivateFirstRelayTests(unittest.TestCase):
    def setUp(self):
        self.service = FakeService()
        self.addCleanup(self.service.close)
        env = patch.dict(os.environ, {'WIZARD_HEAVY_ORIGIN': self.service.origin, 'WIZARD_HEAVY_TOKEN': TOKEN})
        env.start()
        self.addCleanup(env.stop)
        # Inside Hermes the secret scope answers first; here it must read these env values.
        secret = patch.object(pf, '_secret', lambda name: os.environ.get(name, ''))
        secret.start()
        self.addCleanup(secret.stop)
        app = FastAPI()
        app.include_router(api.router, prefix='/api/plugins/wizard-os')
        self.client = TestClient(app)

    def test_state_relays_the_service_answer(self):
        self.service.answers['state'] = (200, {'schema': 'wizard.private-first/1', 'on': True, 'standard_agent': 'hermes', 'private_agent': 'private'})
        r = self.client.get(PREFIX)
        self.assertEqual(r.json(), {'schema': 'wizard.private-first/1', 'on': True, 'standard_agent': 'hermes', 'private_agent': 'private'})
        self.assertEqual(self.service.calls[0][1], 'Bearer ' + TOKEN)
        self.assertTrue(self.service.calls[0][0].endswith('/wizard/internal/private-first/state'))

    def test_state_is_off_when_the_service_cannot_say(self):
        self.service.answers['state'] = (500, {'error': 'boom'})
        self.assertEqual(self.client.get(PREFIX).json(), {'schema': 'wizard.private-first/1', 'on': False})
        self.service.close()
        self.assertEqual(self.client.get(PREFIX).json(), {'schema': 'wizard.private-first/1', 'on': False})
        with patch.dict(os.environ, {'WIZARD_HEAVY_ORIGIN': 'http://example.com'}):
            self.assertEqual(self.client.get(PREFIX).json()['on'], False)

    def test_private_agent_relays_without_any_key(self):
        self.service.answers['private-agent'] = (200, {'ok': True, 'agent': 'private', 'created': True})
        r = self.client.post(PREFIX + '/private-agent', json={'provider': 'tinfoil', 'model': 'kimi-k3', 'models': ['kimi-k3', 'glm-5-3'], 'api_key': 'x'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {'ok': True, 'agent': 'private'})
        self.assertEqual(self.service.calls[-1][2], {'provider': 'tinfoil', 'model': 'kimi-k3', 'models': ['kimi-k3', 'glm-5-3']})

    def test_refusals_are_not_ok(self):
        self.service.answers['private-agent'] = (409, {'ok': False, 'error': 'private_first_off'})
        r = self.client.post(PREFIX + '/private-agent', json={'provider': 'tinfoil'})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json(), {'ok': False, 'error': 'private_first_off'})

    def test_standard_agent_applies_the_model_only_when_told(self):
        applied = []

        async def fake_apply(provider, model):
            applied.append((provider, model))
            return True

        with patch.object(pf, 'apply_main_model', fake_apply):
            self.service.answers['standard-agent'] = (200, {'ok': True, 'agent': 'hermes', 'apply_model': True, 'model': 'gpt-6.1-sol'})
            r = self.client.post(PREFIX + '/standard-agent', json={'provider': 'openai-codex', 'model': 'gpt-6.1-sol'})
            self.assertEqual(r.json(), {'ok': True, 'agent': 'hermes'})
            self.service.answers['standard-agent'] = (200, {'ok': True, 'agent': 'hermes', 'apply_model': False})
            self.client.post(PREFIX + '/standard-agent', json={'provider': 'anthropic', 'model': 'claude-opus-5-5'})
        self.assertEqual(applied, [('openai-codex', 'gpt-6.1-sol')])

    def test_writes_are_refused_cross_site_and_need_json(self):
        r = self.client.post(PREFIX + '/standard-agent', json={'provider': 'openai-codex'}, headers={'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(r.status_code, 403)
        r = self.client.post(PREFIX + '/private-agent', content=b'provider=tinfoil', headers={'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(r.status_code, 415)
        self.assertEqual(self.service.calls, [])


if __name__ == '__main__':
    unittest.main()
