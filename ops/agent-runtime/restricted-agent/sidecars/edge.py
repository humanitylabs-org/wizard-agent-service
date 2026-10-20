#!/usr/bin/env python3
"""Scoped gateway edge for a restricted agent.

Two listeners:

* GATEWAY (default :8923, reachable from the agent's internal network): the agent's only path to the
  Agent Service. A request is forwarded only when
    - it carries `Authorization: Bearer <token>` whose SHA-256 equals this agent's token hash, and
    - its method + path is on the small agent allowlist below, and
    - it has a Content-Length body (no chunked/pipelined smuggling).
  Everything else is answered here (401/403/400) and never reaches the service. Owner/identity
  headers (X-Wizard-*, Tailscale-*, X-Forwarded-*, Forwarded, Cookie) are dropped; only a fixed set
  of request headers is passed on. Header names must be HTTP tokens and values may not contain CR,
  LF or other control characters. One request per connection (`Connection: close` both ways).

* INGRESS (default :8642): a plain TCP relay so the host-side Agent Service can reach the agent's
  API server. The agent is on an internal network and cannot publish ports itself.

The service still authorizes the token itself (agent principal, own threads only); this edge makes
sure nothing the agent sends is ever seen by the service as anonymous or owner traffic.
"""
import asyncio
import hashlib
import hmac
import json
import os
import re
import sys
import time
from urllib.parse import urlsplit

UPSTREAM_HOST = os.environ["EDGE_UPSTREAM_HOST"]
UPSTREAM_PORT = int(os.environ.get("EDGE_UPSTREAM_PORT", "8923"))
AGENT_HOST = os.environ.get("EDGE_AGENT_HOST", "agent")
AGENT_PORT = int(os.environ.get("EDGE_AGENT_PORT", "8642"))
GATEWAY_PORT = int(os.environ.get("EDGE_GATEWAY_PORT", "8923"))
INGRESS_PORT = int(os.environ.get("EDGE_INGRESS_PORT", "8642"))
TOKEN_SHA256_FILE = os.environ.get("EDGE_TOKEN_SHA256_FILE", "/run/edge/token.sha256")
MAX_HEAD = 16384
MAX_BODY = 8 * 1024 * 1024
IDLE_TIMEOUT = 600

# (method set, compiled full-path regex). Paths are matched after strict validation (see clean_path).
ALLOW = [
    ({"GET", "POST", "DELETE"}, re.compile(r"/wizard/mcp/?")),
    ({"GET"}, re.compile(r"/wizard/v1/agent-context")),
]
PASS_HEADERS = {"content-type", "content-length", "accept", "authorization", "mcp-session-id",
                "mcp-protocol-version", "last-event-id", "user-agent", "idempotency-key"}
SAFE_PATH = re.compile(r"^/[A-Za-z0-9._~/-]*$")
# RFC 9110 token for header names and methods; header values may not carry CR, LF or other controls
# (a bare LF would let a second, forbidden header ride inside an allowed one).
TOKEN_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
BAD_VALUE = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")


def log(**fields):
    fields["ts"] = round(time.time(), 3)
    sys.stdout.write(json.dumps(fields, sort_keys=True) + "\n")
    sys.stdout.flush()


def load_hash():
    value = os.environ.get("EDGE_TOKEN_SHA256", "").strip().lower()
    if not value:
        with open(TOKEN_SHA256_FILE) as fh:
            value = fh.read().strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise SystemExit("edge: token hash file must hold one sha256 hex digest")
    return value


TOKEN_HASH = load_hash()


def clean_path(target):
    """Return (path, query) for an origin-form target, or None if it is anything unusual."""
    if not target.startswith("/") or target.startswith("//"):
        return None
    parts = urlsplit(target)
    path = parts.path
    # No percent-encoding, backslashes, dot segments or empty segments in the path at all.
    if not SAFE_PATH.match(path) or "//" in path:
        return None
    if any(seg in (".", "..") for seg in path.split("/")):
        return None
    if parts.query and not re.fullmatch(r"[A-Za-z0-9._~=&%-]*", parts.query):
        return None
    return path, parts.query


def token_ok(value):
    if not value or not value.startswith("Bearer "):
        return False
    token = value[7:].strip()
    if not token or len(token) > 512:
        return False
    digest = hashlib.sha256(token.encode()).hexdigest()
    return hmac.compare_digest(digest, TOKEN_HASH)


async def reply(writer, code, reason, **fields):
    log(decision="deny", code=code, reason=reason, **fields)
    body = json.dumps({"error": reason}).encode()
    writer.write(f"HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\n"
                 f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    try:
        await writer.drain()
    finally:
        writer.close()


async def relay(reader, writer):
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


async def gateway(reader, writer):
    peer = (writer.get_extra_info("peername") or ("?",))[0]
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError):
        writer.close()
        return
    if len(head) > MAX_HEAD:
        return await reply(writer, 431, "header too large", peer=peer)
    lines = head[:-4].decode("latin-1").split("\r\n")
    request = lines[0].split(" ")
    if len(request) != 3 or request[2] not in ("HTTP/1.1", "HTTP/1.0"):
        return await reply(writer, 400, "bad request line", peer=peer)
    method, target, _ = request
    if not TOKEN_RE.match(method) or BAD_VALUE.search(target):
        return await reply(writer, 400, "bad request line", peer=peer)
    headers = {}
    for line in lines[1:]:
        name, sep, value = line.partition(":")
        if not sep or not TOKEN_RE.match(name) or BAD_VALUE.search(value):
            return await reply(writer, 400, "bad header", peer=peer)
        key = name.lower()
        if key in headers and key in ("authorization", "content-length", "transfer-encoding", "host"):
            return await reply(writer, 400, "duplicate header", peer=peer, header=key)
        headers[key] = value.strip()
    if not token_ok(headers.get("authorization")):
        return await reply(writer, 401, "agent token required", peer=peer, method=method[:10])
    cleaned = clean_path(target)
    if cleaned is None:
        return await reply(writer, 400, "path not allowed", peer=peer, method=method[:10])
    path, query = cleaned
    if not any(method in methods and rx.fullmatch(path) for methods, rx in ALLOW):
        return await reply(writer, 403, "route not granted to agents", peer=peer, method=method, path=path[:200])
    if "transfer-encoding" in headers:
        return await reply(writer, 411, "chunked bodies are not accepted", peer=peer, path=path)
    try:
        length = int(headers.get("content-length", "0"))
    except ValueError:
        return await reply(writer, 400, "bad content-length", peer=peer)
    if length < 0 or length > MAX_BODY:
        return await reply(writer, 413, "body too large", peer=peer)
    try:
        body = await asyncio.wait_for(reader.readexactly(length), 60) if length else b""
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError):
        writer.close()
        return
    # Anything after the declared body (a pipelined second request) is never read or forwarded.
    out = [f"{method} {path}{'?' + query if query else ''} HTTP/1.1",
           f"Host: {UPSTREAM_HOST}:{UPSTREAM_PORT}", "Connection: close"]
    for key, value in headers.items():
        if key in PASS_HEADERS and key != "content-length":
            out.append(f"{key}: {value}")
    out.append(f"Content-Length: {len(body)}")
    try:
        up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(UPSTREAM_HOST, UPSTREAM_PORT), 15)
    except (OSError, asyncio.TimeoutError):
        return await reply(writer, 502, "agent service unavailable", peer=peer, path=path)
    up_writer.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1") + body)
    await up_writer.drain()
    log(decision="forward", peer=peer, method=method, path=path, bytes=len(body))
    await relay(up_reader, writer)
    up_writer.close()


async def ingress(reader, writer):
    try:
        up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(AGENT_HOST, AGENT_PORT), 15)
    except (OSError, asyncio.TimeoutError):
        writer.close()
        return
    await asyncio.gather(relay(reader, up_writer), relay(up_reader, writer))


async def main():
    gw = await asyncio.start_server(gateway, "0.0.0.0", GATEWAY_PORT, limit=MAX_HEAD * 2)
    ing = await asyncio.start_server(ingress, "0.0.0.0", INGRESS_PORT)
    log(event="listening", gateway=GATEWAY_PORT, ingress=INGRESS_PORT, upstream=f"{UPSTREAM_HOST}:{UPSTREAM_PORT}",
        routes=[f"{sorted(m)} {rx.pattern}" for m, rx in ALLOW])
    async with gw, ing:
        await asyncio.gather(gw.serve_forever(), ing.serve_forever())


if __name__ == "__main__":
    asyncio.run(main())
