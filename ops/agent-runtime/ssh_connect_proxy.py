#!/usr/bin/env python3
"""OpenSSH stdio ProxyCommand. All destination authority stays in egress policy."""
import os
import re
import select
import socket
import sys


def main():
    if len(sys.argv) != 3 or not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', sys.argv[1]) or not sys.argv[2].isdigit():
        raise SystemExit('invalid declared TCP target')
    alias, port = sys.argv[1:]
    with socket.create_connection(('egress', 3128), 8) as s:
        s.sendall(f'CONNECT {alias}:{port} HTTP/1.1\r\n\r\n'.encode('ascii'))
        head = bytearray()
        while not head.endswith(b'\r\n\r\n') and len(head) <= 8192:
            chunk = s.recv(1)
            if not chunk:
                raise SystemExit('declared TCP relay closed')
            head.extend(chunk)
        if not bytes(head).startswith(b'HTTP/1.1 200 '):
            raise SystemExit('declared TCP relay refused')
        s.settimeout(None)
        inputs = [s, sys.stdin.buffer]
        while inputs:
            ready, _, _ = select.select(inputs, [], [])
            if s in ready:
                data = s.recv(65536)
                if not data:
                    return
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            if sys.stdin.buffer in ready:
                data = os.read(sys.stdin.fileno(), 65536)
                if data:
                    s.sendall(data)
                else:
                    inputs.remove(sys.stdin.buffer)
                    s.shutdown(socket.SHUT_WR)


if __name__ == '__main__':
    main()
