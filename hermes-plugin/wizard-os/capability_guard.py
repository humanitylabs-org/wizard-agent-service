"""Look up before installing: the WizardOS install guard (issue 463, on for everyone).

A stock Hermes agent that finds no tool for a job builds its own: asked to transcribe audio, one pip-installed
faster-whisper and a speech model next to the box's own Wizard Voice Service. This ``pre_tool_call`` hook catches
package installs (pip, uv, pipx, poetry, conda, npm, yarn, pnpm, bun, apt, brew, cargo, gem), model downloads
(Hugging Face CLI or URLs, ``git clone`` of a model repo, ``ollama pull``) and code that loads a known duplicate,
and matches each name against the box's capability registry, which it reads from this agent's own ``wizard``
gateway (``wizard_capabilities`` with ``format: json``). Only a match is refused, with the tool to use instead (or,
for a capability this agent is not granted, the exact ask for the owner). Everything else runs: this is a nudge
against known duplicates, not a ban on installing things. A gateway without that tool (an older Agent Service)
means nothing is ever refused. The owner can turn the guard off per agent (Agent Service ``/wizard/v1/capabilities``).

The same file ships in the wizard-os plugin (main agent) and in wizard-supervisor-tools (every managed agent);
tests/capability-guard.test.ts keeps the two copies byte-identical. No Hermes core change.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

TOOL = "wizard_capabilities"
CACHE_S = 60.0
FAIL_CACHE_S = 30.0
TIMEOUT_S = 4.0
_cache: dict = {"at": -1e9, "value": None}

# Words that stand for "install" after a program name, per program (None = the program itself fetches its arg).
_INSTALLERS = {
    "pip": {"install"}, "pip3": {"install"}, "pipx": {"install", "run"}, "poetry": {"add"}, "conda": {"install"},
    "mamba": {"install"}, "micromamba": {"install"}, "npm": {"install", "i", "add"}, "yarn": {"add", "dlx"},
    "pnpm": {"add", "install", "i", "dlx"}, "bun": {"add", "install", "i", "x"}, "apt": {"install"},
    "apt-get": {"install"}, "brew": {"install"}, "cargo": {"install"}, "gem": {"install"}, "go": {"install"},
    "ollama": {"pull", "run"}, "huggingface-cli": {"download"}, "hf": {"download"}, "npx": None, "uvx": None,
}
# Options that take a value, so the value is not read as a package name.
_VALUE_OPTS = {"-r", "--requirement", "-c", "--constraint", "-i", "--index-url", "--extra-index-url", "-t", "--target",
               "--prefix", "-f", "--find-links", "--root", "--python", "-p", "--local-dir", "--cache-dir", "--revision",
               "--repo-type", "--token", "-n", "--name", "--channel", "--version", "--with", "--registry"}
_SKIP_PREFIX = {"sudo", "env", "command", "nice", "nohup", "time", "exec", "doas"}
_SEGMENT = re.compile(r"\|\||&&|[;\n|]|\$\(|`")
_MODEL_HOSTS = ("huggingface.co", "hf.co")
_CODE_INSTALL = re.compile(r"(?:pip3?|uv\s+pip|uv\s+add|pipx|npm|apt-get|apt|brew)\s+(?:install|i|add)\s+([^'\"\n;&|)\]]+)")
_CODE_MODEL = re.compile(r"(?:snapshot_download|hf_hub_download|from_pretrained|WhisperModel|load_model|pipeline)\s*\(\s*"
                         r"(?:[A-Za-z_]+\s*=\s*)?['\"]([^'\"]{2,160})['\"]")
_CODE_IMPORT = re.compile(r"(?:^|[\s;'\"(])(?:import|from)\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)")
_URL = re.compile(r"https?://[^\s'\"<>]+")
# argv lists: ["pip", "install", "vosk"], [sys.executable, "-m", "pip", "install", "vosk"]
_CODE_ARGV = re.compile(r"""['"](?:pip3?|uv)['"]\s*,\s*(?:['"]pip['"]\s*,\s*)?['"](?:install|add)['"]\s*,\s*([^\])]+)""")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D401
        return None


def _secret(name: str) -> str:
    try:
        from agent.secret_scope import get_secret
        return get_secret(name) or ""
    except Exception:  # noqa: BLE001 - outside Hermes, or an unscoped read: environment only
        return os.environ.get(name, "") or ""


def _gateway_url() -> str:
    """This agent's own `wizard` MCP server URL from its Hermes config ('' = none)."""
    cfg = None
    try:
        from hermes_cli.config import load_config_readonly
        cfg = load_config_readonly() or {}
    except Exception:  # noqa: BLE001 - outside Hermes, or an older Hermes
        try:
            import yaml
            home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
            cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
        except Exception:  # noqa: BLE001 - no config: no gateway
            return ""
    server = ((cfg or {}).get("mcp_servers") or {}).get("wizard") or {}
    url = server.get("url") if isinstance(server, dict) else None
    return url if isinstance(url, str) else ""


def _fetch() -> dict | None:
    """The registry for this agent, or None (no such tool, no gateway, unreachable: the guard then allows)."""
    url, token = _gateway_url(), _secret("WIZARD_MCP_TOKEN")
    if not url or not token:
        return None
    try:
        p = urlparse(url)
        if (p.scheme not in {"http", "https"} or not p.hostname or p.username or p.password
                or p.path.rstrip("/") != "/wizard/mcp" or p.query or p.fragment):
            return None
        p.port  # a malformed explicit port fails before the credential is sent
    except ValueError:
        return None
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": TOOL, "arguments": {"format": "json"}}}
    req = Request(url, data=json.dumps(rpc).encode("utf-8"), method="POST",
                  headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with build_opener(ProxyHandler({}), _NoRedirect).open(req, timeout=TIMEOUT_S) as res:
            reply = json.loads(res.read(512 * 1024).decode("utf-8"))
        result = reply.get("result") if isinstance(reply, dict) else None
        if not isinstance(result, dict) or result.get("isError"):
            return None
        content = result.get("content") or []
        value = json.loads(content[0].get("text", "")) if content and isinstance(content[0], dict) else None
        return value if isinstance(value, dict) and isinstance(value.get("capabilities"), list) else None
    except Exception:  # noqa: BLE001 - never block a tool call on the lookup itself
        return None


def registry(fresh: bool = False) -> dict | None:
    now = time.monotonic()
    age = now - _cache["at"]
    if not fresh and age < (CACHE_S if _cache["value"] is not None else FAIL_CACHE_S):
        return _cache["value"]
    value = _fetch()
    _cache.update(at=now, value=value)
    return value


def index_jobs() -> list[str] | None:
    """Job names for the kernel's index line, in registry order; None while the gateway has no registry or is unreachable."""
    value = registry()
    if value is None:
        return None
    out: list[str] = []
    for record in value["capabilities"]:
        job = record.get("job") if isinstance(record, dict) else None
        if isinstance(job, str) and job and job not in out:
            out.append(job)
    return out


def _words(text: str) -> list[str]:
    try:
        return shlex.split(text, posix=True)
    except ValueError:
        return text.split()


def _name(raw: str) -> str:
    """`faster-whisper==1.2.1` -> faster-whisper; `@scope/pkg@2` -> @scope/pkg; URLs -> their repo path."""
    raw = raw.strip().strip("'\"")
    if _URL.match(raw) or raw.startswith("git+"):
        path = urlparse(raw.removeprefix("git+")).path.strip("/")
        path = re.sub(r"\.git$", "", path)
        parts = [p for p in path.split("/") if p and p not in {"resolve", "blob", "tree", "main"}]
        return "/".join(parts[:2]).lower()
    if raw.startswith("@"):
        scope, _, rest = raw[1:].partition("/")
        return "@" + scope.lower() + "/" + re.split(r"[@<>=!~;\[\s]", rest, maxsplit=1)[0].lower()
    return re.split(r"[<>=!~;@\[\s]", raw, maxsplit=1)[0].lower()


def _segment_names(segment: str) -> list[str]:
    words = _words(segment)
    while words and (words[0] in _SKIP_PREFIX or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]) or words[0].startswith("-")):
        words = words[1:]
    if not words:
        return []
    cmd = os.path.basename(words[0])
    rest = words[1:]
    if re.fullmatch(r"python(?:\d(?:\.\d+)?)?", cmd) and rest[:2] == ["-m", "pip"]:
        cmd, rest = "pip", rest[2:]
    elif re.fullmatch(r"pip\d(?:\.\d+)?", cmd):
        cmd = "pip"
    elif cmd == "uv" and rest[:1] == ["pip"]:
        cmd, rest = "pip", rest[1:]
    elif cmd == "uv" and rest[:1] in (["add"], ["tool"]):
        cmd, rest = "pip", ["install", *rest[1:]] if rest[:1] == ["add"] else rest[1:]
    if cmd in {"git"} and rest[:1] == ["clone"]:
        return [_name(w) for w in rest[1:] if _URL.match(w) or w.startswith("git@")][:1]
    if cmd in {"wget", "curl", "aria2c"}:
        return [_name(w) for w in rest if _URL.match(w) and any(h in w for h in _MODEL_HOSTS)]
    if cmd not in _INSTALLERS:
        return []
    verbs = _INSTALLERS[cmd]
    if verbs is not None:
        at = next((i for i, w in enumerate(rest) if w in verbs), None)
        if at is None:
            return []
        rest = rest[at + 1:]
    names, skip = [], False
    for w in rest:
        if skip:
            skip = False
            continue
        if w.startswith("-"):
            skip = w in _VALUE_OPTS
            continue
        if w.startswith((".", "/", "~")) or w.endswith((".txt", ".toml", ".cfg", ".whl", ".tar.gz")):
            continue
        names.append(_name(w))
        if verbs is None:
            break  # npx/uvx run one package; the rest are its own arguments
    return [n for n in names if n]


def _code_names(code: str) -> list[str]:
    names = [_name(w) for m in _CODE_INSTALL.finditer(code) for w in m.group(1).split()]
    names += [_name(m.group(1)) for m in _CODE_MODEL.finditer(code)]
    names += [_name(w) for m in _CODE_ARGV.finditer(code) for w in re.findall(r"""['"]([^'"]+)['"]""", m.group(1))]
    names += [n.strip().split(".")[0].lower() for m in _CODE_IMPORT.finditer(code) for n in m.group(1).split(",")]
    names += [_name(u) for u in _URL.findall(code) if any(h in u for h in _MODEL_HOSTS)]
    return [n for n in names if n and not n.startswith("-")]


def names_in(tool_name: str, args: dict) -> list[str]:
    """Packages, models and modules a tool call would install, download or load (lower case, de-duplicated)."""
    found: list[str] = []
    if tool_name == "terminal":
        command = str(args.get("command") or "")
        for segment in _SEGMENT.split(command):
            found += _segment_names(segment)
        found += _code_names(command) if re.search(r"\bpython\d*(?:\.\d+)?\s+-c\b|<<", command) else []
    elif tool_name == "execute_code":
        found += _code_names(str(args.get("code") or ""))
    return list(dict.fromkeys(found))


def _parts(name: str) -> set[str]:
    return {p for p in re.split(r"[-_./:@]+", name) if p}


def match(name: str, records: list) -> dict | None:
    """The capability `name` would duplicate: an equivalent (whole name or one part) or a word spelled as a name."""
    parts = _parts(name)
    last = name.rsplit("/", 1)[-1]
    for record in records:
        if not isinstance(record, dict):
            continue
        equivalents = {str(e).lower() for e in record.get("equivalents") or []}
        if name in equivalents or last in equivalents or parts & equivalents:
            return record
        # Owner words only as whole names, and only phrases ("speech-to-text") or the job itself: a one-word ask
        # such as "watch" or "schedule" is also an ordinary library name.
        spelled = {re.sub(r"\s+", "-", str(w).lower()) for w in [*(record.get("words") or []), record.get("job") or ""]
                   if re.search(r"[\s-]", str(w)) or w == record.get("job")}
        if name in spelled or last in spelled:
            return record
    return None


def _gateway_tool(record: dict) -> str:
    tool = str(record.get("tool") or "")
    return f"mcp__wizard__{tool}" if tool else "wizard_capabilities"


def verdict(name: str, record: dict) -> str:
    job = str(record.get("job") or "this")
    provider = (record.get("provider") or {}).get("name") or "the box"
    status = record.get("status")
    if status == "not-granted":
        return f"WizardOS: not run. {record.get('ask') or f'{provider} does {job} on this box but is not granted to you; ask the owner.'}"
    if status == "unavailable":
        why = record.get("reason") or "it is not answering right now"
        return (f"WizardOS: not run. This box already does {job} with {provider}, but {why}. Tell the owner "
                f"(`wam doctor`) instead of installing {name}; do not build a replacement.")
    return (f"WizardOS: not run. This box already does {job} with {provider}: use `{_gateway_tool(record)}` "
            f"(details: `mcp__wizard__{TOOL}` with job \"{job}\"). Installing {name} would make a second copy outside "
            "the box's privacy and update controls. If the owner wants their own copy anyway, they can turn this "
            "check off for you.")


def pre_tool_call(tool_name: str = "", args=None, **_kwargs):
    if tool_name not in {"terminal", "execute_code"} or not isinstance(args, dict):
        return None
    names = names_in(tool_name, args)
    if not names:
        return None
    value = registry()
    if value is None or value.get("guard") is False:
        return None
    if not any(match(name, value["capabilities"]) for name in names):
        return None
    # About to refuse: decide on a fresh read, so an owner who just turned the guard off for this
    # agent is honoured on the very next try, never up to a cache lifetime later.
    value = registry(fresh=True)
    if value is None or value.get("guard") is False:
        return None
    for name in names:
        record = match(name, value["capabilities"])
        if record is not None:
            return {"action": "block", "message": verdict(name, record)}
    return None


def register(ctx) -> None:
    if hasattr(ctx, "register_hook"):
        ctx.register_hook("pre_tool_call", pre_tool_call)
