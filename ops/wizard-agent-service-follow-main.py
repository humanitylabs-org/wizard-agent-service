#!/usr/bin/env python3
"""Follow main on a hand-deployed Agent Service line (issue 514; owner switch wizard/follow-main, off by default).

One pass, run by ops/wizard-agent-service-follow-main.timer every few minutes:

1. Off unless the switch is on: WIZARD_FOLLOW_MAIN=1 forces it on, =0 forces it off; unset asks the running
   Service (GET /wizard/health -> follow_main.on, which follows the owner's Look-file switch). Off = no change.
2. Read origin/main. When the live release (current/RELEASE_SHA) is main, write state `current` and stop.
3. Wait for GitHub's required checks on that exact commit (test, gitleaks, validate). CI is the remote worker
   that already ran the full suite on this sha, so nothing heavy runs on the box.
4. Prepare the immutable release ~/.local/share/wizard-mobile-server/releases/was-<sha>: git archive of the
   commit + `npm ci --omit=dev` (pure-JS dependencies), RELEASE_SHA and SERVER_TREE, renamed into place.
5. Run the box's deploy helper with that sha (the installed ~/.local/bin/wizard-agent-service-deploy, else the
   release's own copy). It refuses rewinds, skips the drain while the run keeper is up, and rolls back on failure.
6. Write follow-main.json beside the releases (state, live, main, behind_by, behind_since, reason). The Service
   reads it for /wizard/health and tells the owner inside Wizard once the box has been behind for 30 min.

A failed prepare or deploy of the same commit is retried after WIZARD_FOLLOW_MAIN_RETRY_S (default 1800) s.

Every status names its `cause` (issue 638), so the Service tells the owner only what is his to act on:
red-main (a required check failed on main: CI's "Red main" workflow reruns it once and files a bug for the
builder), checks-pending, github (GitHub unreachable), prepare and deploy (`failures` counts tries in a row).
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "wizard.follow-main/1"
REPO = os.environ.get("WIZARD_FOLLOW_MAIN_REPO", "humanitylabs-org/wizard-agent-service")
REPO_URL = f"https://github.com/{REPO}.git"
REQUIRED_CHECKS = ("test", "gitleaks", "validate")
CHECKS_WAIT_S = 3600


def env_path(name: str, default: Path) -> Path:
    return Path(os.environ.get(name) or default)


def settings() -> dict:
    home = Path.home()
    root = env_path("WIZARD_SERVER_RELEASE_ROOT", home / ".local/share/wizard-mobile-server")
    return {
        "home": home,
        "src": env_path("WAS_SOURCE", home / "apps/wizard-agent-service"),
        "root": root,
        "status": env_path("WIZARD_FOLLOW_MAIN_STATUS", root / "follow-main.json"),
        "port": int(os.environ.get("WAS_PORT", "8923")),
        "api": os.environ.get("WIZARD_FOLLOW_MAIN_API", "https://api.github.com").rstrip("/"),
        "retry_s": float(os.environ.get("WIZARD_FOLLOW_MAIN_RETRY_S", "1800")),
        "deploy": os.environ.get("WAS_DEPLOY", ""),
        "npm": os.environ.get("WIZARD_FOLLOW_MAIN_NPM", "npm"),
        "env": {**os.environ, "PATH": f"{home / '.local/bin'}:{os.environ.get('PATH', '')}"},
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run(cfg: dict, *args: str, cwd: Path | None = None, timeout: float = 900) -> str:
    result = subprocess.run(args, cwd=cwd, env=cfg["env"], text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(last_line(result.stderr or result.stdout) or f"{args[0]} exited {result.returncode}")
    return result.stdout.strip()


def last_line(text: str) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return lines[-1][-300:] if lines else ""


def switch_on(cfg: dict) -> bool:
    forced = os.environ.get("WIZARD_FOLLOW_MAIN")
    if forced in {"1", "0"}:
        return forced == "1"
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{cfg['port']}/wizard/health", timeout=5) as r:
            return json.loads(r.read() or b"{}").get("follow_main", {}).get("on") is True
    except Exception:  # noqa: BLE001 - an unreachable or older Service reads as off
        return False


def read_status(cfg: dict) -> dict:
    try:
        data = json.loads(cfg["status"].read_text())
        return data if isinstance(data, dict) and data.get("schema") == SCHEMA else {}
    except (OSError, ValueError):
        return {}


def write_status(cfg: dict, status: dict) -> dict:
    status = {"schema": SCHEMA, **status, "checked_at": now_iso()}
    cfg["status"].parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg["status"].with_name(f".{cfg['status'].name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(status, indent=2) + "\n")
    os.replace(tmp, cfg["status"])
    return status


def live_sha(cfg: dict) -> str | None:
    marker = cfg["root"] / "current" / "RELEASE_SHA"
    try:
        return marker.read_text().strip() or None
    except OSError:
        return None


def main_sha(cfg: dict) -> str:
    src = cfg["src"]
    if not (src / ".git").exists():
        src.parent.mkdir(parents=True, exist_ok=True)
        run(cfg, "git", "clone", "-q", REPO_URL, str(src))
    run(cfg, "git", "fetch", "-q", "origin", "main", cwd=src)
    return run(cfg, "git", "rev-parse", "origin/main^{commit}", cwd=src)


def behind_by(cfg: dict, live: str | None, main: str) -> int | None:
    if not live:
        return None
    try:
        return int(run(cfg, "git", "rev-list", "--count", f"{live}..{main}", cwd=cfg["src"]))
    except Exception:  # noqa: BLE001 - live may be a commit this checkout lacks
        return None


def checks(cfg: dict, sha: str) -> tuple[str, str]:
    """('green' | 'waiting' | 'failed', detail) for the required GitHub checks on this exact commit."""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "wizard-follow-main"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{cfg['api']}/repos/{REPO}/commits/{sha}/check-runs?per_page=100", headers=headers)
    with urllib.request.urlopen(request, timeout=20) as r:
        runs = json.loads(r.read()).get("check_runs", [])
    newest: dict[str, dict] = {}
    for item in runs:
        name = item.get("name")
        # The newest run by id: a re-run that is still queued has no started_at yet and must count as pending.
        if name in REQUIRED_CHECKS and (name not in newest or int(item.get("id") or 0) > int(newest[name].get("id") or 0)):
            newest[name] = item
    failed = [n for n in REQUIRED_CHECKS if n in newest and newest[n].get("status") == "completed"
              and newest[n].get("conclusion") not in {"success", "skipped", "neutral"}]
    if failed:
        return "failed", ", ".join(failed)
    pending = [n for n in REQUIRED_CHECKS if n not in newest or newest[n].get("status") != "completed"]
    return ("waiting", ", ".join(pending)) if pending else ("green", "")


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file() and not p.is_symlink()):
        digest.update(str(path.relative_to(root)).encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def prepare(cfg: dict, sha: str) -> Path:
    """The immutable release for `sha`, built beside the others and renamed into place only when complete."""
    releases = cfg["root"] / "releases"
    release = releases / f"was-{sha}"
    if release.is_dir():
        return release
    releases.mkdir(parents=True, exist_ok=True)
    tmp = releases / f".was-{sha}.{os.getpid()}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    try:
        archive = tmp / ".source.tar"
        run(cfg, "git", "archive", "--format=tar", "-o", str(archive), sha, cwd=cfg["src"])
        with tarfile.open(archive) as tar:
            tar.extractall(tmp, filter="data")
        archive.unlink()
        run(cfg, *shlex.split(cfg["npm"]), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", cwd=tmp, timeout=900)
        (tmp / "RELEASE_SHA").write_text(sha + "\n")
        (tmp / "SERVER_TREE").write_text(tree_digest(tmp / "server") + "\n")
        os.replace(tmp, release)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return release


def deploy_command(cfg: dict, release: Path) -> list[str]:
    if cfg["deploy"]:
        return shlex.split(cfg["deploy"])
    installed = cfg["home"] / ".local/bin/wizard-agent-service-deploy"
    if installed.is_file() and os.access(installed, os.X_OK):
        return [str(installed)]
    return [sys.executable, str(release / "ops/wizard-agent-service-deploy.py")]


def deploy(cfg: dict, sha: str, release: Path) -> None:
    command = deploy_command(cfg, release) + [sha]
    (cfg["home"] / ".local/state").mkdir(parents=True, exist_ok=True)  # the helper's lock lives there; a fresh home lacks it
    result = subprocess.run(command, env={**cfg["env"], "WAS_SOURCE": str(cfg["src"]),
                                          "WIZARD_SERVER_RELEASE_ROOT": str(cfg["root"])},
                            text=True, capture_output=True, timeout=3600)
    if result.returncode:
        raise RuntimeError(last_line(result.stderr) or last_line(result.stdout) or f"deploy exited {result.returncode}")


def plain(text: str) -> str:
    return text.removeprefix("wizard-agent-service-deploy: ").strip()[:300]


def follow_once(cfg: dict | None = None) -> dict:
    cfg = cfg or settings()
    if not switch_on(cfg):
        return {"state": "off"}
    prior = read_status(cfg)
    live = live_sha(cfg)
    try:
        main = main_sha(cfg)
    except Exception as exc:  # noqa: BLE001
        return write_status(cfg, {**{k: prior.get(k) for k in ("main", "behind_by", "behind_since") if prior.get(k)},
                                  "state": "behind" if prior.get("behind_since") else "unknown", "live": live,
                                  "cause": "github", "reason": f"couldn't read main from GitHub: {plain(str(exc))}"})
    if live == main:
        return write_status(cfg, {"state": "current", "live": live, "main": main})
    since = prior.get("behind_since") if prior.get("state") != "current" and prior.get("behind_since") else now_iso()
    base = {"live": live, "main": main, "behind_by": behind_by(cfg, live, main), "behind_since": since}
    failures = int(prior.get("failures") or 0) if prior.get("cause") in {"prepare", "deploy"} else 0
    if prior.get("failed_sha") == main and time.time() - float(prior.get("failed_at_s") or 0) < cfg["retry_s"]:
        return write_status(cfg, {**base, "state": "behind", "reason": prior.get("reason") or "the last try failed",
                                  "cause": prior.get("cause") or "deploy", "failures": max(failures, 1),
                                  "failed_sha": main, "failed_at_s": prior.get("failed_at_s")})
    failed = {"failed_sha": main, "failures": failures + 1}
    try:
        verdict, detail = checks(cfg, main)
    except Exception as exc:  # noqa: BLE001
        return write_status(cfg, {**base, "state": "behind", "cause": "github",
                                  "reason": f"couldn't read main's checks from GitHub: {plain(str(exc))}"})
    if verdict == "failed":
        return write_status(cfg, {**base, "state": "behind", "cause": "red-main",
                                  "reason": f"the newest change on main failed its checks ({detail}), so it is not installed"})
    if verdict == "waiting":
        waited = time.time() - datetime.fromisoformat(since).timestamp()
        state = "behind" if waited > CHECKS_WAIT_S else "waiting"
        return write_status(cfg, {**base, "state": state, "cause": "checks-pending", "reason": f"waiting for main's checks ({detail})"})
    write_status(cfg, {**base, "state": "preparing", "reason": "preparing the release"})
    try:
        release = prepare(cfg, main)
    except Exception as exc:  # noqa: BLE001
        return write_status(cfg, {**base, "state": "behind", "reason": f"couldn't prepare the release: {plain(str(exc))}",
                                  "cause": "prepare", **failed, "failed_at_s": time.time()})
    write_status(cfg, {**base, "state": "deploying", "reason": "installing the release"})
    try:
        deploy(cfg, main, release)
    except Exception as exc:  # noqa: BLE001
        return write_status(cfg, {**base, "live": live_sha(cfg), "state": "behind",
                                  "reason": f"the deploy stopped: {plain(str(exc))}", "cause": "deploy", **failed, "failed_at_s": time.time()})
    now_live = live_sha(cfg)
    if now_live != main:
        return write_status(cfg, {**base, "live": now_live, "state": "behind", "reason": "the deploy finished but the box is not on main",
                                  "cause": "deploy", **failed, "failed_at_s": time.time()})
    return write_status(cfg, {"state": "current", "live": now_live, "main": main, "deployed_at": now_iso()})


if __name__ == "__main__":
    cfg = settings()
    cfg["root"].mkdir(parents=True, exist_ok=True)
    lock = open(cfg["root"] / ".follow-main.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"state": "busy", "reason": "another follow-main pass is running"}))
        raise SystemExit(0)
    print(json.dumps(follow_once(cfg)))
