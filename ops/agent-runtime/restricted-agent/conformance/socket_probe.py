#!/usr/bin/env python3
"""Synthetic socket conformance, run inside each namespace. Exit nonzero on any unmet invariant."""
import errno
import http.client
import ipaddress
import concurrent.futures
import json
import os
import socket
import stat
import sys

TOKEN = lambda agent: f"socket-fixture-token-{agent}-0123456789abcdef"
CHECKS = []


def check(name, ok, detail=None):
    CHECKS.append({"check": name, "pass": bool(ok), "detail": detail})


def call(path=None, token="", host="edge", port=8923):
    c = http.client.HTTPConnection(host, port, timeout=5)
    if path:
        c.sock = socket.socket(socket.AF_UNIX)
        c.sock.settimeout(5)
        c.sock.connect(path)
    c.request("GET", "/wizard/v1/agent-context?format=json", headers={"Authorization": f"Bearer {token}"})
    r = c.getresponse()
    result = r.status, r.read().decode()
    c.close()
    return result


def cannot_open(path):
    s = socket.socket(socket.AF_UNIX)
    try:
        s.connect(path)
        return False
    except OSError as e:
        return e.errno in (errno.ENOENT, errno.EACCES, errno.ENOTDIR)
    finally:
        s.close()


def main(mode):
    if mode == "agent":
        good = call(token=TOKEN("one"))
        check("agent reaches its own context via edge", good[0] == 200 and "ONE-ONLY" in good[1] and "TWO-ONLY" not in good[1], good[0])
        check("edge rejects another agent token", call(token=TOKEN("two"))[0] == 401)
        check("agent has neither ingress nor gateway socket mount", all(cannot_open(p) for p in ("/run/agent-gateway/gateway.sock", "/run/agent-gateway/ingress.sock", "/state/agents/one/gateway/gateway.sock")))
        routes = [line.split() for line in open('/proc/net/route').read().splitlines()[1:]]
        check("sandbox has no default route (all off-subnet host ports unreachable)", bool(routes) and not any(r[1] == '00000000' for r in routes), routes)
        own = {str(a[4][0]) for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
        sidecars = {str(a[4][0]) for name in ('edge', 'egress') for a in socket.getaddrinfo(name, None, socket.AF_INET)}
        subnet = ipaddress.ip_network(next(iter(own)) + '/28', strict=False)
        hosts = [str(h) for h in subnet.hosts() if str(h) not in own | sidecars]
        ports = [22, 80, 443, 2375, 2376, 8642, 8923, 8929, int(os.environ.get('CONF_HOST_PORT', '28923'))]
        def reachable(target):
            s = socket.socket(); s.settimeout(.1)
            try:
                return target if s.connect_ex(target) == 0 else None
            finally:
                s.close()
        with concurrent.futures.ThreadPoolExecutor(32) as executor:
            hits = [hit for hit in executor.map(reachable, [(h, p) for h in hosts for p in ports]) if hit]
        check("no sandbox address reaches synthetic host listener or other host services", not hits, {"hosts": hosts, "ports": ports, "hits": hits})
        # Exhaust every TCP port on off-sandbox host addresses. ENETUNREACH must be immediate;
        # the full dispatcher drill additionally scans every sandbox address and common host services.
        targets = {'10.250.0.1', '172.17.0.1', '192.168.5.2', '10.0.2.2'}
        for name in ('host.docker.internal', 'host.lima.internal', 'gateway.docker.internal'):
            try:
                targets.update(str(a[4][0]) for a in socket.getaddrinfo(name, None, socket.AF_INET))
            except OSError:
                pass
        unexpected = []
        for host in sorted(targets):
            for port in range(1, 65536):
                s = socket.socket()
                s.settimeout(.02)
                try:
                    code = s.connect_ex((host, port))
                finally:
                    s.close()
                if code != errno.ENETUNREACH:
                    unexpected.append([host, port, code])
                    break  # fail immediately; never spend hours timing out on a broken route
        check("all 65535 TCP ports unreachable on every discovered off-sandbox host address", not unexpected, {"targets": sorted(targets), "unexpected": unexpected})
    elif mode == "edge":
        own = '/run/agent-gateway/gateway.sock'
        good = call(own, TOKEN('one'))
        check("edge opens only own socket", good[0] == 200 and 'ONE-ONLY' in good[1] and 'TWO-ONLY' not in good[1], good[0])
        wrong = call(own, TOKEN('two'))
        check("Service binds socket identity in addition to token", wrong[0] == 403 and 'principal.agent_socket' in wrong[1], wrong[0])
        check("edge cannot open other agent socket", all(cannot_open(p) for p in (
            '/state/agents/two/gateway/gateway.sock', '/gate-two/gateway.sock', '/run/two/gateway.sock',
            '/run/agent-gateway/../two/gateway.sock', '/state/agents/two/gateway/ingress.sock',
            '/gate-two/ingress.sock', '/run/two/ingress.sock')))
        check("edge sees no keys or parent agent directory", not os.path.exists('/state/agents') and not os.path.exists('/run/agent-gateway/gateway.key'))
    elif mode == "service":
        for agent in ('one', 'two'):
            path = f'/state/agents/{agent}/gateway/gateway.sock'
            good = call(path, TOKEN(agent))
            other = 'two' if agent == 'one' else 'one'
            check(f"real Service attributes {agent} socket to {agent}", good[0] == 200 and agent.upper() + '-ONLY' in good[1] and other.upper() + '-ONLY' not in good[1], good[0])
            check(f"{agent} socket rejects {other} token", call(path, TOKEN(other))[0] == 403)
            st = os.lstat(path)
            check(f"{agent} socket is private and owned by Service", stat.S_ISSOCK(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o600 and st.st_uid == os.getuid())
        listening = []
        for table in ('/proc/net/tcp', '/proc/net/tcp6'):
            for line in open(table).read().splitlines()[1:]:
                fields = line.split()
                if fields[3] == '0A':
                    listening.append(int(fields[1].split(':')[1], 16))
        check("no TCP agent listener (no TCP listeners at all in socket Service fixture)", not listening, listening)
    else:
        raise ValueError(mode)


try:
    main(sys.argv[1])
except Exception as e:
    check("probe completed", False, repr(e))
print(json.dumps({"checks": CHECKS, "passed": sum(c['pass'] for c in CHECKS), "total": len(CHECKS)}, indent=2))
sys.exit(0 if CHECKS and all(c['pass'] for c in CHECKS) else 1)
