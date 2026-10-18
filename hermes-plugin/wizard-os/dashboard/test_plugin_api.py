"""Unit test for the Wizard OS dashboard plugin route (no Hermes needed): python3 -I test_plugin_api.py"""
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

fastapi = types.ModuleType("fastapi")


class _Router:
    def get(self, _path):
        return lambda fn: fn


fastapi.APIRouter = _Router
sys.modules.setdefault("fastapi", fastapi)
sys.path.insert(0, str(Path(__file__).parent))
import plugin_api  # noqa: E402


class W:
    def __init__(self, label, used, reset):
        self.label, self.used_percent, self.reset_at = label, used, reset


class Snap:
    def __init__(self, windows, plan="pro", reason=None, raw=None):
        self.windows, self.plan, self.unavailable_reason, self.raw = windows, plan, reason, raw
        self.fetched_at = datetime(2026, 10, 16, 4, 48, 23, 362000, tzinfo=timezone.utc)


calls = []


def fetch_ok(provider, read_only=False):
    calls.append((provider, read_only))
    return Snap([W("Weekly", 6.0, datetime(2026, 10, 22, 6, 13, 23, tzinfo=timezone.utc)), W("Bad", float("nan"), None)],
                plan="Pro", raw={"credits": {"has_credits": True, "balance": "62500.00"}, "access_token": "SECRET"})


d = plugin_api.chatgpt_usage(fetch_ok)
assert calls == [("openai-codex", True)], calls   # read-only: never refreshes or rotates
assert d["ok"] and d["plan"] == "Pro", d
assert d["usage"]["limits"] == [{"id": "weekly:0", "label": "Weekly", "usedPercent": 6.0, "remainingPercent": 94,
                                 "resetsAt": "2026-10-22T06:13:23.000Z"}], d
assert d["usage"]["paid"]["balanceMinor"] == 6250000 and d["usage"]["fetchedAt"] == "2026-10-16T04:48:23.362Z"
assert "SECRET" not in repr(d)
assert plugin_api.chatgpt_usage(lambda p, read_only=False: None) == {
    "ok": False, "reason": "ChatGPT usage is not available right now."}
assert plugin_api.chatgpt_usage(lambda p, read_only=False: Snap([], reason="not signed in"))["reason"] == "not signed in"
print("ok")
