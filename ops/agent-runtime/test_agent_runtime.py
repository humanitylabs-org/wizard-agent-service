"""Restricted runtime driver: env contract, no fallback, vendored files checked. Run: python3 -m unittest ops/agent-runtime/test_agent_runtime.py"""
import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar  # noqa: E402


def agent_folder(root: Path, agent_id: str, network: dict | None, isolation: str = "restricted") -> dict:
    folder = root / agent_id
    (folder / "home").mkdir(parents=True)
    (folder / "home" / ".env").write_text("API_SERVER_KEY=x\n")
    (folder / "runtime.key").write_text("api-key-0123456789\n")
    (folder / "gateway.key").write_text("gateway-key-abcdef\n")
    runtime = {"kind": "container", "app_id": f"agent-{agent_id}", "port": 18650}
    if isolation:
        runtime["isolation"] = isolation
    if network is not None:
        runtime["network"] = network
    agent = {"schema": 1, "id": agent_id, "label": "Daily", "runtime": runtime, "model": {"provider": "anthropic"}}
    (folder / "agent.json").write_text(json.dumps(agent))
    return agent


class RestrictedDriverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.agents = ar.Agents(self.tmp / "agents", None)
        self.driver = ar.RestrictedDriver(self.agents, ar.RESTRICTED_DIR, "", 8924)
        self.calls = []
        self.real_docker = ar.docker
        ar.docker = lambda args, **kw: (self.calls.append((args, kw.get("env"))), type("R", (), {"stdout": "", "returncode": 0})())[1]

    def tearDown(self):
        ar.docker = self.real_docker
        shutil.rmtree(self.tmp)

    def test_env_contract(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        env = self.driver.env(agent)
        self.assertEqual(env["AGENT_PROJECT"], "agent-daily")
        self.assertEqual(env["AGENT_HOME_VOLUME"], str(self.tmp / "agents" / "daily" / "home"))
        self.assertEqual(env["AGENT_API_KEY"], "api-key-0123456789")
        self.assertEqual(env["EDGE_TOKEN_SHA256"], hashlib.sha256(b"gateway-key-abcdef").hexdigest())
        self.assertEqual((env["AGENT_UPLINK_SUBNET"], env["AGENT_SANDBOX_SUBNET"]), ("10.250.0.16/28", "10.251.0.16/28"))
        self.assertEqual(env["AGENT_INGRESS_BIND"], "127.0.0.1:18650")
        self.assertEqual((env["EDGE_UPSTREAM_HOST"], env["EDGE_UPSTREAM_PORT"]), ("10.250.0.17", "8924"))
        self.assertNotIn("gateway-key-abcdef", json.dumps(env))

    def test_lifecycle_uses_the_vendored_compose_and_the_agent_service(self):
        agent = agent_folder(self.tmp / "agents", "daily", {"uplink": "10.250.0.16/28", "sandbox": "10.251.0.16/28"})
        self.driver.apply(agent)
        compose = [args for args, _ in self.calls if args[0] == "compose"]
        self.assertEqual(compose[0][:4], ["compose", "-p", "agent-daily", "-f"])
        self.assertEqual(compose[0][4], str(ar.RESTRICTED_DIR / "compose.yml"))
        self.assertIn("--build", compose[0])
        self.driver.stop(agent)
        self.assertEqual(self.calls[-1][0][-1], "stop")

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
