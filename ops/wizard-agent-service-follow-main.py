#!/usr/bin/env python3
"""Follow main on a hand-deployed Agent Service line (issue 514; on wherever its timer is installed).

One pass, run by ops/wizard-agent-service-follow-main.timer every few minutes:

1. Read origin/main. When the live release (current/RELEASE_SHA) is main, write state `current` and stop.
2. Wait for GitHub's required checks on that exact commit (test, gitleaks, validate). CI is the remote worker
   that already ran the full suite on this sha, so nothing heavy runs on the box.
3. Prepare the immutable release ~/.local/share/wizard-mobile-server/releases/was-<sha>: git archive of the
   commit + `npm ci --omit=dev` (pure-JS dependencies), RELEASE_SHA and SERVER_TREE, renamed into place.
4. Run the box's deploy helper with that sha (the installed ~/.local/bin/wizard-agent-service-deploy, else the
   release's own copy). It refuses rewinds, skips the drain while the run keeper is up, and rolls back on failure.
5. Write follow-main.json beside the releases (state, live, main, behind_by, behind_since, reason). The Service
   reads it for /wizard/health and tells the owner inside Wizard once the box has been behind for 30 min.

A failed prepare or deploy of the same commit is retried after WIZARD_FOLLOW_MAIN_RETRY_S (default 1800) s.

Every status names its `cause` (issue 638), so the Service tells the owner only what is his to act on:
red-main (a required check failed on main: CI's "Red main" workflow reruns it once and files a bug for the
builder), checks-pending, github (GitHub unreachable), prepare and deploy (`failures` counts tries in a row).

A deploy that only waits for the heavy queue to go idle (issue 644) is `waiting` / `heavy-busy`: no failure, retried
on the next pass, told to nobody. Only a wait longer than any active job may run (max(4 h, its own timeout) + 1 h)
turns `behind` / `heavy-stuck`, which names the job holding the queue.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sqlite3
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
# The deploy helper refuses while any heavy job is in one of these states (require_heavy_idle in the deploy helper).
HEAVY_ACTIVE = {"queued", "running", "cancelling", "cancellation_pending", "submitting"}
HEAVY_REFUSAL = "heavy queue not idle"
HEAVY_LIMIT_S = 4 * 3600  # heavy jobs are expected to finish within 4 h
HEAVY_GRACE_S = 3600


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
        "api": os.environ.get("WIZARD_FOLLOW_MAIN_API", "https://api.github.com").rstrip("/"),
        "retry_s": float(os.environ.get("WIZARD_FOLLOW_MAIN_RETRY_S", "1800")),
        "deploy": os.environ.get("WAS_DEPLOY", ""),
        "npm": os.environ.get("WIZARD_FOLLOW_MAIN_NPM", "npm"),
        "heavy_db": env_path("WIZARD_FOLLOW_MAIN_HEAVY_DB", home / ".hermes/state/wizard-mobile/heavy.sqlite3"),
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


def heavy_active(cfg: dict) -> list[dict]:
    """The heavy jobs that make the deploy helper refuse, oldest first (empty when there is no queue)."""
    path = cfg["heavy_db"]
    if not path.exists():
        return []
    try:
        db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
        try:
            rows = db.execute("SELECT id,data FROM heavy_jobs ORDER BY rowid").fetchall()
        finally:
            db.close()
    except sqlite3.Error:
        return []  # unreadable: the deploy helper decides, and its refusal is still read as a heavy wait
    jobs = []
    for job_id, data in rows:
        try:
            job = json.loads(data)
        except ValueError:
            continue
        if isinstance(job, dict) and job.get("state") in HEAVY_ACTIVE:
            jobs.append({**job, "job_id": job.get("job_id") or job_id})
    return sorted(jobs, key=lambda j: j.get("created_at") if isinstance(j.get("created_at"), (int, float)) else 0)


def heavy_label(job: dict) -> str:
    """`heavy_<id> (<command>)`: the job id plus the start of its command, enough for the owner's agent to find it."""
    argv = (job.get("spec") or {}).get("argv") if isinstance(job.get("spec"), dict) else None
    command = " ".join(str(a) for a in argv[:4]) if isinstance(argv, list) and argv else ""
    command = command.replace("\n", " ")[:80]
    return f"{job.get('job_id')}" + (f" ({command})" if command else "")


def heavy_wait(cfg: dict, prior: dict, base: dict, jobs: list[dict]) -> dict:
    """Status while the deploy waits for the heavy queue: `waiting`, or `behind` / heavy-stuck once overdue."""
    since = prior.get("heavy_since") if prior.get("cause") in {"heavy-busy", "heavy-stuck"} and prior.get("heavy_since") else now_iso()
    waited = time.time() - datetime.fromisoformat(since).timestamp()
    limits = [int((j.get("spec") or {}).get("timeout_seconds") or 0) for j in jobs if isinstance(j.get("spec"), dict)]
    limit = max([HEAVY_LIMIT_S, *[x for x in limits if x > 0]]) + HEAVY_GRACE_S
    count = len(jobs)
    who = heavy_label(jobs[0]) if jobs else ""
    if waited > limit and who:
        hours = int(waited // 3600)
        return write_status(cfg, {**base, "state": "behind", "cause": "heavy-stuck", "heavy_since": since, "heavy_job": who,
                                  "reason": f"heavy job {who} has held the heavy queue for {hours} h, longer than any heavy job may run, so the update can't install"})
    what = f"{count} heavy job{'s' if count != 1 else ''} to finish" if count else "a heavy job to finish"
    status = {**base, "state": "waiting", "cause": "heavy-busy", "heavy_since": since,
              "reason": f"waiting for {what}" + (f" ({who})" if who else "") + "; installs when the heavy queue is idle"}
    if who:
        status["heavy_job"] = who
    return write_status(cfg, status)


def plain(text: str) -> str:
    return text.removeprefix("wizard-agent-service-deploy: ").strip()[:300]


def follow_once(cfg: dict | None = None) -> dict:
    cfg = cfg or settings()
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
    if prior.get("failed_sha") == main and time.time() - float(prior.get("failed_at_s") or 0) < cfg["retry_s"]:
        return write_status(cfg, {**base, "state": "behind", "reason": prior.get("reason") or "the last try failed",
                                  "cause": prior.get("cause") or "deploy", "failures": max(int(prior.get("failures") or 0), 1),
                                  "failed_sha": main, "failed_at_s": prior.get("failed_at_s")})

    def failed(cause: str) -> dict:
        """Tries of this stage failed in a row: a prepare failure followed by a first deploy failure is 1, not 2."""
        count = int(prior.get("failures") or 0) if prior.get("cause") == cause else 0
        return {"cause": cause, "failed_sha": main, "failures": count + 1, "failed_at_s": time.time()}
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
                                  **failed("prepare")})
    jobs = heavy_active(cfg)
    if jobs:
        return heavy_wait(cfg, prior, base, jobs)
    write_status(cfg, {**base, "state": "deploying", "reason": "installing the release"})
    try:
        deploy(cfg, main, release)
    except Exception as exc:  # noqa: BLE001
        if HEAVY_REFUSAL in str(exc):  # a heavy job started between our look and the helper's: still only a wait
            return heavy_wait(cfg, prior, base, heavy_active(cfg))
        return write_status(cfg, {**base, "live": live_sha(cfg), "state": "behind",
                                  "reason": f"the deploy stopped: {plain(str(exc))}", **failed("deploy")})
    now_live = live_sha(cfg)
    if now_live != main:
        return write_status(cfg, {**base, "live": now_live, "state": "behind", "reason": "the deploy finished but the box is not on main",
                                  **failed("deploy")})
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
