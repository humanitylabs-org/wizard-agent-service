"""Restricted runtime driver: env contract, no fallback, vendored files checked. Run: python3 -m unittest ops/agent-runtime/test_agent_runtime.py"""
import hashlib
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar  # noqa: E402


def agent_folder(root: Path, agent_id: str, network: dict | None, isolation: str = "restricted") -> dict:
    folder = root / agent_id
    (folder / "home").mkdir(parents=True)
    managed = folder / ("managed" if isolation else "home")
    managed.mkdir(exist_ok=True)
    (managed / ".env").write_text("API_SERVER_KEY=x\n")
    (managed / "config.yaml").write_text("model: {}\n")
    (folder / "runtime.key").write_text("api-key-0123456789\n")
    (folder / "gateway.key").write_text("gateway-key-abcdef\n")
    gateway = folder / "gateway"
    gateway.mkdir(mode=0o700)
    sock = socket.socket(socket.AF_UNIX)
    sock.bind(str(gateway / "gateway.sock"))
    (gateway / "gateway.sock").chmod(0o600)
    sock.close()
    runtime = {"kind": "container", "app_id": f"agent-{agent_id}", "port": 18650}
    if isolation:
        runtime["isolation"] = isolation
    if network is not None:
        runtime["network"] = network
    agent = {"schema": 1, "id": agent_id, "label": "Daily", "runtime": runtime, "model": {"provider": "anthropic"}}
    (folder / "agent.json").write_text(json.dumps(agent))
    return agent


class ClaudeLoginMountTest(unittest.TestCase):
    def doc(self, privacy, provider):
        agent = {"id": "phil", "privacy": privacy, "model": {"provider": provider},
                 "runtime": {"app_id": "agent-phil", "port": 18651}}
        return json.loads(ar.compose_doc(agent, image="img", proxy_image="proxy", home_source="/h", uid=1000, gid=1000, ports=False))

    def test_standard_claude_agent_mounts_the_shared_login(self):
        doc = self.doc("standard", "anthropic")
        svc = doc["services"]["agent-phil"]
        self.assertIn("claude-login:/claude", svc["volumes"])
        self.assertEqual(svc["environment"]["CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR"], "/claude")
        self.assertEqual(doc["volumes"]["claude-login"], {"name": "wizard-ai-accounts-claude", "external": True})

    def test_private_or_other_provider_never_gets_it(self):
        for privacy, provider in (("private", "anthropic"), ("private", "tinfoil"), ("standard", "openai-codex")):
            doc = self.doc(privacy, provider)
            self.assertNotIn("volumes", doc)
            self.assertFalse(any("/claude" in v for v in doc["services"]["agent-phil"]["volumes"]))


class RestrictedDriverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()   # macOS: /var is a symlink to /private/var
        self.agents = ar.Agents(self.tmp / "agents", None)
        self.driver = ar.RestrictedDriver(self.agents, ar.RESTRICTED_DIR, "")
        self.calls = []
        self.real_docker = ar.docker
        ar.docker = lambda args, **kw: (self.calls.append((args, kw.get("env"))), type("R", (), {"stdout": "", "returncode": 0})())[1]

    def tearDown(self):
        ar.docker = self.real_docker
        shutil.rmtree(self.tmp)

    def claude_agent(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        agent["privacy"] = "standard"
        return agent

    def test_grant_override_digest_is_required_and_verified(self):
        copy = self.tmp / "runtime-grant"
        shutil.copytree(ar.RESTRICTED_DIR, copy)
        with (copy / "compose.claude-token.yml").open("a") as fh:
            fh.write("\n# changed\n")
        with self.assertRaisesRegex(SystemExit, "compose.claude-token.yml differs"):
            ar.verify_vendored(copy)
        manifest = copy / "SOURCE.txt"
        manifest.write_text("\n".join(line for line in manifest.read_text().splitlines()
                                      if not line.endswith("  ./compose.claude-token.yml")))
        with self.assertRaisesRegex(SystemExit, "compose.claude-token.yml is not listed"):
            ar.verify_vendored(copy)

    def test_memory_grant_security_sources_cannot_be_unlisted(self):
        copy = self.tmp / "runtime-security"
        shutil.copytree(ar.RESTRICTED_DIR, copy)
        manifest = copy / "SOURCE.txt"
        original = manifest.read_text()
        for name in ("sidecars/claude-init.py", "sidecars/hostname_policy.py", "sidecars/Dockerfile",
                     "conformance/in_agent.py", "conformance/docker_credentials.py", "sidecars/edge.py",
                     "conformance/inspect_check.py", "conformance/ingress_probe.py"):
            with self.subTest(name=name):
                manifest.write_text("\n".join(line for line in original.splitlines() if not line.endswith("  ./" + name)))
                with self.assertRaisesRegex(SystemExit, "is not listed"):
                    ar.verify_vendored(copy)
        manifest.write_text(original)
        ar.verify_vendored(copy)

    def test_env_contract(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        env = self.driver.env(agent)
        self.assertEqual(env["AGENT_PROJECT"], "agent-daily")
        self.assertEqual(env["AGENT_HOME_VOLUME"], str(self.tmp / "agents" / "daily" / "home"))
        self.assertEqual(env["AGENT_API_KEY"], "api-key-0123456789")
        self.assertEqual(env["EDGE_TOKEN_SHA256"], hashlib.sha256(b"gateway-key-abcdef").hexdigest())
        self.assertEqual((env["AGENT_UPLINK_SUBNET"], env["AGENT_SANDBOX_SUBNET"]), ("10.250.0.16/28", "10.251.0.16/28"))
        self.assertNotIn("AGENT_INGRESS_BIND", env)
        self.assertEqual(env["AGENT_GATEWAY_DIR"], str(self.tmp / "agents" / "daily" / "gateway"))
        self.assertNotIn("EDGE_UPSTREAM_HOST", env)
        self.assertNotIn("EDGE_UPSTREAM_PORT", env)
        self.assertNotIn("gateway-key-abcdef", json.dumps(env))

    def test_lifecycle_uses_the_vendored_compose_and_the_agent_service(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        self.driver.apply(agent)
        compose = [args for args, _ in self.calls if args[0] == "compose"]
        self.assertEqual(compose[0][:4], ["compose", "-p", "agent-daily", "-f"])
        self.assertEqual(compose[0][4], str(ar.RESTRICTED_DIR / "compose.yml"))
        self.assertEqual([c[5] for c in compose[:3]], ["build", "stop", "up"])
        # The agent is stopped before its home is touched, and the home sync runs between stop and up.
        self.assertEqual(compose[1][6:], [ar.RESTRICTED_SERVICE])
        # build, stop, then the home sync, then up: the host never writes into the agent-owned home itself.
        order = [args[0] if args[0] != "compose" else args[5] for args, _ in self.calls if args[0] in ("compose", "run")]
        self.assertEqual(order[:4], ["build", "stop", "run", "up"])
        sync = next(args for args, _ in self.calls if args[0] == "run")
        for flag in (["--network", "none"], ["--read-only"], ["--cap-drop", "ALL"], ["--user", "0:0"]):
            self.assertTrue(any(sync[i:i + len(flag)] == flag for i in range(len(sync))), flag)
        self.assertIn(f"{self.tmp / 'agents' / 'daily' / 'managed'}:/managed:ro", sync)
        self.assertIn(f"{self.tmp / 'agents' / 'daily' / 'home'}:/opt/data", sync)
        self.assertIn("chown 10000:10000", sync[-1])
        # Provider keys land in managed/.env, not in the home.
        self.assertFalse((self.tmp / "agents" / "daily" / "home" / ".env").exists())

    def test_start_and_apply_recreate_legacy_container_endpoints(self):
        # Pre-socket projects can retain stale Docker endpoints without the `agent` DNS alias.
        # Compose's config hash need not change; ordinary `up` leaves that drift untouched.
        agent = agent_folder(self.tmp / "agents", "legacy", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        self.assertNotIn("ingress_socket", agent["runtime"])
        for action in (self.driver.start, self.driver.apply):
            self.calls.clear()
            action(agent)
            up = next(args for args, _ in self.calls if args[0] == "compose" and args[5] == "up")
            self.assertIn("--force-recreate", up)
            self.assertIn("--remove-orphans", up)
            self.assertEqual(up[:3], ["compose", "-p", "agent-legacy"])

    def test_tinfoil_agents_are_refused_before_anything_runs(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        agent["model"] = {"provider": "tinfoil"}
        with self.assertRaises(ar.RuntimeFailure) as raised:
            self.driver.apply(agent)
        self.assertEqual((raised.exception.code, raised.exception.status), ("restricted_provider_unsupported", 409))
        self.assertEqual(self.calls, [])

    def test_sync_writes_through_a_fresh_temp_dir_and_renames(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        self.driver.apply(agent)
        script = next(args for args, _ in self.calls if args[0] == "run")[-1]
        self.assertIn("mktemp -d /opt/data/.wizard-sync.", script)
        self.assertIn('mv -T -f "$tmp/.env" /opt/data/.env', script)
        self.assertNotIn(".new", script)   # no predictable names an agent could plant

    def test_sync_timeout_removes_the_named_helper(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        removed = []
        real = ar.docker

        def fake(args, **kw):
            if args[0] == "run":
                raise subprocess.TimeoutExpired(args, 120)
            if args[0] == "rm":
                removed.append(args)
            return real(args, **kw)
        ar.docker = fake
        try:
            with self.assertRaises(ar.RuntimeFailure) as raised:
                self.driver.sync_home(agent)
        finally:
            ar.docker = real
        self.assertEqual(raised.exception.code, "agent_sync_timeout")
        self.assertEqual(len(removed), 1)
        self.assertTrue(removed[0][2].startswith("agent-daily-sync-"))

    def test_only_restricted_agents_lock_per_agent(self):
        restricted, runtipi = object(), object()
        self.assertIs(ar.lifecycle_lock(runtipi, restricted, "a"), ar.LOCK)
        self.assertIs(ar.lifecycle_lock(runtipi, None, "a"), ar.LOCK)
        self.assertIs(ar.lifecycle_lock(restricted, restricted, "a"), ar.agent_lock("a"))
        # A restricted action never waits for a Runtipi one.
        with ar.LOCK:
            lock = ar.lifecycle_lock(restricted, restricted, "b")
            self.assertTrue(lock.acquire(timeout=1))
            lock.release()

    def test_lifecycle_locks_are_per_agent(self):
        self.assertIs(ar.agent_lock("a"), ar.agent_lock("a"))
        self.assertIsNot(ar.agent_lock("a"), ar.agent_lock("b"))
        with ar.agent_lock("a"):
            self.assertTrue(ar.agent_lock("b").acquire(timeout=1))
            ar.agent_lock("b").release()

    def test_missing_socket_refused_before_docker(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        (self.tmp / "agents" / "daily" / "gateway" / "gateway.sock").unlink()
        with mock.patch.object(ar, "docker") as docker:
            with self.assertRaisesRegex(ar.RuntimeFailure, "agent_socket_not_ready"):
                self.driver.start(agent)
            docker.assert_not_called()

    def test_gateway_symlink_refused_before_docker(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        gateway = self.tmp / "agents" / "daily" / "gateway"
        moved = gateway.with_name("moved")
        gateway.rename(moved)
        gateway.symlink_to(moved, target_is_directory=True)
        with mock.patch.object(ar, "docker") as docker:
            with self.assertRaisesRegex(ar.RuntimeFailure, "agent_socket_not_ready"):
                self.driver.start(agent)
            docker.assert_not_called()

    def test_nonprivate_socket_refused_before_docker(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        (self.tmp / "agents" / "daily" / "gateway" / "gateway.sock").chmod(0o666)
        with mock.patch.object(ar, "docker") as docker:
            with self.assertRaisesRegex(ar.RuntimeFailure, "agent_socket_not_ready"):
                self.driver.start(agent)
            docker.assert_not_called()

    def test_sync_refuses_without_managed_files(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        (self.tmp / "agents" / "daily" / "managed" / "config.yaml").unlink()
        with self.assertRaises(ar.RuntimeFailure) as raised:
            self.driver.apply(agent)
        self.assertEqual(raised.exception.code, "agent_not_prepared")
        self.assertFalse(any(args[0] == "run" or args[-2:] == ["-d", "--remove-orphans"] for args, _ in self.calls))
        self.calls.clear()
        self.driver.stop(agent)
        commands = [args for args, _ in self.calls]
        self.assertEqual(commands[0][-1], "stop")
        self.assertEqual(commands[1][0], "ps")
        self.assertIn("label=com.docker.compose.service=claude-init", commands[1])
        self.assertEqual(len(commands), 2)

    def test_bad_networks_are_refused(self):
        for network in (None, {"uplink": "10.250.0.16/27", "sandbox": "10.251.0.16/28"}, {"uplink": "172.17.0.0/28", "sandbox": "10.251.0.16/28"},
                        {"uplink": "10.250.0.17/28", "sandbox": "10.251.0.16/28"}, {"uplink": "10.251.0.16/28", "sandbox": "10.250.0.16/28"}):
            agent = agent_folder(self.tmp / "agents", f"a{len(self.calls)}x{abs(hash(str(network))) % 1000}", network)
            with self.assertRaises(ar.RuntimeFailure) as raised:
                self.driver.env(agent)
            self.assertEqual(raised.exception.code, "agent_network_invalid")

    def test_restricted_agents_never_fall_back(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        legacy = agent_folder(self.tmp / "agents", "old", None, isolation="")
        default = object()
        with self.assertRaises(ar.RuntimeFailure) as raised:
            ar.driver_for(agent, default, None)
        self.assertEqual((raised.exception.code, raised.exception.status), ("restricted_runtime_unavailable", 503))
        self.assertIs(ar.driver_for(agent, default, self.driver), self.driver)
        self.assertIs(ar.driver_for(legacy, default, self.driver), default)

    def test_delivery_targets_the_agent_service(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        seen = []
        real = ar.container_for
        ar.container_for = lambda project, service: (seen.append((project, service)), "cid")[1]
        try:
            ar.docker = lambda args, **kw: type("R", (), {"stdout": json.dumps({"verified": True}), "returncode": 0, "stderr": ""})()
            ar.deliver(self.driver, agent, {"session_id": "s1", "delivery_key": "k", "body": "b", "title": "t"})
        finally:
            ar.container_for = real
        self.assertEqual(seen, [("agent-daily", "agent")])

    def test_actual_vendored_tree_is_pinned_including_edge(self):
        ar.verify_vendored(ar.RESTRICTED_DIR)
        copy = self.tmp / "stale-edge"
        shutil.copytree(ar.RESTRICTED_DIR, copy)
        with (copy / "sidecars" / "edge.py").open("a") as fh:
            fh.write("\n# stale pin\n")
        with self.assertRaisesRegex(SystemExit, "edge.py differs"):
            ar.verify_vendored(copy)

    def test_vendored_runtime_is_checked(self):
        copy = self.tmp / "runtime"
        shutil.copytree(ar.RESTRICTED_DIR, copy)
        ar.verify_vendored(copy)
        with (copy / "compose.yml").open("a") as fh:
            fh.write("\n# changed\n")
        with self.assertRaises(SystemExit):
            ar.verify_vendored(copy)


if __name__ == "__main__":
    unittest.main()
