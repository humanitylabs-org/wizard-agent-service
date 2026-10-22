"""No-listener regression tests for the restricted edge's heavy relay allowlist."""
import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch


class HeavyAllowlistTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch.dict(os.environ, {"EDGE_UPSTREAM_HOST": "fixture", "EDGE_TOKEN_SHA256": "0" * 64}):
            cls.edge = runpy.run_path(str(Path(__file__).resolve().parents[1] / "sidecars/edge.py"))

    def allowed(self, method, target):
        cleaned = self.edge["clean_path"](target)
        return bool(cleaned and any(method in methods and rx.fullmatch(cleaned[0])
                                   for methods, rx in self.edge["ALLOW"]))

    def test_exact_post_routes(self):
        for action in ("submit", "status", "cancel", "artifacts"):
            target = "/wizard/v1/agent-heavy/" + action
            self.assertTrue(self.allowed("POST", target))
            for method in ("GET", "PUT", "DELETE", "PATCH", "OPTIONS"):
                self.assertFalse(self.allowed(method, target))

    def test_no_host_routes_or_encoding_bypass(self):
        for target in ("/wizard/internal/heavy/submit", "/wizard/v1/agent-heavy/submit/extra",
                       "/wizard/v1/agent-heavy/%73ubmit", "/wizard/v1/agent-heavy/../submit",
                       "//wizard/v1/agent-heavy/submit", "/wizard/v1/agent-heavy/submit/"):
            self.assertFalse(self.allowed("POST", target))

    def test_identity_headers_still_stripped(self):
        self.assertNotIn("x-wizard-owner-proof", self.edge["PASS_HEADERS"])
        self.assertNotIn("x-wizard-agent-id", self.edge["PASS_HEADERS"])
        self.assertIn("authorization", self.edge["PASS_HEADERS"])
        self.assertFalse(self.edge["token_ok"]("Bearer fixture"))


if __name__ == "__main__":
    unittest.main()
