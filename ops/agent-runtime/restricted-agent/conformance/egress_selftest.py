#!/usr/bin/env python3
"""Self-test of the egress sidecar's TLS gate, run on the Docker host before the containers start.

Uses the real sidecars/egress.py functions and its real `handle()` against a local recording upstream
(public-address vetting is stubbed to 127.0.0.1 so no internet is needed). Proves:
  - a valid ClientHello split across TLS records is reassembled and accepted (R2-N3);
  - truncated / non-TLS input is refused;
  - a refused tunnel never opens an upstream connection, so no forbidden byte reaches it, and the
    client receives the gate's access_denied alert (R2-N2).
Prints one JSON document; exit 1 on any failure."""
import asyncio
import importlib.util
import json
import os
import ssl
import sys

os.environ.setdefault("EGRESS_ALLOWLIST_HOSTS", "en.wikipedia.org")
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("egress", os.path.join(HERE, "..", "sidecars", "egress.py"))
eg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eg)
GATE_LOG = []
eg.log = lambda **fields: GATE_LOG.append(fields)   # keep the gate's own JSON log out of stdout
CHECKS = []


def check(cid, desc, ok, evidence=""):
    CHECKS.append({"id": cid, "check": desc, "pass": bool(ok), "evidence": str(evidence)[:300]})


def client_hello(name):
    ctx = ssl.create_default_context()
    if name is None:
        ctx.check_hostname = False
    i, o = ssl.MemoryBIO(), ssl.MemoryBIO()
    obj = ctx.wrap_bio(i, o, server_hostname=name)
    try:
        obj.do_handshake()
    except ssl.SSLWantReadError:
        pass
    return o.read()


def fragment(record, cut):
    """Split one handshake record into two valid handshake records after `cut` handshake bytes."""
    hs = record[5:]
    a, b = hs[:cut], hs[cut:]
    return (bytes([0x16, 0x03, 0x01]) + len(a).to_bytes(2, "big") + a
            + bytes([0x16, 0x03, 0x01]) + len(b).to_bytes(2, "big") + b)


async def parse(data):
    reader = asyncio.StreamReader()
    reader.feed_data(data)
    reader.feed_eof()
    raw, hs = await eg.read_client_hello(reader)
    return raw, (eg.client_hello_sni(hs) if hs is not None else None)


async def run_gate(payload, eof=False):
    """Drive the real handle(): CONNECT en.wikipedia.org:443, then `payload`. Returns (client reply after
    the 200 line, bytes the upstream received, upstream connection count)."""
    got, conns = bytearray(), []

    async def upstream(r, w):
        conns.append(1)
        try:
            while True:
                chunk = await asyncio.wait_for(r.read(65536), 3)
                if not chunk:
                    break
                got.extend(chunk)
        except asyncio.TimeoutError:
            pass
        w.close()

    up = await asyncio.start_server(upstream, "127.0.0.1", 0)
    up_port = up.sockets[0].getsockname()[1]
    real_open = asyncio.open_connection
    eg.public_addresses = lambda host: ["127.0.0.1"]
    eg.asyncio.open_connection = lambda host, port, **kw: real_open("127.0.0.1", up_port, **kw)
    gate = await asyncio.start_server(eg.handle, "127.0.0.1", 0)
    r, w = await real_open("127.0.0.1", gate.sockets[0].getsockname()[1])
    w.write(b"CONNECT en.wikipedia.org:443 HTTP/1.1\r\nHost: en.wikipedia.org:443\r\n\r\n")
    await w.drain()
    status = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 5)
    w.write(payload)
    await w.drain()
    if eof:
        w.write_eof()   # client gives up mid-hello
    try:
        reply = await asyncio.wait_for(r.read(64), 5)
    except asyncio.TimeoutError:
        reply = b"<timeout>"
    await asyncio.sleep(0.5)
    w.close()
    eg.asyncio.open_connection = real_open
    gate.close()
    up.close()
    return status.split(b"\r\n")[0], reply, bytes(got), len(conns)


async def main():
    good = client_hello("en.wikipedia.org")
    raw, sni = await parse(good)
    check("G1", "single-record ClientHello: SNI read, bytes kept intact", sni == "en.wikipedia.org" and raw == good, sni)
    for cut in (10, 40, 120):
        frag = fragment(good, cut)
        raw, sni = await parse(frag)
        check(f"G2-{cut}", f"ClientHello split across records after {cut} bytes is reassembled",
              sni == "en.wikipedia.org" and raw == frag, sni)
    for name, data in (("truncated record", good[:60]), ("truncated handshake", fragment(good, 40)[:80])):
        try:
            res = await parse(data)
            check("G3-" + name, f"{name} is refused", False, res)
        except (asyncio.IncompleteReadError, ValueError) as e:
            check("G3-" + name, f"{name} is refused", True, type(e).__name__)
    raw, sni = await parse(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
    check("G4", "non-TLS bytes are recognised as not TLS", sni is None, sni)
    raw, sni = await parse(client_hello(None))
    check("G5", "ClientHello without SNI yields empty name", sni == "", sni)

    # Real handle(): allowed SNI passes through intact; refused tunnels never reach the upstream.
    status, reply, got, conns = await run_gate(fragment(good, 40))
    check("G6", "gate forwards a fragmented allowlisted ClientHello byte-for-byte",
          b"200" in status and got == fragment(good, 40) and conns == 1, {"conns": conns, "bytes": len(got)})
    for cid, desc, payload in (("G7", "SNI for an unlisted site", client_hello("example.com")),
                               ("G8", "raw non-TLS bytes", b"GET / HTTP/1.1\r\nHost: en.wikipedia.org\r\n\r\n"),
                               ("G9", "truncated ClientHello", good[:60])):
        status, reply, got, conns = await run_gate(payload, eof=cid == "G9")
        check(cid, f"gate refuses {desc}: access_denied alert, upstream never connected, nothing forwarded",
              b"200" in status and reply == eg.DENY_ALERT and conns == 0 and not got,
              {"reply": reply.hex(), "upstream_conns": conns, "upstream_bytes": len(got)})


asyncio.run(main())
print(json.dumps({"summary": {"total": len(CHECKS), "passed": sum(c["pass"] for c in CHECKS),
                              "failed": [c["id"] for c in CHECKS if not c["pass"]]}, "checks": CHECKS}, indent=1))
sys.exit(0 if all(c["pass"] for c in CHECKS) else 1)
