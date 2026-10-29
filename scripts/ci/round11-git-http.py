#!/usr/bin/env python3
"""Read-only smart HTTP catalogue for generated fixtures, backed by real Git CGI."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit


def handler(root):
    root = Path(root).resolve()

    class GitHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_GET(self):
            self.serve_git()

        def do_POST(self):
            self.serve_git()

        def serve_git(self):
            target = urlsplit(self.path)
            allowed = ((self.command == 'GET' and target.path == '/catalog/.git/info/refs'
                        and target.query == 'service=git-upload-pack')
                       or (self.command == 'POST' and target.path == '/catalog/.git/git-upload-pack'
                           and not target.query))
            if not allowed:
                self.send_error(403, 'read-only synthetic catalogue')
                return
            length = int(self.headers.get('Content-Length', '0'))
            if self.headers.get('Transfer-Encoding') or not 0 <= length <= 8 * 1024 * 1024:
                self.send_error(411)
                return
            env = {**os.environ, 'GIT_PROJECT_ROOT':str(root), 'GIT_HTTP_EXPORT_ALL':'1',
                   'REQUEST_METHOD':self.command, 'PATH_INFO':target.path,
                   'QUERY_STRING':target.query, 'CONTENT_TYPE':self.headers.get('Content-Type', ''),
                   'CONTENT_LENGTH':str(length), 'REMOTE_ADDR':'127.0.0.1',
                   'SERVER_PROTOCOL':'HTTP/1.1', 'GIT_CONFIG_COUNT':'2',
                   'GIT_CONFIG_KEY_0':'safe.directory', 'GIT_CONFIG_VALUE_0':str(root / 'catalog'),
                   'GIT_CONFIG_KEY_1':'safe.directory', 'GIT_CONFIG_VALUE_1':str(root / 'catalog/.git')}
            # Remain on Git protocol v0, which the selected isomorphic-git client supports.
            env.pop('HTTP_GIT_PROTOCOL', None)
            p = subprocess.run(['git', 'http-backend'], input=self.rfile.read(length),
                               capture_output=True, env=env, timeout=30)
            if p.returncode:
                self.send_error(502, 'synthetic git backend failed')
                return
            headers, body = p.stdout.split(b'\r\n\r\n', 1)
            pairs = [line.decode('latin1').split(':', 1) for line in headers.split(b'\r\n')]
            status = next((int(v.strip().split()[0]) for k, v in pairs if k.lower() == 'status'), 200)
            self.send_response(status)
            for key, value in pairs:
                if key.lower() not in ('status', 'content-length', 'connection'):
                    self.send_header(key, value.strip())
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    return GitHandler


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--root', required=True)
    p.add_argument('--port', type=int, default=8080)
    args = p.parse_args()
    ThreadingHTTPServer(('0.0.0.0', args.port), handler(args.root)).serve_forever()
