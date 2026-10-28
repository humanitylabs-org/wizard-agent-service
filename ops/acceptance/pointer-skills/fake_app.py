#!/usr/bin/env python3
"""A DeFleur-shaped Wizard app for the pointer-skill acceptance run: a stock-shaped streamable-HTTP MCP server
(JSON responses, session id on initialize) whose tools make short-form video. It renders nothing; it only records
which tool the agent called, so the run can judge routing. Stdlib only.

Env: PORT (default 8799), CALL_LOG (jsonl, default /log/calls.jsonl).
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8799"))
CALL_LOG = os.environ.get("CALL_LOG", "/log/calls.jsonl")
TOOLS = [
    {"name": "create_short", "description": "Make a short-form vertical video from a source clip in the owner's Files. "
     "Returns a job id; the finished short is saved under Videos/Edited.",
     "inputSchema": {"type": "object", "properties": {
         "source": {"type": "string", "description": "Path of the source clip, relative to the owner's Files root."},
         "brief": {"type": "string", "description": "Optional: what the short should focus on."}},
         "required": ["source"]}},
    {"name": "job_status", "description": "Status of a create_short job.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"]}},
    {"name": "list_styles", "description": "Caption and pacing styles the editor offers.",
     "inputSchema": {"type": "object", "properties": {}}},
]


def log(entry):
    with open(CALL_LOG, "a") as f:
        f.write(json.dumps({"t": time.time(), **entry}) + "\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj=None, headers=None):
        body = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True})
        self._send(405, {"error": "POST only"})

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        log({"method": msg.get("method"), "params": msg.get("params") if msg.get("method") == "tools/call" else None})
        if "id" not in msg:
            return self._send(202)
        ok = lambda result: self._send(200, {"jsonrpc": "2.0", "id": msg["id"], "result": result}, {"Mcp-Session-Id": "app-s1"})
        method = msg.get("method")
        if method == "initialize":
            return ok({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "defleur-video-fake"}})
        if method == "tools/list":
            return ok({"tools": TOOLS})
        if method == "tools/call":
            name = (msg.get("params") or {}).get("name")
            args = (msg.get("params") or {}).get("arguments") or {}
            if name == "create_short":
                text = f"Started job dv-0001 for {args.get('source', '?')}. The short will be saved as Videos/Edited/short-0001.mp4."
            elif name == "job_status":
                text = "Job dv-0001: rendering, about two minutes left."
            else:
                text = "Styles: punchy, calm, captions-only."
            return ok({"content": [{"type": "text", "text": text}]})
        self._send(200, {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "unknown method"}})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
