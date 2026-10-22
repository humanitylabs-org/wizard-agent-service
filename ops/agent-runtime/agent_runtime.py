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
import hashlib
import fcntl
from contextlib import contextmanager
import hmac
import ipaddress
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import threading
import time
from offline_index import snapshot as index_snapshot
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,30}$")
STORE = "wizardapps"
DEFAULT_IMAGE = "ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2"
DEFAULT_PROXY_IMAGE = "ghcr.io/tinfoilsh/tinfoil-proxy:0.2.3"
# The restricted runtime (wizard-app-store runtimes/restricted-agent, vendored unchanged; see SOURCE.txt).
RESTRICTED_DIR = Path(__file__).resolve().parent / "restricted-agent"
RESTRICTED_SERVICE = "agent"
AGENT_UID = 10000                      # the restricted runtime's agent user (compose.yml, home-init.sh)
MANAGED_FILES = (".env", "config.yaml")
SIDECAR_IMAGE = os.environ.get("WIZARD_AGENT_SIDECAR_IMAGE", "restricted-agent-sidecars:local")  # owner-selected, preloaded only
UPLINK_POOL = ipaddress.ip_network("10.250.0.0/16")
SANDBOX_POOL = ipaddress.ip_network("10.251.0.0/16")
LOCK = threading.Lock()   # the Runtipi/compose drivers: one lifecycle action at a time (they patch shared module state)
_AGENT_LOCKS: dict = {}
_AGENT_LOCKS_GUARD = threading.Lock()


def agent_lock(agent_id: str) -> threading.Lock:
    """One lifecycle lock per restricted agent: a slow or stuck agent never holds up the others."""
    with _AGENT_LOCKS_GUARD:
        return _AGENT_LOCKS.setdefault(agent_id, threading.Lock())


def lifecycle_lock(chosen, restricted_driver, agent_id: str) -> threading.Lock:
    """Restricted agents share no state between lifecycle actions, so they lock per agent; every other driver
    keeps the global lock (RuntipiDriver._install patches process-wide wam.private functions)."""
    return agent_lock(agent_id) if restricted_driver is not None and chosen is restricted_driver else LOCK


class RuntimeFailure(Exception):
    def __init__(self, code: str, status: int = 502):
        super().__init__(code)
        self.code = code
        self.status = status


@contextmanager
def import_process_lock(agents, agent_id):
    """Same OS lock as the owner import/undo CLI, outside the sealed home."""
    folder = agents.root / agent_id
    fd = os.open(folder / '.lifecycle.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


# ---------------------------------------------------------------- docker

def docker(args: list[str], *, input_text: str | None = None, timeout: int = 900, check: bool = True,
           env: dict | None = None) -> subprocess.CompletedProcess:
    sock = Path("/var/run/docker.sock")
    if sock.exists() and os.access(sock, os.W_OK):
        cmd = ["docker", *args]
    else:   # the owner is in the docker group but this login session is not (e.g. a systemd user unit)
        cmd = ["sg", "docker", "-c", shlex.join(["docker", *args])]
    run = subprocess.run(cmd, input=input_text, capture_output=True, text=True, timeout=timeout,
                         env={**os.environ, **env} if env else None)
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

    def managed(self, agent_id: str) -> Path:
        """Where the Service writes a restricted agent's managed files (.env, config.yaml); synced into its home."""
        return self.root / agent_id / "managed"

    def add_provider_keys(self, agent: dict) -> None:
        """The Service writes .env without provider keys; add the ones this agent's provider needs."""
        env_path = (self.managed(agent["id"]) if restricted(agent) else self.home(agent["id"])) / ".env"
        try:
            lines = env_path.read_text().splitlines()
        except PermissionError:
            raise RuntimeFailure("agent_home_not_writable", 409) from None
        except OSError:
            raise RuntimeFailure("agent_not_prepared", 409) from None
        lines = [line for line in lines if not line.startswith("TINFOIL_API_KEY=")]
        if (agent.get("model") or {}).get("provider") == "tinfoil":
            key = self.tinfoil_key()
            if not key:
                raise RuntimeFailure("provider_not_configured", 503)
            lines.append(f"TINFOIL_API_KEY={key}")
        tmp = env_path.with_name(f".env.tmp-{os.getpid()}")
        try:
            tmp.write_text("\n".join(lines) + "\n")
        except PermissionError:   # a restricted agent's home belongs to its container user after the first start
            raise RuntimeFailure("agent_home_not_writable", 409) from None
        os.chmod(tmp, 0o600)
        tmp.replace(env_path)


    def secret(self, agent_id: str, name: str) -> str:
        try:
            return (self.root / agent_id / name).read_text().strip()
        except OSError:
            return ""


def restricted(agent: dict) -> bool:
    return (agent.get("runtime") or {}).get("isolation") == "restricted"


def agent_networks(agent: dict) -> tuple[ipaddress.IPv4Network, ipaddress.IPv4Network]:
    """The agent's own /28 pair, as allocated by the Agent Service; anything else is refused."""
    network = (agent.get("runtime") or {}).get("network") or {}
    try:
        uplink = ipaddress.ip_network(str(network.get("uplink")), strict=True)
        sandbox = ipaddress.ip_network(str(network.get("sandbox")), strict=True)
    except ValueError:
        raise RuntimeFailure("agent_network_invalid", 400) from None
    if uplink.prefixlen != 28 or sandbox.prefixlen != 28 or not uplink.subnet_of(UPLINK_POOL) or not sandbox.subnet_of(SANDBOX_POOL):
        raise RuntimeFailure("agent_network_invalid", 400)
    return uplink, sandbox


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


class RestrictedDriver:
    """Runs an agent in the restricted runtime: the vendored compose file unchanged, configured by environment
    (README environment contract). Kept off Runtipi's shared network; the compose project holds the agent and its
    sidecars, so stop/start act on all of them."""

    def __init__(self, agents: Agents, runtime_dir: Path, image: str, listener_port: int):
        self.agents, self.image, self.listener_port = agents, image, listener_port
        self.runtime_dir = runtime_dir.resolve()
        self.compose_file = self.runtime_dir / "compose.yml"
        verify_vendored(self.runtime_dir)

    def project(self, agent_id: str) -> str:
        return f"agent-{agent_id}"

    def env(self, agent: dict) -> dict:
        uplink, sandbox = agent_networks(agent)
        import declared_egress
        try:
            grants = declared_egress.validate(agent['runtime'].get('declared_tcp', []))
        except (ValueError, TypeError):
            raise RuntimeFailure('declared_tcp_invalid', 409) from None
        if grants and not agent.get('imported'):
            raise RuntimeFailure('declared_tcp_import_required', 409)
        api_key = self.agents.secret(agent["id"], "runtime.key")
        gateway_key = self.agents.secret(agent["id"], "gateway.key")
        if not api_key or not gateway_key:
            raise RuntimeFailure("agent_not_prepared", 409)
        env = {
            "AGENT_PROJECT": self.project(agent["id"]),
            "AGENT_HOME_VOLUME": str(self.agents.home(agent["id"])),
            "AGENT_API_KEY": api_key,
            "EDGE_TOKEN_SHA256": hashlib.sha256(gateway_key.encode()).hexdigest(),
            "AGENT_UPLINK_SUBNET": str(uplink),
            "AGENT_SANDBOX_SUBNET": str(sandbox),
            "AGENT_INGRESS_BIND": f"127.0.0.1:{agent['runtime']['port']}",
            "EDGE_UPSTREAM_HOST": str(next(uplink.hosts())),
            "EDGE_UPSTREAM_PORT": str(self.listener_port),
            "EGRESS_DECLARED_TCP": json.dumps(grants, separators=(',', ':')),
            "EGRESS_TCP_RELAY_HOST": str(next(uplink.hosts())) if grants else '',
            "SIDECAR_IMAGE": SIDECAR_IMAGE,   # the same image sync_home runs, whatever the compose default becomes
        }
        image = agent["runtime"].get("image") if agent.get("imported") else self.image
        if image:
            env["AGENT_IMAGE"] = image
        return env

    def _compose(self, agent: dict, *args: str, timeout: int) -> subprocess.CompletedProcess:
        files = ["-f", str(self.compose_file)]
        override = self.agents.root / agent["id"] / "import-runtime.json"
        if agent.get('imported') and override.is_file():
            files += ["-f", str(override)]
        return docker(["compose", "-p", self.project(agent["id"]), *files, *args],
                      timeout=timeout, env=self.env(agent))

    def sync_home(self, agent: dict) -> None:
        """Copy the Service-managed files into the agent-owned home: a one-shot, no-network, read-only container with
        only the file capabilities, like the runtime's own home-init. The host never writes into the home itself."""
        managed = self.agents.managed(agent["id"])
        missing = [name for name in MANAGED_FILES if not (managed / name).is_file()]
        if missing:
            raise RuntimeFailure("agent_not_prepared", 409)
        home = self.agents.home(agent["id"])
        home.mkdir(mode=0o700, exist_ok=True)
        # Only ever called with the agent stopped (see _prepare), so nothing in the home changes underneath us. The
        # agent controlled it before, so nothing there is trusted: each file is written into a fresh directory made
        # by mktemp (exclusive, root-owned 0700, unpredictable name), then renamed over the target. rename(2)
        # replaces a planted symlink or FIFO instead of following or opening it; a planted directory makes the sync
        # fail, which only stops that agent.
        copy = "; ".join(f'cp /managed/{name} "$tmp/{name}"; chown {AGENT_UID}:{AGENT_UID} "$tmp/{name}"; chmod 600 "$tmp/{name}";'
                         f' mv -T -f "$tmp/{name}" /opt/data/{name}' for name in MANAGED_FILES)
        script = (f'set -eu; umask 077; tmp=$(mktemp -d /opt/data/.wizard-sync.XXXXXXXX); trap \'rm -rf "$tmp"\' EXIT; {copy};'
                  f' chown {AGENT_UID}:{AGENT_UID} /opt/data; chmod 700 /opt/data')
        name = f"{self.project(agent['id'])}-sync-{secrets.token_hex(4)}"
        try:
            docker(["run", "--rm", "--name", name, "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL",
                    "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges:true",
                    "-v", f"{home}:/opt/data", "-v", f"{managed}:/managed:ro", "--entrypoint", "/bin/sh", SIDECAR_IMAGE,
                    "-c", script], timeout=120)
        except subprocess.TimeoutExpired:
            # Killing the docker client leaves the container running: remove it, then fail this agent only.
            docker(["rm", "-f", name], timeout=60, check=False)
            raise RuntimeFailure("agent_sync_timeout", 504)

    def _prepare(self, agent: dict) -> None:
        if (agent.get("model") or {}).get("provider") == "tinfoil":
            # No Tinfoil attestation sidecar in the restricted runtime yet; the Service refuses this too.
            raise RuntimeFailure("restricted_provider_unsupported", 409)
        if agent["runtime"].get("admission") == "importing":
            raise RuntimeFailure("agent_import_in_progress", 409)
        if agent.get('imported'):
            if agent['runtime'].get('declared_tcp'):
                self.env(agent)  # validate policy before any start or helper
                expected = hashlib.sha256((self.runtime_dir / 'sidecars/egress.py').read_bytes()).hexdigest()
                code = 'import hashlib; print(hashlib.sha256(open("/srv/egress.py","rb").read()).hexdigest())'
                actual = docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                                 '--security-opt', 'no-new-privileges:true', '--user', '65534:65534',
                                 '--entrypoint', 'python3', SIDECAR_IMAGE, '-c', code], timeout=30).stdout.strip()
                if actual != expected:
                    raise RuntimeFailure('declared_tcp_image_mismatch', 409)
            docker(["image", "inspect", SIDECAR_IMAGE], timeout=30)
            docker(["image", "inspect", agent["runtime"].get("image") or self.image], timeout=30)
            refresh = self.agents.root / agent["id"] / "import-update.json"
            if refresh.is_file():
                command = ["uv", "run", "--offline", "--no-project", "--with", "PyYAML>=6.0.2,<7", "--with", "python-dotenv>=1,<2", "python"]
                result = subprocess.run([*command, str(Path(__file__).with_name('hermes_import.py')), 'refresh-managed',
                                         str(self.agents.root / agent["id"])], capture_output=True, text=True, timeout=60)
                if result.returncode:
                    raise RuntimeFailure("import_harness_update_failed")
        else:
            self.agents.add_provider_keys(agent)
            self._compose(agent, "build", timeout=1800)
        # A running agent could swap paths in its home while the root helper works there, so stop it first; `up`
        # starts it again with the new files.
        self._compose(agent, "stop", RESTRICTED_SERVICE, timeout=300)
        self.sync_home(agent)

    def apply(self, agent: dict) -> dict:
        self._prepare(agent)
        project = self.project(agent["id"])
        self._compose(agent, "up", "-d", "--remove-orphans", timeout=1800)
        return {"ok": True, "driver": "restricted", "project": project}

    def start(self, agent: dict) -> dict:
        self._prepare(agent)
        self._compose(agent, "up", "-d", timeout=1800)
        return {"ok": True}

    def stop(self, agent: dict) -> dict:
        self._compose(agent, "stop", timeout=300)
        return {"ok": True}


def verify_vendored(runtime_dir: Path) -> None:
    """The runtime is used exactly as reviewed: every file listed in SOURCE.txt must match its digest."""
    try:
        lines = (runtime_dir / "SOURCE.txt").read_text().splitlines()
    except OSError:
        raise SystemExit("restricted runtime: SOURCE.txt missing") from None
    listed = [line.split("  ", 1) for line in lines if re.fullmatch(r"[0-9a-f]{64}  \./\S+", line)]
    if not any(name == "./compose.yml" for _, name in listed):
        raise SystemExit("restricted runtime: compose.yml is not listed in SOURCE.txt")
    for digest, name in listed:
        try:
            actual = hashlib.sha256((runtime_dir / name).read_bytes()).hexdigest()
        except OSError:
            raise SystemExit(f"restricted runtime: {name} missing") from None
        if actual != digest:
            raise SystemExit(f"restricted runtime: {name} differs from the reviewed revision")


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

    def _images(self, agent: dict) -> list[str]:
        return [self.image] + ([self.proxy_image] if (agent.get("model") or {}).get("provider") == "tinfoil" else [])

    def _ensure_images(self, agent: dict) -> None:
        """Runtipi's install runs `compose down --rmi all` before `up`, which deletes the agent images (4 GB for
        Hermes) and then fails `up` on a box that can't pull them in time. Pull them here once and pin each with a
        stopped keeper container, so the install can never remove them (an image in use by a container is kept)."""
        for image in self._images(agent):
            if docker(["image", "inspect", image], timeout=60, check=False).returncode:
                docker(["pull", "-q", image], timeout=1800)
            keeper = "wizard-agent-image-" + re.sub(r"[^a-z0-9]+", "-", image.rsplit("/", 1)[-1].lower()).strip("-")
            found = docker(["ps", "-aq", "--filter", f"name=^{keeper}$"], timeout=60, check=False).stdout.split()
            if not found:
                docker(["create", "--name", keeper, "--label", "wizard-os.agent-image-keeper=1", "--entrypoint", "true", image],
                       timeout=120)

    def _install(self, agent: dict) -> dict:
        self._ensure_images(agent)
        pkg = self._package(agent)
        head = subprocess.run(["git", "-C", str(pkg), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        p = self.private
        saved = (p.token, p.head_commit, p.fetch, p.pull)
        p.token = lambda: "local-candidate"
        p.head_commit = lambda repo, tok: head
        p.fetch = lambda repo, commit, dest, tok: (Path(dest).mkdir(parents=True, exist_ok=True), subprocess.run(
            f"git -C {shlex.quote(str(pkg))} archive {commit} | tar -x -C {shlex.quote(str(dest))}", shell=True, check=True))
        p.pull = lambda image, tok: None
        c = self.cli.Config()
        try:
            # wait=False: wam's own wait only ends on running/stopped, so a failed install (Runtipi drops the app
            # row) would hold the runtime lock for 15 minutes. Wait here and treat `missing` as the failure.
            result = self.cli.install(c, f"wizard-os-agents/{agent['runtime']['app_id']}", {}, wait=False)
        finally:
            p.token, p.head_commit, p.fetch, p.pull = saved
        status = self._settle(c.runtipi(), agent, {"running", "stopped"}, timeout=900)
        self.cli.write_registry(c, c.runtipi())
        if status not in {"running", "stopped"}:
            raise RuntimeFailure(f"install_{status}"[:60])
        return {**result, "status": status}

    def _settle(self, rt, agent: dict, want: set[str], timeout: int) -> str:
        """Wait for one of `want`; `missing` after the app was seen (or after a short grace) means Runtipi gave up."""
        deadline, grace, seen, status = time.time() + timeout, time.time() + 20, False, "unknown"
        while time.time() < deadline:
            try:
                status = ((rt.app(self.urn(agent)) or {}).get("app") or {}).get("status") or "missing"
            except Exception:  # noqa: BLE001  (RuntipiError: transient API errors keep waiting)
                status = "unknown"
            if status in want:
                return status
            if status == "missing" and (seen or time.time() > grace):
                return status
            seen = seen or status not in {"missing", "unknown"}
            time.sleep(3)
        return status

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
            if result.get("status") == "stopped":
                return self.start(agent)
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


# ---------------------------------------------------------------- stopped runtime history authority

def runtime_home(driver, agent: dict) -> Path:
    """Configured home only: never derive authority paths from agent-controlled mounts."""
    home = driver.agents.home(agent['id'])
    # Stock Runtipi uses the same configured agent root, which must be the
    # app-data/wizard-os/agents root. Alongside mode explicitly overrides the bind.
    # Reject escaped/symlinked agent home directories before any host/sidecar read.
    try:
        root = driver.agents.root.resolve(strict=True)
        if home.is_symlink() or not home.resolve(strict=True).is_relative_to(root):
            raise ValueError()
    except (OSError, ValueError):
        raise RuntimeFailure("offline_census_unavailable", 503) from None
    return home


def read_index(driver, agent: dict, *, ids: bool = False) -> dict:
    home = runtime_home(driver, agent)
    try:
        if not restricted(agent):
            return index_snapshot(home, ids)
        # Restricted homes belong to 10000:10000 and are 0700. Never chmod them
        # or read as the helper owner/root. Reuse the home-sync sidecar image,
        # but no privileges, network, writable mount, or agent code/config.
        name = f"{driver.project(agent['id'])}-census-{secrets.token_hex(4)}"
        script = Path(__file__).with_name('offline_index.py').read_text()
        try:
            run = docker(["run", "--rm", "--name", name, "--network", "none", "--read-only",
                          "--user", f"{AGENT_UID}:{AGENT_UID}", "--cap-drop", "ALL",
                          "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "128m",
                          "--mount", f"type=bind,src={home},dst=/opt/data,readonly",
                          "--entrypoint", "python3", SIDECAR_IMAGE, "-c", script,
                          "/opt/data", "ids" if ids else "stat"], timeout=30)
        except subprocess.TimeoutExpired:
            docker(["rm", "-f", name], timeout=10, check=False)
            raise RuntimeFailure("offline_census_timeout", 504) from None
        value = json.loads(run.stdout)
        if not isinstance(value, dict) or not isinstance(value.get('files'), dict):
            raise ValueError()
        for key in ('state.db', 'state.db-wal', 'state.db-shm', 'state.db-journal'):
            item = value['files'][key]
            if item != 'absent' and (not isinstance(item, list) or len(item) != 5
                                    or any(type(n) is not int or n < 0 for n in item)):
                raise ValueError()
        if ids and (not isinstance(value.get('ids'), list) or len(value['ids']) > 100000
                    or any(not isinstance(s, str) or not s or len(s) > 200 for s in value['ids'])):
            raise ValueError()
        return value
    except RuntimeFailure:
        raise
    except Exception:
        raise RuntimeFailure("offline_census_unavailable", 503) from None


def runtime_down_state(driver, agent: dict) -> dict:
    """Only driver-owned status/lifecycle metadata; no container env or content."""
    service = RESTRICTED_SERVICE if restricted(agent) else service_names(agent)[0]
    app_status = None
    if isinstance(driver, RuntipiDriver):
        try:
            rt = driver.cli.Config().runtipi()
            app_status = ((rt.app(driver.urn(agent)) or {}).get('app') or {}).get('status')
        except Exception:
            raise RuntimeFailure("runtime_generation_unavailable", 503) from None
        if app_status != 'stopped':
            raise RuntimeFailure("runtime_not_stopped", 503)
    found = docker(["ps", "-aq", "--filter", f"label=com.docker.compose.project={driver.project(agent['id'])}",
                    "--filter", f"label=com.docker.compose.service={service}"], timeout=10).stdout.split()
    if not found:
        return {'app': app_status, 'container': 'absent'}
    if len(found) != 1:
        raise RuntimeFailure("runtime_generation_unavailable", 503)
    run = docker(["inspect", "--format", '{{json .Id}}\n{{json .State}}\n{{json .RestartCount}}', found[0]], timeout=10)
    try:
        cid, state, restarts = [json.loads(line) for line in run.stdout.splitlines()]
        started, finished = state['StartedAt'], state['FinishedAt']
        if (not isinstance(cid, str) or not cid or state['Status'] != 'exited' or state['Running']
                or state.get('Restarting') or type(restarts) is not int or restarts < 0
                or any(not isinstance(t, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T.+Z', t)
                       or t.startswith('0001-') for t in (started, finished))):
            raise ValueError()
        # Runtipi stop is compose down, not stop. A surviving container is not
        # its stable down state, even if exited (could be an out-of-band start).
        if isinstance(driver, RuntipiDriver):
            raise ValueError()
        return {'app': app_status, 'container': [cid, started, finished, restarts]}
    except (ValueError, KeyError, TypeError):
        raise RuntimeFailure("runtime_generation_unavailable", 503) from None


def inspect_runtime(driver, agent: dict) -> tuple[dict, dict]:
    """Stopped identity survives compose down and binds DB/WAL/SHM stat identity."""
    down = runtime_down_state(driver, agent)
    index = read_index(driver, agent)
    if runtime_down_state(driver, agent) != down:
        raise RuntimeFailure("runtime_generation_changed", 503)
    generation = hashlib.sha256(json.dumps([down, index['files']], sort_keys=True).encode()).hexdigest()
    return {"status": "stopped", "generation": generation}, {}


def offline_census(driver, agent: dict) -> dict:
    """Ids-only stopped census. Caller holds the same lock as stop/start/apply."""
    before, _ = inspect_runtime(driver, agent)
    index = read_index(driver, agent, ids=True)
    after, _ = inspect_runtime(driver, agent)
    if before != after:
        raise RuntimeFailure("runtime_generation_changed", 503)
    return {**after, "ids": index['ids']}


def lifecycle_action(driver, agent: dict, action: str) -> dict:
    """Called only under lifecycle_lock; a stop returns its seal atomically."""
    if isinstance(driver, ImportDriver):
        # Imports have no compose generation. Absence in a compose label lookup
        # MUST NOT mint a false stopped seal for an actually running import.
        if action in {'inspect', 'census'}:
            raise RuntimeFailure('import_offline_census_unavailable', 503)
        result = getattr(driver, action)(agent)
        if action == 'stop':
            return {**result, 'census': None, 'census_error': 'import_offline_census_unavailable'}
        return result
    if action == 'inspect':
        return inspect_runtime(driver, agent)[0]
    if action == 'census':
        return offline_census(driver, agent)
    result = getattr(driver, action)(agent)
    if action == 'stop' and result.get('ok') is not False:
        try:
            result = {**result, 'census': offline_census(driver, agent)}
        except RuntimeFailure as error:
            # Stopping succeeded even if no authority can be sealed. Explicitly
            # report that fact; neither helper nor service may trust an empty set.
            result = {**result, 'census': None, 'census_error': error.code}
    return result


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
    service = RESTRICTED_SERVICE if restricted(agent) else service_names(agent)[0]
    cid = container or (('agent-' + agent['id']) if isinstance(driver, ImportDriver) else container_for(driver.project(agent['id']), service))
    user = f'{os.getuid()}:{os.getgid()}' if isinstance(driver, ImportDriver) else f"{AGENT_UID}:{AGENT_UID}" if restricted(agent) else "hermes"
    if isinstance(driver, ImportDriver):
        label = docker(['inspect', '--format', '{{index .Config.Labels "wizard.import.id"}}', cid], timeout=10).stdout.strip()
        if label != agent['id']:
            raise RuntimeFailure('import_container_not_owned', 409)
    run = docker(["exec", "-i", "-u", user, cid, "/opt/hermes/.venv/bin/python", "-c", DELIVER_SCRIPT],
                 input_text=json.dumps(clean), timeout=120, check=False)
    if run.returncode:
        code = (run.stderr.strip().splitlines() or ["delivery_failed"])[-1]
        raise RuntimeFailure(code if re.fullmatch(r"[a-z_]{3,40}", code) else "delivery_failed")
    return json.loads(run.stdout.strip().splitlines()[-1])


# ---------------------------------------------------------------- HTTP

class ImportDriver:
    """Existing host helper, own-home only; never route an import through Runtipi install."""
    def __init__(self, agents):
        self.agents = agents

    def _action(self, agent, action):
        path = self.agents.root / agent['id'] / 'import-journal.json'
        interpreter = os.environ.get('WIZARD_IMPORT_PYTHON')
        command = ([interpreter] if interpreter else ['uv', 'run', '--no-project', '--with', 'PyYAML>=6.0.2,<7', 'python'])
        result = subprocess.run([*command, str(Path(__file__).with_name('hermes_import.py')), 'lifecycle', str(path), action],
                                capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeFailure('import_lifecycle_failed', 502)
        return json.loads(result.stdout)

    def start(self, agent):
        return self._action(agent, 'start')

    def stop(self, agent):
        return self._action(agent, 'stop')

    def apply(self, agent):
        return self._action(agent, 'apply')


def driver_for(agent: dict, driver, restricted_driver):
    """A restricted agent runs only in the restricted runtime; it never falls back to the default driver."""
    if restricted(agent):
        if restricted_driver is None:
            raise RuntimeFailure("restricted_runtime_unavailable", 503)
        return restricted_driver
    if agent.get('imported') == {'schema': 1, 'format': 'hermes'}:
        return ImportDriver(driver.agents)
    return driver


def make_handler(token: str, agents: Agents, driver, main_container: str = "", restricted_driver=None):
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
            m = re.fullmatch(r"/agents/([a-z][a-z0-9-]{0,30})/(apply|start|stop|deliver|inspect|census)", self.path)
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
                chosen = driver_for(agent, driver, restricted_driver)
                if action == "deliver":
                    self._json(200, deliver(chosen, agent, payload))
                    return
                with lifecycle_lock(chosen, restricted_driver, agent_id), import_process_lock(agents, agent_id):
                    agent = agents.read(agent_id)
                    result = lifecycle_action(chosen, agent, action)
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
    ap.add_argument("--restricted-runtime-dir", type=Path, default=RESTRICTED_DIR,
                    help="restricted runtime (compose.yml + SOURCE.txt); agents with runtime.isolation=restricted run here")
    ap.add_argument("--agent-listener-port", type=int, default=8929, help="the Agent Service's agent-only listener port (WIZARD_AGENT_PORT)")
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
    restricted_driver = None
    if (args.restricted_runtime_dir / "compose.yml").exists():
        restricted_driver = RestrictedDriver(agents, args.restricted_runtime_dir, os.environ.get("WIZARD_RESTRICTED_AGENT_IMAGE", ""),
                                             args.agent_listener_port)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(token, agents, driver, args.main_container, restricted_driver))
    sys.stderr.write(f"[agent-runtime] {args.driver} driver on 127.0.0.1:{args.port}, agents in {agents.root}\n")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
