#!/usr/bin/env python3
"""Allowlist HTTPS egress proxy for a restricted agent.

The agent sits on an internal-only Docker network, so this proxy is its only route out. It accepts
HTTP CONNECT to port 443 for hostnames on the allowlist and nothing else: no plain HTTP, no IP
literals, no other ports, and no hostname that resolves to a private, loopback, link-local,
CGNAT (tailnet) or otherwise non-global address. An explicit EGRESS_DECLARED_TCP policy can
add exact alias:port raw TCP tunnels, solely via fixed host relays on this agent's uplink gateway.
It never grants generic SOCKS, arbitrary CONNECT, DNS private-address access, or a Tailscale socket.
One JSON line per decision goes to stdout.

Allowlist file: one hostname per line; a leading "*." allows subdomains (not the bare domain).
"""
import asyncio
import ipaddress
import json
import os
import re
import socket
import sys
import time

ALLOWLIST_FILE = os.environ.get("EGRESS_ALLOWLIST", "/etc/egress/allowlist.txt")
LISTEN_PORT = int(os.environ.get("EGRESS_PORT", "3128"))
MAX_HEAD = 8192
IDLE_TIMEOUT = 300


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


def load_declared_tcp(value, relay_host):
    """Exact alias:port grants only. The relay's bind address is the uplink gateway,
    never a client-controlled destination. Invalid policy refuses startup."""
    entries = json.loads(value)
    if not isinstance(entries, list) or len(entries) > 16:
        raise ValueError("invalid declared TCP list")
    if not entries:
        return {}
    relay = ipaddress.ip_address(relay_host)
    pool = ipaddress.ip_network("10.250.0.0/16")
    if relay not in pool or int(relay) % 16 != 1:
        raise ValueError("relay must be a restricted uplink gateway")
    grants, aliases, ports = {}, set(), set()
    for item in entries:
        if not isinstance(item, dict) or set(item) != {"alias", "address", "port", "relay_port"}:
            raise ValueError("invalid declared TCP entry")
        alias, address, port, relay_port = (item[k] for k in ("alias", "address", "port", "relay_port"))
        if not isinstance(alias, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", alias):
            raise ValueError("invalid declared TCP alias")
        if not isinstance(address, str) or ipaddress.ip_address(address) not in ipaddress.ip_network("100.64.0.0/10"):
            raise ValueError("declared TCP address must be tailnet IPv4")
        if type(port) is not int or not 1 <= port <= 65535 or port == 443:
            raise ValueError("invalid declared TCP port")
        if type(relay_port) is not int or not 1024 <= relay_port <= 65535:
            raise ValueError("invalid relay port")
        if alias in aliases or relay_port in ports:
            raise ValueError("duplicate declared TCP alias or relay port")
        aliases.add(alias)
        ports.add(relay_port)
        grants[(alias, str(port))] = dict(item, relay_host=str(relay))
    return grants


DECLARED_TCP = load_declared_tcp(os.environ.get("EGRESS_DECLARED_TCP", "[]"),
                                 os.environ.get("EGRESS_TCP_RELAY_HOST", ""))


async def declared_tunnel(reader, writer, peer, grant):
    # No SOCKS/general proxy authority in the agent or this sidecar. The host
    # relay itself launches a fixed tailscale nc destination; it reads no target.
    try:
        up_reader, up_writer = await asyncio.wait_for(
            asyncio.open_connection(grant["relay_host"], grant["relay_port"]), 15)
    except (OSError, asyncio.TimeoutError):
        return await refuse(writer, 502, "Declared TCP relay unavailable", peer=peer,
                            alias=grant["alias"])
    log(decision="allow", transport="declared-tcp", peer=peer, alias=grant["alias"],
        address=grant["address"], port=grant["port"])
    writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    await writer.drain()
    await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))


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


def public_addresses(host):
    """Resolve host; return its addresses only if every one is globally routable."""
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
            await writer.drain()
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


def client_hello_sni(handshake):
    """SNI host name from a complete ClientHello handshake message (4-byte header included); '' when it
    carries none. Raises ValueError when the message is malformed."""
    try:
        if handshake[0] != 0x01:
            raise ValueError("not a ClientHello")
        body = handshake[4:4 + int.from_bytes(handshake[1:4], "big")]
        i = 2 + 32                      # client version, random
        i += 1 + body[i]                # session id
        i += 2 + int.from_bytes(body[i:i + 2], "big")   # cipher suites
        i += 1 + body[i]                # compression methods
        if i > len(body):
            raise ValueError("truncated ClientHello")
        if i + 2 > len(body):
            return ""
        ext_end = i + 2 + int.from_bytes(body[i:i + 2], "big")
        if ext_end > len(body):
            raise ValueError("truncated extensions")
        i += 2
        while i + 4 <= ext_end:
            ext_type, ext_len = int.from_bytes(body[i:i + 2], "big"), int.from_bytes(body[i + 2:i + 4], "big")
            ext = body[i + 4:i + 4 + ext_len]
            if len(ext) != ext_len:
                raise ValueError("truncated extension")
            if ext_type == 0:           # server_name: list length, then (type 0 = host_name, length, name)
                if len(ext) < 5 or ext[2] != 0:
                    raise ValueError("bad server_name")
                name = ext[5:5 + int.from_bytes(ext[3:5], "big")]
                return name.decode("ascii", "strict").lower().rstrip(".")
            i += 4 + ext_len
        return ""
    except IndexError as exc:
        raise ValueError("truncated ClientHello") from exc


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
    grant = DECLARED_TCP.get((host, port)) if sep else None
    if grant is not None:
        return await declared_tunnel(reader, writer, peer, grant)
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
        hello, handshake = await read_client_hello(reader)
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


async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", LISTEN_PORT, limit=MAX_HEAD * 2)
    log(event="listening", port=LISTEN_PORT, exact=sorted(EXACT), suffixes=sorted(SUFFIXES))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
