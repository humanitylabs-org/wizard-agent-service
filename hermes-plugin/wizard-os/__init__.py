"""Wizard OS plugin for stock Hermes.

Registers one system-prompt section, ``wizard-os.kernel``: a FIXED Wizard OS orientation (under
900 characters, the same on every box, no per-app list). Apps are discovered through the
``wizard-job-<job>`` pointer skills in ``~/.wizard-os/skills`` (``skills.external_dirs``); this
plugin rewrites them from ``apps.json`` when the Agent Service has not. Mid-thread installs arrive
as a one-line per-run delta from the Agent Service. No Hermes core change, no SOUL/memory edit.
"""

from __future__ import annotations

import json
import logging
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

try:  # loaded as a package by Hermes
    from . import kernel as _kernel
    from . import media as _media
    from . import app_skill_guard as _app_skill_guard
except ImportError:  # loaded as a plain module (tests)
    import kernel as _kernel  # type: ignore[no-redef]
    import media as _media  # type: ignore[no-redef]
    import app_skill_guard as _app_skill_guard  # type: ignore[no-redef]

logger = logging.getLogger(__name__)
SECTION_ID = "wizard-os.kernel"
_SESSION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D401
        return None


try:  # Hermes resolves credentials per profile scope; os.environ is process-global under multiplexing.
    from agent.secret_scope import get_secret as _get_secret
except ImportError:  # outside Hermes (tests)
    def _get_secret(name: str, default=None):  # type: ignore[no-redef]
        return os.environ.get(name, default)


_DEFAULT_GATEWAY = "http://127.0.0.1:8796/wizard/mcp"


def _gateway_url() -> str:
    """This profile's own `wizard` MCP server URL: the transport Hermes already gives its gateway key to."""
    try:
        from hermes_cli.config import load_config_readonly

        server = ((load_config_readonly() or {}).get("mcp_servers") or {}).get("wizard") or {}
        url = server.get("url") if isinstance(server, dict) else None
        return url if isinstance(url, str) and url else _DEFAULT_GATEWAY
    except Exception:  # noqa: BLE001 - outside Hermes, or no config yet
        return _DEFAULT_GATEWAY


_FOLLOW_UP_SCHEMA = {
    "name": "wizard_follow_up",
    "description": (
        "Create, list, or explicitly stop a quiet one-shot follow-up for this Wizard chat thread. "
        "Use create when you owe the owner a future result: checks stay silent while pending and the "
        "first finished result, real blocker, or required decision returns in this same thread."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create", "list", "stop"]},
            "name": {"type": "string", "description": "Short label for the promised result."},
            "instructions": {"type": "string", "description": "What to check and what finished result is owed."},
            "every_minutes": {"type": "integer", "minimum": 1, "maximum": 1440, "default": 10},
            "watcher_id": {"type": "string", "description": "Optional exact watcher id to stop; omit to stop all for this thread."},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


def _follow_up_request(args: dict, *, session_id: str = "", **_kwargs):
    """Call this agent's own Wizard gateway. The session id comes from Hermes, never model arguments."""
    action = str(args.get("action") or "")
    if action not in {"create", "list", "stop"}:
        return {"success": False, "error": "action must be create, list, or stop"}
    if not _SESSION_ID.fullmatch(str(session_id or "")):
        return {"success": False, "error": "This run has no Wizard thread to attach the follow-up to."}
    arguments: dict = {"action": action, "session_id": session_id}
    if action == "create":
        name = " ".join(str(args.get("name") or "").split())
        instructions = str(args.get("instructions") or "").strip()
        every = args.get("every_minutes", 10)
        if not name or len(name) > 160 or not instructions or len(instructions) > 8000:
            return {"success": False, "error": "create requires a name (1–160) and instructions (1–8000)"}
        if isinstance(every, bool) or not isinstance(every, int) or not 1 <= every <= 1440:
            return {"success": False, "error": "every_minutes must be 1 to 1440"}
        arguments.update({"name": name, "instructions": instructions, "every_minutes": every})
    elif action == "stop" and args.get("watcher_id"):
        arguments["watcher_id"] = str(args["watcher_id"])

    try:
        token = _get_secret("WIZARD_MCP_TOKEN") or ""
    except Exception:  # noqa: BLE001 - an unscoped read under multiplexing fails closed
        token = ""
    if not token:
        return {"success": False, "error": "Wizard follow-ups are not configured for this agent."}
    url = _gateway_url()
    try:
        parsed = urlparse(url)
        # Only the gateway endpoint itself, never a URL with credentials, query or another path.
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password
                or parsed.path.rstrip("/") != "/wizard/mcp" or parsed.query or parsed.fragment):
            return {"success": False, "error": "Wizard follow-up gateway is not configured for this agent."}
        parsed.port  # validate a malformed explicit port before building an authenticated request
    except ValueError:
        return {"success": False, "error": "Wizard follow-up gateway is not configured for this agent."}
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "wizard_follow_up", "arguments": arguments}}
    request = Request(
        url, data=json.dumps(rpc).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        # Never inherit HTTP_PROXY/HTTPS_PROXY or follow a redirect with the gateway credential.
        with build_opener(ProxyHandler({}), _NoRedirect).open(request, timeout=15) as response:
            reply = json.loads(response.read(128 * 1024).decode("utf-8"))
        result = reply.get("result") if isinstance(reply, dict) else None
        if not isinstance(result, dict):
            return {"success": False, "error": "Wizard follow-up request failed."}
        content = result.get("content") or []
        text = content[0].get("text", "") if content and isinstance(content[0], dict) else ""
        if result.get("isError"):
            return {"success": False, "error": text or "Wizard follow-up request failed."}
        value = json.loads(text) if text else {}
        return {"success": True, **(value if isinstance(value, dict) else {})}
    except HTTPError as error:
        return {"success": False, "error": f"Wizard follow-up request failed ({error.code})"}
    except (URLError, TimeoutError, OSError, ValueError):
        return {"success": False, "error": "Wizard follow-up service is unavailable."}


def _section(_session_info) -> str:
    try:
        _kernel.refresh_pointer_skills()
    except Exception:  # noqa: BLE001 - pointer skills are best effort
        logger.debug("wizard-os: pointer skill refresh failed", exc_info=True)
    registry = _kernel.read_registry()
    if registry is None:
        return ""  # no Wizard OS on this box (yet): add nothing
    return _kernel.kernel_for_session()


def register(ctx) -> None:
    ctx.register_system_prompt_section(SECTION_ID, _section, position="after_memory", max_chars=2000)
    ctx.register_tool(name="wizard_follow_up", toolset="wizard_os", schema=_FOLLOW_UP_SCHEMA,
                      handler=_follow_up_request, emoji="👁")
    # Every MEDIA: file the agent sends lands where Wizard chats can show it (media.py).
    if hasattr(ctx, "register_hook"):
        ctx.register_hook("transform_llm_output", _media.transform_llm_output)
        _app_skill_guard.register(ctx)
