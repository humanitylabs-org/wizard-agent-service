#!/usr/bin/env python3
"""Probe the real agent API from the Service namespace (same Linux kernel, no TCP fallback)."""
import http.client
import json
import os
import socket
import stat
import sys


def get(path, route, key=None):
    c = http.client.HTTPConnection('agent', timeout=5)
    try:
        c.sock = socket.socket(socket.AF_UNIX)
        c.sock.settimeout(5)
        c.sock.connect(path)
        c.request('GET', route, headers={'Authorization': f'Bearer {key}'} if key else {})
        r = c.getresponse()
        r.read()
        return r.status
    finally:
        c.close()


path = sys.argv[1]
if '--health' in sys.argv:
    print(get(path, '/health'))
else:
    st = os.lstat(path)
    result = {'health': get(path, '/health'), 'authenticated': get(path, '/v1/models', os.environ['CONF_API_KEY']),
              'wrong_key': get(path, '/v1/models', 'wrong-synthetic-api-key'),
              'without_key': get(path, '/v1/models'), 'private_socket': stat.S_ISSOCK(st.st_mode)
              and stat.S_IMODE(st.st_mode) == 0o600 and st.st_uid == os.getuid()}
    print(json.dumps(result))
    sys.exit(0 if result == {'health': 200, 'authenticated': 200, 'wrong_key': 401,
                            'without_key': 401, 'private_socket': True} else 1)
