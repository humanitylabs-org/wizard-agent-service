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

Builds an immutable release under ~/.local/share/wizard-mobile-server/releases/was-<sha>,
runs the service test suite, switches the `current` symlink, restarts wizard-mobile.service
(its unit name is kept for compatibility) and verifies /wizard/health. On failure the prior
release is restored. Legacy Wizard Mobile UI releases no longer touch the backend.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
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


def run_suite(work: Path) -> None:
    """npm test, with one bounded retry for load-induced vitest timeouts.

    On a busy box (load 20+) a few unrelated vitest cases exceed their 5 s timeout, and a different set
    each run (25 Oct 2026: three deploys refused this way, each failing other files). A real regression
    fails again deterministically, so: rerun only the failed vitest files once, serially, with a long
    timeout, then run the rest of the chain that vitest's failure short-circuited. Anything else fails."""
    import re  # noqa: PLC0415
    first = subprocess.run(["npm", "test", "--silent"], cwd=work, env=ENV, text=True, capture_output=True)
    if not first.returncode:
        return
    out = (first.stdout or "") + (first.stderr or "")
    failed = sorted(set(re.findall(r"FAIL\s+(tests/\S+\.test\.ts)", out)))
    scripts = json.loads((work / "package.json").read_text()).get("scripts", {})
    unit = scripts.get("test:unit", "")
    if not failed or not unit.startswith("vitest run && "):
        raise RuntimeError(f"npm test: {out[-3000:]}")
    print(f"npm test failed in {len(failed)} vitest file(s); retrying them serially once: {' '.join(failed)}",
          file=sys.stderr)
    run(str(work / "node_modules" / ".bin" / "vitest"), "run", *failed, "--testTimeout=60000",
        "--hookTimeout=60000", "--maxWorkers=1", cwd=work)
    run("bash", "-c", unit.split("vitest run && ", 1)[1], cwd=work)
    if "test:agent-parity" in scripts:
        run("npm", "run", "--silent", "test:agent-parity", cwd=work)


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
        stage = ROOT / "releases" / f".was-{sha}.{os.getpid()}.tmp"
        shutil.rmtree(stage, ignore_errors=True)
        work = ROOT / "releases" / f".was-{sha}.{os.getpid()}.work"
        shutil.rmtree(work, ignore_errors=True)
        try:
            run("git", "worktree", "add", "-q", "--detach", str(work), sha, cwd=SRC)
            run("npm", "ci", "--silent", "--no-audit", "--no-fund", cwd=work)
            run_suite(work)
            stage.mkdir(mode=0o700)
            shutil.copytree(work / "server", stage / "server")
            # Service-owned agent assets (Supervisor/Reporter plugin + skills) are read by server/ at import.
            for extra in ("hermes-plugin", "skills", "ops"):
                if (work / extra).is_dir():
                    shutil.copytree(work / extra, stage / extra, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for name in ("package.json", "package-lock.json"):
                shutil.copy2(work / name, stage / name)
            run("npm", "ci", "--omit=dev", "--silent", "--no-audit", "--no-fund", cwd=stage)
            run(str(NODE_DIR / "node"), "--input-type=module", "-e", "await import('./server/service.mjs')", cwd=stage)
            (stage / "RELEASE_SHA").write_text(sha + "\n")
            (stage / "SOURCE_REPO").write_text(REPO_URL + "\n")
            (stage / "SERVER_TREE").write_text(tree_digest(stage / "server") + "\n")
            os.replace(stage, release)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
            subprocess.run(["git", "worktree", "remove", "--force", str(work)], cwd=SRC, capture_output=True)
            shutil.rmtree(work, ignore_errors=True)
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
