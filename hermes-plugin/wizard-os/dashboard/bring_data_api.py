"""Importer API: the Importer app (and its Setup step) drive ``bring_data.py`` through the agent's dashboard.

Mounted by plugin_api.py under /api/plugins/wizard-os/bring-data/ (stock dashboard login required). The
engine is the same module the ``wizard_bring_data`` agent tool uses; nothing here parses an export.

GET  sources   agent folders on this box (Claude Code, other Hermes homes) + exports in Files Inbox/Downloads,
               and ``into``: other Wizard OS agents an import can go into (then this agent is a source too)
GET  imports?dest=<agent>   earlier imports (for per-import Undo)
POST scan      {path} or {paths: [...]}, dest?, scan_id?    -> counts, draft facts, skills, personality, fact store
GET  progress?scan_id=<id>   where that scan is: step, done/total, idle seconds, seconds_left
POST cancel    {scan_id}     stop that scan at its next step (it answers "Scan cancelled.")
POST import    {import_id, chats, skills, personality, facts, about: {facts, text}, dest?}
POST undo      {import_id, dest?}

``dest`` is an agent id from ``sources.into`` (never a path); omitted means this agent.
PUT  upload?name=<file>.zip   raw body -> Files/Inbox/<file>.zip (streamed, size-capped)

Every write needs ``X-Wizard-Import: 1`` (a cross-site form cannot send it) and is refused cross-site.
``WIZARD_BRING_DATA_READ_ONLY=1`` turns every write off (scan still answers) for previews of a live agent.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

_spec = spec_from_file_location("wizard_os_bring_data_engine", Path(__file__).resolve().parent.parent / "bring_data.py")
assert _spec is not None and _spec.loader is not None
engine = module_from_spec(_spec)
_spec.loader.exec_module(engine)

router = APIRouter(prefix="/bring-data")
_LOCK = threading.Lock()  # one import, undo or upload at a time
MAX_UPLOAD = int(os.environ.get("WIZARD_BRING_DATA_MAX_UPLOAD", str(8 * 1024 * 1024 * 1024)))
MAX_BODY = 256 * 1024
_NAME = re.compile(r"^[^/\\\x00-\x1f]{1,120}\.(zip|json)$", re.IGNORECASE)
_DEST = re.compile(r"^(here|[a-z][a-z0-9-]{0,30})$")


def _dest(value) -> dict:
    if value in (None, ""):
        return {}
    if not isinstance(value, str) or not _DEST.fullmatch(value):
        raise HTTPException(400, "Unknown agent")
    return {"dest": value}


def _guard(request: Request, json_body: bool = True) -> None:
    if request.headers.get("X-Wizard-Import") != "1":
        raise HTTPException(403, "Importer header required")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Cross-site action rejected")
    if json_body and request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
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


def _run(action: str, args: dict, lock: bool = False):
    def call():
        if lock:
            with _LOCK:
                return json.loads(engine.handle_app(action, args))
        return json.loads(engine.handle_app(action, args))

    return call


async def _answer(response: Response, action: str, args: dict, lock: bool = False):
    response.headers["Cache-Control"] = "no-store"
    result = await run_in_threadpool(_run(action, args, lock))
    if not result.get("success"):
        raise HTTPException(409, result.get("error") or "That didn't work")
    return result


def _paths_ok(args: dict) -> None:
    paths = args["paths"] if isinstance(args.get("paths"), list) else [args.get("path")]
    if not all(isinstance(p, str) and p and engine.allowed_path(p) for p in paths):
        raise HTTPException(403, "The Importer reads only from Files or the agent folders it lists.")


@router.get("/sources")
async def sources(response: Response):
    return await _answer(response, "sources", {})


@router.get("/imports")
async def imports(response: Response, dest: str = ""):
    return await _answer(response, "status", _dest(dest))


@router.post("/scan")
async def scan(request: Request, response: Response):
    _guard(request)
    args = await _body(request)
    dest = _dest(args.get("dest"))
    args = {k: args[k] for k in ("path", "paths", "scan_id") if k in args}
    _paths_ok(args)
    return await _answer(response, "scan", {**args, **dest})


@router.get("/progress")
async def progress(response: Response, scan_id: str = ""):
    return await _answer(response, "progress", {"scan_id": scan_id})


@router.post("/cancel")
async def cancel(request: Request, response: Response):
    _guard(request)
    body = await _body(request)
    return await _answer(response, "cancel_scan", {"scan_id": str(body.get("scan_id") or "")})


@router.post("/import")
async def run_import(request: Request, response: Response):
    _guard(request)
    body = await _body(request)
    args = {k: body[k] for k in ("import_id", "chats", "skills", "personality", "facts", "about") if k in body}
    return await _answer(response, "import", {**args, **_dest(body.get("dest"))}, lock=True)


@router.post("/undo")
async def undo(request: Request, response: Response):
    _guard(request)
    body = await _body(request)
    return await _answer(response, "undo", {"import_id": str(body.get("import_id") or ""), **_dest(body.get("dest"))},
                         lock=True)


@router.put("/upload")
async def upload(request: Request, response: Response, name: str = ""):
    """Stream one export into Files/Inbox. Never overwrites: a second file of the same name gets (2), (3)…"""
    _guard(request, json_body=False)
    response.headers["Cache-Control"] = "no-store"
    if engine.read_only():
        raise HTTPException(409, "This Importer is in preview mode: nothing is saved.")
    name = name.strip()
    if not _NAME.fullmatch(name) or name.startswith(".") or ".." in name:
        raise HTTPException(400, "Upload the export .zip (or Claude's .json link list) as it was downloaded.")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD:
        raise HTTPException(413, "That file is too large to import here.")
    inbox = engine.files_root() / "Inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".importer-upload-", dir=str(inbox))
    total = 0
    try:
        with os.fdopen(fd, "wb") as out:
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_UPLOAD:
                    raise HTTPException(413, "That file is too large to import here.")
                out.write(chunk)
        if not total:
            raise HTTPException(400, "The upload was empty.")
        with _LOCK:
            stem, suffix = os.path.splitext(name)
            target, n = inbox / name, 1
            while target.exists():
                n += 1
                target = inbox / f"{stem} ({n}){suffix}"
            os.replace(tmp, target)
        return {"success": True, "path": f"Inbox/{target.name}", "size": total}
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
