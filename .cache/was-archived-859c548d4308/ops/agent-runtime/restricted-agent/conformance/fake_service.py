#!/usr/bin/env python3
"""Stand-in Agent Service for conformance runs. Answers every request with 200 and records the
method, path and headers it received (one JSON line per request) so the harness can prove which
requests the edge let through and which headers survived."""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get("FAKE_LOG", "/tmp/requests.jsonl")


def plant_canaries():
    """Stand-in 'host' secrets inside this container only (tmpfs); the agent must never see them."""
    canary = os.environ.get("FAKE_CANARY", "")
    for path, body in (("/tmp/host-home/canary.txt", f"synthetic host-home file {canary}\n"),
                       ("/tmp/host-home/.ssh/id_ed25519", f"-----BEGIN SYNTHETIC TEST KEY-----\n{canary}\n"),
                       ("/tmp/control-plane/secrets.env", f"WIZARD_SERVICE_SECRET={canary}\n")):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(body)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        record = {"ts": time.time(), "method": self.command, "path": self.path,
                  "headers": {k.lower(): v for k, v in self.headers.items()}, "body_bytes": len(body)}
        with open(LOG, "a") as fh:
            fh.write(json.dumps(record) + "\n")
        out = json.dumps({"fake_service": True, "path": self.path,
                          "headers_seen": sorted(record["headers"])}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = _handle

    def log_message(self, *args):
        sys.stderr.write("fake-service " + (args[0] % args[1:]) + "\n")


def host_listener(port):
    """Synthetic host service on the Docker host's own network stack (network_mode: host), on every
    host address. It greets each connection with the canary, so any connection the agent manages to
    open is visible in the receipts."""
    import socketserver

    class Greeter(socketserver.BaseRequestHandler):
        def handle(self):
            sys.stderr.write(f"host-listener connection from {self.client_address[0]}\n")
            self.request.sendall(f"synthetic host service {os.environ.get('FAKE_CANARY', '')}\n".encode())

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer(("0.0.0.0", port), Greeter).serve_forever()


if __name__ == "__main__":
    if os.environ.get("FAKE_MODE") == "host-listener":
        host_listener(int(os.environ.get("FAKE_PORT", "18923")))
    plant_canaries()
    ThreadingHTTPServer(("0.0.0.0", 8923), Handler).serve_forever()
