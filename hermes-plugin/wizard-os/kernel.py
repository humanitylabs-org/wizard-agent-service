"""Wizard OS kernel + pointer skills (Python twin of server/agent-bridge.mjs).

The kernel is fixed text (no app list); discovery is the wizard-job-* pointer skills, which this
module can also write from ~/.wizard-os/apps.json when the Agent Service is down. Keep this file and agent-bridge.mjs in lockstep: tests/agent-bridge.test.ts renders both
from the same fixtures and requires byte-identical output.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

MCP_SERVER_NAME = "wizard"
META_TOOL = "wizard_apps"
KERNEL_LIMIT = 900
JOB_SKILL_PREFIX = "wizard-job-"
JOB_MAP_LINES = 12
DEFAULT_FILES_ROOT = "~/runtipi/media"
JOB_STAMP = ".wizard-jobs"
SKIP_PROVIDES = {"shell", "agent-service", "agent"}
_CTRL = re.compile(r"[\u0000-\u001f\u007f]")
_WS = re.compile(r"\s+")
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_JOB = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


def _clean(value, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return _WS.sub(" ", _CTRL.sub(" ", value)).strip()[:limit]


def os_home() -> Path:
    return Path(os.environ.get("WIZARD_OS_HOME") or Path.home() / ".wizard-os").expanduser()


def tool_prefix(app_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", str(app_id or ""))


def job_words(job: str) -> str:
    text = _clean(re.sub(r"[-_]+", " ", str(job or "")), 60)
    return re.sub(r"^short form ", "short-form ", text)


def read_registry(path: Path | None = None) -> dict | None:
    path = path or os_home() / "apps.json"
    try:
        if path.stat().st_size > 2 * 1024 * 1024:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def bridge_apps(registry: dict | None, mcp_address: str = "url") -> list[dict]:
    out, seen = [], set()
    for app in (registry or {}).get("apps") or []:
        if not isinstance(app, dict):
            continue
        app_id = _clean(app.get("id"), 64)
        if not app_id or not _ID.match(app_id) or app_id in seen:
            continue
        provides = [_clean(v, 40) for v in app.get("provides") or [] if _clean(v, 40)]
        if any(p in SKIP_PROVIDES for p in provides):
            continue
        mcp = app.get("mcp")
        if not isinstance(mcp, dict):
            mcp = {}
        url = (mcp.get("internal") or mcp.get("url")) if mcp_address == "internal" else (mcp.get("url") or mcp.get("internal"))
        url = _clean(url, 300)
        if not url or not re.match(r"^https?://", url):
            continue
        seen.add(app_id)
        skill = app.get("skill")
        out.append({
            "id": app_id, "prefix": tool_prefix(app_id), "name": _clean(app.get("name"), 60) or app_id,
            "summary": _clean(app.get("summary"), 200), "status": _clean(app.get("status"), 24) or "unknown",
            "jobs": [p for p in provides if p not in SKIP_PROVIDES],
            "skill": skill if isinstance(skill, str) and skill and ".." not in skill else "",
        })
    return sorted(out, key=lambda a: a["id"])


def agent_tool_name(prefix: str, tool: str, harness: str = "hermes") -> str:
    base = f"{prefix}__{tool}"
    return f"mcp__{MCP_SERVER_NAME}__{base}" if harness == "hermes" else base


def job_skill_name(job: str) -> str:
    return f"{JOB_SKILL_PREFIX}{job}"


def _jobs_of(apps: list[dict]) -> list[tuple[str, list[dict]]]:
    by_job: dict[str, list[dict]] = {}
    for app in apps:
        for job in app["jobs"]:
            if _JOB.match(job):
                by_job.setdefault(job, []).append(app)
    return sorted(by_job.items())


def render_kernel(apps: list[dict] | None = None, harness: str = "hermes",
                  files_root: str = DEFAULT_FILES_ROOT, job_map: bool = False) -> str:
    """Twin of agent-bridge.mjs renderKernel: FIXED text, no per-app list unless job_map."""
    apps = apps or []
    hermes = harness == "hermes"
    meta = f"mcp__{MCP_SERVER_NAME}__{META_TOOL}" if hermes else META_TOOL
    name = f"mcp__{MCP_SERVER_NAME}__<app>__<tool>" if hermes else "<app>__<tool>"
    text = [
        "Wizard OS: you are the owner's agent on this box. Installed Wizard apps do jobs for the owner.",
        f"The owner's files are in the Files root, {files_root}. App tools take paths relative to it.",
        "When a request matches a wizard-job-<job> skill in your skills list:" if hermes else "When a request matches a job below:",
        "1. Load that skill with skill_view, then the app skill it names." if hermes else "1. Use the app named for that job.",
        f"2. Call the app's tool on the `{MCP_SERVER_NAME}` MCP server, named `{name}`."
        + (" If it is not in your tool list, run it with tool_call and that exact name." if hermes else ""),
        "3. Never search the disk, read apps.json, run wam or write a client to find or reach an app.",
        f'"What apps do I have?": call `{meta}`. If an app tool fails, tell the owner it is not reachable (`wam doctor`).',
        "Save only short pointer skills for app jobs, never a copy of an app's workflow.",
    ]
    if job_map or not hermes:
        rows = [f"- {job_words(job)} -> " + ", ".join(f"{a['name']} (`{agent_tool_name(a['prefix'], '*', harness)}`)" for a in owners)
                for job, owners in _jobs_of(apps)[:JOB_MAP_LINES]]
        text += ["", "Jobs on this box:", *(rows or ["- (no apps installed yet)"])]
    return "\n".join(text)


def kernel_for_session(home: Path | None = None) -> str:
    home = home or os_home()
    job_map = os.environ.get("WIZARD_KERNEL_JOB_MAP") == "1"
    apps = bridge_apps(read_registry(home / "apps.json"), os.environ.get("WIZARD_APPS_MCP_ADDRESS", "url")) if job_map else []
    return render_kernel(apps, "hermes", os.environ.get("WIZARD_FILES_ROOT") or DEFAULT_FILES_ROOT, job_map)


def pointer_skills(apps: list[dict], harness: str = "hermes", tools: dict | None = None) -> dict:
    """Twin of agent-bridge.mjs pointerSkills: one routing-only skill per job."""
    tools = tools or {}
    out = {}
    for job, owners in _jobs_of(apps):
        words = job_words(job)
        names = " or ".join(a["name"] for a in owners)
        lines = []
        for a in owners:
            known = [f"`{agent_tool_name(a['prefix'], t, harness)}`" for t in (tools.get(a["id"]) or [])[:8]]
            calls = ", ".join(known) if known else f"`{agent_tool_name(a['prefix'], '*', harness)}`"
            down = "" if a["status"] == "running" else f" It is {a['status']} right now: tell the owner (`wam doctor`)."
            lead = f" Load its skill `{a['id']}` with skill_view, then call" if a["skill"] else " Call"
            lines.append(f"- {a['name']}.{lead} {calls}.{down}")
        tail = " If one is not in your tool list, run it with tool_call and that exact name." if harness == "hermes" else ""
        out[job_skill_name(job)] = "\n".join([
            "---",
            f"name: {job_skill_name(job)}",
            f"description: Use when the owner asks for {words}. The installed {names} app does it; call its tools, never search files.",
            "---",
            "",
            f"# {words}",
            "",
            *lines,
            "",
            f"Tools are on the `{MCP_SERVER_NAME}` MCP server.{tail} Paths are relative to the owner's Files root.",
            "",
            "Written by Wizard OS from apps.json and rebuilt when apps change. Do not edit.",
            "",
        ])
    return out


def refresh_pointer_skills(home: Path | None = None) -> list[str] | None:
    """Write the wizard-job-* pointers when the Agent Service has not (stamp missing or older than
    apps.json, e.g. the service is down or the App Manager just rewrote the skills folder)."""
    import shutil

    home = home or os_home()
    apps_json, root = home / "apps.json", home / "skills"
    stamp = root / JOB_STAMP
    try:
        if stamp.is_file() and stamp.stat().st_mtime >= apps_json.stat().st_mtime:
            return None
        apps = bridge_apps(read_registry(apps_json), os.environ.get("WIZARD_APPS_MCP_ADDRESS", "url"))
        root.mkdir(parents=True, exist_ok=True)
        skills = pointer_skills(apps)
        for entry in root.iterdir():
            if (entry.name.startswith(JOB_SKILL_PREFIX) and entry.name not in skills) or entry.name == "_jobs":
                shutil.rmtree(entry, ignore_errors=True)
        for name, text in skills.items():
            target = root / name / "SKILL.md"
            if target.is_file() and target.read_text(encoding="utf-8") == text:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".md.tmp")
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(target)
        stamp.write_text(f"{int(time.time() * 1000)}\n", encoding="utf-8")
        return sorted(skills)
    except OSError:
        return None
