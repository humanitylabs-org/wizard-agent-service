#!/usr/bin/env python3
"""Deploy the Wizard Agent Service (live /wizard/ backend) from humanitylabs-org/wizard-agent-service.

Usage: wizard-agent-service-deploy [<git-ref>]   (default: live = what is serving now)
       wizard-agent-service-deploy --rollback
       wizard-agent-service-deploy <git-ref> --allow-rewind   (only with James's explicit approval)
       wizard-agent-service-deploy <git-ref> --no-drain       (skip the idle wait; James's explicit approval)

Restarts straight away while wizard-run-keeper.service is active (it holds in-flight replies across the
restart). Without the keeper it waits up to WIZARD_DRAIN_MAX_WAIT s (default 600) for a quiet moment, then
goes ahead; replies it cuts are resumed once by the Agent Service (~/.hermes/scripts/wizard_drain_restart.py).

Refuses any ref that does not contain the live release: parallel threads deploy from their own
branches, and a stale ref would silently roll back another thread's shipped work. Branch new work
from `live` (kept pointing at the serving sha in the source checkout).

Uses a remotely prepared/tested immutable release under
~/.local/share/wizard-mobile-server/releases/was-<sha>, switches `current`, restarts wizard-mobile.service
(its unit name is kept for compatibility) and verifies /wizard/health. On failure the prior
release is restored. Legacy Wizard Mobile UI releases no longer touch the backend.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
REPO_URL = "https://github.com/humanitylabs-org/wizard-agent-service.git"
SRC = Path(os.environ.get("WAS_SOURCE", HOME / "apps/wizard-agent-service"))
ROOT = Path(os.environ.get("WIZARD_SERVER_RELEASE_ROOT", HOME / ".local/share/wizard-mobile-server"))
SERVICE = os.environ.get("WAS_SERVICE", "wizard-mobile.service")
PORT = int(os.environ.get("WAS_PORT", "8923"))
NODE_DIR = HOME / ".local/bin"
ENV = {**os.environ, "PATH": f"{NODE_DIR}:{os.environ.get('PATH', '')}"}


def run(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(args, cwd=cwd, env=ENV, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"{' '.join(args)}: {(result.stderr or result.stdout)[-3000:]}")
    return result.stdout.strip()


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file() and not p.is_symlink()):
        digest.update(str(path.relative_to(root)).encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def switch(target: Path) -> None:
    current = ROOT / "current"
    tmp = ROOT / f".current.{os.getpid()}.tmp"
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    os.symlink(target, tmp, target_is_directory=True)
    os.replace(tmp, current)


NO_DRAIN = False


def healthy(timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    last = "not ready"
    while time.monotonic() < deadline:
        try:
            if run("systemctl", "--user", "is-active", SERVICE) == "active":
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/wizard/health", timeout=3) as r:
                    if r.status == 200:
                        return
                    last = f"health {r.status}"
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
        time.sleep(0.5)
    raise RuntimeError(f"{SERVICE} not healthy: {last}")


def receipts() -> Path:
    path = ROOT / "receipts"
    path.mkdir(parents=True, exist_ok=True)
    return path


def live_sha(prior: Path | None) -> str | None:
    marker = prior / "RELEASE_SHA" if prior else None
    return marker.read_text().strip() if marker and marker.is_file() else None


def guard_rewind(prior: Path | None, sha: str, allow_rewind: bool) -> None:
    """Refuse a deploy that does not contain the live release.

    Parallel threads deploy from their own branches. A ref cut before another thread's
    deploy (or plain origin/main while live runs ahead of it) silently removes that
    thread's shipped work. Rebase onto the live release (`git rebase live`) instead.
    """
    live = live_sha(prior)
    if not live or live == sha or allow_rewind:
        return
    if subprocess.run(["git", "merge-base", "--is-ancestor", live, sha], cwd=SRC, env=ENV).returncode == 0:
        return
    missing = subprocess.run(["git", "log", "--oneline", f"{sha}..{live}"], cwd=SRC, env=ENV,
                             text=True, capture_output=True).stdout.strip().splitlines()
    raise RuntimeError(
        f"refusing to deploy {sha[:12]}: it does not contain the live release {live[:12]}, so "
        f"{len(missing)} shipped commit(s) would be rolled back:\n  " + "\n  ".join(missing[:15])
        + "\nRebase onto the live release (branch `live` in the source checkout) and redeploy. "
        "Use --rollback to return to the prior release, or --allow-rewind only with James's explicit approval.")


def mark_live(sha: str) -> None:
    # Local branch `live` always names what is serving, so new work branches from it.
    subprocess.run(["git", "branch", "-f", "live", sha], cwd=SRC, env=ENV, capture_output=True)


def require_heavy_idle() -> None:
    path = HOME / ".hermes/state/wizard-mobile/heavy.sqlite3"
    if not path.exists():
        return
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        active = [job_id for job_id, data in db.execute("SELECT id,data FROM heavy_jobs")
                  if json.loads(data).get("state") in {"queued", "running", "cancelling", "cancellation_pending", "submitting"}]
    if active:
        raise RuntimeError(f"heavy queue not idle: {len(active)} active jobs; retry after completion")


def activate_bridge(target: Path, helper_release: Path) -> None:
    state = run("systemctl", "--user", "show", "wizard-heavy-rpc.service", "-p", "LoadState", "--value")
    if state == "not-found":
        return  # Installs without a host SSH bridge retain their existing behavior.
    helper = helper_release / "ops/activate-heavy-bridge.py"
    if not helper.is_file():
        raise RuntimeError("release missing bridge activation check")
    run(sys.executable, str(helper), str(target))
    run(sys.executable, str(helper), str(target), "--check-only")


def deploy(ref: str, allow_rewind: bool = False) -> dict:
    if not (SRC / ".git").is_dir():
        run("git", "clone", "-q", REPO_URL, str(SRC))
    run("git", "fetch", "-q", "origin", cwd=SRC)
    sha = run("git", "rev-parse", f"{ref}^{{commit}}", cwd=SRC)
    live_now = ROOT / "current"
    guard_rewind(Path(os.path.realpath(live_now)) if live_now.exists() else None, sha, allow_rewind)
    release = ROOT / "releases" / f"was-{sha}"
    if not release.is_dir():
        raise RuntimeError("immutable release missing: prepare and test it on the designated remote worker first; never run heavy tests on the control plane")
    if (release / "RELEASE_SHA").read_text().strip() != sha:
        raise RuntimeError("release identity mismatch")
    current = ROOT / "current"
    keeper = subprocess.run(["systemctl", "--user", "is-active", "wizard-run-keeper.service"],
                            capture_output=True, text=True).stdout.strip() == "active"
    if keeper and not NO_DRAIN:
        # 21 Oct 2026: since WAS ec74ef8 the run stream keeper (never restarted by deploys) holds every
        # in-flight reply across this restart, so waiting for idle only delayed deploys by up to 10 min.
        print("wizard-agent-service-deploy: run keeper active; replies survive the restart, no drain wait",
              file=sys.stderr, flush=True)
    elif not NO_DRAIN:
        # 19 Oct 2026: a raw restart here cut four live runs (blank "Worked for" threads). Prefer a quiet
        # moment; after the bounded wait go ahead, the Agent Service resumes any reply this cuts.
        sys.path.insert(0, str(Path.home() / ".hermes/scripts"))
        from wizard_drain_restart import wait_for_drain
        wait_for_drain(max_wait=float(os.environ.get("WIZARD_DRAIN_MAX_WAIT", "600")),
                       log=lambda line: print(f"wizard-agent-service-deploy: {line}", file=sys.stderr, flush=True))
    prior = Path(os.path.realpath(current)) if current.exists() else None
    guard_rewind(prior, sha, allow_rewind)  # re-check: another deploy may have landed during the build
    require_heavy_idle()
    if prior:
        run("app-parity-gate", str(prior), str(release))
    receipt = {
        "status": "activating", "source_repo": REPO_URL, "source_sha": sha,
        "server_tree": (release / "SERVER_TREE").read_text().strip(),
        "release": str(release), "prior_release": str(prior) if prior else None,
        "deployed_at": datetime.now(timezone.utc).isoformat(),
    }
    path = receipts() / f"was-{sha}-{int(time.time())}.json"
    path.write_text(json.dumps(receipt, indent=2) + "\n")
    switch(release)
    try:
        activate_bridge(release, release)
        run("systemctl", "--user", "restart", SERVICE)
        healthy()
    except Exception:
        if prior:
            switch(prior)
            activate_bridge(prior, release)
            run("systemctl", "--user", "restart", SERVICE)
            healthy()
        receipt["status"] = "rolled_back"
        path.write_text(json.dumps(receipt, indent=2) + "\n")
        raise
    receipt["status"] = "verified"
    path.write_text(json.dumps(receipt, indent=2) + "\n")
    (receipts() / "latest.json").write_text(json.dumps(receipt, indent=2) + "\n")
    mark_live(sha)
    return receipt


def rollback() -> dict:
    latest = json.loads((receipts() / "latest.json").read_text())
    prior = latest.get("prior_release")
    if not prior or not Path(prior).is_dir():
        raise RuntimeError("no prior release recorded")
    require_heavy_idle()
    helper_release = Path(os.path.realpath(ROOT / "current"))
    activate_bridge(Path(prior), helper_release)
    switch(Path(prior))
    run("systemctl", "--user", "restart", SERVICE)
    healthy()
    return {"status": "rolled_back", "restored": prior}


if __name__ == "__main__":
    try:
        NO_DRAIN = "--no-drain" in sys.argv[1:]  # only with James's explicit approval (emergency fix)
        args = [a for a in sys.argv[1:] if a not in {"--allow-rewind", "--no-drain"}]
        allow = "--allow-rewind" in sys.argv[1:]
        arg = args[0] if args else "live"
        # One deploy at a time (21 Oct 2026): agents now deploy without James's per-action
        # reply, so parallel threads must queue here; the live-ancestry check runs after the
        # lock, so a waiting deploy whose ref no longer contains the new live release is refused.
        import fcntl
        _lock = open(Path.home() / ".local/state/wizard-agent-service-deploy.lock", "w")
        try:
            fcntl.flock(_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("wizard-agent-service-deploy: another deploy is running; waiting for it", file=sys.stderr)
            fcntl.flock(_lock, fcntl.LOCK_EX)
        print(json.dumps(rollback() if arg == "--rollback" else deploy(arg, allow), indent=2))
    except Exception as exc:  # noqa: BLE001
        print(f"wizard-agent-service-deploy: {exc}", file=sys.stderr)
        raise SystemExit(1)
