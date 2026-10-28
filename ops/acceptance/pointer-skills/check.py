#!/usr/bin/env python3
"""Pointer-skill acceptance (wizard-os spec/AGENT_BRIDGE.md, "Discovery: pointer skills"), run as root inside a
fresh disposable VM. The box is the stock Wizard shape reduced to what the check needs:

- stock Hermes from the official image (pinned digest, unmodified), gateway mode, with the two links a box gives it
  (`wam agent-link` / `wizard link`): `mcp_servers.wizard` -> the Agent Service gateway with a bearer token, and the
  service's skills folder mounted read-only and listed in `skills.external_dirs`;
- the Wizard Agent Service built from the candidate source, owning apps.json -> pointer skills;
- a DeFleur-shaped app container (fake_app.py) whose MCP tools make short-form video and log every call;
- a real model (OpenAI-compatible endpoint; key read from stdin, never argv or disk outside the VM's private dir).

"Install" and "uninstall" use the App Manager's own registry writer (wam/registry.py `write`, the projection step of
`wam install` / `wam uninstall`) to write apps.json and the app's shipped skill, and start/stop the app container
with docker. Runtipi itself is not in the loop (labelled in the receipt).

Phases: empty box -> install -> N fresh threads ask "make a short video from this clip" with no app named; the app
must receive create_short -> uninstall -> the pointer must disappear -> a fresh thread asks the same; no app tool
call and no mention of the app.

    check.py --was-src <dir> --wam-src <dir> --hermes-image <ref> --py-image <ref> --model <id> --base-url <url>
             --out <dir> [--trials 3]      (model key on stdin)
"""
import argparse
import json
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

NET = "ps"
HERMES, WAS, APP = "ps-hermes", "ps-was", "ps-defleur-video"
APP_ID, APP_NAME, JOB = "defleur-video", "DeFleur Video", "short-form-video"
POINTER = f"wizard-job-{JOB}"
WAS_URL = "http://127.0.0.1:8787"
HERMES_URL = "http://127.0.0.1:8642"
PROMPT = "Make a short video from this clip: Videos/beach-day.mp4"
ROOT = Path("/var/lib/pointer-skills")


class Box:
    def __init__(self, a, model_key):
        self.a, self.model_key = a, model_key
        self.out = Path(a.out)
        self.ev = self.out / "evidence"
        self.ev.mkdir(parents=True, exist_ok=True)
        self.data, self.os_home, self.was_state = ROOT / "hermes", ROOT / "wizard-os", ROOT / "was"
        self.app_dir = ROOT / "app"
        self.key, self.mcp_token = secrets.token_hex(24), secrets.token_hex(24)
        self.results, self.trials = [], []
        self.meta = {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model": a.model,
                     "hermes_image": a.hermes_image, "prompt": PROMPT}
        self.log = open(self.ev / "harness.log", "a")
        sys.path.insert(0, a.wam_src)
        from wam import registry  # the App Manager's real registry writer
        self.registry = registry

    # ---------- plumbing ----------
    def say(self, *msg):
        line = time.strftime("%H:%M:%S ") + " ".join(str(m) for m in msg)
        print(line, flush=True)
        self.log.write(line + "\n")
        self.log.flush()

    def sh(self, *cmd, check=True, timeout=1200):
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if check and p.returncode:
            raise RuntimeError(f"{' '.join(cmd[:4])}... exited {p.returncode}: {p.stderr[-1500:]}")
        return p.stdout

    def http(self, method, path, body=None, base=WAS_URL, headers=None, timeout=120):
        h = {"content-type": "application/json", **(headers or {})}
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, method=method, data=data, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, raw
        except Exception as e:  # noqa: BLE001
            return 0, str(e)

    def wait(self, what, fn, timeout=180, every=2):
        end, last = time.time() + timeout, None
        while time.time() < end:
            try:
                last = fn()
                if last:
                    return last
            except Exception as e:  # noqa: BLE001
                last = e
            time.sleep(every)
        raise RuntimeError(f"timed out waiting for {what}: {last}")

    def dump(self, name, obj):
        p = self.ev / name
        p.write_text(obj if isinstance(obj, str) else json.dumps(obj, indent=2, default=str))
        return p

    def record(self, check, ok, detail, evidence=()):
        self.results.append({"check": check, "pass": bool(ok), "detail": detail,
                             "evidence": [str(Path(e).relative_to(self.out)) for e in evidence]})
        self.say("PASS" if ok else "FAIL", check, "-", detail)
        self.save()

    def save(self):
        (self.out / "results.json").write_text(json.dumps(self.meta | {"checks": self.results, "trials": self.trials}, indent=2))

    # ---------- box ----------
    def setup(self):
        for c in (HERMES, WAS, APP):
            self.sh("docker", "rm", "-f", c, check=False)
        self.sh("docker", "network", "rm", NET, check=False)
        shutil.rmtree(ROOT, ignore_errors=True)
        for d in (self.data, self.os_home, self.was_state, self.app_dir):
            d.mkdir(parents=True)
        self.sh("docker", "pull", "-q", self.a.hermes_image)
        self.sh("docker", "pull", "-q", self.a.py_image)
        self.say("building the Agent Service from", self.a.was_src)
        self.sh("docker", "build", "-q", "-t", "ps-was:candidate", self.a.was_src, timeout=1800)
        self.meta["was_image_id"] = self.sh("docker", "image", "inspect", "-f", "{{.Id}}", "ps-was:candidate").strip()
        cfg = "\n".join([
            "model:", "  provider: custom", f"  base_url: {self.a.base_url}", f"  api_key: {self.model_key}",
            f"  default: {self.a.model}", "agent:", "  max_turns: 30",
            "mcp_servers:", "  wizard:", f"    url: http://{WAS}:8787/wizard/mcp",
            "    headers:", "      Authorization: Bearer ${WIZARD_MCP_TOKEN}",
            "skills:", "  external_dirs:", "    - /opt/wizard-os/skills", ""])
        (self.data / "config.yaml").write_text(cfg)
        (self.data / ".env").write_text(f"WIZARD_MCP_TOKEN={self.mcp_token}\n")
        (self.data / ".env").chmod(0o600)
        self.write_registry([])  # a fresh box: App Manager registry with no apps
        shutil.copy(Path(__file__).with_name("fake_app.py"), self.app_dir / "fake_app.py")
        for p in (self.data, self.os_home, self.was_state, self.app_dir):
            self.sh("chown", "-R", "1000:1000", str(p))
        self.sh("docker", "network", "create", NET)
        self.sh("docker", "run", "-d", "--name", WAS, "--network", NET, "-p", "127.0.0.1:8787:8787",
                "-v", f"{self.was_state}:/state", "-v", f"{self.os_home}:/state/wizard-os",
                "-e", "WIZARD_HERMES_API_KEY=" + self.key, "-e", f"HERMES_ORIGIN=http://{HERMES}:8642",
                "-e", "WIZARD_AUTH_MODE=none", "-e", "WIZARD_APPS_MCP_ADDRESS=internal",
                "-e", "WIZARD_MCP_TOKEN=" + self.mcp_token, "ps-was:candidate")
        self.sh("docker", "run", "-d", "--name", HERMES, "--network", NET, "-p", "127.0.0.1:8642:8642",
                "-v", f"{self.data}:/opt/data", "-v", f"{self.os_home / 'skills'}:/opt/wizard-os/skills:ro",
                "-e", "HERMES_UID=1000", "-e", "HERMES_GID=1000",
                "-e", "API_SERVER_KEY=" + self.key, "-e", "API_SERVER_HOST=0.0.0.0", "-e", "API_SERVER_PORT=8642",
                self.a.hermes_image, "gateway", "run")
        self.wait("Agent Service sees Hermes", lambda: (self.http("GET", "/wizard/health")[1] or {}).get("upstream_reachable"), timeout=300)
        self.meta["hermes_version"] = self.sh("docker", "exec", "-u", "hermes", HERMES, "hermes", "--version").strip().splitlines()[0]
        self.say("box up:", self.meta["hermes_version"])

    def write_registry(self, apps):
        reg = {"schema": 1, "apps": apps, "grants": []}
        self.registry.write(reg, self.os_home)
        self.sh("chown", "-R", "1000:1000", str(self.os_home))

    def app_entry(self):
        return {"id": APP_ID, "name": APP_NAME, "status": "running", "summary": "Makes short-form video from clips.",
                "provides": [JOB], "skill": f"skills/{APP_ID}/SKILL.md",
                "mcp": {"url": "http://127.0.0.1:18799/mcp", "internal": f"http://{APP}:8799/mcp", "transport": "streamable-http"},
                "_skill_src": str(Path(__file__).with_name("app-skill") / "SKILL.md")}

    def listing(self, name):
        """What each side sees: the service's skills folder and the same folder inside Hermes."""
        host = sorted(p.name for p in (self.os_home / "skills").iterdir())
        inside = self.sh("docker", "exec", HERMES, "ls", "-la", "/opt/wizard-os/skills", check=False)
        text = "service skills folder (WIZARD_OS_HOME/skills):\n  " + "\n  ".join(host) + "\n\ninside Hermes (/opt/wizard-os/skills, read-only):\n" + inside
        return self.dump(name, text), host

    def calls(self):
        p = self.app_dir / "calls.jsonl"
        return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []

    # ---------- threads ----------
    def new_thread(self):
        sid = f"wizard_{int(time.time() * 1000)}_{uuid.uuid4().hex[:12]}"
        st, j = self.http("POST", "/wizard/hermes/api/sessions", {"source": "wizard-mobile", "id": sid, "model": self.a.model, "provider": "custom"})
        if st not in (200, 201):
            raise RuntimeError(f"session create {st}: {j}")
        return sid

    def send(self, sid, text, timeout=480):
        st, j = self.http("POST", "/wizard/hermes/v1/runs", {"session_id": sid, "input": text, "model": self.a.model,
                                                             "provider": "custom", "require_model_lock": True},
                          headers={"Idempotency-Key": str(uuid.uuid4())})
        if st not in (200, 202):
            raise RuntimeError(f"run create {st}: {j}")
        rid = j["run_id"]

        def done():
            s, r = self.http("GET", f"/wizard/hermes/v1/runs/{rid}")
            return r if s == 200 and r.get("status") in ("completed", "failed", "cancelled", "stopped", "error", "interrupted") else None
        return self.wait(f"run {rid}", done, timeout=timeout, every=3)

    def transcript(self, sid):
        """User/assistant text as the shell reads it, plus every tool call from Hermes' own state.db (backup copy)."""
        st, j = self.http("GET", f"/wizard/hermes/api/sessions/{sid}/messages?order=oldest&limit=500&include_compacted=true")
        rows = j.get("data", []) if st == 200 and isinstance(j, dict) else []
        copy = ROOT / "state-copy.db"
        copy.unlink(missing_ok=True)
        src = sqlite3.connect(f"file:{self.data / 'state.db'}?mode=ro", uri=True, timeout=30)
        dst = sqlite3.connect(copy)
        src.backup(dst)
        src.close()
        cols = [r[1] for r in dst.execute("PRAGMA table_info(messages)")]
        want = [c for c in ("id", "role", "tool_name", "tool_calls", "content") if c in cols]
        db_rows = [dict(zip(want, r)) for r in dst.execute(f"SELECT {', '.join(want)} FROM messages WHERE session_id=? ORDER BY id", (sid,))]
        dst.close()
        tool_calls = []
        for r in db_rows:
            raw = r.get("tool_calls")
            if not raw:
                continue
            try:
                for c in json.loads(raw):
                    fn = c.get("function") or {}
                    tool_calls.append({"name": fn.get("name") or c.get("name"), "arguments": str(fn.get("arguments") or c.get("arguments") or "")[:400]})
            except (ValueError, TypeError, AttributeError):
                tool_calls.append({"raw": str(raw)[:400]})
        final = ""
        for r in rows:
            if r.get("role") == "assistant" and isinstance(r.get("content"), str) and r["content"].strip():
                final = r["content"]
        if not final:
            for r in db_rows:
                if r.get("role") == "assistant" and isinstance(r.get("content"), str) and r["content"].strip():
                    final = r["content"]
        return {"session": sid, "tool_calls": tool_calls, "final_reply": final,
                "thread": [{"role": r.get("role"), "content": str(r.get("content"))[:1500]} for r in rows]}

    # ---------- phases ----------
    def run(self):
        self.setup()
        ev, before = self.listing("01-skills-fresh-box.txt")
        self.record("Fresh box has no pointer skills", not any(n.startswith("wizard-job-") for n in before), f"skills folder: {before}", [ev])

        # The model route answers a plain turn (otherwise every later check is about the route, not routing).
        sid = self.new_thread()
        run = self.send(sid, "Reply with the single word: ready")
        t = self.transcript(sid) | {"phase": "route-check", "run": run}
        evr = self.dump("01-route-check.json", t)
        if run.get("status") != "completed":
            self.record("Model route answers a plain turn", False, f"run {run.get('status')}: {run.get('error')}", [evr])
            raise RuntimeError("model route failed; see evidence/01-route-check.json and hermes logs")

        # Install: app container up, then the App Manager's registry write (apps.json + the app's shipped skill).
        self.sh("docker", "run", "-d", "--name", APP, "--network", NET, "-v", f"{self.app_dir}:/log",
                "-e", "CALL_LOG=/log/calls.jsonl", "-u", "1000:1000", self.a.py_image, "python", "/log/fake_app.py")
        time.sleep(2)
        self.write_registry([self.app_entry()])
        pointer = self.os_home / "skills" / POINTER / "SKILL.md"
        try:
            self.wait("pointer skill written", lambda: pointer.is_file() and "create_short" in pointer.read_text(), timeout=90)
            ok = True
        except RuntimeError:
            ok = pointer.is_file()
        ev, after = self.listing("02-skills-after-install.txt")
        evp = self.dump("02-pointer-SKILL.md", pointer.read_text() if pointer.is_file() else "(missing)")
        self.record("Install writes the job's pointer skill (with the app's real tool names)", ok,
                    f"skills folder: {after}", [ev, evp])

        hits = 0
        for i in range(self.a.trials):
            sid = self.new_thread()
            n0 = len(self.calls())
            run = self.send(sid, PROMPT)
            t = self.transcript(sid)
            new = [c for c in self.calls()[n0:] if c.get("method") == "tools/call"]
            picked = any((c.get("params") or {}).get("name") == "create_short" for c in new)
            hits += picked
            t |= {"phase": "installed", "trial": i + 1, "run_status": run.get("status"), "run_error": run.get("error"), "run": run,
                  "app_tool_calls": [c.get("params") for c in new], "picked_app_tool": picked}
            self.trials.append(t)
            self.dump(f"03-installed-trial-{i + 1}.json", t)
            self.say(f"trial {i + 1}: status {run.get('status')} picked={picked} tools={[c.get('name') for c in t['tool_calls']]}")
        self.record(f"New thread, no app named: the agent calls {APP_NAME}'s create_short",
                    hits == self.a.trials, f"{hits}/{self.a.trials} fresh threads reached create_short on the app",
                    [self.ev / f"03-installed-trial-{i + 1}.json" for i in range(self.a.trials)])

        # Uninstall: registry write without the app (drops its skill folder), then stop the container.
        self.write_registry([])
        self.sh("docker", "rm", "-f", APP, check=False)
        try:
            self.wait("pointer skill removed", lambda: not (self.os_home / "skills" / POINTER).exists(), timeout=90)
            gone = True
        except RuntimeError:
            gone = False
        ev, final_list = self.listing("04-skills-after-uninstall.txt")
        self.record("Uninstall removes the pointer skill", gone and not any(n.startswith("wizard-job-") for n in final_list),
                    f"skills folder: {final_list}", [ev])

        sid = self.new_thread()
        n0 = len(self.calls())
        run = self.send(sid, PROMPT)
        t = self.transcript(sid)
        named = [c for c in t["tool_calls"] if "defleur" in json.dumps(c).lower()]
        mentions = "defleur" in t["final_reply"].lower()
        t |= {"phase": "uninstalled", "run_status": run.get("status"), "run_error": run.get("error"), "run": run,
              "app_tool_calls_after": len(self.calls()) - n0, "defleur_tool_calls": named, "reply_mentions_app": mentions}
        self.trials.append(t)
        evu = self.dump("05-uninstalled-thread.json", t)
        self.record(f"After uninstall a new thread neither calls nor names {APP_NAME}", not named and not mentions and run.get("status") == "completed",
                    f"run {run.get('status')}; defleur tool calls {len(named)}; reply mentions app: {mentions}", [evu])
        self.meta["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.save()
        return all(c["pass"] for c in self.results)

    def collect_logs(self):
        """Hermes and Agent Service logs for diagnosis, with the model key and tokens scrubbed."""
        def scrub(text):
            for secret in (self.model_key, self.key, self.mcp_token):
                text = text.replace(secret, "<redacted>")
            return text
        for name, cmd in (("hermes-container.log", ["docker", "logs", "--tail", "400", HERMES]),
                          ("was.log", ["docker", "logs", "--tail", "400", WAS])):
            p = subprocess.run(cmd, capture_output=True, text=True)
            self.dump(name, scrub(p.stdout + p.stderr)[-60000:])
        logs = []
        for f in sorted((self.data / "logs").glob("*.log")) if (self.data / "logs").is_dir() else []:
            logs.append(f"== {f.name}\n" + "\n".join(f.read_text(errors="replace").splitlines()[-300:]))
        self.dump("hermes-logs.txt", scrub("\n".join(logs))[-80000:])

    def teardown(self):
        try:
            self.collect_logs()
        except Exception as e:  # noqa: BLE001
            self.say("log collection failed:", e)
        for c in (HERMES, WAS, APP):
            self.sh("docker", "rm", "-f", c, check=False)
        shutil.rmtree(self.data, ignore_errors=True)  # holds the model key


def main():
    ap = argparse.ArgumentParser()
    for k in ("--was-src", "--wam-src", "--hermes-image", "--py-image", "--model", "--base-url", "--out"):
        ap.add_argument(k, required=True)
    ap.add_argument("--trials", type=int, default=3)
    a = ap.parse_args()
    key = sys.stdin.readline().strip()
    if not key:
        raise SystemExit("model key expected on stdin")
    box = Box(a, key)
    try:
        ok = box.run()
    except Exception as e:  # noqa: BLE001
        box.record("Harness completed", False, f"{type(e).__name__}: {e}")
        ok = False
    finally:
        box.teardown()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
