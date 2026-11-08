"""Offline contract tests: python3 -I test_plugin_api.py -v (FastAPI/httpx/openai).

Hermes imports, credentials and upstream streams are fakes. Socket connections and
sensitive file access are tripwires, including in the real SDK MockTransport test.
"""
import asyncio
import builtins
import copy
import io
import json
import logging
import socket
import sys
import threading
import time
import types
import unittest
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from openai import AsyncOpenAI
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).parent))
import plugin_api as api

PREFIX = "/api/plugins/wizard-os"
MODEL = "gpt-6-luna"
BODY = {"model": MODEL, "system": "PRIVATE_SYSTEM", "messages": [
    {"role": "user", "content": "PRIVATE_PROMPT"},
    {"role": "assistant", "content": "APP_HISTORY"},
    {"role": "user", "content": "Continue"}], "max_tokens": 200, "stream": False}


def completed(**overrides):
    response = {"model": "effective-model-version", "status": "completed", "output": [
                    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hello"}]}],
                "usage": {"input_tokens": 12, "output_tokens": 3, "total_tokens": 15}}
    response.update(overrides)
    return {"type": "response.completed", "response": response}


class FakeStream:
    def __init__(self, events):
        self.events = iter(events)
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            item = next(self.events)
        except StopIteration:
            raise StopAsyncIteration from None
        if isinstance(item, Exception):
            raise item
        if callable(item):
            return await item()
        return item

    async def close(self):
        self.closed = True


class FakeClient:
    def __init__(self, stream):
        self.stream, self.closed, self.kwargs = stream, False, None
        self.responses = self

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return self.stream

    async def close(self):
        self.closed = True


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        # No actual transport is ever allowed, even if a future edit misses a fake.
        self.stack.enter_context(patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")))
        original_open, original_io_open = builtins.open, io.open

        def safe_open(real):
            def guarded(file, *args, **kwargs):
                value = str(file)
                if any(s in value for s in ("auth.json", "/.codex", "credential_pool.json", "MEMORY.md", "SOUL.md", "AGENTS.md")):
                    raise AssertionError("private file forbidden")
                return real(file, *args, **kwargs)
            return guarded
        self.stack.enter_context(patch("builtins.open", safe_open(original_open)))
        self.stack.enter_context(patch("io.open", safe_open(original_io_open)))
        original_import = builtins.__import__
        forbidden = {"run_agent", "agent.auxiliary_client", "hermes_state", "agent.memory_manager",
                     "agent.prompt_builder", "tools.memory_tool", "tools.skills_tool"}

        def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name in forbidden or "AIAgent" in (fromlist or ()) or "SessionDB" in (fromlist or ()):
                raise AssertionError("agent/persistence import forbidden")
            return original_import(name, globals, locals, fromlist, level)
        self.stack.enter_context(patch("builtins.__import__", guarded_import))
        # Also an instantiation tripwire if a reference was imported before this test.
        self.agent = Mock(side_effect=AssertionError("AIAgent forbidden"))
        self.stack.enter_context(patch.dict(sys.modules, {
            "run_agent": types.SimpleNamespace(AIAgent=self.agent),
            "hermes_state": types.SimpleNamespace(SessionDB=self.agent)}))

        self.convert = Mock(side_effect=lambda messages, **kwargs: [
            {"type": "message", "role": m["role"], "content": [{
                "type": "input_text" if m["role"] == "user" else "output_text", "text": m["content"]}]}
            for m in messages])
        self.stack.enter_context(patch.dict(sys.modules, {
            "agent": types.ModuleType("agent"),
            "agent.codex_responses_adapter": types.SimpleNamespace(_chat_messages_to_responses_input=self.convert)}))
        self.resolver = self.stack.enter_context(patch.object(api, "_resolve_credential", return_value="FAKE_OAUTH_ONLY"))
        self.stream = FakeStream([{"type": "response.output_text.delta", "delta": "Hello"}, completed()])
        self.upstream = FakeClient(self.stream)
        self.factory = self.stack.enter_context(patch.object(api, "_client", return_value=self.upstream))
        self.config = copy.deepcopy(api._config())
        self.stack.enter_context(patch.object(api, "_config", return_value=self.config))
        self.app = FastAPI()
        self.app.include_router(api.router, prefix=PREFIX)
        self.client = self.stack.enter_context(TestClient(self.app))
        self.assertEqual(api._ACTIVE, 0)

    def tearDown(self):
        self.agent.assert_not_called()
        self.assertEqual(api._ACTIVE, 0)
        self.assertFalse(api._PRIVATE.get())

    def post(self, **changes):
        return self.client.post(PREFIX + "/infer/chatgpt", json={**BODY, **changes})

    def test_exact_payload_effective_model_and_usage(self):
        response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"ok": True, "model": "effective-model-version", "content": "Hello",
                                          "usage": {"input_tokens": 12, "output_tokens": 3, "total_tokens": 15}})
        self.assertEqual(set(self.upstream.kwargs), {"model", "instructions", "input", "store", "stream"})
        self.assertIs(self.upstream.kwargs["store"], False)
        self.assertIs(self.upstream.kwargs["stream"], True)
        self.assertEqual(self.upstream.kwargs["instructions"], BODY["system"])
        self.assertEqual(self.upstream.kwargs["model"], MODEL)
        self.convert.assert_called_once_with(BODY["messages"], current_issuer_kind="codex_backend",
            current_issuer_model=MODEL, replay_encrypted_reasoning=False, native_compaction_eligible=False)
        self.resolver.assert_called_once_with(MODEL)
        self.assertTrue(self.stream.closed and self.upstream.closed)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_optional_system_has_no_default_persona(self):
        body = {"model": MODEL, "messages": [{"role": "user", "content": "hi"}]}
        self.assertEqual(self.client.post(PREFIX + "/infer/chatgpt", json=body).status_code, 200)
        self.assertEqual(self.upstream.kwargs["instructions"], "")

    def test_config_catalog_no_credential_read(self):
        response = self.client.get(PREFIX + "/models/chatgpt")
        self.assertEqual(response.json(), {"models": self.config["models"]})
        self.resolver.assert_not_called()
        self.config["models"] = [{"id": "operator-model", "label": "Custom", "tier": "standard", "abilities": ["text", "streaming"]}]
        self.assertEqual(self.post().status_code, 400)
        self.assertEqual(self.post(model="operator-model").status_code, 200)

    def test_tool_and_override_refusal(self):
        for key, value in {"tools": [], "tool_choice": "none", "base_url": "https://example.com", "api_key": "x",
                           "headers": {}, "extra_headers": {}, "provider": "openai", "profile": "x",
                           "session_id": "x", "store": True, "memory": False}.items():
            with self.subTest(key=key):
                self.assertEqual(self.post(**{key: value}).status_code, 400)
        for message in ({"role": "tool", "content": "x"}, {"role": "system", "content": "x"},
                        {"role": "assistant", "content": "x", "tool_calls": []}, {"role": "user", "content": []}):
            self.assertEqual(self.post(messages=[message]).status_code, 400)
        self.resolver.assert_not_called()

    def test_identity_headers_refused_on_both_routes(self):
        for name in ("Tailscale-User-Login", "X-Forwarded-For", "Forwarded", "X-Real-IP", "CF-Connecting-IP", "cf-anything"):
            with self.subTest(name=name):
                self.assertEqual(self.client.post(PREFIX + "/infer/chatgpt", json=BODY, headers={name: ""}).status_code, 403)
                self.assertEqual(self.client.get(PREFIX + "/models/chatgpt", headers={name: ""}).status_code, 403)
        self.resolver.assert_not_called()

    def test_origin_query_and_encoding_refusal(self):
        for origin in ("null", "https://evil.invalid", "http://testserver/path", "http://testserver@evil.invalid"):
            self.assertEqual(self.client.post(PREFIX + "/infer/chatgpt", json=BODY, headers={"origin": origin}).status_code, 403)
        self.assertEqual(self.client.get(PREFIX + "/models/chatgpt?model=bad").status_code, 400)
        self.assertEqual(self.client.post(PREFIX + "/infer/chatgpt", json=BODY, headers={"content-encoding": "gzip"}).status_code, 415)
        self.assertEqual(self.client.post(PREFIX + "/infer/chatgpt", content="nope").status_code, 415)
        self.resolver.assert_not_called()
        self.assertEqual(self.client.get(PREFIX + "/models/chatgpt", headers={"origin": "http://testserver"}).status_code, 200)

    def test_validation_and_size_limits(self):
        for changes in ({"model": "not-allowed"}, {"stream": "true"}, {"max_tokens": True},
                        {"max_tokens": 0}, {"max_tokens": 999999}, {"messages": []}, {"system": []}):
            self.assertEqual(self.post(**changes).status_code, 400)
        self.assertEqual(self.post(messages=[BODY["messages"][0]] * 129).status_code, 400)
        self.config["limits"]["request_bytes"] = 100
        self.assertEqual(self.post().status_code, 413)
        self.assertEqual(self.client.post(PREFIX + "/infer/chatgpt", content=iter([b"a" * 60, b"b" * 60]),
                                         headers={"content-type": "application/json"}).status_code, 413)
        self.resolver.assert_not_called()

    def test_malformed_and_duplicate_json_not_echoed(self):
        for body in ('{"model":"PRIVATE_PROMPT","model":"second"}', '{"PRIVATE_PROMPT":', '[]', 'null'):
            response = self.client.post(PREFIX + "/infer/chatgpt", content=body, headers={"content-type": "application/json"})
            self.assertEqual(response.status_code, 400)
            self.assertNotIn("PRIVATE_PROMPT", response.text)
        self.resolver.assert_not_called()

    def test_error_mapping_no_fallback_or_disclosure(self):
        for status, code in ((401, "expired"), (429, "limit"), (403, "provider_error"), (404, "provider_error"), (500, "provider_error")):
            error = RuntimeError("PRIVATE_PROMPT FAKE_OAUTH_ONLY")
            error.status_code = status
            self.resolver.side_effect = error
            response = self.post()
            self.assertEqual(response.json(), {"ok": False, "error": {"code": code}})
        self.resolver.side_effect = TimeoutError("PRIVATE_PROMPT")
        self.assertEqual(self.post().json()["error"]["code"], "unreachable")
        self.resolver.side_effect = api.InferenceError("signed_out", 401)
        self.assertEqual(self.post().json()["error"]["code"], "signed_out")
        self.factory.assert_not_called()

    def test_stream_done_event(self):
        response = self.post(stream=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/event-stream", response.headers["content-type"])
        chunks = response.text.strip().split("\n\n")
        self.assertEqual(len(chunks), 2)
        self.assertTrue(chunks[0].startswith("event: delta\n"))
        self.assertTrue(chunks[1].startswith("event: done\n"))
        value = json.loads(chunks[1].split("data: ")[1])
        self.assertEqual(value["model"], "effective-model-version")
        self.assertEqual(value["usage"]["total_tokens"], 15)
        self.assertNotIn("content", value)
        self.assertTrue(self.stream.closed and self.upstream.closed)

    def test_tool_output_and_incomplete_fail_closed(self):
        bad_events = [
            {"type": "response.output_item.added", "item": {"type": "web_search_call"}},
            {"type": "response.function_call_arguments.delta", "delta": "x"},
            {"type": "response.incomplete", "response": {}},
            completed(output=[{"type": "function_call"}]), completed(model=None), completed(usage=None)]
        for event in bad_events:
            self.upstream.stream = FakeStream([event])
            self.assertEqual(self.post().json()["error"]["code"], "provider_error")
        self.upstream.stream = FakeStream([])
        self.assertEqual(self.post().json()["error"]["code"], "provider_error")

    def test_mid_stream_error_not_done_or_raw_exception(self):
        self.stream.events = iter([{"type": "response.output_text.delta", "delta": "Hi"},
                                  RuntimeError("PRIVATE_PROMPT FAKE_OAUTH_ONLY")])
        response = self.post(stream=True)
        self.assertIn("event: error", response.text)
        self.assertNotIn("event: done", response.text)
        self.assertNotIn("PRIVATE_PROMPT", response.text)
        self.assertTrue(self.stream.closed and self.upstream.closed)

    def test_upstream_rate_limit_event(self):
        self.stream.events = iter([{"type": "response.failed", "response": {
            "error": {"code": "rate_limit_exceeded", "message": "PRIVATE_PROMPT"}}}])
        self.assertEqual(self.post().json()["error"]["code"], "limit")

    def test_output_limit_cancels_not_truncated_success(self):
        response = self.post(max_tokens=3)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["error"]["code"], "limit")
        self.assertTrue(self.stream.closed and self.upstream.closed)

    def test_timeout_closes_stream(self):
        async def stall():
            await asyncio.Event().wait()
        self.stream.events = iter([stall])
        self.config["limits"]["timeout_seconds"] = 0.02
        response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertTrue(self.stream.closed and self.upstream.closed)

    def test_body_timeout(self):
        async def scenario():
            async def receive():
                await asyncio.Event().wait()
            scope = {"type": "http", "method": "POST", "path": "/infer/chatgpt", "query_string": b"",
                     "scheme": "http", "headers": [(b"host", b"testserver"), (b"content-type", b"application/json")]}
            self.config["limits"]["body_timeout_seconds"] = 0.01
            response = await api.post_chatgpt_infer(Request(scope, receive))
            self.assertEqual(response.status_code, 503)
        asyncio.run(scenario())
        self.resolver.assert_not_called()

    def test_hosted_bridge_fails_closed_before_credentials(self):
        with patch.dict(api.os.environ, {"HERMES_PLUGIN_HOST_PROCESS": "1"}):
            self.assertEqual(self.post(stream=True).status_code, 503)
        self.resolver.assert_not_called()

    def test_upstream_usage_above_output_budget_fails(self):
        self.stream.events = iter([{"type": "response.output_text.delta", "delta": "Hello"},
            completed(usage={"input_tokens": 1, "output_tokens": 500, "total_tokens": 501})])
        self.assertEqual(self.post().json()["error"]["code"], "limit")

    def test_concurrency_rejection(self):
        api._ACTIVE = self.config["limits"]["concurrency"]
        try:
            self.assertEqual(self.post().status_code, 429)
            self.resolver.assert_not_called()
        finally:
            api._ACTIVE = 0

    def test_cancelled_refresh_keeps_slot_until_thread_exits(self):
        started, release = threading.Event(), threading.Event()
        def blocked(model):
            started.set()
            release.wait(2)
            return "FAKE_OAUTH_ONLY"
        self.resolver.side_effect = blocked
        self.config["limits"]["timeout_seconds"] = 0.02
        async def scenario():
            transport = httpx.ASGITransport(app=self.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                try:
                    response = await client.post(PREFIX + "/infer/chatgpt", json=BODY)
                    self.assertEqual(response.status_code, 503)
                    self.assertTrue(started.is_set())
                    self.assertEqual(api._ACTIVE, 1)
                finally:
                    release.set()
                for _ in range(100):
                    if api._ACTIVE == 0:
                        break
                    await asyncio.sleep(0.005)
                self.assertEqual(api._ACTIVE, 0)
        asyncio.run(scenario())
        self.factory.assert_not_called()

    def test_disconnect_cleans_up_stream_and_slot(self):
        async def scenario():
            data = json.dumps({**BODY, "stream": True}).encode()
            scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
                     "method": "POST", "path": "/infer/chatgpt", "query_string": b"", "scheme": "http",
                     "headers": [(b"host", b"testserver"), (b"content-type", b"application/json")]}
            async def receive():
                return {"type": "http.request", "body": data, "more_body": False}
            async def send(message):
                if message["type"] == "http.response.body":
                    raise OSError("disconnected")
            response = await api.post_chatgpt_infer(Request(scope, receive))
            try:
                await response(scope, receive, send)
            except Exception as exc:
                self.assertIn(type(exc).__name__, {"ClientDisconnect", "OSError"})
        asyncio.run(scenario())
        self.assertTrue(self.stream.closed and self.upstream.closed)

    def test_real_sdk_error_body_is_not_logged_or_returned(self):
        attempts = []
        def handle(request):
            attempts.append(request)
            return httpx.Response(401, json={"error": {"code": "invalid_api_key",
                "message": "PRIVATE_PROMPT FAKE_OAUTH_ONLY"}})
        self.factory.side_effect = lambda token, seconds: AsyncOpenAI(
            api_key=token, base_url=api._CODEX_URL, max_retries=0,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle), trust_env=False))
        logs = io.StringIO()
        handler = logging.StreamHandler(logs)
        logger = logging.getLogger("openai._base_client")
        previous = logger.level
        logger.setLevel(logging.DEBUG)
        logger.addHandler(handler)
        try:
            response = self.post()
        finally:
            logger.removeHandler(handler)
            logger.setLevel(previous)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "expired")
        self.assertNotIn("PRIVATE_PROMPT", response.text + logs.getvalue())
        self.assertNotIn("FAKE_OAUTH_ONLY", response.text + logs.getvalue())

    def test_real_sdk_mock_transport_payload_and_debug_log_privacy(self):
        wire = []
        def handle(request):
            wire.append(request)
            events = [{"type": "response.output_text.delta", "delta": "Hello"}, completed()]
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  content="".join("data: " + json.dumps(e) + "\n\n" for e in events))
        def factory(token, seconds):
            return AsyncOpenAI(api_key=token, base_url=api._CODEX_URL, max_retries=0,
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle), trust_env=False))
        self.factory.side_effect = factory
        logs = io.StringIO()
        handler = logging.StreamHandler(logs)
        root = logging.getLogger()
        root.addHandler(handler)
        sdk_logger = logging.getLogger("openai._base_client")
        previous = sdk_logger.level
        sdk_logger.setLevel(logging.DEBUG)
        try:
            response = self.post()
            self.assertEqual(response.status_code, 200, response.text)
            sdk_logger.debug("outside-private-request")
        finally:
            sdk_logger.setLevel(previous)
            root.removeHandler(handler)
        self.assertEqual(len(wire), 1)
        self.assertEqual(str(wire[0].url), api._CODEX_URL + "/responses")
        self.assertEqual(wire[0].headers["authorization"], "Bearer FAKE_OAUTH_ONLY")
        payload = json.loads(wire[0].content)
        self.assertEqual(set(payload), {"model", "instructions", "input", "store", "stream"})
        self.assertNotIn("PRIVATE_PROMPT", logs.getvalue())
        self.assertNotIn("PRIVATE_SYSTEM", logs.getvalue())
        self.assertNotIn("FAKE_OAUTH_ONLY", logs.getvalue())
        self.assertIn("outside-private-request", logs.getvalue())


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.entry = types.SimpleNamespace(id="row-one", auth_type="oauth", last_status="ok",
                                          runtime_base_url=api._CODEX_URL, runtime_api_key="FAKE",
                                          needs_refresh=False)
        self.pool = Mock()
        self.pool.entries.return_value = [self.entry]
        self.pool._entry_needs_refresh.side_effect = lambda e: e.needs_refresh
        self.load = Mock(return_value=self.pool)
        self.cooldown = Mock(return_value=None)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(api, "_config", return_value={"credential_id": "row-one"}))
        self.stack.enter_context(patch.dict(sys.modules, {
            "agent": types.ModuleType("agent"), "hermes_cli": types.ModuleType("hermes_cli"),
            "agent.credential_pool": types.SimpleNamespace(load_pool=self.load, model_cooldown_until=self.cooldown,
                                                          _exhausted_until=lambda e, **kw: time.time() + 60),
            "hermes_cli.auth_codex": types.SimpleNamespace(_codex_pool_route_base_url=lambda url: url)}))

    def test_provider_pinned_and_refresh_reuses_pool_transaction(self):
        self.entry.needs_refresh = True
        def locked_refresh(entry, *, force):
            self.assertIs(entry, self.entry)
            self.assertIs(force, False)
            entry.needs_refresh = False
            return entry
        self.pool._refresh_entry.side_effect = locked_refresh
        self.assertEqual(api._resolve_credential(MODEL), "FAKE")
        self.load.assert_called_once_with("openai-codex")
        self.pool._refresh_entry.assert_called_once_with(self.entry, force=False)
        self.pool.select.assert_not_called()

    def test_refresh_failure_never_selects_another_account(self):
        self.entry.needs_refresh = True
        self.pool.entries.return_value = [self.entry, types.SimpleNamespace(id="other-account")]
        self.pool._refresh_entry.return_value = None
        with self.assertRaises(api.InferenceError) as caught:
            api._resolve_credential(MODEL)
        self.assertEqual(caught.exception.code, "expired")
        self.pool.select.assert_not_called()
        self.pool._refresh_entry.assert_called_once()

    def test_multiple_accounts_require_explicit_pin(self):
        self.pool.entries.return_value = [self.entry, types.SimpleNamespace(id="other-account")]
        with patch.object(api, "_config", return_value={"credential_id": None}):
            with self.assertRaises(api.InferenceError):
                api._resolve_credential(MODEL)
        self.pool.entries.return_value = [types.SimpleNamespace(id="other-account")]
        with self.assertRaises(api.InferenceError) as caught:
            api._resolve_credential(MODEL)
        self.assertEqual(caught.exception.code, "signed_out")
        self.pool.select.assert_not_called()
        self.pool._refresh_entry.assert_not_called()

    def test_missing_dead_limited_and_custom_route(self):
        for key, value, code in (("last_status", "dead", "expired"), ("last_status", "exhausted", "limit"),
                                 ("auth_type", "api_key", "signed_out"),
                                 ("runtime_base_url", "https://relay.invalid", "provider_error")):
            old = getattr(self.entry, key)
            setattr(self.entry, key, value)
            with self.assertRaises(api.InferenceError) as caught:
                api._resolve_credential(MODEL)
            self.assertEqual(caught.exception.code, code)
            setattr(self.entry, key, old)
        self.pool.entries.return_value = []
        with self.assertRaises(api.InferenceError) as caught:
            api._resolve_credential(MODEL)
        self.assertEqual(caught.exception.code, "signed_out")
        self.pool._refresh_entry.assert_not_called()


class UsageTests(unittest.TestCase):
    def test_existing_usage_remains_read_only_and_redacted(self):
        def fetch(provider, read_only=False):
            self.assertEqual((provider, read_only), ("openai-codex", True))
            return types.SimpleNamespace(plan="Pro", unavailable_reason=None,
                fetched_at=datetime(2026, 10, 16, 4, 48, 23, 362000, tzinfo=timezone.utc),
                windows=[types.SimpleNamespace(label="Weekly", used_percent=6.0,
                         reset_at=datetime(2026, 10, 22, 6, 13, 23, tzinfo=timezone.utc)),
                         types.SimpleNamespace(label="Bad", used_percent=float("nan"), reset_at=None)],
                raw={"credits": {"has_credits": True, "balance": "62500.00"}, "access_token": "SECRET"})
        result = api.chatgpt_usage(fetch)
        self.assertEqual(result["usage"]["limits"], [{"id": "weekly:0", "label": "Weekly", "usedPercent": 6.0,
            "remainingPercent": 94, "resetsAt": "2026-10-22T06:13:23.000Z"}])
        self.assertEqual(result["usage"]["paid"]["balanceMinor"], 6250000)
        self.assertEqual(result["usage"]["fetchedAt"], "2026-10-16T04:48:23.362Z")
        self.assertNotIn("SECRET", repr(result))
        self.assertFalse(api.chatgpt_usage(lambda *a, **kw: None)["ok"])


if __name__ == "__main__":
    unittest.main()
