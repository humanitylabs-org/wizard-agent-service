"""Offline contract tests for the Importer API: python3 -I test_bring_data_api.py -v (FastAPI/httpx).

The engine runs for real against temp folders; Hermes' memory tool is not needed (no card in these calls).
"""
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))
import bring_data_api as api  # noqa: E402

H = {"X-Wizard-Import": "1", "Content-Type": "application/json"}
P = "/bring-data"


class ImporterApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.home, self.files = base / "agent", base / "media"
        self.home.mkdir()
        (self.files / "Inbox").mkdir(parents=True)
        self.env = {k: os.environ.get(k) for k in ("HERMES_HOME", "WIZARD_FILES_ROOT", "WIZARD_BRING_DATA_READ_ONLY", "HOME")}
        os.environ.update(HERMES_HOME=str(self.home), WIZARD_FILES_ROOT=str(self.files), HOME=str(base / "user"))
        os.environ.pop("WIZARD_BRING_DATA_READ_ONLY", None)
        app = FastAPI()
        app.include_router(api.router)
        self.client = TestClient(app)
        self.zip = self.files / "Inbox/chatgpt.zip"
        conv = [{"title": "Porto", "create_time": 1700000000, "update_time": 1700000001, "current_node": "a", "id": "c1",
                 "mapping": {"r": {"message": None, "parent": None, "children": ["q"]},
                             "q": {"message": {"author": {"role": "user"}, "content": {"content_type": "text", "parts": ["Trip?"]}},
                                   "parent": "r", "children": ["a"]},
                             "a": {"message": {"author": {"role": "assistant"}, "recipient": "all",
                                               "content": {"content_type": "text", "parts": ["Go."]}}, "parent": "q", "children": []}}}]
        with zipfile.ZipFile(self.zip, "w") as zf:
            zf.writestr("conversations.json", json.dumps(conv))

    def tearDown(self):
        for k, v in self.env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def test_writes_need_the_importer_header_and_json(self):
        body = {"path": "Inbox/chatgpt.zip"}
        self.assertEqual(self.client.post(P + "/scan", json=body).status_code, 403)
        self.assertEqual(self.client.post(P + "/scan", content="x", headers={"X-Wizard-Import": "1",
                                                                              "Content-Type": "text/plain"}).status_code, 415)
        self.assertEqual(self.client.post(P + "/scan", json=body, headers={**H, "Sec-Fetch-Site": "cross-site"}).status_code, 403)
        self.assertEqual(self.client.put(P + "/upload?name=a.zip", content=b"PK").status_code, 403)

    def test_scan_import_imports_undo(self):
        scan = self.client.post(P + "/scan", json={"path": "Inbox/chatgpt.zip"}, headers=H)
        self.assertEqual(scan.status_code, 200, scan.text)
        self.assertEqual(scan.json()["counts"]["chats"], 1)
        self.assertEqual(scan.headers["cache-control"], "no-store")
        iid = scan.json()["import_id"]
        done = self.client.post(P + "/import", json={"import_id": iid, "chats": True, "extra": "ignored"}, headers=H)
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(done.json()["done"]["chats"]["chats_written"], 1)
        listed = self.client.get(P + "/imports").json()["imports"]
        self.assertEqual([(i["import_id"], i["via"], i["label"]) for i in listed], [(iid, "importer", "ChatGPT")])
        self.assertEqual(self.client.post(P + "/undo", json={"import_id": iid}, headers=H).status_code, 200)
        self.assertEqual(self.client.get(P + "/imports").json()["imports"], [])

    def test_scan_refuses_paths_outside_files_and_agent_folders(self):
        for path in ("/etc", "../../etc", str(self.home)):
            r = self.client.post(P + "/scan", json={"path": path}, headers=H)
            self.assertEqual(r.status_code, 403, path)
        r = self.client.post(P + "/scan", json={"paths": ["Inbox/chatgpt.zip", "/etc/passwd"]}, headers=H)
        self.assertEqual(r.status_code, 403)

    def test_upload_streams_into_inbox_without_overwriting(self):
        data = self.zip.read_bytes()
        first = self.client.put(P + "/upload?name=chatgpt.zip", content=data, headers={"X-Wizard-Import": "1"})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["path"], "Inbox/chatgpt (2).zip")
        self.assertEqual((self.files / "Inbox/chatgpt (2).zip").read_bytes(), data)
        for name in ("../x.zip", ".hidden.zip", "run.sh", ""):
            self.assertEqual(self.client.put(P + "/upload?name=" + name, content=data,
                                             headers={"X-Wizard-Import": "1"}).status_code, 400, name)
        self.assertEqual(self.client.put(P + "/upload?name=empty.zip", content=b"",
                                         headers={"X-Wizard-Import": "1"}).status_code, 400)
        self.assertEqual(sorted(p.name for p in (self.files / "Inbox").iterdir()), ["chatgpt (2).zip", "chatgpt.zip"])

    def test_preview_mode_refuses_writes_but_scans(self):
        os.environ["WIZARD_BRING_DATA_READ_ONLY"] = "1"
        scan = self.client.post(P + "/scan", json={"path": "Inbox/chatgpt.zip"}, headers=H)
        self.assertEqual(scan.status_code, 200)
        self.assertTrue(self.client.get(P + "/sources").json()["read_only"])
        self.assertEqual(self.client.post(P + "/import", json={"import_id": scan.json()["import_id"], "chats": True},
                                          headers=H).status_code, 409)
        self.assertEqual(self.client.put(P + "/upload?name=b.zip", content=b"PK",
                                         headers={"X-Wizard-Import": "1"}).status_code, 409)
        self.assertEqual(list(self.home.rglob("*")), [])

    def test_dest_is_an_agent_id_and_reaches_that_agents_home(self):
        registry = Path(self.tmp.name) / "wizard-os/agents"
        home = registry / "studio/home"
        home.mkdir(parents=True)
        (home / "config.yaml").write_text("memory: {}\n", "utf-8")
        (registry / "studio/agent.json").write_text(json.dumps({"schema": 1, "id": "studio", "label": "Studio", "runtime": {
            "kind": "container", "app_id": "agent-studio", "port": 18700}}), "utf-8")
        os.environ["WIZARD_AGENTS_DIR"] = str(registry)
        self.addCleanup(os.environ.pop, "WIZARD_AGENTS_DIR", None)
        self.assertEqual([d["id"] for d in self.client.get(P + "/sources").json()["into"]], ["studio"])
        for bad in ("../studio", "/tmp", "Studio", 7):
            r = self.client.post(P + "/scan", json={"path": "Inbox/chatgpt.zip", "dest": bad}, headers=H)
            self.assertEqual(r.status_code, 400, bad)
        scan = self.client.post(P + "/scan", json={"path": "Inbox/chatgpt.zip", "dest": "studio"}, headers=H).json()
        self.assertEqual(scan["into"], "Studio")
        done = self.client.post(P + "/import", json={"import_id": scan["import_id"], "chats": True, "dest": "studio"}, headers=H)
        self.assertEqual(done.status_code, 200, done.text)
        self.assertTrue((home / "cache/bring-data/imports.json").is_file())
        self.assertFalse((self.home / "cache").exists())
        self.assertEqual(len(self.client.get(P + "/imports?dest=studio").json()["imports"]), 1)
        self.assertEqual(self.client.get(P + "/imports").json()["imports"], [])
        undo = self.client.post(P + "/undo", json={"import_id": scan["import_id"], "dest": "studio"}, headers=H)
        self.assertEqual(undo.status_code, 200, undo.text)
        self.assertEqual(self.client.get(P + "/imports?dest=studio").json()["imports"], [])


if __name__ == "__main__":
    unittest.main()
