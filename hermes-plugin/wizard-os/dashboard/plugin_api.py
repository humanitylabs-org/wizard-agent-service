"""Wizard OS dashboard API, mounted by stock Hermes at /api/plugins/wizard-os/ (dashboard login required).

GET /ai-usage/chatgpt -> this agent's own ChatGPT (openai-codex) usage in the wizard.ai-connection/1 `usage`
shape, so the ChatGPT connection app can report usage without ever holding a token. Read-only: Hermes' own
usage reader with read_only=True (no refresh, rotation or store write). Never returns a token.

POST /infer/chatgpt and GET /models/chatgpt implement the raw connection boundary.
See CHATGPT_INFERENCE.md for auth, limits, SSE and Hermes-internal compatibility.
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import math
import os
import threading
import time
from contextlib import contextmanager
from datetime import timezone
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from importlib.util import spec_from_file_location, module_from_spec

_spec = spec_from_file_location('wizard_provider_accounts', Path(__file__).with_name('provider_accounts.py'))
assert _spec is not None and _spec.loader is not None
_accounts = module_from_spec(_spec)
_spec.loader.exec_module(_accounts)
_lspec = spec_from_file_location('wizard_account_lifecycle', Path(__file__).with_name('account_lifecycle.py'))
assert _lspec is not None and _lspec.loader is not None
_lifecycle = module_from_spec(_lspec)
_lspec.loader.exec_module(_lifecycle)

router = APIRouter()

# Add / reconnect / remove ship switched OFF. The read-only listing works on every box regardless of
# auth.adopt_external_logins (Hermes keeps importing an existing Claude Code login). Turning account changes on needs a
# path that provably keeps that login; until then set WIZARD_ACCOUNT_CHANGES=1 only on a box that has been checked.
# A comma list of providers (e.g. `chatgpt`) turns changes on for those only: a fresh Wizard OS box adds ChatGPT
# sign-ins here while its Claude sign-in stays with the Claude app's own Claude Code page (the login the agent's
# Claude subscription provider uses).
def _changes_on(provider: str) -> bool:
    value = os.environ.get('WIZARD_ACCOUNT_CHANGES', '0').strip().lower()
    if value == '1':
        return True
    return provider in {p.strip() for p in value.split(',') if p.strip()}
_CHANGES_OFF = 'Adding and removing subscriptions here is switched off for now; manage them with stock Hermes.'


@router.get('/provider-accounts/{provider}/operations/{operation}')
def account_operation_status(provider: str, operation: str, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    try:
        return _lifecycle.broker.poll(provider, operation)
    except _lifecycle.BrokerError:
        raise HTTPException(404, 'Unknown operation') from None


@router.post('/provider-accounts/{provider}/operations')
async def account_operation(provider: str, request: Request, response: Response):
    # Stock dashboard auth protects all plugin routes. Require a non-simple
    # request too: cross-origin forms cannot initiate provider operations.
    response.headers['Cache-Control'] = 'no-store'
    if not _changes_on(provider):
        raise HTTPException(403, _CHANGES_OFF)
    if request.headers.get('X-Wizard-Account-Action') != '1' or request.headers.get('content-type', '').split(';')[0] != 'application/json':
        raise HTTPException(403, 'Account action header required')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'Cross-site action rejected')
    raw = b''
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > 4096:
            raise HTTPException(413, 'Request too large')
    try:
        body = json.loads(raw)
        if not isinstance(body, dict) or set(body) - {'action', 'target', 'label', 'confirmed', 'operation', 'code'}:
            raise _lifecycle.BrokerError('Invalid request')
        action = body.get('action')
        if action == 'cancel':
            return _lifecycle.broker.cancel(provider, body.get('operation'))
        if action == 'submit':
            return _lifecycle.broker.submit(provider, body.get('operation'), body.get('code'))
        return _lifecycle.broker.start(provider, action, body.get('target'), body.get('label', ''), body.get('confirmed'))
    except _lifecycle.BrokerError as error:
        raise HTTPException(409, str(error)) from None
    except (ValueError, TypeError):
        raise HTTPException(409, 'Invalid account request') from None
    except Exception:
        raise HTTPException(503, 'Account broker unavailable; check inventory before retrying') from None
_CACHE: dict = {"at": 0.0, "value": None}
_TTL = 60.0


def _iso(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def chatgpt_usage(fetch=None) -> dict:
    """{"ok": true, "plan", "usage": {fetchedAt, limits, paid}} or {"ok": false, "reason"}."""
    if fetch is None:
        from agent.account_usage import fetch_account_usage
        fetch = fetch_account_usage
    snap = fetch("openai-codex", read_only=True)
    if snap is None or getattr(snap, "unavailable_reason", None) or not getattr(snap, "windows", ()):
        reason = getattr(snap, "unavailable_reason", None) if snap is not None else None
        return {"ok": False, "reason": str(reason or "ChatGPT usage is not available right now.")[:200]}
    limits = []
    for i, w in enumerate(snap.windows):
        used = w.used_percent
        if not isinstance(used, (int, float)) or not math.isfinite(used):
            continue
        used = min(100.0, max(0.0, float(used)))
        label = str(w.label or "Limit")[:60]
        limits.append({"id": f"{label.lower().replace(' ', '-')}:{i}", "label": label,
                       "usedPercent": round(used, 1), "remainingPercent": math.floor(100 - used),
                       "resetsAt": _iso(w.reset_at)})
    paid = None
    credits = ((snap.raw or {}).get("credits") or {}) if isinstance(snap.raw, dict) else {}
    if credits.get("has_credits") is True:
        bal = credits.get("balance")
        try:
            bal_minor = round(float(bal) * 100)
        except (TypeError, ValueError):
            bal_minor = None
        paid = {"type": "credits", "enabled": True, "currency": "USD", "exponent": 2, "usedMinor": None,
                "limitMinor": None, "balanceMinor": bal_minor, "unlimited": credits.get("unlimited") is True}
    return {"ok": True, "plan": (str(snap.plan)[:40] if snap.plan else None),
            "usage": {"fetchedAt": _iso(snap.fetched_at), "limits": limits, "paid": paid}}


@router.get("/ai-usage/chatgpt")
def get_chatgpt_usage():
    now = time.monotonic()
    if _CACHE["value"] is not None and now - _CACHE["at"] < _TTL:
        return _CACHE["value"]
    try:
        value = chatgpt_usage()
    except Exception as e:  # noqa: BLE001 - report, never raise a token-bearing traceback
        value = {"ok": False, "reason": f"ChatGPT usage read failed ({type(e).__name__})."}
    _CACHE.update(at=now, value=value)
    return value


@router.get('/provider-accounts/{provider}')
def get_provider_accounts(provider: str):
    if provider not in _accounts.PROVIDERS:
        raise HTTPException(404, 'Unknown provider')
    try:
        result = _accounts.provider_accounts(provider)
        # Changes off (the default): the listing needs no Hermes config at all.
        if not _changes_on(provider):
            reason = _CHANGES_OFF
            result['management'] = {**result['management'], 'status': 'off', 'message': reason}
            result['actions'] = {k: False for k in result.get('actions', {})}
            for row in result.get('accounts', []):
                if isinstance(row.get('actions'), dict):
                    row['actions'] = {k: False for k in row['actions']}
            return result
        from hermes_cli.config import load_config_readonly
        auth = (load_config_readonly() or {}).get('auth') or {}
        reason = None
        if provider == 'chatgpt' and auth.get('codex_login_flow', 'device_code') != 'device_code':
            reason = 'Account changes require the stock device_code login flow.'
        if reason:
            result['management'] = {**result['management'], 'status': 'blocked', 'message': reason}
            result['actions'] = {k: False for k in result.get('actions', {})}
            for row in result.get('accounts', []):
                row['actions'] = {k: False for k in row.get('actions', {})}
        return result
    except Exception:
        raise HTTPException(503, 'Hermes account inventory unavailable') from None


# This file is imported directly by the dashboard (not as a Python package).
# Operator-owned, packaged config; never read request-selected files or Hermes prompts.
_CONFIG_PATH = Path(__file__).resolve().parent.parent / "chatgpt.json"
_CODEX_URL = "https://chatgpt.com/backend-api/codex"
_PRIVATE = contextvars.ContextVar("wizard_raw_inference_private", default=False)
_ACTIVE = 0
_ACTIVE_LOCK = threading.Lock()


class InferenceError(Exception):
    """Only constant codes cross the HTTP/log boundary; never exception text."""

    def __init__(self, code="provider_error", status=502):
        self.code, self.status = code, status
        super().__init__(code)


def _config():
    config = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    models, limits = config["models"], config["limits"]
    credential_id = config.get("credential_id")
    if credential_id is not None and (not isinstance(credential_id, str) or not credential_id):
        raise InferenceError()
    if not models or len({m["id"] for m in models}) != len(models):
        raise InferenceError()
    for model in models:
        if (set(model) != {"id", "label", "tier", "abilities"}
                or not all(isinstance(model[k], str) and model[k] for k in ("id", "label", "tier"))
                or model["tier"] not in {"fast", "standard", "frontier"}
                or model["abilities"] != ["text", "streaming"]):
            raise InferenceError()
    for key in ("request_bytes", "messages", "max_tokens", "timeout_seconds", "body_timeout_seconds", "concurrency"):
        if type(limits[key]) is not int or limits[key] <= 0:
            raise InferenceError()
    return config


def _check_boundary(request):
    # Presence, not truthiness: an empty identity header is still refused.
    for name in request.headers:
        name = name.lower()
        if name in {"tailscale-user-login", "x-forwarded-for", "forwarded", "x-real-ip"} or name.startswith("cf-"):
            raise InferenceError("provider_error", 403)
    # A backend connection app should send no Origin. Same-origin dashboard callers
    # retain the dashboard's existing authentication; no cross-origin browser access.
    origin = request.headers.get("origin")
    if origin is not None:
        parsed = urlsplit(origin)
        if (parsed.scheme not in {"http", "https"} or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment
                or origin != f"{request.url.scheme}://{request.headers.get('host', '')}"):
            raise InferenceError("provider_error", 403)
    # Never accept credentials or prompts in the query string (access logs record URLs).
    if request.url.query:
        raise InferenceError("provider_error", 400)


def _error(exc):
    if isinstance(exc, InferenceError):
        return exc
    status = getattr(exc, "status_code", None)
    code = getattr(exc, "code", None)
    if not isinstance(code, str):
        code = None
    if status == 429 or code in {"rate_limit_exceeded", "usage_limit_reached", "insufficient_quota", "codex_quota_exhausted"}:
        return InferenceError("limit", 429)
    if status == 401 or code in {"invalid_grant", "token_expired", "codex_auth_expired", "codex_auth_refresh_failed"}:
        return InferenceError("expired", 401)
    if code in {"codex_auth_missing", "codex_auth_missing_access_token", "codex_auth_missing_refresh_token"}:
        return InferenceError("signed_out", 401)
    if isinstance(exc, (TimeoutError, ConnectionError)) or type(exc).__name__ in {
            "APIConnectionError", "APITimeoutError", "ConnectError", "ReadTimeout"}:
        return InferenceError("unreachable", 503)
    return InferenceError()


def _error_response(exc):
    error = _error(exc)
    return JSONResponse({"ok": False, "error": {"code": error.code}}, status_code=error.status,
                        headers={"Cache-Control": "no-store"})


async def _read_body(request, config):
    limit = config["limits"]["request_bytes"]
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise InferenceError("provider_error", 415)
    if request.headers.get("content-encoding", "identity").lower() != "identity":
        raise InferenceError("provider_error", 415)
    length = request.headers.get("content-length")
    if length is not None and (not length.isdecimal() or int(length) > limit):
        raise InferenceError("limit", 413)
    body = bytearray()
    async with asyncio.timeout(config["limits"]["body_timeout_seconds"]):
        async for chunk in request.stream():
            if len(body) + len(chunk) > limit:
                raise InferenceError("limit", 413)
            body.extend(chunk)
    try:
        # Duplicate keys are ambiguous (e.g. two different model IDs). Reject them.
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        data = json.loads(body, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        raise InferenceError("provider_error", 400) from None
    if (not isinstance(data, dict) or set(data) - {"model", "system", "messages", "max_tokens", "stream"}
            or not {"model", "messages"} <= set(data)):
        raise InferenceError("provider_error", 400)
    if not isinstance(data["model"], str) or data["model"] not in {m["id"] for m in config["models"]}:
        raise InferenceError("provider_error", 400)
    data.setdefault("system", "")
    data.setdefault("stream", False)
    data.setdefault("max_tokens", config["limits"]["max_tokens"])
    if not isinstance(data["system"], str) or type(data["stream"]) is not bool:
        raise InferenceError("provider_error", 400)
    if (type(data["max_tokens"]) is not int
            or not 1 <= data["max_tokens"] <= config["limits"]["max_tokens"]):
        raise InferenceError("limit", 400)
    messages = data["messages"]
    if not isinstance(messages, list) or not messages or len(messages) > config["limits"]["messages"]:
        raise InferenceError("limit", 400)
    for message in messages:
        if (not isinstance(message, dict) or set(message) != {"role", "content"}
                or message["role"] not in ("user", "assistant") or not isinstance(message["content"], str)):
            raise InferenceError("provider_error", 400)
    return data


def _resolve_credential(model):
    """One pinned OAuth pool row; refresh ONLY via Hermes's locked transaction.

    Do not use the auxiliary auto-provider resolver or singleton/CLI recovery.
    Do not call select(): it may refresh/rotate to a different account on failure.
    Multiple rows require an operator-configured ID, never an availability picker.
    """
    from agent.credential_pool import load_pool, model_cooldown_until, _exhausted_until

    pool = load_pool("openai-codex")
    entries = pool.entries()
    if not entries:
        raise InferenceError("signed_out", 401)
    pinned = _config().get("credential_id")
    if pinned is not None:
        matches = [e for e in entries if e.id == pinned]
        if len(matches) != 1:
            raise InferenceError("signed_out", 401)
        entry = matches[0]
    elif len(entries) == 1:
        entry = entries[0]
    else:
        raise InferenceError()  # Ask the operator to pin, never guess an account.
    if entry.auth_type != "oauth":
        raise InferenceError("signed_out", 401)
    if entry.last_status == "dead":
        raise InferenceError("expired", 401)
    until = _exhausted_until(entry, sole_credential=len(entries) == 1) if entry.last_status == "exhausted" else None
    if (until is not None and until > time.time()) or model_cooldown_until(entry, model) is not None:
        raise InferenceError("limit", 429)
    # Refuse custom gateways even if the owner's pool routes one; never send a
    # gateway key to ChatGPT or a ChatGPT token to a relay.
    from hermes_cli.auth_codex import _codex_pool_route_base_url
    if _codex_pool_route_base_url(entry.runtime_base_url).rstrip("/") != _CODEX_URL:
        raise InferenceError()
    if pool._entry_needs_refresh(entry):
        identity = entry.id
        entry = pool._refresh_entry(entry, force=False)
        if entry is None or entry.id != identity:
            raise InferenceError("expired", 401)
    if not entry.runtime_api_key or pool._entry_needs_refresh(entry):
        raise InferenceError("expired", 401)
    if _codex_pool_route_base_url(entry.runtime_base_url).rstrip("/") != _CODEX_URL:
        raise InferenceError()
    return entry.runtime_api_key


class _PrivateSDKLogFilter(logging.Filter):
    def filter(self, record):
        return not _PRIVATE.get()


_SDK_LOG_FILTER = _PrivateSDKLogFilter()
# OpenAI debug logging includes the entire JSON request and upstream error body.
# Context-local suppression leaves concurrent normal Hermes logging unchanged.
for _logger_name in ("openai._base_client", "agent.credential_pool", "hermes_cli.auth_codex"):
    logging.getLogger(_logger_name).addFilter(_SDK_LOG_FILTER)


@contextmanager
def _private_logs():
    marker = _PRIVATE.set(True)
    try:
        yield
    finally:
        _PRIVATE.reset(marker)


def _credentials_private(model):
    with _private_logs():
        return _resolve_credential(model)


def _client(token, seconds):
    import httpx
    from openai import AsyncOpenAI

    return AsyncOpenAI(api_key=token, base_url=_CODEX_URL, max_retries=0,
                       organization="", project="", timeout=seconds,
                       http_client=httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=seconds))


def _payload(data):
    # The same converter used by _CodexCompletionsAdapter, without its runtime
    # session cache scope, default persona, auxiliary routing, logging or Relay hooks.
    from agent.codex_responses_adapter import _chat_messages_to_responses_input

    return {"model": data["model"], "instructions": data["system"],
            "input": _chat_messages_to_responses_input(
                data["messages"], current_issuer_kind="codex_backend",
                current_issuer_model=data["model"], replay_encrypted_reasoning=False,
                native_compaction_eligible=False),
            "store": False, "stream": True}


def _value(obj, key, default=None):
    return obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)


def _no_tools(item):
    if _value(item, "type") not in {"message", "reasoning"}:
        raise InferenceError()
    if _value(item, "type") == "message":
        if _value(item, "role") != "assistant":
            raise InferenceError()
        for part in _value(item, "content", ()) or ():
            if _value(part, "type") not in {"output_text", "refusal"}:
                raise InferenceError()


def _result(response, content):
    model = _value(response, "model")
    if not isinstance(model, str) or not model or len(model) > 200:
        raise InferenceError()  # Never substitute the requested model for missing upstream truth.
    output = _value(response, "output")
    if not isinstance(output, list):
        raise InferenceError()
    final_text = []
    for item in output:
        _no_tools(item)
        if _value(item, "type") == "message":
            for part in _value(item, "content", ()) or ():
                # A refusal is not a successful empty answer.
                if _value(part, "type") == "refusal":
                    raise InferenceError()
                final_text.append(_value(part, "text", ""))
    if "".join(final_text) != content:
        raise InferenceError()  # Missing/duplicated deltas are not a successful answer.
    usage = _value(response, "usage")
    counts = {key: _value(usage, key) for key in ("input_tokens", "output_tokens", "total_tokens")}
    if any(type(v) is not int or v < 0 for v in counts.values()):
        raise InferenceError()
    return {"ok": True, "model": model, "content": content, "usage": counts}


async def _events(data, token, deadline):
    # All SDK operations (including aclose/error construction) stay in this
    # request's private logging context. No prompt/response/exception is logged.
    client = stream = None
    try:
        with _private_logs():
            client = _client(token, max(0.001, deadline - time.monotonic()))
            async with asyncio.timeout_at(deadline):
                stream = await client.responses.create(**_payload(data))
        content, size, events = [], 0, 0
        while True:
            with _private_logs():
                async with asyncio.timeout_at(deadline):
                    try:
                        event = await anext(stream)
                    except StopAsyncIteration:
                        raise InferenceError() from None  # EOF without completed is never success.
            events += 1
            if events > 100000:
                raise InferenceError("limit", 429)
            kind = _value(event, "type", "")
            if kind in {"response.output_item.added", "response.output_item.done"}:
                _no_tools(_value(event, "item"))
            elif kind == "response.output_text.delta":
                delta = _value(event, "delta")
                if not isinstance(delta, str):
                    raise InferenceError()
                size += len(delta.encode("utf-8"))
                # Codex rejects max_output_tokens. A UTF-8 byte is a conservative
                # upper bound on a byte-BPE token; do not pretend this is an
                # upstream/billing cap. Fail rather than return truncated success.
                if size > data["max_tokens"]:
                    raise InferenceError("limit", 429)
                content.append(delta)
                yield "delta", {"text": delta}
            elif kind == "response.completed":
                response = _value(event, "response")
                if _value(response, "status") != "completed":
                    raise InferenceError()
                result = _result(response, "".join(content))
                if result["usage"]["output_tokens"] > data["max_tokens"]:
                    raise InferenceError("limit", 429)
                yield "done", result
                return
            elif kind in {"error", "response.failed", "response.incomplete"}:
                error = _value(_value(event, "response", event), "error", {})
                # Only code, not the potentially prompt-bearing message.
                # Map external codes without trusting them as our response enum.
                class UpstreamError(Exception):
                    code = _value(error, "code", "provider_error")
                raise _error(UpstreamError())
            elif "function_call" in kind or "tool" in kind:
                raise InferenceError()
    finally:
        # Starlette cancels the stream on disconnect. Shield bounded cleanup,
        # including when the consumer closes this generator after a done event.
        import anyio
        with _private_logs(), anyio.move_on_after(2, shield=True):
            try:
                try:
                    if stream is not None:
                        await stream.close()
                finally:
                    if client is not None:
                        await client.close()
            except Exception:
                pass  # Never let a cleanup exception disclose the upstream request.


class _InferenceStreamResponse(StreamingResponse):
    """Own the slot/resources even if ASGI disconnects before body iteration."""

    def __init__(self, body, events, deadline):
        super().__init__(body, media_type="text/event-stream",
                         headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
        self.events, self.deadline = events, deadline

    async def __call__(self, scope, receive, send):
        try:
            async with asyncio.timeout_at(self.deadline):
                await super().__call__(scope, receive, send)
        except TimeoutError:
            pass  # A stalled downstream cannot hold a concurrency slot forever.
        finally:
            try:
                await self.events.aclose()
            finally:
                _release_slot()


def _release_slot():
    global _ACTIVE
    with _ACTIVE_LOCK:
        _ACTIVE -= 1


def _sse(kind, value):
    return f"event: {kind}\ndata: {json.dumps(value, ensure_ascii=True, separators=(',', ':'))}\n\n"


@router.get("/models/chatgpt")
async def get_chatgpt_models(request: Request):
    try:
        _check_boundary(request)
        return JSONResponse({"models": _config()["models"]}, headers={"Cache-Control": "no-store"})
    except Exception as exc:
        return _error_response(exc)


@router.post("/infer/chatgpt")
async def post_chatgpt_infer(request: Request):
    global _ACTIVE
    acquired = transferred = False
    credential_task = events = None
    try:
        _check_boundary(request)
        # Hermes's optional subprocess bridge buffers request/response bodies,
        # defeating streaming/cancellation and ingress bounds. Do not claim SSE
        # support there; default in-process dashboard mounts support this route.
        if os.environ.get("HERMES_PLUGIN_HOST_PROCESS") == "1":
            raise InferenceError("provider_error", 503)
        config = _config()
        with _ACTIVE_LOCK:
            if _ACTIVE >= config["limits"]["concurrency"]:
                raise InferenceError("limit", 429)
            _ACTIVE += 1
            acquired = True
        data = await _read_body(request, config)
        deadline = time.monotonic() + config["limits"]["timeout_seconds"]
        credential_task = asyncio.create_task(asyncio.to_thread(_credentials_private, data["model"]))
        # Cancellation cannot kill a locked refresh thread. Keep its slot until
        # the thread exits; never admit an unbounded queue of abandoned refreshes.
        async with asyncio.timeout_at(deadline):
            token = await asyncio.shield(credential_task)
        events = _events(data, token, deadline)
        first = await anext(events)  # Credential/provider failures before first output remain HTTP errors.
        if data["stream"]:
            async def body():
                try:
                    yield _sse(first[0], {k: v for k, v in first[1].items() if k != "content"})
                    async for kind, value in events:
                        # Streaming does not repeat the full text in the done event.
                        yield _sse(kind, {k: v for k, v in value.items() if k != "content"})
                except Exception as exc:
                    yield _sse("error", {"ok": False, "error": {"code": _error(exc).code}})
            response = _InferenceStreamResponse(body(), events, deadline)
            transferred = True
            return response
        result = first[1] if first[0] == "done" else None
        async for kind, value in events:
            if kind == "done":
                result = value
        if result is None:
            raise InferenceError()
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    except Exception as exc:
        return _error_response(exc)
    finally:
        if not transferred:
            if events is not None:
                await events.aclose()
            if acquired:
                if credential_task is not None and not credential_task.done():
                    def finished(task):
                        try:
                            task.exception()  # retrieve, never log a credential-bearing exception
                        except asyncio.CancelledError:
                            pass
                        finally:
                            _release_slot()
                    credential_task.add_done_callback(finished)
                else:
                    _release_slot()
