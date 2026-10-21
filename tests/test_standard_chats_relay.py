"""Disposable loopback-only tests. No owner agents, homes, keys or histories."""
import ast
import importlib.util
import json
import re
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler
from unittest.mock import patch
import os

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('standard_relay', ROOT/'ops/standard-chats-relay.py')
assert spec is not None and spec.loader is not None
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
PRIVATE = 'fixture-private-token-0000000000'
STANDARD = 'fixture-standard-token-000000000'


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        calls = self.calls

        class Fake(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                calls.append((self.command, self.path, dict(self.headers), data))
                if data == b'{"redirect":true}':
                    self.send_response(302)
                    self.send_header('Location', '/owner-only')
                    self.end_headers()
                    return
                if data == b'{"oversize":true}':
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'x'*(relay.MAX_REPLY+1))
                    return
                permitted = self.headers.get('Authorization') == 'Bearer '+PRIVATE
                self.send_response(200 if permitted else 403)
                self.end_headers()
                self.wfile.write(b'{"result":"fixture-standard-reference"}' if permitted else b'{"error":"standard_chats_denied"}')

            def do_GET(self):
                calls.append(('GET', self.path, {}, b''))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'owner-only fixture')

        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Fake)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), relay.make_handler('http://127.0.0.1:'+str(self.upstream.server_port)))
        for server in (self.upstream, self.server):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
        self.base = 'http://127.0.0.1:'+str(self.server.server_port)

    def tearDown(self):
        for server in (self.server, self.upstream):
            server.shutdown()
            server.server_close()

    def call(self, path=relay.PATH, method='POST', data=b'{}', headers=None):
        h = {'Authorization':'Bearer '+PRIVATE, 'Content-Type':'application/json', **(headers or {})}
        request = Request(self.base+path, data=data if method=='POST' else None, method=method, headers=h)
        try:
            response = build_opener(ProxyHandler({})).open(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.read(), dict(response.headers)

    def test_only_fixed_route_and_post_can_reach_upstream(self):
        for path in ['/wizard/mcp', '/wizard/operator/api/sessions', '/wizard/standard-chats/mcp?x=1', '/wizard/%73tandard-chats/mcp']:
            self.assertEqual(self.call(path)[0], 404)
        for method in ['GET','DELETE','PATCH','PUT','OPTIONS','HEAD']:
            self.assertEqual(self.call(method=method)[0],405)
        self.assertEqual(self.calls,[])

    def test_private_bearer_preserved_and_standard_denial_not_upgraded(self):
        self.assertEqual(self.call()[0],200)
        self.assertEqual(self.calls[0][0:2],('POST',relay.PATH))
        self.assertEqual(self.calls[0][2]['Authorization'],'Bearer '+PRIVATE)
        self.assertNotIn('Cookie',self.calls[0][2])
        status,body,_=self.call(headers={'Authorization':'Bearer '+STANDARD})
        self.assertEqual(status,403)
        self.assertEqual(json.loads(body)['error'],'standard_chats_denied')

    def test_no_owner_proxy_context_or_missing_credential(self):
        self.assertEqual(self.call(headers={'Authorization':''})[0],401)
        for name in ['Origin','Forwarded','X-Forwarded-For','X-Real-IP','X-Wizard-Owner-Proof']:
            self.assertEqual(self.call(headers={name:'fixture'})[0],403)
        self.assertEqual(self.calls,[])

    def test_bounds_and_no_redirect_following(self):
        self.assertEqual(self.call(data=b'x'*(relay.MAX_BODY+1))[0],413)
        self.assertEqual(self.call(headers={'Content-Type':'text/plain'})[0],415)
        self.assertEqual(self.calls,[])
        self.assertEqual(self.call(data=b'{"oversize":true}')[0],502)
        status,_,headers=self.call(data=b'{"redirect":true}')
        self.assertEqual(status,302)
        self.assertNotIn('Location',headers)
        self.assertFalse(any(c[0]=='GET' for c in self.calls))

    def test_process_proxy_environment_cannot_redirect_the_agent_bearer(self):
        with patch.dict(os.environ,{'HTTP_PROXY':'http://127.0.0.1:1','http_proxy':'http://127.0.0.1:1','NO_PROXY':'','no_proxy':''}):
            self.assertEqual(self.call()[0],200)
        self.assertEqual(len(self.calls),1)

    def test_upstream_cannot_target_owner_remote_or_arbitrary_path(self):
        for value in ['https://example.org','http://example.org','http://127.0.0.1/owner','http://user:key@127.0.0.1','http://127.0.0.1?owner=1']:
            with self.assertRaises(ValueError):
                relay.make_handler(value)

    def test_restricted_edge_only_adds_post_on_read_only_route(self):
        tree=ast.parse((ROOT/'ops/agent-runtime/restricted-agent/sidecars/edge.py').read_text())
        assignment=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ALLOW' for t in n.targets))
        namespace: dict={'re':re}
        exec(compile(ast.Module(body=[assignment],type_ignores=[]),'<edge-allow-test>','exec'),namespace)
        methods=set().union(*(methods for methods,pattern in namespace['ALLOW'] if pattern.fullmatch(relay.PATH)))
        self.assertEqual(methods,{'POST'})
        self.assertFalse(any(pattern.fullmatch('/wizard/operator/api/sessions') for _,pattern in namespace['ALLOW']))


if __name__ == '__main__':
    unittest.main()
