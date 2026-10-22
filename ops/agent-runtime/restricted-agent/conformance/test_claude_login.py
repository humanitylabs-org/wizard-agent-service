"""Offline Docker Compose rendering only: no containers, credentials or network listeners."""
import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


def render(granted=False):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AGENT_", "EDGE_", "EGRESS_", "COMPOSE_"))}
    env.update(AGENT_API_KEY="synthetic-api-key", EDGE_TOKEN_SHA256="0" * 64)
    args = ["docker", "compose", "--project-name", "claude-grant-fixture", "-f", str(ROOT / "compose.yml")]
    if granted:
        args += ["-f", str(ROOT / "compose.claude-login.yml")]
    result = subprocess.run([*args, "config", "--format", "json"], env=env, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


class ClaudeComposeTest(unittest.TestCase):
    def test_base_has_no_login(self):
        doc = render()
        self.assertNotIn("claude-login", doc.get("volumes", {}))
        for service in doc["services"].values():
            self.assertNotIn("CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR", service.get("environment", {}))
            self.assertFalse(any(v["target"] == "/claude" for v in service.get("volumes", [])))

    def test_grant_mounts_only_in_agent(self):
        doc = render(True)
        self.assertEqual(doc["volumes"]["claude-login"]["name"], "wizard-ai-accounts-claude")
        self.assertTrue(doc["volumes"]["claude-login"]["external"])
        for name, service in doc["services"].items():
            logins = [v for v in service.get("volumes", []) if v["target"] == "/claude"]
            self.assertEqual(len(logins), 1 if name == "agent" else 0)
            if name == "agent":
                self.assertEqual(logins[0]["source"], "claude-login")
                self.assertFalse(logins[0].get("read_only", False))
                self.assertEqual(service["environment"]["CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR"], "/claude")
            else:
                self.assertNotIn("CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR", service.get("environment", {}))

    def test_grant_preserves_hardening_and_home_init(self):
        base, grant = render(), render(True)
        for name in ("edge", "home-init"):
            self.assertEqual(base["services"][name], grant["services"][name])
        a, b = base["services"]["agent"], grant["services"]["agent"]
        for key in set(a) - {"environment", "volumes"}:
            self.assertEqual(a[key], b[key], key)
        self.assertEqual(b["user"], "10000:10000")
        self.assertEqual(b["cap_drop"], ["ALL"])
        self.assertTrue(b["read_only"])
        self.assertEqual(a["volumes"], [v for v in b["volumes"] if v["target"] != "/claude"])

    def test_only_required_refresh_host_added(self):
        base, grant = render(), render(True)
        def hosts(doc):
            return set(doc["services"]["egress"]["environment"]["EGRESS_ALLOWLIST_HOSTS"].split())
        self.assertEqual(hosts(grant) - hosts(base), {"platform.claude.com"})
        self.assertFalse(hosts(base) - hosts(grant))
        self.assertNotIn("statsig.anthropic.com", hosts(grant))


if __name__ == "__main__":
    unittest.main()
