"""Private first (wizard-agent-service issue 545, wizard-os spec/AGENTS.md section 10).

Mounted by plugin_api.py under /api/plugins/wizard-os/private-first (stock dashboard login required). The Claude,
ChatGPT and Tinfoil provider images ask here instead of reading the owner's Look file
(wizard-app-store images/PRIVATE_FIRST.md). Each call goes to the Agent Service's loopback route
/wizard/internal/private-first/<action> with the wizard-schedule plugin's origin and token, or, where a box has none
(every standard install, issue 575), with this Hermes's own `wizard` MCP origin and gateway key. The Service owns the
switch and every decision; this file only relays, and applies a suggested model inside this Hermes when the
Service says the standard agent has none.

GET  ''                  -> {schema: "wizard.private-first/1", on, standard_agent, private_agent}; any failure: on false
POST /standard-agent     {provider, model}          -> {ok: true, agent: "hermes"}
POST /private-agent      {provider, model, models}  -> {ok: true, agent: <private agent id>}

Writes are refused cross-site and need application/json.
"""
from __future__ import annotations

import json
import logging
import os
import re

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/private-first")
SCHEMA = "wizard.private-first/1"
MAX_BODY = 16 * 1024
_LOCAL = re.compile(r"http://(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?")
# The `wizard` MCP URL: http://wizard-agent-service:8787/wizard/mcp (fresh box) or http://127.0.0.1:<port>/wizard/mcp
_GATEWAY = re.compile(r"(https?://[A-Za-z0-9.\-]+(?::\d{1,5})?|http://\[::1\](?::\d{1,5})?)/wizard/mcp/?")
_log = logging.getLogger(__name__)


def _secret(name: str) -> str:
    try:
        from agent.secret_scope import get_secret

        return str(get_secret(name) or os.environ.get(name, "") or "")
    except Exception:  # noqa: BLE001 - outside Hermes
        return os.environ.get(name, "")


def _gateway() -> tuple[str, str]:
    """This Hermes's own `wizard` MCP entry: (Service origin, gateway key), or ('', '').

    Every linked main Hermes has it (WAM agent_link on a fresh box, `wizard link` alongside), while no standard
    install sets the heavy-lane secrets (issue 575). The key only goes to the origin Hermes already sends it to.
    """
    try:
        from hermes_cli.config import load_config_readonly

        server = ((load_config_readonly() or {}).get("mcp_servers") or {}).get("wizard") or {}
        url = server.get("url") if isinstance(server, dict) else None
    except Exception:  # noqa: BLE001 - outside Hermes, or no config yet
        url = None
    match = _GATEWAY.fullmatch(url) if isinstance(url, str) else None
    token = _secret("WIZARD_MCP_TOKEN").strip()
    return (match.group(1), token) if match and token else ("", "")


def _service() -> tuple[str, str]:
    """(origin, token) for the Service's loopback route: the heavy-lane pair where a box has one, else the gateway."""
    origin, token = _secret("WIZARD_HEAVY_ORIGIN").rstrip("/"), _secret("WIZARD_HEAVY_TOKEN")
    if _LOCAL.fullmatch(origin) and token:
        return origin, token
    return _gateway()


def service_call(action: str, value: dict, timeout: float = 20) -> tuple[int, dict]:
    """POST the Agent Service's private-first route; (status, answer). Unreachable -> (0, {})."""
    from urllib.error import HTTPError
    from urllib.request import ProxyHandler, Request as UrlRequest, build_opener

    origin, token = _service()
    if not origin or not token:
        return 0, {}
    request = UrlRequest(origin + "/wizard/internal/private-first/" + action, method="POST",
                         data=json.dumps(value).encode(),
                         headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=timeout) as response:
            return response.status, json.loads(response.read(64 * 1024) or b"{}")
    except HTTPError as error:
        try:
            return error.code, json.loads(error.read(64 * 1024) or b"{}")
        except ValueError:
            return error.code, {}
    except (OSError, ValueError):
        return 0, {}


async def apply_main_model(provider: str, model: str) -> bool:
    """The suggested model as this Hermes's main model, through stock /api/model/set (main scope)."""
    from hermes_cli.web_models import ModelAssignment
    from hermes_cli.web_routers.models import set_model_assignment

    body = ModelAssignment(scope="main", provider=provider, model=model, confirm_expensive_model=True)
    result = await set_model_assignment(body)
    return bool(isinstance(result, dict) and result.get("ok", True) is not False)


def _guard(request: Request) -> None:
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Cross-site action rejected")
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise HTTPException(415, "Use application/json")


async def _body(request: Request) -> dict:
    raw = b""
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_BODY:
            raise HTTPException(413, "Request too large")
    try:
        value = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(400, "Invalid JSON") from None
    if not isinstance(value, dict):
        raise HTTPException(400, "Expected an object")
    return value


def _answer(status: int, answer: dict) -> JSONResponse:
    if status == 200 and answer.get("ok") is True and isinstance(answer.get("agent"), str):
        return JSONResponse({"ok": True, "agent": answer["agent"]}, headers={"Cache-Control": "no-store"})
    code = status if 400 <= status < 600 else 503
    return JSONResponse({"ok": False, "error": str(answer.get("error") or "unavailable")[:80]}, status_code=code,
                        headers={"Cache-Control": "no-store"})


@router.get("")
async def state(response: Response):
    response.headers["Cache-Control"] = "no-store"
    status, answer = await run_in_threadpool(service_call, "state", {}, 5)
    if status != 200 or answer.get("schema") != SCHEMA:
        return {"schema": SCHEMA, "on": False}
    return {"schema": SCHEMA, "on": answer.get("on") is True, "standard_agent": answer.get("standard_agent") or "hermes",
            "private_agent": answer.get("private_agent") if isinstance(answer.get("private_agent"), str) else None}


@router.post("/standard-agent")
async def standard_agent(request: Request):
    _guard(request)
    value = await _body(request)
    provider = value.get("provider") if isinstance(value.get("provider"), str) else ""
    model = value.get("model") if isinstance(value.get("model"), str) else ""
    status, answer = await run_in_threadpool(service_call, "standard-agent", {"provider": provider, "model": model})
    if status == 200 and answer.get("ok") is True and answer.get("apply_model") is True and model:
        try:
            await apply_main_model(provider, model)
        except Exception:  # noqa: BLE001 - the agent is on and attached; the owner can still pick a model
            _log.warning("private-first: suggested model not applied", exc_info=True)
    return _answer(status, answer)


@router.post("/private-agent")
async def private_agent(request: Request):
    _guard(request)
    value = await _body(request)
    models = value.get("models") if isinstance(value.get("models"), list) else []
    body = {"provider": value.get("provider") if isinstance(value.get("provider"), str) else "",
            "model": value.get("model") if isinstance(value.get("model"), str) else "",
            "models": [m for m in models[:32] if isinstance(m, str)]}
    # Creating the agent starts its container: allow the Service the time a first start takes.
    status, answer = await run_in_threadpool(service_call, "private-agent", body, 240)
    return _answer(status, answer)
