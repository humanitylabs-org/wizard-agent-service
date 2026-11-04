#!/usr/bin/env python3
"""Credential-free real TLS proof; disposable labelled --rm containers only.
No agent images, homes or live service endpoints are used. Source mount is read-only.
Uses an already available Python sidecar image (override PROBE_IMAGE if needed).
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
NAME = 'claude-grant-test-' + secrets.token_hex(4)
IMAGE = os.environ.get('PROBE_IMAGE', 'restricted-agent-sidecars:local')


def docker(*args, check=True):
    return subprocess.run(['docker', *args], capture_output=True, text=True, timeout=90, check=check)


PROBE = r'''
import http.client, json, socket, ssl, time
host = 'api.anthropic.com'
expected = socket.gethostbyname('egress')
assert socket.gethostbyname(host) == expected
# getent must agree with the sandbox DNS alias, not a public address.
import subprocess
assert expected in subprocess.check_output(['getent', 'hosts', host], text=True)
for attempt in range(30):
    try:
        ready = socket.create_connection(('egress', 443), timeout=1)
        ready.close()
        break
    except OSError:
        time.sleep(0.1)
else:
    raise AssertionError('egress did not listen')
conn = http.client.HTTPSConnection(host, 443, timeout=30, context=ssl.create_default_context())
conn.connect()
cert = conn.sock.getpeercert()
assert cert and conn.sock.context.verify_mode == ssl.CERT_REQUIRED
assert any(typ == 'DNS' and (name == host or name == '*.anthropic.com') for typ, name in cert['subjectAltName'])
conn.request('GET', '/')  # no credential and no request body
status = conn.getresponse().status
conn.close()
refused = False
try:
    with socket.create_connection(('egress', 443), timeout=5) as raw:
        ssl.create_default_context().wrap_socket(raw, server_hostname='example.com')
except ssl.SSLError as error:
    refused = error.reason == 'TLSV1_ALERT_ACCESS_DENIED'
assert refused, 'non-passthrough SNI was accepted'
print(json.dumps({'checks': 4, 'dns_alias': True, 'getent': True, 'verified_real_cert': True,
                  'http_status': status, 'non_passthrough_refused': refused}))
'''


def main():
    networks, container = [], False
    try:
        for suffix, internal in (('uplink', False), ('sandbox', True)):
            name = NAME + '-' + suffix
            args = ['network', 'create', '--label', 'claude-grant-test']
            if internal:
                args += ['--internal', '--opt', 'com.docker.network.bridge.inhibit_ipv4=true']
            docker(*args, name)
            networks.append(name)
        docker('run', '--rm', '-d', '--name', NAME, '--label', 'claude-grant-test',
               '--network', networks[1], '--network-alias', 'egress',
               '--network-alias', 'api.anthropic.com', '--network-alias', 'platform.claude.com',
               '--user', '65534:65534', '--read-only', '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--pids-limit', '64',
               '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
               '--mount', f'type=bind,src={ROOT / "sidecars"},dst=/srv,readonly',
               '-e', 'EGRESS_ALLOWLIST_HOSTS=api.anthropic.com platform.claude.com',
               '--entrypoint', 'python3', IMAGE, '-u', '/srv/egress.py')
        container = True
        docker('network', 'connect', networks[0], NAME)
        result = docker('run', '--rm', '--name', NAME + '-probe', '--label', 'claude-grant-test', '--network', networks[1],
                        '--user', '10000:10000', '--read-only', '--cap-drop', 'ALL',
                        '--security-opt', 'no-new-privileges:true', '--entrypoint', 'python3', IMAGE, '-c', PROBE)
        print(result.stdout.strip())
    except subprocess.CalledProcessError as error:
        # No credentials exist in this test or its logs.
        print(error.stderr)
        if container:
            print(docker('logs', NAME, check=False).stdout)
        raise
    finally:
        docker('rm', '-f', NAME + '-probe', check=False)
        if container:
            docker('rm', '-f', NAME, check=False)
        for name in reversed(networks):
            docker('network', 'rm', name, check=False)


if __name__ == '__main__':
    main()
