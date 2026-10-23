#!/usr/bin/env python3
"""Machines: give one Wizard agent its own computer, without its owner's logins.

v1 implements one access level, **agent-owned**: the owner hands a machine to an agent
(a build box like Thales, a spare mini PC) and the agent gets a full shell on it.

The SSH key lives here, on the host, owned by the owner. The agent never sees it. Each
granted agent gets a Unix socket in its own directory, mounted read-only into only that
agent's container at /run/wizard-machines. The bundled `machine` client streams stdin,
stdout, stderr and the exit code through that socket; the relay runs OpenSSH with a fixed
destination, a pinned host key and no forwarding. Revoking a grant kills that agent's
open sessions within two seconds and refuses new ones.

Owner CLI (stdlib only):

  machines.py add builder --label Builder --host <address> --user <account> \
      --known-hosts-from ~/.ssh/known_hosts      # prints the public key to authorize
  machines.py grant builder <agent>
  machines.py check builder                        # owner-side SSH test
  machines.py serve                               # the relay (systemd unit alongside)
  machines.py revoke builder <agent>
  machines.py list | audit
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid

ID = re.compile(r"[a-z][a-z0-9-]{0,47}\Z")
HOST = re.compile(r"[A-Za-z0-9][A-Za-z0-9.:-]{0,252}\Z")
USER = re.compile(r"[a-z_][a-z0-9_.-]{0,31}\Z")
MAX_FRAME = 1 << 20
MAX_SESSIONS = 16          # per agent
LEVELS = ("agent-owned",)  # v1: the one level in use; see spec/MACHINES.md
HERE = Path(__file__).resolve().parent


class Denied(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Denied(code)


def default_root() -> Path:
    return Path(os.environ.get("WIZARD_MACHINES_ROOT") or Path.home() / ".wizard-os" / "machines")


def private_dir(path: Path, mode=0o700) -> Path:
    path.mkdir(mode=mode, parents=True, exist_ok=True)
    st = path.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == os.geteuid(), "unsafe_directory")
    os.chmod(path, mode)
    return path


# ---------------------------------------------------------------- registry

class Registry:
    def __init__(self, root: Path):
        self.root = private_dir(Path(root))
        self.path = self.root / "registry.json"
        self.keys = private_dir(self.root / "keys")
        self.sockets = private_dir(self.root / "sockets", 0o711)

    def read(self) -> dict:
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {"version": 1, "machines": {}}
        with os.fdopen(fd) as f:
            st = os.fstat(f.fileno())
            require(st.st_uid == os.geteuid() and st.st_mode & 0o077 == 0, "unsafe_registry")
            return json.load(f)

    @contextlib.contextmanager
    def edit(self):
        fd = os.open(self.root / "registry.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            data = self.read()
            yield data
            tmp = self.root / f".registry.{uuid.uuid4().hex}"
            with open(os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as f:
                json.dump(data, f, indent=1, sort_keys=True)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        finally:
            os.close(fd)

    def machine(self, machine_id: str) -> dict:
        m = self.read()["machines"].get(machine_id)
        require(m is not None, "unknown_machine")
        return m

    def authorize(self, agent: str, machine_id: str) -> dict:
        m = self.read()["machines"].get(machine_id)
        require(m is not None and not m.get("disabled"), "not_granted")
        require(agent in (m.get("agents") or {}), "not_granted")
        return m

    def granted(self, agent: str) -> list[dict]:
        out = []
        for mid, m in sorted(self.read()["machines"].items()):
            g = (m.get("agents") or {}).get(agent)
            if g and not m.get("disabled"):
                out.append({"id": mid, "label": m["label"], "level": g["level"]})
        return out

    def agents(self) -> set[str]:
        return {a for m in self.read()["machines"].values() if not m.get("disabled") for a in (m.get("agents") or {})}


def audit(root: Path, **event) -> None:
    """Owner-only, metadata-only activity log: who, which machine, when, exit, bytes. No commands or output."""
    event = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **event}
    fd = os.open(root / "audit.jsonl", os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as f:
        f.write(json.dumps(event, sort_keys=True) + "\n")


# ---------------------------------------------------------------- framing

def send(sock, lock, kind: bytes, payload: bytes = b"") -> None:
    with lock:
        sock.sendall(kind + struct.pack(">I", len(payload)) + payload)


def recv_exact(sock, n: int) -> bytes | None:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def recv(sock) -> tuple[bytes, bytes] | None:
    head = recv_exact(sock, 5)
    if head is None:
        return None
    kind, size = head[:1], struct.unpack(">I", head[1:])[0]
    if size > MAX_FRAME:
        raise Denied("frame_too_large")
    body = recv_exact(sock, size) if size else b""
    if body is None:
        return None
    return kind, body


# ---------------------------------------------------------------- relay

def ssh_argv(reg: Registry, machine_id: str, m: dict, command: str | None, ssh_bin: str) -> list[str]:
    argv = [ssh_bin, "-F", "/dev/null", "-T",
            "-i", str(reg.keys / machine_id), "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
            "-o", f"UserKnownHostsFile={reg.keys / (machine_id + '.known_hosts')}",
            "-o", "GlobalKnownHostsFile=/dev/null", "-o", "StrictHostKeyChecking=yes",
            "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
            "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes",
            "-o", "PermitLocalCommand=no", "-o", "ControlMaster=no", "-o", "ControlPath=none",
            "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4",
            "-p", str(m["port"]), "-l", m["user"]]
    if m.get("proxy_command"):   # owner-set transport, e.g. userspace Tailscale: `tailscale nc %h %p`
        argv += ["-o", f"ProxyCommand={m['proxy_command']}"]
    argv.append(m["host"])
    if command:
        argv += ["--", command]
    return argv


class Relay:
    def __init__(self, root: Path, peer_uid: int | None, ssh_bin: str = "ssh"):
        self.reg = Registry(root)
        self.root = self.reg.root
        self.peer_uid, self.ssh_bin = peer_uid, ssh_bin
        self.listeners: dict[str, socket.socket] = {}
        self.sessions: dict[str, int] = {}
        self.lock = threading.Lock()
        self.stopping = threading.Event()

    # One listener per granted agent, created/removed as grants change.
    def reconcile(self) -> None:
        want = self.reg.agents()
        for agent in want - set(self.listeners):
            self.listeners[agent] = self.listen(agent)
            threading.Thread(target=self.accept_loop, args=(agent,), daemon=True).start()
        for agent in set(self.listeners) - want:
            sock = self.listeners.pop(agent)
            with contextlib.suppress(OSError):
                sock.close()
            with contextlib.suppress(FileNotFoundError):
                (self.reg.sockets / agent / "machines.sock").unlink()

    def listen(self, agent: str) -> socket.socket:
        d = self.reg.sockets / agent
        private_dir(d, 0o755)
        client = d / "machine"
        tmp = d / ".machine.tmp"
        shutil.copyfile(HERE / "machine", tmp)
        os.chmod(tmp, 0o755)
        os.replace(tmp, client)
        path = d / "machines.sock"
        with contextlib.suppress(FileNotFoundError):
            path.unlink()
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(str(path))
        os.chmod(path, 0o666)   # reachability is the mount: only this agent's container sees this directory
        s.listen(16)
        return s

    def accept_loop(self, agent: str) -> None:
        sock = self.listeners.get(agent)
        while sock and not self.stopping.is_set():
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(agent, conn), daemon=True).start()

    def handle(self, agent: str, conn: socket.socket) -> None:
        wlock = threading.Lock()
        session = uuid.uuid4().hex[:12]
        machine_id, proc, counted = None, None, False
        sent = {"stdin": 0, "stdout": 0, "stderr": 0}
        try:
            pid, uid, _ = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(self.peer_uid is None or uid == self.peer_uid, "peer_denied")
            first = recv(conn)
            require(first is not None and first[0] == b"h", "bad_request")
            req = json.loads(first[1])
            require(isinstance(req, dict), "bad_request")
            if req.get("op") == "list":
                send(conn, wlock, b"x", json.dumps({"code": 0, "machines": self.reg.granted(agent)}).encode())
                return
            machine_id = req.get("machine")
            command = req.get("command")
            require(isinstance(machine_id, str) and ID.fullmatch(machine_id), "bad_machine")
            require(command is None or (isinstance(command, str) and len(command) <= 131072), "bad_command")
            m = self.reg.authorize(agent, machine_id)
            with self.lock:
                require(self.sessions.get(agent, 0) < MAX_SESSIONS, "too_many_sessions")
                self.sessions[agent] = self.sessions.get(agent, 0) + 1
                counted = True
            audit(self.root, event="start", session=session, agent=agent, machine=machine_id,
                  interactive=command is None)
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.reg.keys), "LANG": "C.UTF-8"}
            proc = subprocess.Popen(ssh_argv(self.reg, machine_id, m, command, self.ssh_bin), env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    start_new_session=True)
            revoked = threading.Event()

            def kill():
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(proc.pid, 9)


            def pump(stream, kind, key):
                while True:
                    chunk = stream.read1(65536)
                    if not chunk:
                        return
                    sent[key] += len(chunk)
                    try:
                        send(conn, wlock, kind, chunk)
                    except OSError:
                        return

            def feed():
                try:
                    while True:
                        frame = recv(conn)
                        if frame is None:          # client gone: end the session
                            kill()
                            return
                        kind, body = frame
                        if kind == b"i":
                            sent["stdin"] += len(body)
                            proc.stdin.write(body)
                            proc.stdin.flush()
                        elif kind == b"e":
                            proc.stdin.close()
                except (OSError, ValueError, Denied):
                    kill()

            def watch():
                while proc.poll() is None:
                    time.sleep(2)
                    try:
                        self.reg.authorize(agent, machine_id)
                    except Exception:
                        revoked.set()
                        kill()
                        return

            threads = [threading.Thread(target=pump, args=(proc.stdout, b"o", "stdout"), daemon=True),
                       threading.Thread(target=pump, args=(proc.stderr, b"r", "stderr"), daemon=True)]
            for t in threads:
                t.start()
            threading.Thread(target=feed, daemon=True).start()
            threading.Thread(target=watch, daemon=True).start()
            code = proc.wait()
            for t in threads:
                t.join(5)
            result = {"code": 255 if revoked.is_set() else code}
            if revoked.is_set():
                result["error"] = "revoked"
            audit(self.root, event="end", session=session, agent=agent, machine=machine_id,
                  exit=result["code"], revoked=revoked.is_set(), bytes=sent)
            with contextlib.suppress(OSError):
                send(conn, wlock, b"x", json.dumps(result).encode())
        except Denied as e:
            audit(self.root, event="denied", session=session, agent=agent, machine=machine_id, reason=str(e))
            with contextlib.suppress(OSError):
                send(conn, wlock, b"x", json.dumps({"code": 255, "error": str(e)}).encode())
        except Exception as e:  # never leak details to the agent; keep them in the owner log
            audit(self.root, event="error", session=session, agent=agent, machine=machine_id, reason=type(e).__name__)
            with contextlib.suppress(OSError):
                send(conn, wlock, b"x", json.dumps({"code": 255, "error": "relay_error"}).encode())
        finally:
            if proc:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(proc.pid, 9)
            if counted:
                with self.lock:
                    self.sessions[agent] -= 1
            with contextlib.suppress(OSError):
                conn.close()

    def serve(self) -> None:
        while not self.stopping.is_set():
            try:
                self.reconcile()
            except Exception as e:
                print(f"machines: reconcile failed: {type(e).__name__}", file=sys.stderr, flush=True)
            self.stopping.wait(2)


# ---------------------------------------------------------------- owner CLI

def cmd_add(reg: Registry, a) -> None:
    for value, pattern, code in ((a.id, ID, "bad_id"), (a.host, HOST, "bad_host"), (a.user, USER, "bad_user")):
        require(pattern.fullmatch(value), code)
    key, known = reg.keys / a.id, reg.keys / f"{a.id}.known_hosts"
    require(not key.exists(), "already_added")
    lookup = a.host if a.port == 22 else f"[{a.host}]:{a.port}"
    pins = subprocess.run(["ssh-keygen", "-F", lookup, "-f", os.path.expanduser(a.known_hosts_from)],
                          capture_output=True, text=True).stdout
    lines = [ln for ln in pins.splitlines() if ln and not ln.startswith("#")]
    require(lines, "host_key_not_pinned")
    with open(os.open(known, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as f:
        f.write("\n".join(lines) + "\n")
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f"wizard-machines:{a.id}", "-f", str(key)],
                   check=True)
    with reg.edit() as data:
        require(a.id not in data["machines"], "already_added")
        data["machines"][a.id] = {"label": a.label, "host": a.host, "port": a.port, "user": a.user,
                                  "agents": {}, "added": int(time.time()),
                                  **({"proxy_command": a.proxy_command} if a.proxy_command else {})}
    print(f"Added {a.id}. Authorize this key on {a.user}@{a.host} (~/.ssh/authorized_keys):")
    print(key.with_suffix(".pub").read_text().strip())


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Wizard Machines (agent-owned level)")
    p.add_argument("--root", type=Path, default=default_root())
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("add")
    s.add_argument("id")
    s.add_argument("--label", required=True)
    s.add_argument("--host", required=True)
    s.add_argument("--port", type=int, default=22)
    s.add_argument("--user", required=True)
    s.add_argument("--known-hosts-from", required=True, help="known_hosts file that already pins this host")
    s.add_argument("--proxy-command", help="owner-set ssh ProxyCommand (e.g. userspace Tailscale nc %%h %%p)")
    for name in ("grant", "revoke"):
        s = sub.add_parser(name)
        s.add_argument("machine")
        s.add_argument("agent")
    s = sub.add_parser("check")
    s.add_argument("machine")
    sub.add_parser("list")
    s = sub.add_parser("audit")
    s.add_argument("-n", type=int, default=20)
    s = sub.add_parser("serve")
    s.add_argument("--peer-uid", type=int, default=10000, help="uid the agent container runs as (-1: any)")
    s.add_argument("--ssh-bin", default="ssh")
    a = p.parse_args(argv)
    reg = Registry(a.root)
    try:
        if a.cmd == "add":
            cmd_add(reg, a)
        elif a.cmd == "grant":
            require(ID.fullmatch(a.agent), "bad_agent")
            with reg.edit() as data:
                m = data["machines"].get(a.machine)
                require(m is not None, "unknown_machine")
                m.setdefault("agents", {})[a.agent] = {"level": "agent-owned", "granted": int(time.time())}
            audit(reg.root, event="grant", agent=a.agent, machine=a.machine, level="agent-owned")
            print(f"{a.agent} now owns {a.machine}. Its container needs grants.machines=true in agent.json.")
        elif a.cmd == "revoke":
            with reg.edit() as data:
                m = data["machines"].get(a.machine)
                require(m is not None, "unknown_machine")
                (m.get("agents") or {}).pop(a.agent, None)
            audit(reg.root, event="revoke", agent=a.agent, machine=a.machine)
            print(f"Revoked {a.agent} on {a.machine}; open sessions end within 2 s.")
        elif a.cmd == "check":
            m = reg.machine(a.machine)
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(reg.keys)}
            r = subprocess.run(ssh_argv(reg, a.machine, m, "uname -sm", "ssh"), env=env, stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=60)
            print(r.stdout.strip() or r.stderr.strip())
            return r.returncode
        elif a.cmd == "list":
            for mid, m in sorted(reg.read()["machines"].items()):
                agents = ", ".join(f"{k} ({v['level']})" for k, v in (m.get("agents") or {}).items()) or "no agents"
                print(f"{mid}  {m['label']}  {m['user']}@{m['host']}:{m['port']}  {agents}"
                      + ("  DISABLED" if m.get("disabled") else ""))
        elif a.cmd == "audit":
            path = reg.root / "audit.jsonl"
            if path.exists():
                print("".join(path.read_text().splitlines(keepends=True)[-a.n:]), end="")
        elif a.cmd == "serve":
            Relay(reg.root, None if a.peer_uid < 0 else a.peer_uid, a.ssh_bin).serve()
    except Denied as e:
        print(f"machines: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
