"""Declared-host TLS CONNECT proxy; stdlib only, no payload/URL/header logging."""
import ipaddress
import json
import os
import re
import select
import socket
import socketserver
import struct
import time


def hostname(value):
    if not isinstance(value, str) or len(value) > 253 or value != value.lower():
        raise ValueError('hostname')
    if not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+', value):
        raise ValueError('hostname')
    if any(len(x) > 63 or x.startswith('-') or x.endswith('-') for x in value.split('.')):
        raise ValueError('hostname')
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ValueError('IP target')


def target(value, allowed):
    host, port = value.rsplit(':', 1)
    if port != '443' or hostname(host) not in allowed:
        raise ValueError('target')
    return host


def exact(sock, size):
    data = b''
    while len(data) < size:
        part = sock.recv(size - len(data))
        if not part:
            raise ValueError('truncated')
        data += part
    return data


def client_hello(sock, host):
    # Require a TLS ClientHello with exactly the CONNECT hostname as SNI.
    # Fragmented hellos are accumulated without forwarding any byte upstream.
    wire, hello = b'', b''
    while len(hello) < 4 or len(hello) < 4 + int.from_bytes(hello[1:4], 'big'):
        record = exact(sock, 5)
        size = int.from_bytes(record[3:5], 'big')
        if record[0] != 22 or record[1] != 3 or not 1 <= size <= 16384 or len(wire) + size > 65536:
            raise ValueError('TLS required')
        body = exact(sock, size)
        wire += record + body
        hello += body
        if hello[0] != 1:
            raise ValueError('ClientHello required')
    end = 4 + int.from_bytes(hello[1:4], 'big')
    p = 38
    p += 1 + hello[p]
    p += 2 + int.from_bytes(hello[p:p+2], 'big')
    p += 1 + hello[p]
    length = int.from_bytes(hello[p:p+2], 'big'); p += 2
    if p + length != end:
        raise ValueError('extensions')
    names = []
    while p < end:
        kind, size = struct.unpack('!HH', hello[p:p+4]); p += 4
        value = hello[p:p+size]; p += size
        if kind == 0:
            if int.from_bytes(value[:2], 'big') != len(value) - 2:
                raise ValueError('SNI')
            q = 2
            while q < len(value):
                typ, size = struct.unpack('!BH', value[q:q+3]); q += 3
                name = value[q:q+size]; q += size
                if typ != 0:
                    raise ValueError('SNI')
                names.append(name.decode('ascii'))
    if p != end or len(names) != 1 or (host is not None and names != [host]):
        raise ValueError('SNI mismatch')
    return (wire, hostname(names[0])) if host is None else wire


def public_connection(host):
    # Resolve here, validate the complete answer, then connect to a numeric result.
    # No second resolver lookup; private/loopback/metadata/rebinding answers fail.
    answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not answers or any(not ipaddress.ip_address(a[4][0]).is_global for a in answers):
        raise ValueError('nonpublic DNS')
    for family, typ, proto, _, address in answers:
        sock = socket.socket(family, typ, proto); sock.settimeout(15)
        try:
            sock.connect(address)
            return sock
        except OSError:
            sock.close()
    raise OSError('upstream unavailable')


def pump(left, right):
    # Bounded memory and duration; half-close permits streamed final responses.
    peers = {left: right, right: left}
    deadline = time.monotonic() + 600
    while peers and time.monotonic() < deadline:
        ready, _, _ = select.select(list(peers), [], [], 60)
        if not ready:
            break
        for source in ready:
            data = source.recv(65536)
            if data:
                peers[source].sendall(data)
            else:
                peers[source].shutdown(socket.SHUT_WR)
                del peers[source]


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(20)
        try:
            head = b''
            while not head.endswith(b'\r\n\r\n'):
                head += exact(self.request, 1)
                if len(head) > 8192:
                    raise ValueError('headers')
            line, *headers = head.decode('ascii').split('\r\n')
            method, authority, version = line.split(' ')
            if method != 'CONNECT' or version not in ('HTTP/1.0', 'HTTP/1.1'):
                raise ValueError('CONNECT only')
            host = target(authority, self.server.allowed)
            if any(h.lower().startswith(('content-length:', 'transfer-encoding:')) for h in headers):
                raise ValueError('no body')
        except (ValueError, OSError):
            self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            return
        self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        try:
            hello = client_hello(self.request, host)
            with public_connection(host) as upstream:
                upstream.sendall(hello)
                print(json.dumps({'connect': host, 'port': 443}), flush=True)
                self.request.settimeout(60); upstream.settimeout(60)
                pump(self.request, upstream)
        except (ValueError, OSError, IndexError, struct.error, UnicodeError):
            pass


class DirectTLSHandler(socketserver.BaseRequestHandler):
    """Raw TLS passthrough for SDK certificate validation that ignores HTTPS_PROXY.

    Read SNI before opening any upstream; never decrypt TLS or select a target
    from DNS/IP supplied by a client. The verifier still validates peer TLS.
    """
    def handle(self):
        self.request.settimeout(20)
        try:
            hello, host = client_hello(self.request, None)
            if host not in self.server.allowed:
                raise ValueError('undeclared SNI')
            with public_connection(host) as upstream:
                upstream.sendall(hello)
                self.request.settimeout(60); upstream.settimeout(60)
                pump(self.request, upstream)
        except (ValueError, OSError, IndexError, struct.error, UnicodeError):
            pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    def handle_error(self, *args):
        pass


if __name__ == '__main__':
    import threading
    from importlib.util import module_from_spec, spec_from_file_location
    routes = json.loads(os.environ.get('INGRESS_ROUTES', '[]'))
    if routes:
        spec = spec_from_file_location('provider_ingress', '/app/provider-ingress.py')
        ingress = module_from_spec(spec); spec.loader.exec_module(ingress)
        ingress.start(routes)
    allowed = frozenset(hostname(h) for h in json.loads(os.environ['ALLOWED_HOSTS']))
    direct = frozenset(hostname(h) for h in json.loads(os.environ.get('DIRECT_TLS_HOSTS', '[]')))
    if not direct <= allowed:
        raise ValueError('direct TLS hosts must be declared')
    if direct:
        direct_server = Server((os.environ['LISTEN_IP'], 443), DirectTLSHandler)
        direct_server.allowed = direct
        threading.Thread(target=direct_server.serve_forever, daemon=True).start()
    if not allowed:
        # Local providers get fixed incoming TCP routes, never a CONNECT listener.
        threading.Event().wait()
    with Server((os.environ.get('LISTEN_IP', '0.0.0.0'), 3128), Handler) as server:
        server.allowed = allowed
        server.serve_forever()
