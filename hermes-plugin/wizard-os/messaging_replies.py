"""Replies from WizardOS into chats a messaging app owns (wizard-agent-service issue 427).

Owner switch ``wizard/messaging-chat-replies`` (off by default), decided by the Agent Service. Hermes lets only the
Telegram/Slack/... connection write into a chat that connection started, so the Service never sends these replies to
``/v1/runs``. It keeps them in an outbox, and this worker, running inside the Hermes gateway process, takes them:

1. checks the chat is still its conversation key's live session (a ``/new`` in the app moves the key on);
2. posts one line in that chat through the live adapter: ``💬 From WizardOS: <text>``;
3. hands the text to stock Hermes ``PluginContext.inject_message(text, session_key=...)``, the door Hermes gives
   plugins for this: the chat's own adapter runs the turn (in newer Hermes, the session's own queue), so the answer
   goes to the app and into the same session, and the connection stays the only writer;
4. reports back, so the Service can show the answer in WizardOS.

A "note" item (an older chat the Service carries on itself) only posts ``↪ This chat continued in WizardOS.`` once.

Exactly once: each item id is written to a ledger in the plugin's Hermes home BEFORE the inject, so a lost
acknowledgement or a second offer of the same id is acknowledged again, never injected twice.

Hermes' own permission (``plugins.entries.<plugin>.allow_gateway_injection``) is set while the switch is on and taken
back when it goes off (only if this worker set it). No Hermes core change.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

logger = logging.getLogger(__name__)

NOTE_PREFIX = "💬 From WizardOS: "
CONTINUED_NOTE = "↪ This chat continued in WizardOS."
POLL_SECONDS = 2.0
IDLE_SECONDS = 20.0
LEDGER_NAME = ".wizard-messaging-replies.json"
GRANT_MARK = ".wizard-messaging-injection-granted"
_LEDGER_KEEP = 2000


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - outside Hermes (tests)
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _service(gateway_url, secret):
    """``(origin, key)`` of this profile's Agent Service, from the `wizard` MCP entry and its gateway key."""
    url = gateway_url()
    try:
        parsed = urlparse(url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password
                or parsed.path.rstrip("/") != "/wizard/mcp" or parsed.query or parsed.fragment):
            return None
        parsed.port
    except ValueError:
        return None
    try:
        key = secret("WIZARD_MCP_TOKEN") or ""
    except Exception:  # noqa: BLE001
        key = ""
    if not key:
        return None
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", "")), key


class Ledger:
    """Item ids this gateway already handled: ``id -> {status, at}``, kept in the plugin's Hermes home."""

    def __init__(self, path: Path):
        self.path = path
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self.items = data.get("items", {}) if isinstance(data, dict) else {}
            self.noted = set(data.get("noted", [])) if isinstance(data, dict) else set()
        except (OSError, ValueError):
            self.items, self.noted = {}, set()

    def save(self) -> None:
        if len(self.items) > _LEDGER_KEEP:
            for key in sorted(self.items, key=lambda k: self.items[k].get("at", 0))[: len(self.items) - _LEDGER_KEEP]:
                self.items.pop(key, None)
        tmp = self.path.with_name(self.path.name + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"items": self.items, "noted": sorted(self.noted)[-_LEDGER_KEEP:]}), encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def mark(self, item_id: str, status: str, **extra) -> None:
        self.items[item_id] = {"status": status, "at": time.time(), **extra}
        self.save()


def _config_io():
    try:
        from hermes_cli.config import atomic_config_write, read_user_config_raw

        return read_user_config_raw, atomic_config_write
    except Exception:  # noqa: BLE001
        return None


def set_injection_grant(plugin_id: str, on: bool, home: Path | None = None) -> bool:
    """Grant (or take back the grant we gave) ``plugins.entries.<plugin_id>.allow_gateway_injection``.
    True when the permission now matches ``on``. An owner's own setting is never removed."""
    home = home or _home()
    path, mark = home / "config.yaml", home / GRANT_MARK
    io = _config_io()
    if io is None:
        return False
    read, write = io
    try:
        raw = read(path)
    except Exception:  # noqa: BLE001 - an unreadable config is never rewritten
        return False
    if not isinstance(raw, dict):
        return False
    plugins = raw.get("plugins") if isinstance(raw.get("plugins"), dict) else {}
    entries = plugins.get("entries") if isinstance(plugins.get("entries"), dict) else {}
    entry = entries.get(plugin_id) if isinstance(entries.get(plugin_id), dict) else {}
    granted = entry.get("allow_gateway_injection") is True
    if on == granted:
        return True
    if not on and not mark.exists():
        return False  # the owner's own grant: leave it
    if on:
        entry = {**entry, "allow_gateway_injection": True}
    else:
        entry = {k: v for k, v in entry.items() if k != "allow_gateway_injection"}
    entries = {**entries, plugin_id: entry} if entry else {k: v for k, v in entries.items() if k != plugin_id}
    plugins = {**plugins, "entries": entries} if entries else {k: v for k, v in plugins.items() if k != "entries"}
    raw = {**raw, "plugins": plugins} if plugins else {k: v for k, v in raw.items() if k != "plugins"}
    try:
        write(path, raw)
    except Exception:  # noqa: BLE001 - managed installs refuse; the replies then fail visibly in WizardOS
        logger.warning("wizard-os: could not %s the messaging injection permission", "set" if on else "remove", exc_info=True)
        return False
    if on:
        mark.write_text("set by the wizard-os plugin for WizardOS messaging replies\n", encoding="utf-8")
    else:
        mark.unlink(missing_ok=True)
    return True


def _live(platform: str):
    """``(runner, adapter)`` of this process's gateway for *platform*, or ``(None, None)`` outside the gateway."""
    try:
        from gateway.config import Platform

        try:
            from tools.send_message_senders import _live_adapter
        except ImportError:
            from tools.send_message_tool import _live_adapter
        return _live_adapter(Platform(platform))
    except Exception:  # noqa: BLE001
        return None, None


def _current_session(runner, session_key: str) -> str | None:
    store = getattr(runner, "session_store", None)
    lookup = getattr(store, "lookup_by_session_key", None)
    if not callable(lookup):
        return None
    try:
        entry = lookup(session_key)
    except Exception:  # noqa: BLE001
        return None
    return getattr(entry, "session_id", None) if entry is not None else None


def _post(runner, adapter, item: dict, text: str) -> bool:
    """One message in the item's chat (thread kept), sent on the gateway's own loop."""
    loop = getattr(runner, "_gateway_loop", None)
    if adapter is None or loop is None or loop.is_closed():
        return False
    metadata = {"thread_id": item["thread_id"]} if item.get("thread_id") else None
    try:
        future = asyncio.run_coroutine_threadsafe(adapter.send(chat_id=item["chat_id"], content=text, metadata=metadata), loop)
        result = future.result(30)
    except Exception:  # noqa: BLE001
        logger.warning("wizard-os: messaging reply note failed", exc_info=True)
        return False
    return bool(getattr(result, "success", False))


def handle(ctx, item: dict, ledger: Ledger, *, live=_live) -> dict:
    """Work one outbox item; returns the report for the Service (``status`` + optional ``reason``/``at``)."""
    item_id = item["id"]
    seen = ledger.items.get(item_id)
    if seen:  # done before (the acknowledgement was lost): report it again, never act twice
        return {"status": seen["status"], **({"at": seen["at"]} if "at" in seen else {})}
    runner, adapter = live(item.get("platform") or "")
    if runner is None or adapter is None:
        return {"status": "failed", "reason": "no live connection for " + str(item.get("platform"))}
    if item.get("kind") == "note":
        if item["session_id"] not in ledger.noted and not _post(runner, adapter, item, CONTINUED_NOTE):
            return {"status": "failed", "reason": "note not sent"}
        ledger.noted.add(item["session_id"])
        ledger.mark(item_id, "noted")
        return {"status": "noted"}
    current = _current_session(runner, item.get("session_key") or "")
    if current is not None and current != item["session_id"]:
        ledger.mark(item_id, "older")
        return {"status": "older"}
    # Ledger first: a crash after this line reports "injected" again, never a second turn.
    at = time.time()
    ledger.mark(item_id, "injected", at=at)
    _post(runner, adapter, item, NOTE_PREFIX + item["text"])
    if not ctx.inject_message(item["text"], session_key=item["session_key"]):
        ledger.mark(item_id, "failed", at=at)
        return {"status": "failed", "reason": "Hermes refused the injection"}
    return {"status": "injected", "at": at}


class Worker:
    def __init__(self, ctx, gateway_url, secret):
        self.ctx, self.gateway_url, self.secret = ctx, gateway_url, secret
        self.ledger: Ledger | None = None
        self.stop = threading.Event()

    def _call(self, action: str, body: dict) -> dict | None:
        service = _service(self.gateway_url, self.secret)
        if service is None:
            return None
        origin, key = service
        request = Request(f"{origin}/wizard/internal/messaging-replies/{action}", data=json.dumps(body).encode("utf-8"),
                          method="POST", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with build_opener(ProxyHandler({}), _NoRedirect).open(request, timeout=15) as response:
                return json.loads(response.read(512 * 1024).decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, OSError, ValueError):
            return None

    def in_gateway(self) -> bool:
        manager = getattr(self.ctx, "_manager", None)
        return bool(getattr(manager, "has_gateway_message_injector", False))

    def once(self) -> float:
        """One pass; returns how long to wait before the next."""
        if not self.in_gateway():
            return IDLE_SECONDS
        reply = self._call("take", {"limit": 10})
        if not isinstance(reply, dict):
            return IDLE_SECONDS
        on = reply.get("on") is True
        set_injection_grant(self.ctx.plugin_id, on)
        items = [item for item in reply.get("items") or [] if isinstance(item, dict) and isinstance(item.get("id"), str)]
        if not on:
            return IDLE_SECONDS
        if self.ledger is None:
            self.ledger = Ledger(_home() / LEDGER_NAME)
        for item in items:
            try:
                report = handle(self.ctx, item, self.ledger)
            except Exception as error:  # noqa: BLE001 - one bad item never stops the others
                logger.warning("wizard-os: messaging reply %s failed", item.get("id"), exc_info=True)
                report = {"status": "failed", "reason": type(error).__name__}
            self._call("done", {"id": item["id"], **report})
        return POLL_SECONDS

    def run(self) -> None:
        while not self.stop.is_set():
            try:
                wait = self.once()
            except Exception:  # noqa: BLE001
                logger.debug("wizard-os: messaging replies pass failed", exc_info=True)
                wait = IDLE_SECONDS
            self.stop.wait(wait)


def start(ctx, gateway_url, secret) -> Worker | None:
    """Start the worker thread (every process loads plugins; it only works where the gateway runs)."""
    if os.environ.get("WIZARD_MESSAGING_REPLIES_WORKER") == "0" or not hasattr(ctx, "inject_message"):
        return None
    worker = Worker(ctx, gateway_url, secret)
    threading.Thread(target=worker.run, name="wizard-os-messaging-replies", daemon=True).start()
    return worker
