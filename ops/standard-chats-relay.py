#!/usr/bin/env python3
"""Legacy container transport for one read-only MCP route, not an owner/app gateway.

Bind only to a configured private/loopback address. The Agent Service validates the
agent-scoped bearer and current private permission on every request. No keys live here.
Restricted agents use their existing isolated edge instead of this legacy transport.
"""
import ipaddress
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from urllib.parse import urlsplit

PATH = '/wizard/standard-chats/mcp'
MAX_BODY = 16384
MAX_REPLY = 131072

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_handler(upstream='http://127.0.0.1:8923'):
    origin = urlsplit(upstream)
    if origin.scheme != 'http' or origin.hostname not in ('127.0.0.1', 'localhost', '::1') or origin.username or origin.password or origin.path not in ('', '/') or origin.query or origin.fragment:
        raise ValueError('upstream must be a loopback HTTP origin')

    class Handler(BaseHTTPRequestHandler):
        server_version = 'WizardReadOnlyRelay'
        timeout = 15

        def log_message(self, format, *args):
            pass  # Do not log queries, credentials or RPC content.

        def reply(self, status, body):
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def deny(self, status, reason):
            self.reply(status, json.dumps({'error': reason}).encode())

        def do_POST(self):
            if self.path != PATH:
                return self.deny(404, 'not_found')
            if any(k.lower() in ('origin', 'forwarded', 'x-real-ip', 'x-wizard-owner-proof') or k.lower().startswith('x-forwarded-') for k in self.headers):
                return self.deny(403, 'proxy_context_refused')
            auth = self.headers.get('Authorization', '')
            if not auth.startswith('Bearer ') or not 24 <= len(auth[7:]) <= 512:
                return self.deny(401, 'agent_credential_required')
            if not self.headers.get('Content-Type', '').lower().startswith('application/json'):
                return self.deny(415, 'json_required')
            if self.headers.get('Transfer-Encoding'):
                return self.deny(400, 'invalid_request')
            try:
                size = int(self.headers.get('Content-Length', '-1'))
            except ValueError:
                return self.deny(400, 'invalid_request')
            if size < 0 or size > MAX_BODY:
                return self.deny(413, 'request_too_large')
            self.connection.settimeout(15)
            body = self.rfile.read(size)
            if len(body) != size:
                return self.deny(400, 'invalid_request')
            request = Request(upstream.rstrip('/') + PATH, data=body, method='POST', headers={'Authorization': auth, 'Content-Type': 'application/json'})
            try:
                response = build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=20)
            except HTTPError as error:
                response = error
            except (URLError, TimeoutError, OSError):
                return self.deny(502, 'upstream_unavailable')
            with response:
                payload = response.read(MAX_REPLY + 1)
                if len(payload) > MAX_REPLY:
                    return self.deny(502, 'upstream_response_too_large')
                self.reply(response.status, payload)

        def do_GET(self):
            self.deny(405, 'method_not_allowed')

        do_DELETE = do_GET
        do_PATCH = do_GET
        do_PUT = do_GET
        do_OPTIONS = do_GET
        do_HEAD = do_GET

    return Handler


if __name__ == '__main__':
    host = os.environ.get('WIZARD_STANDARD_RELAY_BIND', '127.0.0.1')
    address = ipaddress.ip_address(host)
    if not address.is_private or address.is_unspecified or address.is_multicast:
        raise SystemExit('relay bind must be a private or loopback address')
    server = ThreadingHTTPServer((host, int(os.environ.get('WIZARD_STANDARD_RELAY_PORT', '18986'))), make_handler(os.environ.get('WIZARD_STANDARD_RELAY_UPSTREAM', 'http://127.0.0.1:8923')))
    server.daemon_threads = True
    server.serve_forever()
