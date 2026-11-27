"""Deliveries to the main agent (issue 666): container, host Hermes (alongside) or the fresh box's engine container.

Run: python3 ops/agent-runtime/test_main_delivery.py (CI loads it from test_agent_runtime.py)."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar  # noqa: E402

# A stand-in for stock Hermes's session store with the calls DELIVER_SCRIPT makes (hermes_state.SessionDB).
FAKE_HERMES_STATE = r'''
import json, os, sqlite3
from pathlib import Path

class SessionDB:
    def __init__(self):
        self.db_path = Path(os.environ["HERMES_HOME"]) / "state.db"
        self.conn = sqlite3.connect(self.db_path)
        self.conn.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, hidden INT, read INT)")
        self.conn.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_metadata TEXT, platform_message_id TEXT)")
    def get_session(self, sid):
        row = self.conn.execute("SELECT id, title FROM sessions WHERE id=?", (sid,)).fetchone()
        return {"id": row[0], "title": row[1]} if row else None
    def create_session(self, sid, source, model=None):
        self.conn.execute("INSERT INTO sessions VALUES (?,?,NULL,0,1)", (sid, source)); self.conn.commit()
    def set_session_title(self, sid, title):
        self.conn.execute("UPDATE sessions SET title=? WHERE id=?", (title, sid)); self.conn.commit()
    def get_compression_tip(self, sid):
        return sid
    def append_message(self, sid, role, content, platform_message_id=None, display_metadata=None):
        cur = self.conn.execute("INSERT INTO messages (session_id, role, content, display_metadata, platform_message_id) VALUES (?,?,?,?,?)",
                                (sid, role, content, json.dumps(display_metadata or {}), platform_message_id))
        self.conn.commit(); return cur.lastrowid
    def set_session_hidden(self, sid, v): pass
    def set_session_archived(self, sid, v): pass
    def set_session_read(self, sid, v):
        self.conn.execute("UPDATE sessions SET read=? WHERE id=?", (int(v), sid)); self.conn.commit()
    def touch_session_activity(self, sid): pass
    def close(self): self.conn.close()
'''

PAYLOAD = {"session_id": "app-goals-1", "delivery_key": "goals:1", "title": "Goals", "body": "Weekly goals check-in"}


def host_hermes(root: Path, with_venv: bool = True) -> Path:
    """A host Hermes home: config.yaml, its checkout (hermes_state) and a venv python next to it."""
    home = root / ".hermes"
    src = home / "hermes-agent"
    src.mkdir(parents=True)
    (home / "config.yaml").write_text("model: {}\n")
    (src / "hermes_state.py").write_text(FAKE_HERMES_STATE)
    if with_venv:
        (src / "venv/bin").mkdir(parents=True)
        os.symlink(sys.executable, src / "venv/bin/python")
    return home


def alongside(wizard_home: Path, hermes_home: Path) -> Path:
    agents = wizard_home / "agents"
    agents.mkdir(parents=True)
    (wizard_home / "alongside.json").write_text(json.dumps({"mode": "alongside", "agent": {
        "external": True, "id": "host-hermes", "hermes_home": str(hermes_home), "origin": "http://127.0.0.1:8642"}}))
    return agents


def no_docker(args, **kwargs):
    raise AssertionError(f"docker must not run: {args}")


class MainDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="as666-")
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def rows(self, home: Path):
        import sqlite3
        with sqlite3.connect(home / "state.db") as conn:
            return conn.execute("SELECT session_id, role, content FROM messages").fetchall()

    def test_host_hermes_of_an_alongside_box_gets_the_delivery(self):
        home = host_hermes(self.root)
        agents = alongside(self.root / ".wizard-os", home)
        main = ar.MainAgent(agents)
        with mock.patch.object(ar, "docker", no_docker):
            first = main.deliver(object(), PAYLOAD)
            again = main.deliver(object(), PAYLOAD)
        self.assertEqual((first["verified"], first["already_delivered"], first["session_id"]), (True, False, "app-goals-1"))
        self.assertEqual(first["title"], "Goals")
        self.assertTrue(again["already_delivered"])
        self.assertEqual(self.rows(home), [("app-goals-1", "assistant", "Weekly goals check-in")])

    def test_a_conflicting_redelivery_is_refused(self):
        home = host_hermes(self.root)
        main = ar.MainAgent(alongside(self.root / ".wizard-os", home))
        main.deliver(object(), PAYLOAD)
        with self.assertRaises(ar.RuntimeFailure) as caught:
            main.deliver(object(), {**PAYLOAD, "body": "something else"})
        self.assertEqual(caught.exception.code, "delivery_conflict")

    def test_explicit_hermes_home_and_python(self):
        home = host_hermes(self.root, with_venv=False)
        main = ar.MainAgent(None, hermes_home=home, python=sys.executable)
        with mock.patch.object(ar, "docker", no_docker):
            self.assertTrue(main.deliver(object(), PAYLOAD)["verified"])

    def test_python_from_the_hermes_launcher(self):
        home = host_hermes(self.root, with_venv=False)
        launcher = self.root / "bin" / "hermes"
        launcher.parent.mkdir()
        launcher.write_text(f"#!{sys.executable}\nimport hermes_cli\n")
        launcher.chmod(0o755)
        wrapper = self.root / "bin" / "hermes-wrapper"
        wrapper.write_text(f'#!/bin/sh\nexec {launcher} "$@"\n')
        wrapper.chmod(0o755)
        self.assertIn(sys.executable, ar.MainAgent._launcher_python(wrapper))
        with mock.patch.dict(os.environ, {"WIZARD_HERMES_BIN": str(wrapper)}), mock.patch.object(ar, "HERMES_LAUNCHERS", ()):
            self.assertTrue(ar.MainAgent(None, hermes_home=home).deliver(object(), PAYLOAD)["verified"])

    def test_official_installer_launcher_runs_the_delivery_in_its_environment(self):
        home = host_hermes(self.root, with_venv=False)
        src = home / "hermes-agent"
        setup = f"import sys; sys.path.insert(0, {str(src)!r}); import runpy; "
        launcher = src / ".hermes/bin/hermes"
        launcher.parent.mkdir(parents=True)
        argv = [sys.executable, "-I", "-c", setup + "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"]
        (launcher.parent / "runtime.json").write_text(json.dumps(argv))
        launcher.write_text(f"#!/bin/sh\nif [ \"$1\" = --print-runtime-command ]; then cat {launcher.parent / 'runtime.json'}; exit 0; fi\n"
                            "exec /nonexistent/hermes-python -I -c 'start hermes'\n")
        launcher.chmod(0o755)
        with mock.patch.object(ar.shutil, "which", lambda name: None), mock.patch.object(ar, "HERMES_LAUNCHERS", ()), \
                mock.patch.dict(os.environ, {"WIZARD_HERMES_BIN": ""}):
            main = ar.MainAgent(None, hermes_home=home)
            self.assertTrue(main.deliver(object(), PAYLOAD)["verified"])
            runner = main.host_runner(home)
        self.assertEqual(runner[:3], [sys.executable, "-I", "-c"])
        self.assertEqual(self.rows(home), [("app-goals-1", "assistant", "Weekly goals check-in")])

    def test_a_launcher_without_the_runtime_flag_is_never_given_it(self):
        home = host_hermes(self.root, with_venv=False)
        marker = self.root / "ran"
        launcher = self.root / "hermes"
        launcher.write_text(f"#!/bin/sh\necho \"$@\" > {marker}\n")
        launcher.chmod(0o755)
        with mock.patch.object(ar.shutil, "which", lambda name: None), mock.patch.object(ar, "HERMES_LAUNCHERS", ()), \
                mock.patch.dict(os.environ, {"WIZARD_HERMES_BIN": str(launcher)}):
            with self.assertRaises(ar.RuntimeFailure):
                ar.MainAgent(None, hermes_home=home).deliver(object(), PAYLOAD)
        self.assertFalse(marker.exists())

    def test_no_python_that_opens_the_store_is_a_clear_refusal(self):
        home = host_hermes(self.root, with_venv=False)
        with mock.patch.object(ar.shutil, "which", lambda name: None), mock.patch.object(ar, "HERMES_LAUNCHERS", ()), \
                mock.patch.dict(os.environ, {"WIZARD_HERMES_BIN": ""}):
            with self.assertRaises(ar.RuntimeFailure) as caught:
                ar.MainAgent(None, hermes_home=home).deliver(object(), PAYLOAD)
        self.assertEqual((caught.exception.code, caught.exception.status), ("main_hermes_python_not_found", 503))

    def test_bad_body_is_refused_before_anything_runs(self):
        home = host_hermes(self.root)
        main = ar.MainAgent(alongside(self.root / ".wizard-os", home))
        with self.assertRaises(ar.RuntimeFailure) as caught:
            main.deliver(object(), {**PAYLOAD, "session_id": "../x"})
        self.assertEqual(caught.exception.status, 400)
        self.assertFalse((home / "state.db").exists())

    def calls(self, ps_out: str):
        calls = []

        def fake(args, **kwargs):
            calls.append(args)
            if args[0] == "ps":
                return subprocess.CompletedProcess(args, 0, ps_out, "")
            if "stat" in args:
                return subprocess.CompletedProcess(args, 0, "1000:1000\n", "")
            out = json.dumps({"verified": True, "already_delivered": False, "session_id": "app-goals-1"})
            return subprocess.CompletedProcess(args, 0, out + "\n", "")
        return calls, fake

    def test_fresh_box_engine_container_is_found(self):
        agents = self.root / "app-data/agents"
        agents.mkdir(parents=True)
        calls, fake = self.calls("abc123 hermes-agent-engine\nzzz999 agent-private\n")
        with mock.patch.object(ar, "docker", fake):
            self.assertTrue(ar.MainAgent(agents).deliver(object(), PAYLOAD)["verified"])
        self.assertEqual(calls[-1][:6], ["exec", "-i", "-u", "1000:1000", "abc123", "/opt/hermes/.venv/bin/python"])

    def test_named_container_wins_and_nothing_found_stays_unavailable(self):
        calls, fake = self.calls("")
        with mock.patch.object(ar, "docker", fake):
            ar.MainAgent(None, container="main-hermes").deliver(object(), PAYLOAD)
            self.assertEqual(calls[-1][4], "main-hermes")
            self.assertFalse([c for c in calls if c[0] == "ps"])
            agents = self.root / "agents"
            agents.mkdir()
            with self.assertRaises(ar.RuntimeFailure) as caught:
                ar.MainAgent(agents).deliver(object(), PAYLOAD)
        self.assertEqual((caught.exception.code, caught.exception.status), ("main_delivery_unavailable", 503))

    def test_two_engine_containers_are_never_guessed_between(self):
        agents = self.root / "agents"
        agents.mkdir()
        calls, fake = self.calls("a1 hermes-agent-engine\nb2 hermes-agent-engine\n")
        with mock.patch.object(ar, "docker", fake), self.assertRaises(ar.RuntimeFailure) as caught:
            ar.MainAgent(agents).deliver(object(), PAYLOAD)
        self.assertEqual(caught.exception.code, "main_container_ambiguous")
        self.assertFalse([c for c in calls if c[0] == "exec"])

    def test_http_route_delivers_to_the_host_main_agent(self):
        home = host_hermes(self.root)
        agents = ar.Agents(alongside(self.root / ".wizard-os", home), None)
        server = ThreadingHTTPServer(("127.0.0.1", 0), ar.make_handler("t" * 32, agents, object()))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{server.server_address[1]}/agents/hermes/deliver",
                                         data=json.dumps(PAYLOAD).encode(), method="POST",
                                         headers={"Authorization": "Bearer " + "t" * 32, "Content-Type": "application/json"})
            with mock.patch.object(ar, "docker", no_docker), urllib.request.urlopen(req, timeout=60) as response:
                receipt = json.loads(response.read())
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual((receipt["verified"], receipt["session_id"]), (True, "app-goals-1"))
        self.assertEqual(len(self.rows(home)), 1)


if __name__ == "__main__":
    unittest.main()
