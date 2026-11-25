"""Follow main (issue 514): ops/wizard-agent-service-follow-main.py prepares the newest green main and deploys it.

Uses a local git origin, a fake GitHub checks API, a stand-in npm and a stand-in deploy helper; no network."""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("follow_main", ROOT / "ops/wizard-agent-service-follow-main.py")
fm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fm)


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, text=True, capture_output=True,
                          env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
                               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}).stdout.strip()


class Checks(BaseHTTPRequestHandler):
    runs: dict = {}

    def do_GET(self):  # noqa: N802
        sha = self.path.split("/commits/")[1].split("/")[0]
        body = json.dumps({"check_runs": self.runs.get(sha, [])}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


IDS = iter(range(1000, 100000))


def green(*names):
    return [{"id": next(IDS), "name": n, "status": "completed", "conclusion": "success", "started_at": "2026-11-24T00:00:00Z"}
            for n in names or fm.REQUIRED_CHECKS]


class FollowMainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.origin = self.tmp / "origin.git"
        work = self.tmp / "work"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.origin))
        git(self.tmp, "clone", "-q", str(self.origin), str(work))
        (work / "server").mkdir()
        (work / "server/index.mjs").write_text("// v1\n")
        (work / "package.json").write_text("{}\n")
        git(work, "add", ".")
        git(work, "commit", "-q", "-m", "v1")
        git(work, "push", "-q", "origin", "HEAD:main")
        self.work = work
        self.v1 = git(work, "rev-parse", "HEAD")
        self.src = self.tmp / "src"
        git(self.tmp, "clone", "-q", str(self.origin), str(self.src))
        self.root = self.tmp / "root"
        live = self.root / "releases" / f"was-{self.v1}"
        live.mkdir(parents=True)
        (live / "RELEASE_SHA").write_text(self.v1 + "\n")
        os.symlink(live, self.root / "current")
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        npm = bin_dir / "npm"
        npm.write_text("#!/bin/sh\necho \"$@\" > npm-args && mkdir -p node_modules/yaml\n")
        npm.chmod(0o755)
        deploy = bin_dir / "deploy"
        self.deploy_log = self.tmp / "deploys"
        deploy.write_text("#!/bin/sh\necho \"$1\" >> %s\n[ -f %s ] && { echo 'wizard-agent-service-deploy: refusing to deploy: it does not contain the live release' >&2; exit 1; }\n"
                          "ln -sfn \"$WIZARD_SERVER_RELEASE_ROOT/releases/was-$1\" \"$WIZARD_SERVER_RELEASE_ROOT/current\"\n"
                          % (self.deploy_log, self.tmp / "refuse"))
        deploy.chmod(0o755)
        Checks.runs = {}
        self.api = ThreadingHTTPServer(("127.0.0.1", 0), Checks)
        threading.Thread(target=self.api.serve_forever, daemon=True).start()
        self.env = mock.patch.dict(os.environ, {
            "WAS_SOURCE": str(self.src), "WIZARD_SERVER_RELEASE_ROOT": str(self.root), "WIZARD_FOLLOW_MAIN": "1",
            "WIZARD_FOLLOW_MAIN_API": f"http://127.0.0.1:{self.api.server_port}", "WAS_DEPLOY": str(deploy),
            "WIZARD_FOLLOW_MAIN_NPM": str(npm), "HOME": str(self.tmp / "home")})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.api.shutdown()
        self.api.server_close()
        subprocess.run(["rm", "-rf", str(self.tmp)])

    def merge(self, text="// v2\n"):
        (self.work / "server/index.mjs").write_text(text)
        git(self.work, "commit", "-qam", "change")
        git(self.work, "push", "-q", "origin", "HEAD:main")
        return git(self.work, "rev-parse", "HEAD")

    def status(self):
        return json.loads((self.root / "follow-main.json").read_text())

    def test_off_changes_nothing(self):
        sha = self.merge()
        Checks.runs[sha] = green()
        with mock.patch.dict(os.environ, {"WIZARD_FOLLOW_MAIN": "0"}):
            self.assertEqual(fm.follow_once(), {"state": "off"})
        self.assertFalse((self.root / "follow-main.json").exists())
        self.assertFalse((self.root / "releases" / f"was-{sha}").exists())
        self.assertFalse(self.deploy_log.exists())

    def test_switch_unset_asks_the_service_and_an_unreachable_one_reads_off(self):
        with mock.patch.dict(os.environ, {"WIZARD_FOLLOW_MAIN": "", "WAS_PORT": "9"}):
            self.assertEqual(fm.follow_once(), {"state": "off"})

    def test_current_when_live_is_main(self):
        out = fm.follow_once()
        self.assertEqual(out["state"], "current")
        self.assertEqual(out["live"], self.v1)

    def test_a_green_merge_is_prepared_and_deployed(self):
        sha = self.merge()
        Checks.runs[sha] = green()
        out = fm.follow_once()
        self.assertEqual(out["state"], "current", out)
        self.assertEqual(out["live"], sha)
        release = self.root / "releases" / f"was-{sha}"
        self.assertEqual((release / "RELEASE_SHA").read_text().strip(), sha)
        self.assertEqual((release / "server/index.mjs").read_text(), "// v2\n")
        self.assertEqual((release / "SERVER_TREE").read_text().strip(), fm.tree_digest(release / "server"))
        self.assertIn("--omit=dev", (release / "npm-args").read_text())
        self.assertTrue((release / "node_modules/yaml").is_dir())
        self.assertEqual(self.deploy_log.read_text().split(), [sha])
        self.assertEqual(self.status()["state"], "current")

    def test_waits_for_checks_then_deploys(self):
        sha = self.merge()
        Checks.runs[sha] = green("gitleaks") + [{"id": next(IDS), "name": "test", "status": "in_progress", "started_at": "2026-11-24T00:00:00Z"}]
        out = fm.follow_once()
        self.assertEqual(out["state"], "waiting")
        self.assertIn("test", out["reason"])
        self.assertIn("validate", out["reason"])
        self.assertEqual(out["cause"], "checks-pending")
        self.assertEqual(out["behind_by"], 1)
        self.assertFalse(self.deploy_log.exists())
        since = out["behind_since"]
        Checks.runs[sha] = green()
        self.assertEqual(fm.follow_once()["state"], "current")

        sha3 = self.merge("// v3\n")
        time.sleep(1.1)  # behind_since has second resolution: a new lag starts a new clock
        self.assertNotEqual(fm.follow_once()["behind_since"], since)
        Checks.runs[sha3] = green()
        self.assertEqual(fm.follow_once()["live"], sha3)

    def test_failed_checks_never_deploy_and_say_why(self):
        sha = self.merge()
        Checks.runs[sha] = green("gitleaks", "validate") + [{"id": next(IDS), "name": "test", "status": "completed", "conclusion": "failure", "started_at": "x"}]
        out = fm.follow_once()
        self.assertEqual(out["state"], "behind")
        self.assertIn("failed its checks (test)", out["reason"])
        self.assertEqual(out["cause"], "red-main")  # issue 638: CI's to fix, the Service tells the owner nothing
        self.assertFalse(self.deploy_log.exists())
        self.assertFalse((self.root / "releases" / f"was-{sha}").exists())

    def test_a_rerun_check_counts_by_its_newest_run(self):
        sha = self.merge()
        Checks.runs[sha] = [{"id": 1, "name": "test", "status": "completed", "conclusion": "failure", "started_at": "2026-11-24T01:00:00Z"}] + green()
        self.assertEqual(fm.follow_once()["state"], "current")

    def test_a_queued_rerun_after_a_green_run_is_still_pending(self):
        sha = self.merge()
        Checks.runs[sha] = green() + [{"id": next(IDS), "name": "test", "status": "queued", "conclusion": None, "started_at": None}]
        out = fm.follow_once()
        self.assertEqual(out["state"], "waiting")
        self.assertIn("test", out["reason"])
        self.assertFalse(self.deploy_log.exists())

    def test_a_refused_deploy_is_behind_with_the_helpers_reason_and_waits_to_retry(self):
        (self.tmp / "refuse").write_text("")
        sha = self.merge()
        Checks.runs[sha] = green()
        out = fm.follow_once()
        self.assertEqual(out["state"], "behind")
        self.assertEqual(out["live"], self.v1)
        self.assertEqual(out["reason"], "the deploy stopped: refusing to deploy: it does not contain the live release")
        self.assertEqual((out["cause"], out["failures"]), ("deploy", 1))
        again = fm.follow_once()
        self.assertEqual((again["reason"], again["cause"], again["failures"]), (out["reason"], "deploy", 1))
        self.assertEqual(len(self.deploy_log.read_text().split()), 1)  # no retry storm
        # Issue 638: the retry failing too counts a second failure in a row (the Service tells the owner then).
        with mock.patch.dict(os.environ, {"WIZARD_FOLLOW_MAIN_RETRY_S": "0"}):
            self.assertEqual(fm.follow_once()["failures"], 2)
        (self.tmp / "refuse").unlink()
        with mock.patch.dict(os.environ, {"WIZARD_FOLLOW_MAIN_RETRY_S": "0"}):
            done = fm.follow_once()
        self.assertEqual(done["live"], sha)
        self.assertNotIn("cause", done)
        self.assertNotIn("failures", done)

    def test_a_failed_prepare_leaves_no_half_release(self):
        sha = self.merge()
        Checks.runs[sha] = green()
        with mock.patch.dict(os.environ, {"WIZARD_FOLLOW_MAIN_NPM": "false"}):
            out = fm.follow_once()
        self.assertEqual(out["state"], "behind")
        self.assertIn("couldn't prepare the release", out["reason"])
        self.assertEqual((out["cause"], out["failures"]), ("prepare", 1))
        self.assertEqual([p.name for p in (self.root / "releases").iterdir()], [f"was-{self.v1}"])
        self.assertFalse(self.deploy_log.exists())
        # The retry prepares fine and its first deploy fails: a first failure of a new stage, not "failed again".
        (self.tmp / "refuse").write_text("")
        with mock.patch.dict(os.environ, {"WIZARD_FOLLOW_MAIN_RETRY_S": "0"}):
            out = fm.follow_once()
        self.assertEqual((out["cause"], out["failures"]), ("deploy", 1))

    def heavy_job(self, state="running", age_s=3600, timeout=14400, job_id="heavy_mac644"):
        db = self.tmp / "home/.hermes/state/wizard-mobile/heavy.sqlite3"
        db.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(db)) as c, c:
            c.execute("CREATE TABLE IF NOT EXISTS heavy_jobs(id TEXT PRIMARY KEY, session TEXT, origin TEXT, key TEXT, hash TEXT, data TEXT, agent_id TEXT)")
            job = {"job_id": job_id, "state": state, "created_at": int((time.time() - age_s) * 1000),
                   "spec": {"cwd": "/w", "argv": ["./mac-acceptance.sh", "--full"], "timeout_seconds": timeout}}
            c.execute("INSERT OR REPLACE INTO heavy_jobs VALUES(?,?,?,?,?,?,?)", (job_id, "s", "o", job_id, "h", json.dumps(job), "hermes"))
        return db

    def test_a_busy_heavy_queue_is_a_wait_never_a_deploy_failure(self):
        # Issue 644: the deploy helper refuses while a heavy job runs; that is a wait for nobody, retried every pass.
        db = self.heavy_job()
        sha = self.merge()
        Checks.runs[sha] = green()
        for _ in range(3):
            out = fm.follow_once()
            self.assertEqual((out["state"], out["cause"]), ("waiting", "heavy-busy"), out)
            self.assertNotIn("failures", out)
            self.assertNotIn("failed_sha", out)
            self.assertIn("waiting for 1 heavy job to finish (heavy_mac644 (./mac-acceptance.sh --full))", out["reason"])
            self.assertEqual(out["heavy_job"], "heavy_mac644 (./mac-acceptance.sh --full)")
        self.assertFalse(self.deploy_log.exists())  # the helper is never asked to restart while it would refuse
        self.assertTrue((self.root / "releases" / f"was-{sha}").is_dir())  # prepared, ready for the idle moment
        with closing(sqlite3.connect(db)) as c, c:
            c.execute("UPDATE heavy_jobs SET data=json_set(data, '$.state', 'succeeded')")
        done = fm.follow_once()
        self.assertEqual((done["state"], done["live"]), ("current", sha))
        self.assertNotIn("cause", done)

    def test_the_helpers_own_heavy_refusal_is_a_wait_too(self):
        # A job that starts between our look and the helper's: the refusal still reads as a heavy wait.
        sha = self.merge()
        Checks.runs[sha] = green()
        refuse = self.tmp / "bin/refuse-heavy"
        refuse.write_text("#!/bin/sh\necho 'wizard-agent-service-deploy: heavy queue not idle: 1 active jobs; retry after completion' >&2\nexit 1\n")
        refuse.chmod(0o755)
        with mock.patch.dict(os.environ, {"WAS_DEPLOY": str(refuse), "WIZARD_FOLLOW_MAIN_RETRY_S": "0"}):
            for _ in range(2):
                out = fm.follow_once()
                self.assertEqual((out["state"], out["cause"]), ("waiting", "heavy-busy"), out)
                self.assertNotIn("failures", out)

    def test_a_heavy_wait_longer_than_any_job_may_run_names_the_job(self):
        self.heavy_job(age_s=6 * 3600)
        sha = self.merge()
        Checks.runs[sha] = green()
        first = fm.follow_once()
        self.assertEqual(first["cause"], "heavy-busy")
        # 4 h 59 min into the wait (4 h limit + 1 h grace) it is still only a wait.
        status = {**self.status(), "heavy_since": fm.datetime.fromtimestamp(time.time() - 4 * 3600 - 59 * 60, fm.timezone.utc).isoformat(timespec="seconds")}
        (self.root / "follow-main.json").write_text(json.dumps(status))
        self.assertEqual(fm.follow_once()["state"], "waiting")
        status["heavy_since"] = fm.datetime.fromtimestamp(time.time() - 5 * 3600 - 60, fm.timezone.utc).isoformat(timespec="seconds")
        (self.root / "follow-main.json").write_text(json.dumps(status))
        out = fm.follow_once()
        self.assertEqual((out["state"], out["cause"]), ("behind", "heavy-stuck"), out)
        self.assertIn("heavy job heavy_mac644 (./mac-acceptance.sh --full) has held the heavy queue for 5 h", out["reason"])
        self.assertEqual(out["heavy_since"], status["heavy_since"])
        self.assertFalse(self.deploy_log.exists())

    def test_a_job_with_a_longer_own_timeout_gets_its_own_limit(self):
        self.heavy_job(timeout=10 * 3600)
        sha = self.merge()
        Checks.runs[sha] = green()
        fm.follow_once()
        status = {**self.status(), "heavy_since": fm.datetime.fromtimestamp(time.time() - 8 * 3600, fm.timezone.utc).isoformat(timespec="seconds")}
        (self.root / "follow-main.json").write_text(json.dumps(status))
        self.assertEqual(fm.follow_once()["cause"], "heavy-busy")  # 8 h < 10 h + 1 h

    def test_finished_heavy_jobs_do_not_hold_the_deploy(self):
        self.heavy_job(state="succeeded")
        sha = self.merge()
        Checks.runs[sha] = green()
        self.assertEqual(fm.follow_once()["live"], sha)

    def test_unreachable_github_is_behind_not_a_crash(self):
        sha = self.merge()
        with mock.patch.dict(os.environ, {"WIZARD_FOLLOW_MAIN_API": "http://127.0.0.1:9"}):
            out = fm.follow_once()
        self.assertEqual(out["state"], "behind")
        self.assertEqual(out["main"], sha)
        self.assertIn("couldn't read main's checks", out["reason"])
        self.assertEqual(out["cause"], "github")


class FollowMainUnitTest(unittest.TestCase):
    def test_timer_unit_runs_the_live_releases_copy_with_a_checkout_fallback(self):
        unit = (ROOT / "ops/wizard-agent-service-follow-main.service").read_text()
        self.assertIn("current/ops/wizard-agent-service-follow-main.py", unit)
        self.assertIn("apps/wizard-agent-service/ops/wizard-agent-service-follow-main.py", unit)
        self.assertIn('"$$f"', unit)  # systemd would expand a single $f itself
        timer = (ROOT / "ops/wizard-agent-service-follow-main.timer").read_text()
        self.assertIn("OnUnitActiveSec=5min", timer)


if __name__ == "__main__":
    unittest.main()
