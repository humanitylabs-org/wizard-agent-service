#!/usr/bin/env python3
"""Wizard OS agent runtime: the host half of spec/AGENTS.md section 2.

The Agent Service owns agents/<id>/agent.json, home/config.yaml and home/.env (no provider keys). This helper
is the only piece that touches the container runtime. It runs on the host (loopback, bearer token) because the
Agent Service never gets the Docker socket.

    POST /agents/<id>/apply    package + install (first time) or restart with the current config
    POST /agents/<id>/start    start the agent's container
    POST /agents/<id>/stop     stop it
    POST /agents/<id>/deliver  assistant-only message into the agent's own session store (app deliveries such as
                               recording recaps). `hermes` (the main agent) works when --main-container names the
                               main Hermes container.
    GET  /healthz

Drivers:
    runtipi  the real box path: a local-candidate package installed through the Wizard App Manager (wam) into
             Runtipi, then Runtipi's lifecycle API for start/stop. `--home-mount alongside` adds a Runtipi
             user-config override so the container mounts <agents-dir>/<id>/home (alongside boxes keep agents in
             ~/.wizard-os/agents, outside Runtipi's app-data).
    compose  plain `docker compose -p agent-<id>` (test boxes without Runtipi).

Errors are short symbolic codes; secrets are never returned or logged.
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,30}$")
STORE = "wizardapps"
DEFAULT_IMAGE = "ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2"
DEFAULT_PROXY_IMAGE = "ghcr.io/tinfoilsh/tinfoil-proxy:0.2.3"
LOCK = threading.Lock()


class RuntimeFailure(Exception):
    def __init__(self, code: str, status: int = 502):
        super().__init__(code)
        self.code = code
        self.status = status


# ---------------------------------------------------------------- docker

def docker(args: list[str], *, input_text: str | None = None, timeout: int = 900, check: bool = True) -> subprocess.CompletedProcess:
    sock = Path("/var/run/docker.sock")
    if sock.exists() and os.access(sock, os.W_OK):
        cmd = ["docker", *args]
    else:   # the owner is in the docker group but this login session is not (e.g. a systemd user unit)
        cmd = ["sg", "docker", "-c", shlex.join(["docker", *args])]
    run = subprocess.run(cmd, input=input_text, capture_output=True, text=True, timeout=timeout)
    if check and run.returncode:
        sys.stderr.write(f"[agent-runtime] docker {' '.join(args[:3])} failed: {run.stderr[-400:]}\n")
        raise RuntimeFailure("docker_failed")
    return run


def container_for(project: str, service: str) -> str:
    run = docker(["ps", "-q", "--filter", f"label=com.docker.compose.project={project}",
                  "--filter", f"label=com.docker.compose.service={service}"], timeout=60)
    ids = run.stdout.split()
    if not ids:
        raise RuntimeFailure("agent_not_running", 409)
    return ids[0]


# ---------------------------------------------------------------- agent folder

class Agents:
    def __init__(self, root: Path, tinfoil_key_file: Path | None):
        self.root = root.resolve()
        self.tinfoil_key_file = tinfoil_key_file

    def read(self, agent_id: str) -> dict:
        if not ID_RE.match(agent_id) or agent_id == "hermes":
            raise RuntimeFailure("agent_not_found", 404)
        try:
            agent = json.loads((self.root / agent_id / "agent.json").read_text())
        except (OSError, ValueError):
            raise RuntimeFailure("agent_not_found", 404) from None
        if agent.get("schema") != 1 or agent.get("id") != agent_id or (agent.get("runtime") or {}).get("kind") != "container":
            raise RuntimeFailure("agent_not_found", 404)
        port = (agent.get("runtime") or {}).get("port")
        if not isinstance(port, int) or not 1024 <= port <= 65535:
            raise RuntimeFailure("agent_invalid", 400)
        return agent

    def home(self, agent_id: str) -> Path:
        return self.root / agent_id / "home"

    def tinfoil_key(self) -> str:
        if not self.tinfoil_key_file:
            return ""
        try:
            text = self.tinfoil_key_file.read_text()
        except OSError:
            return ""
        for line in text.splitlines():   # a bare key, or an env file with TINFOIL_API_KEY=
            line = line.strip()
            if line.startswith("TINFOIL_API_KEY="):
                return line.split("=", 1)[1].strip().strip("'\"")
            if line and "=" not in line and not line.startswith("#"):
                return line
        return ""

    def add_provider_keys(self, agent: dict) -> None:
        """The Service writes home/.env without provider keys; add the ones this agent's provider needs."""
        env_path = self.home(agent["id"]) / ".env"
        try:
            lines = env_path.read_text().splitlines()
        except OSError:
            raise RuntimeFailure("agent_not_prepared", 409) from None
        lines = [line for line in lines if not line.startswith("TINFOIL_API_KEY=")]
        if (agent.get("model") or {}).get("provider") == "tinfoil":
            key = self.tinfoil_key()
            if not key:
                raise RuntimeFailure("provider_not_configured", 503)
            lines.append(f"TINFOIL_API_KEY={key}")
        tmp = env_path.with_name(f".env.tmp-{os.getpid()}")
        tmp.write_text("\n".join(lines) + "\n")
        os.chmod(tmp, 0o600)
        tmp.replace(env_path)


# ---------------------------------------------------------------- package

def service_names(agent: dict) -> tuple[str, str]:
    """Unique per agent: Runtipi puts every app on one shared network, where service names are DNS aliases."""
    app_id = agent["runtime"]["app_id"]
    return app_id, f"{app_id}-tinfoil"


def compose_doc(agent: dict, *, image: str, proxy_image: str, home_source: str, uid: int, gid: int, ports: bool) -> str:
    """Miguel's hermes-agent package shape (stock image, HERMES_HOME at /opt/data), API server instead of the
    dashboard, plus the Tinfoil attestation proxy as a sidecar the agent reaches by service name."""
    main, proxy = service_names(agent)
    hermes = {
        "image": image,
        "command": ["gateway", "run"],
        "stop_grace_period": "1m",
        "restart": "unless-stopped",   # a running agent comes back after a host reboot; `compose stop` keeps it stopped
        "volumes": [f"{home_source}:/opt/data"],
        "environment": {"HERMES_UID": str(uid), "HERMES_GID": str(gid)},
        "x-runtipi": {"is_main": True, "internal_port": 8642},
    }
    services = {main: hermes}
    if (agent.get("model") or {}).get("provider") == "tinfoil":
        hermes["depends_on"] = [proxy]
        services[proxy] = {
            "image": proxy_image,
            "command": ["--bind", "0.0.0.0", "--port", "3301", "--allowed-host", proxy, "--log-format", "json"],
            "restart": "unless-stopped",
            "read_only": True,
            "tmpfs": ["/tmp", "/root/.cache"],
            "security_opt": ["no-new-privileges:true"],
            "cap_drop": ["ALL"],
        }
    if ports:
        hermes["ports"] = [f"127.0.0.1:{agent['runtime']['port']}:8642"]
    doc = {"services": services, "x-runtipi": {"schema_version": 2, "overrides": []}}
    return json.dumps(doc, indent=2) + "\n"   # JSON is valid YAML; no PyYAML dependency


def config_doc(agent: dict, *, version: str) -> str:
    now_ms = int(time.time() * 1000)
    return json.dumps({
        "name": f"{agent['label']} (agent)",
        "id": agent["runtime"]["app_id"],
        "available": True,
        "short_desc": f"Agent: {agent['label']} on Hermes.",
        "author": "Wizard OS",
        "port": agent["runtime"]["port"],
        "categories": ["ai"],
        "description": "A Wizard OS agent instance: stock Hermes in its own container with its own home, chats and memory. Managed from the Agents app.",
        "tipi_version": 1,
        "version": version,
        "source": "https://github.com/humanitylabs-org/wizard-agent-service",
        "exposable": False,
        "supported_architectures": ["amd64", "arm64"],
        "created_at": now_ms,
        "updated_at": now_ms,
        "dynamic_config": True,
        "min_tipi_version": "4.8.0",
        "uid": 1000,
        "gid": 1000,
        "form_fields": [],
    }, indent=2) + "\n"


def wizard_md(agent: dict) -> str:
    return (
        "---\n"
        "spec: 0.2\n"
        f"id: {agent['runtime']['app_id']}\n"
        f"name: {json.dumps(agent['label'] + ' (agent)')}\n"
        "type: agent\n"
        "category: agent\n"
        f"summary: {json.dumps('Wizard OS agent instance ' + agent['id'] + ' (Agents app).')}\n"
        "runtime:\n"
        "  config: runtipi/config.json\n"
        "  compose: runtipi/docker-compose.yml\n"
        "---\n"
        f"# {agent['label']} (agent)\n\n"
        "Stock Hermes in its own container, managed by the Wizard OS Agents app (spec/AGENTS.md). Its chats, memory "
        "and skills stay in its own folder. Not an app: it has no window and no launcher tile.\n"
    )


# ---------------------------------------------------------------- drivers

class ComposeDriver:
    def __init__(self, agents: Agents, image: str, proxy_image: str):
        self.agents, self.image, self.proxy_image = agents, image, proxy_image

    def project(self, agent_id: str) -> str:
        return f"agent-{agent_id}"

    def _file(self, agent: dict) -> Path:
        home = self.agents.home(agent["id"])
        st = home.stat()
        path = self.agents.root / agent["id"] / "runtime" / "docker-compose.yml"
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_text(compose_doc(agent, image=self.image, proxy_image=self.proxy_image, home_source=str(home),
                                    uid=st.st_uid, gid=st.st_gid, ports=True))
        return path

    def apply(self, agent: dict) -> dict:
        self.agents.add_provider_keys(agent)
        path = self._file(agent)
        project = self.project(agent["id"])
        running = docker(["ps", "-q", "--filter", f"label=com.docker.compose.project={project}"], timeout=60).stdout.split()
        docker(["compose", "-p", project, "-f", str(path), "up", "-d", "--remove-orphans"], timeout=1800)
        if running:
            docker(["compose", "-p", project, "-f", str(path), "restart", service_names(agent)[0]], timeout=300)
        return {"ok": True, "driver": "compose", "project": project}

    def start(self, agent: dict) -> dict:
        self.agents.add_provider_keys(agent)
        docker(["compose", "-p", self.project(agent["id"]), "-f", str(self._file(agent)), "up", "-d"], timeout=1800)
        return {"ok": True}

    def stop(self, agent: dict) -> dict:
        docker(["compose", "-p", self.project(agent["id"]), "-f", str(self._file(agent)), "stop"], timeout=300)
        return {"ok": True}


class RuntipiDriver:
    """Local candidate through the real App Manager path (wizard-os-platform-contracts: host-dogfood-operations,
    'installing an unpublished local candidate'): same safety check, store layout, Runtipi install, apps.json."""

    def __init__(self, agents: Agents, image: str, proxy_image: str, wam_path: Path, home_mount: str):
        self.agents, self.image, self.proxy_image = agents, image, proxy_image
        self.home_mount = home_mount
        sys.path.insert(0, str(wam_path))
        from wam import cli, private  # noqa: PLC0415  (wam is Miguel's; imported, never edited)
        self.cli, self.private = cli, private

    def project(self, agent_id: str) -> str:
        return f"agent-{agent_id}_{STORE}"

    def urn(self, agent: dict) -> str:
        return f"{agent['runtime']['app_id']}:{STORE}"

    def _package(self, agent: dict) -> Path:
        pkg = self.agents.root / agent["id"] / "package"
        (pkg / "runtipi").mkdir(parents=True, exist_ok=True)
        stock_home = f"${{ROOT_FOLDER_HOST}}/app-data/wizard-os/agents/{agent['id']}/home"
        (pkg / "wizard.md").write_text(wizard_md(agent))
        (pkg / "runtipi" / "config.json").write_text(config_doc(agent, version=agent.get("runtime", {}).get("version") or "0.1.0"))
        (pkg / "runtipi" / "docker-compose.yml").write_text(
            compose_doc(agent, image=self.image, proxy_image=self.proxy_image, home_source=stock_home, uid=1000, gid=1000, ports=False))
        git = ["git", "-C", str(pkg), "-c", "user.name=Wizard OS", "-c", "user.email=agents@wizard.local"]
        if not (pkg / ".git").exists():
            subprocess.run(["git", "init", "-q", str(pkg)], check=True)
        subprocess.run([*git, "add", "-A"], check=True)
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", f"agent {agent['id']} package"], check=True, capture_output=True)
        return pkg

    def _override(self, agent: dict, rt) -> None:
        if self.home_mount != "alongside":
            return
        home = self.agents.home(agent["id"])
        st = home.stat()
        doc = {"services": {service_names(agent)[0]: {"volumes": [f"{home}:/opt/data"], "environment": {"HERMES_UID": str(st.st_uid), "HERMES_GID": str(st.st_gid)}}}}
        rt.req("PUT", f"/user-config/{self.urn(agent)}", {"dockerCompose": json.dumps(doc, indent=2) + "\n", "appEnv": ""})

    def _install(self, agent: dict) -> dict:
        pkg = self._package(agent)
        head = subprocess.run(["git", "-C", str(pkg), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        p = self.private
        saved = (p.token, p.head_commit, p.fetch, p.pull)
        p.token = lambda: "local-candidate"
        p.head_commit = lambda repo, tok: head
        p.fetch = lambda repo, commit, dest, tok: (Path(dest).mkdir(parents=True, exist_ok=True), subprocess.run(
            f"git -C {shlex.quote(str(pkg))} archive {commit} | tar -x -C {shlex.quote(str(dest))}", shell=True, check=True))
        p.pull = lambda image, tok: None
        try:
            return self.cli.install(self.cli.Config(), f"wizard-os-agents/{agent['runtime']['app_id']}", {})
        finally:
            p.token, p.head_commit, p.fetch, p.pull = saved

    def _installed(self, rt, agent: dict) -> bool:
        return agent["runtime"]["app_id"] in self.cli.installed_ids(rt)

    def apply(self, agent: dict) -> dict:
        self.agents.add_provider_keys(agent)
        rt = self.cli.Config().runtipi()
        self._override(agent, rt)
        if not self._installed(rt, agent):
            try:
                result = self._install(agent)
            except SystemExit as error:
                sys.stderr.write(f"[agent-runtime] wam install refused: {str(error)[:300]}\n")
                raise RuntimeFailure("install_refused") from None
            return {"ok": True, "driver": "runtipi", "install": {k: result.get(k) for k in ("id", "urn", "status")}}
        self.stop(agent)
        return self.start(agent)

    def start(self, agent: dict) -> dict:
        self.agents.add_provider_keys(agent)
        rt = self.cli.Config().runtipi()
        rt.req("POST", f"/app-lifecycle/{self.urn(agent)}/start", {}, timeout=300)
        status = rt.wait_status(self.urn(agent), {"running"}, timeout=600)
        if status != "running":
            raise RuntimeFailure(f"start_{status}"[:60])
        return {"ok": True, "status": status}

    def stop(self, agent: dict) -> dict:
        rt = self.cli.Config().runtipi()
        rt.req("POST", f"/app-lifecycle/{self.urn(agent)}/stop", {}, timeout=300)
        status = rt.wait_status(self.urn(agent), {"stopped"}, timeout=300)
        return {"ok": status == "stopped", "status": status}


# ---------------------------------------------------------------- delivery (runs inside the agent container)

DELIVER_SCRIPT = r'''
import hashlib, json, re, sqlite3, sys
sys.path.insert(0, "/opt/hermes")
from hermes_state import SessionDB
p = json.load(sys.stdin)
sid, key, body, title, meta = p["session_id"], p["delivery_key"], p["body"], p["title"], p.get("display_metadata") or {}
def recap(text):
    m = re.search(r"\n\n\[WIZARD_STATUS_V1\][^\n]*?\[/WIZARD_STATUS_V1\]\s*$", text)
    return text[:m.start()] if m else text
db = SessionDB()
path = str(db.db_path)
try:
    if not db.get_session(sid):
        db.create_session(sid, "api_server", model=p.get("model"))
        try:
            db.set_session_title(sid, title)
        except ValueError:
            db.set_session_title(sid, title[:24].rstrip() + " · " + hashlib.sha256(sid.encode()).hexdigest()[:6])
    tip = db.get_compression_tip(sid) or sid
    with sqlite3.connect(path) as conn:
        rows = conn.execute("SELECT id,role,content,display_metadata FROM messages WHERE platform_message_id=?", (key,)).fetchall()
    if len(rows) > 1:
        raise SystemExit("duplicate_delivery_key")
    if rows:
        mid, role, saved, saved_meta = rows[0]
        saved_meta = json.loads(saved_meta or "{}")
        if role != "assistant" or recap(saved) != recap(body) or any(saved_meta.get(k) != v for k, v in meta.items() if k in ("report_id", "source_sha256", "provider", "model")):
            raise SystemExit("delivery_conflict")
        body = saved
    else:
        mid = db.append_message(tip, "assistant", body, platform_message_id=key, display_metadata=meta)
        db.set_session_hidden(tip, False); db.set_session_archived(tip, False); db.set_session_read(tip, False); db.touch_session_activity(tip)
    with sqlite3.connect(path) as conn:
        saved = conn.execute("SELECT role,content FROM messages WHERE id=?", (mid,)).fetchone()
    if tuple(saved) != ("assistant", body):
        raise SystemExit("readback_mismatch")
    print(json.dumps({"verified": True, "already_delivered": bool(rows), "session_id": tip, "message_id": mid, "title": db.get_session(tip).get("title")}))
finally:
    db.close()
'''


def deliver(driver, agent: dict, payload: dict, *, container: str = "") -> dict:
    need = {"session_id": str, "delivery_key": str, "body": str, "title": str}
    for name, kind in need.items():
        if not isinstance(payload.get(name), kind) or not payload[name]:
            raise RuntimeFailure(f"invalid_{name}", 400)
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,120}", payload["session_id"]) or len(payload["body"]) > 400_000:
        raise RuntimeFailure("invalid_payload", 400)
    meta = payload.get("display_metadata") if isinstance(payload.get("display_metadata"), dict) else {}
    clean = {"session_id": payload["session_id"], "delivery_key": payload["delivery_key"][:200], "body": payload["body"],
             "title": payload["title"][:60], "display_metadata": meta, "model": (agent.get("model") or {}).get("model")}
    cid = container or container_for(driver.project(agent["id"]), service_names(agent)[0])
    run = docker(["exec", "-i", "-u", "hermes", cid, "/opt/hermes/.venv/bin/python", "-c", DELIVER_SCRIPT],
                 input_text=json.dumps(clean), timeout=120, check=False)
    if run.returncode:
        code = (run.stderr.strip().splitlines() or ["delivery_failed"])[-1]
        raise RuntimeFailure(code if re.fullmatch(r"[a-z_]{3,40}", code) else "delivery_failed")
    return json.loads(run.stdout.strip().splitlines()[-1])


# ---------------------------------------------------------------- HTTP

def make_handler(token: str, agents: Agents, driver, main_container: str = ""):
    class Handler(BaseHTTPRequestHandler):
        server_version = "wizard-agent-runtime"

        def log_message(self, fmt, *args):  # no request logging (paths only, never bodies)
            sys.stderr.write("[agent-runtime] " + (fmt % args)[:200] + "\n")

        def _json(self, code: int, obj: dict) -> None:
            raw = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):  # noqa: N802
            if self.path == "/healthz":
                self._json(200, {"ok": True})
            else:
                self._json(404, {"error": "not_found"})

        def do_POST(self):  # noqa: N802
            auth = self.headers.get("Authorization", "")
            if not hmac.compare_digest(auth.encode(), f"Bearer {token}".encode()):
                self._json(401, {"error": "unauthorized"})
                return
            m = re.fullmatch(r"/agents/([a-z][a-z0-9-]{0,30})/(apply|start|stop|deliver)", self.path)
            if not m:
                self._json(404, {"error": "not_found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length > 512 * 1024:
                self._json(413, {"error": "too_large"})
                return
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._json(400, {"error": "invalid_json"})
                return
            agent_id, action = m.groups()
            try:
                if agent_id == "hermes" and action == "deliver":
                    # The main agent is not an agent folder; it is delivered to only when the box names its container.
                    if not main_container:
                        raise RuntimeFailure("main_delivery_unavailable", 503)
                    self._json(200, deliver(driver, {"id": "hermes", "model": {}}, payload, container=main_container))
                    return
                agent = agents.read(agent_id)
                if action == "deliver":
                    self._json(200, deliver(driver, agent, payload))
                    return
                with LOCK:
                    result = getattr(driver, action)(agent)
                self._json(200, result)
            except RuntimeFailure as error:
                self._json(error.status, {"error": error.code})
            except Exception as error:  # noqa: BLE001
                sys.stderr.write(f"[agent-runtime] {action} {agent_id} failed: {type(error).__name__}: {str(error)[:300]}\n")
                self._json(502, {"error": "runtime_failed"})

    return Handler


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--agents-dir", required=True, type=Path)
    ap.add_argument("--token-file", required=True, type=Path)
    ap.add_argument("--port", type=int, default=7795)
    ap.add_argument("--driver", choices=["runtipi", "compose"], default="runtipi")
    ap.add_argument("--wam", type=Path, help="wizard-app-manager checkout (runtipi driver)")
    ap.add_argument("--home-mount", choices=["alongside", "stock"], default="alongside")
    ap.add_argument("--tinfoil-key-file", type=Path)
    ap.add_argument("--image", default=DEFAULT_IMAGE)
    ap.add_argument("--proxy-image", default=DEFAULT_PROXY_IMAGE)
    ap.add_argument("--main-container", default="", help="main Hermes container name (enables deliveries to the main agent)")
    args = ap.parse_args(argv)
    token = args.token_file.read_text().strip()
    if len(token) < 24:
        raise SystemExit("token file must hold a random token of at least 24 characters")
    agents = Agents(args.agents_dir, args.tinfoil_key_file)
    if args.driver == "runtipi":
        if not args.wam:
            raise SystemExit("--wam is required for the runtipi driver")
        driver = RuntipiDriver(agents, args.image, args.proxy_image, args.wam, args.home_mount)
    else:
        driver = ComposeDriver(agents, args.image, args.proxy_image)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(token, agents, driver, args.main_container))
    sys.stderr.write(f"[agent-runtime] {args.driver} driver on 127.0.0.1:{args.port}, agents in {agents.root}\n")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
