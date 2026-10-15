#!/usr/bin/env python3
"""Plugin contract against real Hermes secret_scope, never a reimplemented mock.

Run with PYTHONPATH pointing at the supported Hermes source (or an exact,
hash-recorded copy of its import closure). Uses only synthetic fixture secrets.
"""
import contextlib
import concurrent.futures
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from agent import secret_scope

SOURCE = Path(__file__).resolve().parents[1] / 'hermes-plugin/wizard-heavy/__init__.py'
spec = importlib.util.spec_from_file_location('wizard_heavy_fixture', SOURCE)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class Context:
    def __init__(self):
        self.tools = {}
        self.prompt = None

    def register_tool(self, **kw):
        self.tools[kw['name']] = kw['handler']

    def register_system_prompt_section(self, name, provider, **kw):
        self.prompt = provider


@contextlib.contextmanager
def scope(values):
    token = secret_scope.set_secret_scope(values)
    try:
        yield
    finally:
        secret_scope.reset_secret_scope(token)


class ScopedPluginTests(unittest.TestCase):
    def setUp(self):
        self.received = []
        received = self.received

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append((self.path, self.headers.get('Authorization'), data))
                body = json.dumps({'job_id': 'heavy_fixture', 'state': 'queued'}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.env = patch.dict(os.environ, {'WIZARD_HEAVY_ORIGIN': 'http://127.0.0.1:1',
                                          'WIZARD_HEAVY_TOKEN': 'fixture-wrong-process-profile'})
        self.env.start()
        secret_scope.set_multiplex_active(True)
        self.ctx = Context()
        plugin.register(self.ctx)  # no scope at import/registration time
        self.args = {'key': 'same-stable-key', 'cwd': '/Volumes/ThalesMedia/fixture', 'argv': ['true']}

    def tearDown(self):
        secret_scope.set_multiplex_active(False)
        self.env.stop()
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def test_fresh_turn_scopes_resolve_both_origin_and_token_without_restart(self):
        for n in range(2):
            values = {'WIZARD_HEAVY_ORIGIN': self.origin, 'WIZARD_HEAVY_TOKEN': f'fixture-turn-{n}'}
            with scope(values):
                self.assertIn('wizard_heavy_submit', self.ctx.prompt(None))
                result = json.loads(self.ctx.tools['wizard_heavy_submit'](self.args, session_id=f'session-{n}'))
                self.assertEqual(result['state'], 'queued')
        self.assertEqual([item[1] for item in self.received], ['Bearer fixture-turn-0', 'Bearer fixture-turn-1'])
        self.assertEqual([item[2]['session_id'] for item in self.received], ['session-0', 'session-1'])
        self.assertEqual(os.environ['WIZARD_HEAVY_TOKEN'], 'fixture-wrong-process-profile')

    def test_scoped_misses_and_unscoped_calls_fail_closed_for_prompt_and_all_tools(self):
        for values in ({}, {'WIZARD_HEAVY_ORIGIN': self.origin}, {'WIZARD_HEAVY_TOKEN': 'fixture-token'}, None):
            with self.subTest(values=values), scope(values):
                self.assertEqual(self.ctx.prompt(None), '')
                for name, args in [('wizard_heavy_submit', self.args), ('wizard_heavy_status', {'job_id': 'one'}), ('wizard_heavy_cancel', {'job_id': 'one'})]:
                    self.assertIn('error', json.loads(self.ctx.tools[name](args, session_id='s')))
        self.assertEqual(self.received, [])

    def test_concurrent_profile_scopes_do_not_cross_credentials(self):
        barrier = threading.Barrier(2)

        def run(n):
            with scope({'WIZARD_HEAVY_ORIGIN': self.origin, 'WIZARD_HEAVY_TOKEN': f'fixture-concurrent-{n}'}):
                barrier.wait(timeout=5)
                self.assertIn('wizard_heavy_submit', self.ctx.prompt(None))
                return json.loads(self.ctx.tools['wizard_heavy_status']({'job_id': 'one'}, session_id=f'profile-{n}'))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertTrue(all(r['state'] == 'queued' for r in results))
        self.assertEqual(sorted((r[2]['session_id'], r[1]) for r in self.received),
                         [('profile-0', 'Bearer fixture-concurrent-0'), ('profile-1', 'Bearer fixture-concurrent-1')])

    def test_single_profile_process_env_remains_supported(self):
        secret_scope.set_multiplex_active(False)
        with patch.dict(os.environ, {'WIZARD_HEAVY_ORIGIN': self.origin, 'WIZARD_HEAVY_TOKEN': 'fixture-single'}), scope(None):
            self.assertIn('wizard_heavy_submit', self.ctx.prompt(None))
            self.assertEqual(json.loads(plugin.submit(self.args, session_id='single'))['state'], 'queued')
        self.assertEqual(self.received[0][1], 'Bearer fixture-single')


if __name__ == '__main__':
    source = Path(secret_scope.__file__)
    print('actual secret_scope source:', source, 'sha256:', hashlib.sha256(source.read_bytes()).hexdigest(), flush=True)
    unittest.main(verbosity=2)
