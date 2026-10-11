"""Wizard OS kernel renderer (Python twin of server/agent-bridge.mjs renderKernel).

Reads ~/.wizard-os/apps.json directly, so the agent knows the box even when the Agent Service is
down. Keep this file and agent-bridge.mjs in lockstep: tests/agent-bridge.test.ts renders both
from the same fixtures and requires byte-identical output.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

MCP_SERVER_NAME = "wizard"
META_TOOL = "wizard_apps"
KERNEL_LIMIT = 2500
SKIP_PROVIDES = {"shell", "agent-service", "agent"}
_CTRL = re.compile(r"[\u0000-\u001f\u007f]")
_WS = re.compile(r"\s+")
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


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


def render_kernel(apps: list[dict], harness: str = "hermes", tools: dict | None = None) -> str:
    tools = tools or {}
    meta = f"mcp__{MCP_SERVER_NAME}__{META_TOOL}" if harness == "hermes" else META_TOOL

    pattern = f"`mcp__{MCP_SERVER_NAME}__<app>__<tool>`" if harness == "hermes" else "`<app>__<tool>`"
    head = [
        "You are the owner's agent on a Wizard OS box. Installed apps do jobs for the owner.",
        f"Each app's tools are MCP tools on the `{MCP_SERVER_NAME}` server, named {pattern}.",
        *(["If such a tool is not in your tool list, invoke it with `tool_call` and that exact name; you do not need tool_search for it."] if harness == "hermes" else []),
    ]
    rules = [
        "Rules:",
        "1. When a request matches a job in the list above, your first step is that app's tool. Do not search files, read apps.json, run wam or write an MCP client to find out what an app does.",
        f'2. "What apps do I have?" or "what can you do here?": call `{meta}`.',
        "3. For a long job, load the app's skill first with skill_view when one is named.",
        "4. If an app tool fails, tell the owner the app is not reachable and suggest `wam doctor`. Do not work around it.",
        "5. If you save a skill for one of these jobs, make it a short pointer to the app, never a copy of its workflow.",
    ]

    def lines(full: bool) -> list[str]:
        out = []
        for app in apps:
            jobs = ", ".join(job_words(j) for j in (app["jobs"] or ["other"]))
            names = [f"`{agent_tool_name(app['prefix'], t, harness)}`" for t in (tools.get(app["id"]) or [])[: 4 if full else 0]]
            where = ", ".join(names) if names else f"`{agent_tool_name(app['prefix'], '*', harness)}`"
            down = "" if app["status"] == "running" else f" ({app['status']})"
            skill = f"; skill `{app['id']}`" if full and app["skill"] else ""
            out.append(f"- {jobs} -> {app['name']}{down}: {where}{skill}")
        return out

    def compose(body: list[str]) -> str:
        return "\n".join([*head, "", "Apps by job:", *(body or ["- (no apps installed yet)"]), "", *rules])

    full = compose(lines(True))
    return full if len(full) <= KERNEL_LIMIT else compose(lines(False))[:KERNEL_LIMIT]


def tools_from_cache(home: Path | None = None) -> dict:
    """Tool names the Agent Service last saw (agent-context.json); {} when it never ran."""
    try:
        data = json.loads(((home or os_home()) / "agent-context.json").read_text(encoding="utf-8"))
        return {a["id"]: [t.split("__", 1)[1] for t in a.get("tools") or [] if "__" in t] for a in data.get("apps") or []}
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return {}


def gateway_url() -> str:
    """The `wizard` MCP server URL from the Hermes config (stock loader), or ''."""
    try:
        from hermes_cli.config import load_config_readonly

        entry = (load_config_readonly().get("mcp_servers") or {}).get(MCP_SERVER_NAME) or {}
        return str(entry.get("url") or "")
    except Exception:  # noqa: BLE001
        return ""


def refresh_tool_cache(home: Path | None = None, timeout: float = 1.0) -> bool:
    """Ask the Agent Service for the current tool names (GET /wizard/v1/agent-context) and cache
    them in <home>/agent-context.json. Best effort: the kernel falls back to `<app>__*`."""
    import urllib.request

    home = home or os_home()
    url = gateway_url()
    if not url or "/wizard/mcp" not in url:
        return False
    try:
        token = ""
        entry_headers = {}
        from hermes_cli.config import load_config_readonly

        entry = (load_config_readonly().get("mcp_servers") or {}).get(MCP_SERVER_NAME) or {}
        entry_headers = {k: os.path.expandvars(str(v)) for k, v in (entry.get("headers") or {}).items()}
        token = entry_headers.get("Authorization", "")
        req = urllib.request.Request(url.replace("/wizard/mcp", "/wizard/v1/agent-context?format=json"),
                                     headers={"Authorization": token} if token else {})
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - box-local URL from config
            data = json.loads(resp.read(512 * 1024))
        if not isinstance(data, dict) or not isinstance(data.get("apps"), list):
            return False
        tmp = home / f".agent-context.json.tmp-{os.getpid()}"
        tmp.write_text(json.dumps({"apps": data["apps"]}), encoding="utf-8")
        tmp.replace(home / "agent-context.json")
        return True
    except Exception:  # noqa: BLE001
        return False


def kernel_for_session(home: Path | None = None) -> str:
    home = home or os_home()
    refresh_tool_cache(home)
    apps = bridge_apps(read_registry(home / "apps.json"), os.environ.get("WIZARD_APPS_MCP_ADDRESS", "url"))
    return render_kernel(apps, "hermes", tools_from_cache(home))


def pointer_skills(apps: list[dict], harness: str = "hermes") -> dict:
    """One tiny skill per job (twin of agent-bridge.mjs pointerSkills)."""
    by_job: dict[str, list[dict]] = {}
    for app in apps:
        for job in app["jobs"]:
            if re.match(r"^[a-z0-9][a-z0-9-]{0,39}$", job):
                by_job.setdefault(job, []).append(app)
    out = {}
    for job in sorted(by_job):
        owners = by_job[job]
        words = job_words(job)
        names = " or ".join(a["name"] for a in owners)
        body = [
            "---",
            f"name: wizard-job-{job}",
            f"description: Use when the owner asks for {words}. Use the installed {names} app's tools; never search files for it.",
            "---",
            "",
            f"# {words}",
            "",
            *[f"- {a['name']}: call `{agent_tool_name(a['prefix'], '*', harness)}`"
              + (f". Its full skill is `{a['id']}` (skill_view)." if a["skill"] else ".") for a in owners],
            "",
            "Pointer written by the Wizard Agent Service from apps.json. It is rebuilt when apps change; edit nothing here.",
            "",
        ]
        out[job] = "\n".join(body)
    return out


def refresh_pointer_skills(home: Path | None = None) -> list[str] | None:
    """Rewrite <home>/skills/_jobs when it is missing or older than apps.json (the Agent Service
    normally does this; the plugin covers boxes where it is down or cannot write)."""
    import shutil

    home = home or os_home()
    apps_json, target = home / "apps.json", home / "skills" / "_jobs"
    try:
        if target.is_dir() and target.stat().st_mtime >= apps_json.stat().st_mtime:
            return None
        apps = bridge_apps(read_registry(apps_json), os.environ.get("WIZARD_APPS_MCP_ADDRESS", "url"))
        tmp = home / "skills" / f"._jobs.tmp-{os.getpid()}"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        skills = pointer_skills(apps)
        for job, text in skills.items():
            (tmp / job).mkdir()
            (tmp / job / "SKILL.md").write_text(text, encoding="utf-8")
        shutil.rmtree(target, ignore_errors=True)
        tmp.rename(target)
        return sorted(skills)
    except OSError:
        return None
