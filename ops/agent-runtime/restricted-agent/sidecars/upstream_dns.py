"""Bounded DNS A lookup against explicit uplink resolvers, never Docker's alias resolver.

TLS still validates the real hostname at the client. UDP replies are bound to a connected
resolver socket, random transaction id and the exact question; all returned IPs are vetted
by the egress caller. Truncated replies fail closed. No search domains or host-file fallback.
"""
import ipaddress
import os
import secrets
import socket
import struct


def parse_response(data, ident, question):
    if len(data) < 12:
        raise ValueError("short DNS header")
    rid, flags, qd, an, _, _ = struct.unpack("!6H", data[:12])
    if rid != ident or (flags & 0xFA0F) != 0x8000 or qd != 1 or an > 128:
        raise ValueError("invalid DNS response")
    if data[12:12 + len(question)] != question:
        raise ValueError("DNS question mismatch")
    i, addrs = 12 + len(question), []
    for _ in range(an):
        # Skip an owner name without following compression pointers.
        while True:
            if i >= len(data):
                raise ValueError("truncated DNS name")
            n = data[i]
            i += 1
            if n & 0xC0 == 0xC0:
                if i >= len(data) or ((n & 63) << 8 | data[i]) >= len(data):
                    raise ValueError("bad DNS pointer")
                i += 1
                break
            if n & 0xC0 or n > 63 or i + n > len(data):
                raise ValueError("bad DNS label")
            if n == 0:
                break
            i += n
        if i + 10 > len(data):
            raise ValueError("truncated DNS answer")
        kind, cls, _, size = struct.unpack("!HHIH", data[i:i + 10])
        i += 10
        value = data[i:i + size]
        i += size
        if len(value) != size:
            raise ValueError("truncated DNS rdata")
        if kind == 1 and cls == 1:
            if size != 4:
                raise ValueError("bad DNS A record")
            addrs.append(str(ipaddress.IPv4Address(value)))
    if not addrs:
        raise ValueError("no DNS A addresses")
    return sorted(set(addrs))


def resolve(host):
    labels = host.encode("ascii").split(b".")
    if not labels or any(not label or len(label) > 63 for label in labels):
        raise OSError("invalid DNS name")
    question = b"".join(bytes([len(label)]) + label for label in labels) + b"\0\0\1\0\1"
    for resolver in os.environ.get("EGRESS_UPSTREAM_DNS", "1.1.1.1 8.8.8.8").split():
        # Resolver addresses must themselves be public, literal IPv4 addresses.
        ip = ipaddress.IPv4Address(resolver)
        if not ip.is_global or ip.is_multicast:
            raise OSError("non-public upstream DNS")
        ident = secrets.randbits(16)
        packet = struct.pack("!6H", ident, 0x0100, 1, 0, 0, 0) + question
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(3)
                sock.connect((str(ip), 53))
                sock.send(packet)
                return parse_response(sock.recv(4096), ident, question)
        except (OSError, ValueError):
            continue
    raise OSError("upstream DNS failed")
