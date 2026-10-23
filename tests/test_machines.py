"""Machines (agent-owned level): real relay + real Unix sockets + real client, fake ssh binary."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1] / "ops" / "machines"
sys.path.insert(0, str(ROOT))
import machines  # noqa: E402

FAKE_SSH = """#!/bin/sh
# Stand-in for OpenSSH: record argv, then run the command (after --) locally, or a shell on stdin.
printf '%s\\n' "$@" > "@LOG@"
while [ $# -gt 0 ]; do [ "$1" = "--" ] && { shift; exec sh -c "$1"; }; shift; done
exec sh
"""


class MachinesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="wm-", dir=os.environ.get("TMPDIR")))
        self.root = self.tmp / "m"
        self.ssh = self.tmp / "ssh"
        self.ssh.write_text(FAKE_SSH.replace("@LOG@", str(self.tmp / "argv")))
        self.ssh.chmod(0o755)
        reg = machines.Registry(self.root)
        with reg.edit() as data:
            data["machines"]["box"] = {"label": "Box", "host": "10.0.0.9", "port": 2222, "user": "worker",
                                       "agents": {"alice": {"level": "agent-owned", "granted": 0}}}
            data["machines"]["other"] = {"label": "Other", "host": "10.0.0.8", "port": 22, "user": "w", "agents": {}}
        self.relay = machines.Relay(self.root, peer_uid=os.getuid(), ssh_bin=str(self.ssh))
        threading.Thread(target=self.relay.serve, daemon=True).start()
        self.sock = self.root / "sockets" / "alice" / "machines.sock"
        for _ in range(50):
            if self.sock.exists():
                break
            time.sleep(0.1)

    def tearDown(self):
        self.relay.stopping.set()
        for s in self.relay.listeners.values():
            s.close()

    def client(self, *args, stdin=b"", sock=None, timeout=20):
        env = {**os.environ, "WIZARD_MACHINES_SOCKET": str(sock or self.sock)}
        return subprocess.run([sys.executable, str(self.root / "sockets" / "alice" / "machine"), *args],
                              input=stdin, capture_output=True, env=env, timeout=timeout)

    def test_exec_streams_and_passes_exit_code(self):
        r = self.client("box", "--", "echo out; echo err >&2; exit 7")
        self.assertEqual((r.returncode, r.stdout, r.stderr), (7, b"out\n", b"err\n"))
        argv = (self.tmp / "argv").read_text().splitlines()
        for pinned in ("-F", "/dev/null", "StrictHostKeyChecking=yes", "ForwardAgent=no", "ClearAllForwardings=yes",
                       "IdentitiesOnly=yes", "2222", "worker", "10.0.0.9"):
            self.assertIn(pinned, argv)
        self.assertIn(str(self.root / "keys" / "box"), argv)
        self.assertNotIn("ProxyCommand", " ".join(argv))
        with machines.Registry(self.root).edit() as data:
            data["machines"]["box"]["proxy_command"] = "nc %h %p"
        self.client("box", "--", "true")
        self.assertIn("ProxyCommand=nc %h %p", (self.tmp / "argv").read_text().splitlines())

    def test_stdin_binary_roundtrip_and_interactive_shell(self):
        blob = os.urandom(300_000)
        r = self.client("box", "--", "cat", stdin=blob)
        self.assertEqual((r.returncode, r.stdout), (0, blob))
        r = self.client("box", stdin=b"echo hi\nexit 3\n")
        self.assertEqual((r.returncode, r.stdout), (3, b"hi\n"))

    def test_ssh_compatible_mode_for_rsync_and_git(self):
        r = self.client("--ssh", "-l", "x", "-o", "Foo=bar", "-p", "22", "box", "echo", "a", "b")
        self.assertEqual((r.returncode, r.stdout), (0, b"a b\n"))
        r = self.client("--ssh", "git@box", "--", "echo ok")
        self.assertEqual(r.stdout, b"ok\n")

    def test_list_and_refusals(self):
        r = self.client("list")
        self.assertEqual(r.stdout.decode().split("\t")[0], "box")
        r = self.client("other", "--", "true")
        self.assertEqual((r.returncode, r.stderr), (255, b"machine: not_granted\n"))
        r = self.client("nope", "--", "true")
        self.assertIn(b"not_granted", r.stderr)
        self.assertFalse((self.root / "sockets" / "bob").exists(), "no socket for ungranted agents")

    def test_peer_uid_enforced(self):
        self.relay.peer_uid = os.getuid() + 1
        r = self.client("box", "--", "true")
        self.assertEqual((r.returncode, r.stderr), (255, b"machine: peer_denied\n"))

    def test_revoke_kills_running_session_and_removes_socket(self):
        proc = subprocess.Popen([sys.executable, str(self.root / "sockets" / "alice" / "machine"), "box", "--",
                                 "echo started; sleep 60"], env={**os.environ, "WIZARD_MACHINES_SOCKET": str(self.sock)},
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
        self.assertEqual(proc.stdout.readline(), b"started\n")
        machines.main(["--root", str(self.root), "revoke", "box", "alice"])
        out, err = proc.communicate(timeout=10)
        self.assertEqual((proc.returncode, err), (255, b"machine: revoked\n"))
        for _ in range(40):
            if not self.sock.exists():
                break
            time.sleep(0.1)
        self.assertFalse(self.sock.exists())
        events = [json.loads(x)["event"] for x in (self.root / "audit.jsonl").read_text().splitlines()]
        self.assertEqual(events[-2:], ["revoke", "end"] if events[-1] == "end" else ["end", "revoke"])

    def test_audit_is_metadata_only(self):
        self.client("box", "--", "echo SECRET-OUTPUT # SECRET-COMMAND")
        log = (self.root / "audit.jsonl").read_text()
        self.assertNotIn("SECRET", log)
        self.assertIn('"exit": 0', log)

    def test_private_layout(self):
        mode = lambda p: (self.root / p).stat().st_mode & 0o777
        self.assertEqual((mode(""), mode("keys"), mode("registry.json")), (0o700, 0o700, 0o600))


class DriverOverrideTest(unittest.TestCase):
    def test_mount_only_with_explicit_grant_on_restricted_standard_agent(self):
        sys.path.insert(0, str(ROOT.parent / "agent-runtime"))
        import agent_runtime as ar
        tmp = Path(tempfile.mkdtemp(prefix="wmd-", dir=os.environ.get("TMPDIR")))
        (tmp / "agents" / "a1").mkdir(parents=True)
        agents = type("A", (), {"root": tmp / "agents"})()
        base = {"id": "a1", "privacy": "standard", "runtime": {"kind": "container", "isolation": "restricted"}}
        os.environ.pop("WIZARD_MACHINES_ROOT", None)
        self.assertIsNone(ar.machines_override(agents, base))
        self.assertIsNone(ar.machines_override(agents, {**base, "grants": {"machines": "yes"}}))
        self.assertIsNone(ar.machines_override(agents, {**base, "privacy": "private", "grants": {"machines": True}}))
        path = ar.machines_override(agents, {**base, "grants": {"machines": True}})
        vol = json.loads(path.read_text())["services"]["agent"]["volumes"]
        self.assertEqual(vol, [{"type": "bind", "source": str(tmp / "machines" / "sockets" / "a1"),
                                "target": "/run/wizard-machines", "read_only": True}])
        self.assertEqual((tmp / "machines").stat().st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()
