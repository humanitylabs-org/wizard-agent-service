#!/usr/bin/env python3
"""Allowlist HTTPS egress proxy for a restricted agent.

The agent sits on an internal-only Docker network, so this proxy is its only route out. It accepts
HTTP CONNECT to port 443 for hostnames on the allowlist and nothing else: no plain HTTP, no IP
literals, no other ports, and no hostname that resolves to a private, loopback, link-local,
CGNAT (tailnet) or otherwise non-global address. One JSON line per decision goes to stdout.

Allowlist file: one hostname per line; a leading "*." allows subdomains (not the bare domain).
"""
import asyncio
import ipaddress
import json
import os
import socket
import re
import struct
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hostname_policy import valid_public_hostname

ALLOWLIST_FILE = os.environ.get("EGRESS_ALLOWLIST", "/etc/egress/allowlist.txt")
LISTEN_PORT = int(os.environ.get("EGRESS_PORT", "3128"))
MAX_HEAD = 8192
IDLE_TIMEOUT = 300
HELLO_TIMEOUT = 10


def load_allowlist(path):
    exact, suffixes = set(), set()
    with open(path) as fh:
        for raw in fh:
            line = raw.split("#", 1)[0].strip().lower().rstrip(".")
            if not line:
                continue
            if line.startswith("*."):
                suffixes.add(line[1:])          # ".example.com"
            else:
                exact.add(line)
    return exact, suffixes


def load_allowlist_env(value):
    exact, suffixes = set(), set()
    for item in value.replace(",", " ").split():
        item = item.strip().lower().rstrip(".")
        if item.startswith("*."):
            suffixes.add(item[1:])
        elif item:
            exact.add(item)
    return exact, suffixes


# EGRESS_ALLOWLIST_HOSTS (space/comma separated) wins over the file, so no host file mount is needed.
if os.environ.get("EGRESS_ALLOWLIST_HOSTS", "").strip():
    EXACT, SUFFIXES = load_allowlist_env(os.environ["EGRESS_ALLOWLIST_HOSTS"])
else:
    EXACT, SUFFIXES = load_allowlist(ALLOWLIST_FILE)


def log(**fields):
    fields["ts"] = round(time.time(), 3)
    sys.stdout.write(json.dumps(fields, sort_keys=True) + "\n")
    sys.stdout.flush()


def host_allowed(host):
    if host in EXACT:
        return True
    return any(host.endswith(s) and len(host) > len(s) for s in SUFFIXES)


def is_ip_literal(host):
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        return False


PASSTHROUGH_HOSTS = set(os.environ.get(
    "EGRESS_PASSTHROUGH_HOSTS", "api.anthropic.com platform.claude.com").replace(",", " ").split())
PASSTHROUGH_ALIASES = set(os.environ.get(
    "EGRESS_PASSTHROUGH_ALIASES", "api.anthropic.com platform.claude.com").replace(",", " ").split())
MAX_CONNECTIONS = int(os.environ.get("EGRESS_MAX_CONNECTIONS", "64"))
ACTIVE_CONNECTIONS = 0


def public_addresses(host):
    """Resolve host; return its addresses only if every one is globally routable.
    Alias hosts MUST bypass Docker DNS, including for CONNECT requests.
    """
    if host in PASSTHROUGH_HOSTS:
        from upstream_dns import resolve
        addrs = resolve(host)
    else:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        addrs = sorted({info[4][0] for info in infos})
    for addr in addrs:
        ip = ipaddress.ip_address(addr)
        if not ip.is_global or ip.is_multicast:
            raise PermissionError(f"resolves to non-public address {addr}")
    return addrs


async def pipe(reader, writer):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), IDLE_TIMEOUT)
            if not data:
                break
            writer.write(data)
            await asyncio.wait_for(writer.drain(), IDLE_TIMEOUT)
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def refuse(writer, code, reason, **fields):
    log(decision="deny", code=code, reason=reason, **fields)
    writer.write(f"HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
    try:
        await writer.drain()
    finally:
        writer.close()


MAX_HELLO = 64 * 1024
# TLS alert record (fatal, access_denied) sent into the tunnel when the gate refuses it, so the client
# can tell the proxy refused it rather than the destination.
DENY_ALERT = bytes([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31])


def valid_hostname(host):
    return valid_public_hostname(host)


def client_hello_sni(handshake):
    """Strict, bounded ClientHello parser. ECH is refused (the inner SNI is unknowable)."""
    if len(handshake) < 4 or len(handshake) > MAX_HELLO or handshake[0] != 1:
        raise ValueError("not a bounded ClientHello")
    size = int.from_bytes(handshake[1:4], "big")
    if size > len(handshake) - 4:
        raise ValueError("truncated ClientHello")
    body, i = handshake[4:4 + size], 0

    def take(n):
        nonlocal i
        if i + n > len(body):
            raise ValueError("truncated ClientHello field")
        result = body[i:i + n]
        i += n
        return result

    def vector(width):
        return take(int.from_bytes(take(width), "big"))

    take(34)
    if len(vector(1)) > 32:
        raise ValueError("bad session id")
    suites = vector(2)
    if not suites or len(suites) % 2 or not vector(1):
        raise ValueError("bad ciphers or compression")
    if i == len(body):
        return ""
    extensions = vector(2)
    if i != len(body):
        raise ValueError("trailing ClientHello bytes")
    j, seen, sni = 0, set(), ""
    while j < len(extensions):
        if j + 4 > len(extensions):
            raise ValueError("truncated extension header")
        kind, length = struct.unpack("!HH", extensions[j:j + 4])
        j += 4
        ext = extensions[j:j + length]
        j += length
        if len(ext) != length or kind in seen or kind == 0xfe0d:
            raise ValueError("truncated, duplicate or ECH extension")
        seen.add(kind)
        if kind == 0:
            if (len(ext) < 6 or int.from_bytes(ext[:2], "big") != len(ext) - 2
                    or ext[2] != 0 or int.from_bytes(ext[3:5], "big") != len(ext) - 5):
                raise ValueError("bad server_name")
            try:
                sni = ext[5:].decode("ascii").lower()
            except UnicodeDecodeError:
                raise ValueError("non-ASCII SNI") from None
            if not valid_hostname(sni):
                raise ValueError("invalid SNI hostname")
    return sni


async def read_client_hello(reader):
    """Read TLS handshake records until one complete ClientHello is assembled (TLS may split it across
    records). Returns (raw bytes exactly as received, handshake message), or (raw, None) when the client
    did not start with a TLS handshake. Bounded to MAX_HELLO bytes and 15 seconds in total."""
    async def read():
        raw, hs = b"", b""
        while True:
            header = await reader.readexactly(5)
            raw += header
            if header[0] != 0x16 or header[1] != 0x03:
                return raw, None
            length = int.from_bytes(header[3:5], "big")
            if length == 0 or length > 16384 or len(raw) + length > MAX_HELLO:
                raise ValueError("bad or oversized record")
            fragment = await reader.readexactly(length)
            raw += fragment
            hs += fragment
            if len(hs) >= 4 and len(hs) >= 4 + int.from_bytes(hs[1:4], "big"):
                return raw, hs
    return await asyncio.wait_for(read(), 15)


async def handle(reader, writer):
    peer = (writer.get_extra_info("peername") or ("?",))[0]
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError):
        writer.close()
        return
    if len(head) > MAX_HEAD:
        return await refuse(writer, 431, "Header Too Large", peer=peer)
    line = head.split(b"\r\n", 1)[0].decode("latin-1")
    parts = line.split(" ")
    if len(parts) != 3 or parts[0] != "CONNECT":
        return await refuse(writer, 403, "Only HTTPS CONNECT is allowed", peer=peer, method=parts[0][:16])
    target = parts[1]
    host, sep, port = target.rpartition(":")
    host = host.strip().lower().rstrip(".")
    if not sep or port != "443":
        return await refuse(writer, 403, "Only port 443 is allowed", peer=peer, target=target[:255])
    if not host or is_ip_literal(host):
        return await refuse(writer, 403, "IP literals are not allowed", peer=peer, target=target[:255])
    if not host_allowed(host):
        return await refuse(writer, 403, "Host not on allowlist", peer=peer, host=host[:255])
    try:
        addrs = await asyncio.get_running_loop().run_in_executor(None, public_addresses, host)
    except PermissionError as exc:
        return await refuse(writer, 403, "Destination not public", peer=peer, host=host, detail=str(exc))
    except OSError:
        return await refuse(writer, 502, "Resolve failed", peer=peer, host=host)
    writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    await writer.drain()
    # The tunnel must carry TLS for the host that was vetted: the ClientHello's SNI has to name it.
    # This stops raw non-TLS tunnels and asking a shared IP/CDN for a different (unlisted) site. The
    # upstream connection is only opened after this check, so a refused tunnel never reaches it.
    try:
        hello, handshake = await asyncio.wait_for(read_client_hello(reader), HELLO_TIMEOUT)
        sni = client_hello_sni(handshake) if handshake is not None else None
    except (ValueError, UnicodeDecodeError, asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError):
        sni, hello, handshake = None, b"", None
    if sni != host:
        log(decision="deny", reason="tunnel is not TLS for the vetted host", peer=peer, host=host,
            sni=(sni or "")[:255], tls=handshake is not None)
        try:
            writer.write(DENY_ALERT)
            await writer.drain()
        finally:
            writer.close()
        return
    try:
        # Connect to the address we vetted, not the name (no second resolution to rebind).
        up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(str(addrs[0]), 443), 15)
    except (OSError, asyncio.TimeoutError):
        log(decision="error", reason="upstream connect failed", peer=peer, host=host)
        writer.close()
        return
    log(decision="allow", peer=peer, host=host, addr=addrs[0])
    up_writer.write(hello)
    await up_writer.drain()
    await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))


def validate_passthrough():
    if (not PASSTHROUGH_HOSTS or PASSTHROUGH_HOSTS != PASSTHROUGH_ALIASES or MAX_CONNECTIONS < 1
            or any(not valid_hostname(h) or h not in EXACT for h in PASSTHROUGH_HOSTS)):
        raise ValueError("passthrough hosts must equal aliases and be allowlisted exact DNS names")


def passthrough_allowed(sni):
    return bool(sni and valid_hostname(sni) and sni in PASSTHROUGH_HOSTS
                and sni in PASSTHROUGH_ALIASES and sni in EXACT)


async def handle_passthrough(reader, writer):
    """Port 443: inspect only ClientHello, then splice encrypted bytes unchanged."""
    up_writer = None
    try:
        hello, handshake = await asyncio.wait_for(read_client_hello(reader), HELLO_TIMEOUT)
        sni = client_hello_sni(handshake) if handshake else ""
        if not passthrough_allowed(sni):
            raise ValueError("SNI not a passthrough alias")
        # Defense against a missing/wrong Docker alias; this name must resolve to the
        # local interface receiving the connection. Real upstream lookup is separate.
        local_ip = writer.get_extra_info("sockname")[0]
        aliases = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(sni, 443, type=socket.SOCK_STREAM), 10)
        if {a[4][0] for a in aliases} != {local_ip}:
            raise ValueError("SNI does not resolve to receiving alias")
        addrs = await asyncio.wait_for(asyncio.to_thread(public_addresses, sni), 10)
        up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(str(addrs[0]), 443), 15)
        up_writer.write(hello)
        await asyncio.wait_for(up_writer.drain(), IDLE_TIMEOUT)
        log(decision="allow", mode="passthrough", host=sni)
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
    except (ValueError, OSError, asyncio.TimeoutError, asyncio.IncompleteReadError):
        # No HTTP/plaintext on this port, and never log raw TLS/application bytes.
        log(decision="deny", mode="passthrough", reason="TLS alias gate refused or upstream unavailable")
        try:
            writer.write(DENY_ALERT)
            await asyncio.wait_for(writer.drain(), 2)
        except (OSError, asyncio.TimeoutError):
            pass
    finally:
        writer.close()
        if up_writer:
            up_writer.close()


async def bounded(handler, reader, writer):
    global ACTIVE_CONNECTIONS
    if ACTIVE_CONNECTIONS >= MAX_CONNECTIONS:
        writer.close()
        return
    ACTIVE_CONNECTIONS += 1
    try:
        await handler(reader, writer)
    finally:
        ACTIVE_CONNECTIONS -= 1
        writer.close()


async def main():
    validate_passthrough()
    # Docker's unprivileged-port-start=0 allows uid 65534 to bind 443 without caps.
    proxy = await asyncio.start_server(lambda r, w: bounded(handle, r, w), "0.0.0.0", LISTEN_PORT, limit=MAX_HEAD * 2)
    # Bind only the sandbox alias IP, never the uplink listener address.
    addresses = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(
        sorted(PASSTHROUGH_HOSTS)[0], 443, family=socket.AF_INET, type=socket.SOCK_STREAM), 10)
    bind_ips = {a[4][0] for a in addresses}
    if len(bind_ips) != 1 or ipaddress.ip_address(next(iter(bind_ips))).is_global:
        raise ValueError("passthrough alias must identify one sandbox IPv4 address")
    tls = await asyncio.start_server(lambda r, w: bounded(handle_passthrough, r, w),
                                     str(next(iter(bind_ips))), 443, limit=MAX_HELLO)
    log(event="listening", ports=[LISTEN_PORT, 443], passthrough=sorted(PASSTHROUGH_HOSTS))
    async with proxy, tls:
        await asyncio.gather(proxy.serve_forever(), tls.serve_forever())


if __name__ == "__main__":
    asyncio.run(main())
