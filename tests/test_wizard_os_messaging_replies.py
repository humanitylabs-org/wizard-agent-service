"""wizard-os plugin: WizardOS replies into messaging-app chats (wizard-agent-service issue 427).

Run: python3 tests/test_wizard_os_messaging_replies.py
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("messaging_replies", ROOT / "hermes-plugin" / "wizard-os" / "messaging_replies.py")
mr = importlib.util.module_from_spec(spec)
sys.modules["messaging_replies"] = mr
spec.loader.exec_module(mr)


class FakeAdapter:
    def __init__(self):
        self.sent = []

    async def send(self, chat_id, content, metadata=None):
        self.sent.append((chat_id, content, metadata))
        return SimpleNamespace(success=True, message_id="m1")


class FakeLoop:
    """Stands in for the gateway loop: run the coroutine at once on a private loop."""

    def is_closed(self):
        return False


def run_now(coro, _loop):
    import asyncio
    import concurrent.futures

    future = concurrent.futures.Future()
    future.set_result(asyncio.new_event_loop().run_until_complete(coro))
    return future


class FakeStore:
    def __init__(self, current):
        self.current = current

    def lookup_by_session_key(self, key):
        return SimpleNamespace(session_id=self.current.get(key)) if key in self.current else None


class FakeCtx:
    plugin_id = "wizard-os"

    def __init__(self, ok=True):
        self.injected = []
        self.ok = ok

    def inject_message(self, text, role="user", *, session_key=None):
        self.injected.append((text, session_key))
        return self.ok


ITEM = {"id": "wizmr_" + "a" * 32, "kind": "inject", "session_id": "s1", "session_key": "agent:main:telegram:dm:42",
        "platform": "telegram", "chat_id": "42", "chat_type": "dm", "thread_id": "", "text": "hello from WizardOS"}


class HandleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ledger = mr.Ledger(Path(self.tmp.name) / "ledger.json")
        self.adapter = FakeAdapter()
        self.runner = SimpleNamespace(_gateway_loop=FakeLoop(), session_store=FakeStore({ITEM["session_key"]: "s1"}))
        self.live = lambda platform: (self.runner, self.adapter)
        patcher = mock.patch.object(mr.asyncio, "run_coroutine_threadsafe", run_now)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_current_chat_gets_the_note_then_one_injected_turn(self):
        ctx = FakeCtx()
        report = mr.handle(ctx, dict(ITEM), self.ledger, live=self.live)
        self.assertEqual(report["status"], "injected")
        self.assertEqual(self.adapter.sent, [("42", "💬 From WizardOS: hello from WizardOS", None)])
        self.assertEqual(ctx.injected, [("hello from WizardOS", "agent:main:telegram:dm:42")])

    def test_the_same_item_again_is_reported_never_injected_twice(self):
        ctx = FakeCtx()
        first = mr.handle(ctx, dict(ITEM), self.ledger, live=self.live)
        # A lost acknowledgement: the Service offers the same id again, also after a gateway restart.
        again = mr.handle(ctx, dict(ITEM), mr.Ledger(self.ledger.path), live=self.live)
        self.assertEqual(again["status"], "injected")
        self.assertEqual(again["at"], first["at"])
        self.assertEqual(len(ctx.injected), 1)
        self.assertEqual(len(self.adapter.sent), 1)

    def test_a_slack_thread_keeps_its_thread(self):
        ctx = FakeCtx()
        item = {**ITEM, "id": "wizmr_" + "b" * 32, "platform": "slack", "chat_id": "C1", "thread_id": "1700000000.000100",
                "session_key": "agent:main:slack:group:C1:1700000000.000100"}
        self.runner.session_store = FakeStore({item["session_key"]: "s1"})
        self.assertEqual(mr.handle(ctx, item, self.ledger, live=self.live)["status"], "injected")
        self.assertEqual(self.adapter.sent[0][2], {"thread_id": "1700000000.000100"})
        self.assertEqual(ctx.injected[0][1], item["session_key"])

    def test_a_chat_the_app_moved_on_from_is_not_injected(self):
        ctx = FakeCtx()
        self.runner.session_store = FakeStore({ITEM["session_key"]: "s2"})
        self.assertEqual(mr.handle(ctx, dict(ITEM), self.ledger, live=self.live), {"status": "older"})
        self.assertEqual(ctx.injected, [])
        self.assertEqual(self.adapter.sent, [])

    def test_a_note_is_posted_once_per_chat(self):
        note = {**ITEM, "kind": "note", "text": ""}
        self.assertEqual(mr.handle(FakeCtx(), dict(note, id="wizmr_" + "c" * 32), self.ledger, live=self.live), {"status": "noted"})
        self.assertEqual(mr.handle(FakeCtx(), dict(note, id="wizmr_" + "d" * 32), self.ledger, live=self.live), {"status": "noted"})
        self.assertEqual(self.adapter.sent, [("42", mr.CONTINUED_NOTE, None)])

    def test_refused_injection_and_no_connection_fail_visibly(self):
        report = mr.handle(FakeCtx(ok=False), dict(ITEM), self.ledger, live=self.live)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(mr.handle(FakeCtx(), dict(ITEM, id="wizmr_" + "e" * 32), self.ledger, live=lambda p: (None, None))["status"], "failed")


class GrantTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.config = {"model": {"default": "x"}}
        io = (lambda path: json.loads(json.dumps(self.config)), lambda path, raw: (self.config.clear(), self.config.update(raw)))
        patcher = mock.patch.object(mr, "_config_io", lambda: io)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_switch_on_grants_and_off_takes_back_only_our_grant(self):
        self.assertTrue(mr.set_injection_grant("wizard-os", True, self.home))
        self.assertIs(self.config["plugins"]["entries"]["wizard-os"]["allow_gateway_injection"], True)
        self.assertTrue(mr.set_injection_grant("wizard-os", False, self.home))
        self.assertEqual(self.config, {"model": {"default": "x"}})

    def test_the_owners_own_grant_stays(self):
        self.config["plugins"] = {"entries": {"wizard-os": {"allow_gateway_injection": True}}}
        self.assertFalse(mr.set_injection_grant("wizard-os", False, self.home))
        self.assertIs(self.config["plugins"]["entries"]["wizard-os"]["allow_gateway_injection"], True)


class WorkerTests(unittest.TestCase):
    def test_outside_the_gateway_it_never_calls_the_service(self):
        calls = []
        ctx = SimpleNamespace(_manager=SimpleNamespace(has_gateway_message_injector=False), plugin_id="wizard-os")
        worker = mr.Worker(ctx, lambda: "http://127.0.0.1:1/wizard/mcp", lambda name: "k")
        worker._call = lambda *a: calls.append(a)
        self.assertEqual(worker.once(), mr.IDLE_SECONDS)
        self.assertEqual(calls, [])

    def test_switch_off_takes_the_grant_back_and_injects_nothing(self):
        ctx = SimpleNamespace(_manager=SimpleNamespace(has_gateway_message_injector=True), plugin_id="wizard-os",
                              inject_message=mock.Mock())
        worker = mr.Worker(ctx, lambda: "http://127.0.0.1:1/wizard/mcp", lambda name: "k")
        worker._call = lambda action, body: {"on": False, "items": [ITEM]}
        with mock.patch.object(mr, "set_injection_grant") as grant:
            self.assertEqual(worker.once(), mr.IDLE_SECONDS)
        grant.assert_called_once_with("wizard-os", False)
        ctx.inject_message.assert_not_called()

    def test_service_address_is_only_the_wizard_gateway(self):
        self.assertEqual(mr._service(lambda: "http://svc:8787/wizard/mcp", lambda n: "k"), ("http://svc:8787", "k"))
        for url in ("http://u:p@svc/wizard/mcp", "http://svc/other", "file:///x", "http://svc/wizard/mcp?x=1"):
            self.assertIsNone(mr._service(lambda u=url: u, lambda n: "k"), url)
        self.assertIsNone(mr._service(lambda: "http://svc/wizard/mcp", lambda n: ""))


if __name__ == "__main__":
    unittest.main()
