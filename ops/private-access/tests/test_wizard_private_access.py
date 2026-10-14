"""Unit tests for wizard-private-access against the fake tailscale/systemctl doubles.

Run: python3 -m unittest discover -s ops/private-access/tests -t ops/private-access/tests -v
"""
import http.client
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HELPER = os.path.join(ROOT, "wizard-private-access")
FAKE = os.path.join(ROOT, "testing", "fake-tailscale")
FAKE_SYSTEMCTL = os.path.join(ROOT, "testing", "fake-systemctl")
PORT = 18789


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=20):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class HelperCase(unittest.TestCase):
    state_overrides = {}
    serve_upstream = str(PORT)
    tailscale_path = FAKE

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="wpa-")
        self.state = os.path.join(self.dir, "state.json")
        self.sock = os.path.join(self.dir, "run", "sock")
        with open(self.state, "w") as handle:
            json.dump(self.state_overrides, handle)
        conf = os.path.join(self.dir, "helper.conf")
        with open(conf, "w") as handle:
            handle.write(f"socket = {self.sock}\nsocket_group =\nserve_upstream = {self.serve_upstream}\n"
                         f"tailscale = {self.tailscale_path}\nsystemctl = {FAKE_SYSTEMCTL}\n"
                         "start_wait_seconds = 5\nserve_wait_seconds = 4\nlogin_child_seconds = 60\n")
        env = {**os.environ, "FAKE_TAILSCALE_STATE": self.state, "WIZARD_PRIVATE_ACCESS_CONF": conf}
        self.env = env
        self.proc = subprocess.Popen([sys.executable, HELPER], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.time() + 10
        while not os.path.exists(self.sock):
            if self.proc.poll() is not None or time.time() > deadline:
                raise AssertionError("helper did not start: " + (self.proc.stderr.read() if self.proc.stderr else b"").decode())
            time.sleep(0.05)

    def tearDown(self):
        self.proc.terminate()
        try:
            self.assertEqual(self.proc.wait(timeout=10), 0)  # SIGTERM is a clean shutdown
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            raise AssertionError("helper ignored SIGTERM")
        self.assertFalse(os.path.exists(self.sock))
        if self.proc.stderr:
            self.proc.stderr.close()

    # -- helpers ---------------------------------------------------------------------------------
    def call(self, method, path, body=None, raw=None):
        conn = UnixConnection(self.sock)
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
        conn.request(method, path, body=payload or None, headers={"Content-Type": "application/json"} if payload else {})
        response = conn.getresponse()
        value = json.loads(response.read() or b"null")
        conn.close()
        return response.status, value

    def fake(self, *args):
        subprocess.run([sys.executable, FAKE, *args], env=self.env, check=True)

    def fake_state(self):
        with open(self.state) as handle:
            return json.load(handle)

    def calls(self):
        return [c for c in self.fake_state().get("calls", []) if c and c[0] != "status" and c[:2] != ["serve", "status"]]

    def assert_no_forbidden(self):
        flat = " ".join(" ".join(c) for c in self.fake_state().get("calls", []))
        for word in ("funnel", "--ssh", "--advertise", "--exit-node", "--auth-key", "--authkey", "--accept-routes=true"):
            self.assertNotIn(word, flat)


class NotInstalled(HelperCase):
    tailscale_path = "/nonexistent/tailscale"

    def test_status_and_start_without_tailscale(self):
        status, value = self.call("GET", "/v1/status")
        self.assertEqual(status, 200)
        self.assertEqual((value["installed"], value["daemon"], value["backend_state"]), (False, "missing", "NoState"))
        self.assertEqual(value["serve"], {"on": False, "target": None})
        status, value = self.call("POST", "/v1/start", {"hostname": "wizard"})
        self.assertEqual((status, value["error"]), (409, "tailscale_not_installed"))
        status, value = self.call("POST", "/v1/reset", {})
        self.assertEqual(status, 200)


class DaemonMissing(HelperCase):
    state_overrides = {"daemon": "stopped", "unit_missing": True}

    def test_unit_missing_reports_missing_and_refuses_start(self):
        _, value = self.call("GET", "/v1/status")
        self.assertEqual((value["installed"], value["daemon"]), (True, "missing"))
        status, value = self.call("POST", "/v1/start", {})
        self.assertEqual((status, value["error"]), (409, "tailscaled_missing"))
        self.assertTrue(set(value) == {"error", "detail"})


class DaemonStopped(HelperCase):
    state_overrides = {"daemon": "stopped"}

    def test_start_enables_daemon_and_returns_sign_in_link_quickly(self):
        _, value = self.call("GET", "/v1/status")
        self.assertEqual((value["installed"], value["daemon"], value["auth_url"]), (True, "stopped", None))
        started = time.monotonic()
        status, value = self.call("POST", "/v1/start", {"hostname": "wizard"})
        self.assertEqual(status, 200)
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(value["daemon"], "running")
        self.assertEqual(value["backend_state"], "NeedsLogin")
        self.assertRegex(value["auth_url"], r"^https://login\.tailscale\.com/a/fake\d+$")
        self.assertIn(["systemctl", "enable", "--now", "tailscaled"], self.fake_state()["calls"])
        up = [c for c in self.calls() if c[0] == "up"][0]
        self.assertEqual(up, ["up", "--reset", "--hostname=wizard", "--accept-dns=false"])
        self.assert_no_forbidden()


class SignInFlow(HelperCase):
    def test_needs_login_then_running(self):
        status, value = self.call("POST", "/v1/start", {"hostname": "wizard"})
        self.assertEqual((status, value["backend_state"]), (200, "NeedsLogin"))
        link = value["auth_url"]
        self.assertTrue(link.startswith("https://login.tailscale.com/a/"))
        # status keeps answering with the same link while the human signs in; a second start reuses it
        self.assertEqual(self.call("GET", "/v1/status")[1]["auth_url"], link)
        self.assertEqual(self.call("POST", "/v1/start", {})[1]["auth_url"], link)
        self.assertEqual(len([c for c in self.calls() if c[0] == "up"]), 1)
        self.fake("_complete-login", "Owner@Example.com")
        _, value = self.call("GET", "/v1/status")
        self.assertEqual(value["backend_state"], "Running")
        self.assertEqual(value["auth_url"], None)
        self.assertEqual(value["dns_name"], "wizard.tail1234.ts.net")
        self.assertEqual(value["tailnet"], "tail1234.ts.net")
        self.assertEqual(value["owner_login"], "owner@example.com")
        self.assertEqual(value["https_enabled"], False)
        # Running: start is a no-op
        self.assertEqual(self.call("POST", "/v1/start", {})[1]["backend_state"], "Running")
        self.assertEqual(len([c for c in self.calls() if c[0] == "up"]), 1)

    def test_rejects_bad_hostnames_and_bodies(self):
        for body in ({"hostname": "Wizard Box"}, {"hostname": "-x"}, {"hostname": 7}, {"hostname": "a" * 64}):
            status, value = self.call("POST", "/v1/start", body)
            self.assertEqual((status, value["error"]), (400, "bad_hostname"))
        self.assertEqual(self.call("POST", "/v1/start", raw=b"[1]")[0], 400)
        self.assertEqual(self.call("POST", "/v1/start", raw=b"x" * 5000)[0], 413)
        self.assertEqual([c for c in self.calls() if c[0] == "up"], [])


class HttpsNotEnabled(HelperCase):
    def sign_in(self):
        self.call("POST", "/v1/start", {})
        self.fake("_complete-login", "owner@example.com")

    def test_serve_before_sign_in_is_refused(self):
        status, value = self.call("POST", "/v1/serve", {})
        self.assertEqual((status, value["error"]), (409, "not_signed_in"))

    def test_waiting_cli_yields_enable_link_then_serve_turns_on(self):
        self.sign_in()
        started = time.monotonic()
        status, value = self.call("POST", "/v1/serve", {})
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(status, 200)
        self.assertEqual(value["https_enable_url"], "https://login.tailscale.com/f/serve?node=nFAKE123")
        self.assertEqual(value["serve"]["on"], False)
        self.assertEqual(self.call("GET", "/v1/status")[1]["https_enable_url"], "https://login.tailscale.com/f/serve?node=nFAKE123")
        self.fake("_enable-https")
        status, value = self.call("POST", "/v1/serve", {})
        self.assertEqual(status, 200)
        self.assertTrue(value["https_enabled"])
        self.assertEqual(value["serve"], {"on": True, "target": f"http://127.0.0.1:{PORT}"})
        self.assertEqual(value["https_enable_url"], None)
        serves = [c for c in self.calls() if c[0] == "serve" and c[1] != "reset"]
        self.assertTrue(all(c == ["serve", "--bg", "--https=443", f"http://127.0.0.1:{PORT}"] for c in serves))
        self.assert_no_forbidden()


class HttpsNotEnabledNoWait(HttpsNotEnabled):
    state_overrides = {"serve_should_wait": False}


class ServingAndPeers(HelperCase):
    state_overrides = {"https_enabled": True}

    def test_running_serving_with_owner_peers(self):
        self.call("POST", "/v1/start", {})
        self.fake("_complete-login", "owner@example.com")
        self.fake("_add-peer", "iphone", "iOS", "true")
        self.fake("_add-peer", "pixel", "android", "false")
        self.fake("_add-peer", "laptop", "macOS", "true")
        self.fake("_add-peer", "strangers-phone", "iOS", "true", "someone@else.com")
        status, value = self.call("POST", "/v1/serve", {})
        self.assertEqual(status, 200)
        self.assertEqual(value["serve"], {"on": True, "target": f"http://127.0.0.1:{PORT}"})
        self.assertTrue(value["https_enabled"])
        peers = {p["name"]: p for p in value["peers"]}
        self.assertEqual(set(peers), {"iphone", "pixel", "laptop"})  # only the owner's own devices
        self.assertEqual((peers["iphone"]["os"], peers["iphone"]["online"], peers["iphone"]["last_seen"]), ("iOS", True, None))
        self.assertEqual((peers["pixel"]["os"], peers["pixel"]["online"], peers["pixel"]["last_seen"]), ("android", False, "2026-10-01T10:00:00Z"))
        for peer in value["peers"]:
            self.assertRegex(peer["id"], r"^[0-9a-f]{16}$")
            self.assertNotIn("PEER", peer["id"])
            self.assertEqual(set(peer), {"id", "name", "os", "online", "last_seen"})
        # a second serve is a no-op
        before = len(self.calls())
        self.call("POST", "/v1/serve", {})
        self.assertEqual(len(self.calls()), before)

    def test_reset_unpairs_and_keeps_tailscaled(self):
        self.call("POST", "/v1/start", {})
        self.fake("_complete-login", "owner@example.com")
        self.call("POST", "/v1/serve", {})
        status, value = self.call("POST", "/v1/reset", {})
        self.assertEqual(status, 200)
        self.assertEqual(value["backend_state"], "NeedsLogin")
        self.assertEqual(value["serve"], {"on": False, "target": None})
        self.assertEqual((value["installed"], value["daemon"], value["owner_login"], value["dns_name"]), (True, "running", None, None))
        tail = self.calls()[-2:]
        self.assertEqual(tail, [["serve", "reset"], ["logout"]])
        self.assertEqual(self.fake_state()["serve"], {})

    def test_reset_kills_pending_login(self):
        self.call("POST", "/v1/start", {})
        self.call("POST", "/v1/reset", {})
        _, value = self.call("GET", "/v1/status")
        self.assertEqual(value["auth_url"], None)


class ResetFailure(HelperCase):
    state_overrides = {"https_enabled": True, "logout_fails": True}

    def test_failed_logout_is_an_error_not_success(self):
        self.call("POST", "/v1/start", {})
        self.fake("_complete-login", "owner@example.com")
        self.call("POST", "/v1/serve", {})
        status, value = self.call("POST", "/v1/reset", {})
        self.assertEqual((status, value["error"]), (502, "reset_failed"))
        self.assertIn("logout failed", value["detail"])


class ResetWhileStopped(HelperCase):
    state_overrides = {"https_enabled": True}

    def test_stopped_daemon_is_started_so_reset_really_signs_out(self):
        self.call("POST", "/v1/start", {})
        self.fake("_complete-login", "owner@example.com")
        self.call("POST", "/v1/serve", {})
        self.fake("_set", "daemon", '"stopped"')
        status, value = self.call("POST", "/v1/reset", {})
        self.assertEqual(status, 200)
        self.assertEqual((value["daemon"], value["serve"]["on"], value["owner_login"]), ("stopped", False, None))
        state = self.fake_state()
        self.assertEqual((state["backend"], state["serve"], state["daemon"]), ("NeedsLogin", {}, "stopped"))
        systemctl = [c for c in state["calls"] if c[0] == "systemctl" and c[1] != "show"]
        self.assertEqual(systemctl[-2:], [["systemctl", "start", "tailscaled"], ["systemctl", "stop", "tailscaled"]])  # never enabled at boot


class NoticeInServeOutput(HelperCase):
    state_overrides = {"serve_notice": "Update available: see https://tailscale.com/kb/1067/update"}

    def test_only_control_links_count_as_enable_links(self):
        self.call("POST", "/v1/start", {})
        self.fake("_complete-login", "owner@example.com")
        _, value = self.call("POST", "/v1/serve", {})
        self.assertEqual(value["https_enable_url"], "https://login.tailscale.com/f/serve?node=nFAKE123")


class MachineAuth(HelperCase):
    def test_needs_machine_auth_is_reported(self):
        self.fake("_set", "backend", '"NeedsMachineAuth"')
        _, value = self.call("GET", "/v1/status")
        self.assertEqual((value["backend_state"], value["auth_url"], value["dns_name"], value["owner_login"]),
                         ("NeedsMachineAuth", None, None, None))


class NoServeUpstream(HelperCase):
    serve_upstream = ""
    state_overrides = {"https_enabled": True}

    def test_serve_requires_configured_upstream(self):
        self.call("POST", "/v1/start", {})
        self.fake("_complete-login", "owner@example.com")
        status, value = self.call("POST", "/v1/serve", {})
        self.assertEqual((status, value["error"]), (409, "serve_upstream_not_configured"))


class Surface(HelperCase):
    def test_only_four_endpoints(self):
        for method, path in (("GET", "/"), ("GET", "/v1/start"), ("POST", "/v1/status"), ("GET", "/v1/serve"),
                             ("POST", "/v1/funnel"), ("POST", "/v1/up"), ("DELETE", "/v1/reset"), ("GET", "/v1/status?x=1"),
                             ("POST", "/v1/start/"), ("PUT", "/v1/serve")):
            status, value = self.call(method, path)
            self.assertEqual(status, 404, f"{method} {path}")
            self.assertEqual(set(value), {"error", "detail"})

    def test_socket_permissions(self):
        mode = stat.S_IMODE(os.stat(self.sock).st_mode)
        self.assertEqual(mode, 0o660)
        self.assertTrue(stat.S_ISSOCK(os.stat(self.sock).st_mode))

    def test_requests_are_serialized(self):
        # A serve that waits on the owner holds the helper; a status sent meanwhile is answered after it.
        self.call("POST", "/v1/start", {})
        self.fake("_complete-login", "owner@example.com")
        self.fake("_enable-https")
        with open(self.state) as handle:
            state = json.load(handle)
        state["serve_delay"] = 1.5
        with open(self.state, "w") as handle:
            json.dump(state, handle)
        order = []

        def slow():
            self.call("POST", "/v1/serve", {})
            order.append("serve")
        thread = threading.Thread(target=slow)
        thread.start()
        time.sleep(0.4)
        _, value = self.call("GET", "/v1/status")
        order.append("status")
        thread.join()
        self.assertEqual(order, ["serve", "status"])
        self.assertTrue(value["serve"]["on"])  # the status saw the finished serve, not a half state


class Install(unittest.TestCase):
    def test_image_root_install_is_idempotent_and_never_touches_tailscale(self):
        image = tempfile.mkdtemp(prefix="wpa-root-")
        script = os.path.join(ROOT, "install.sh")
        subprocess.run(["sh", script, "--root", image, "--serve-upstream", "8799", "--socket-group", "1000"], check=True, capture_output=True)
        subprocess.run(["sh", script, "--root", image], check=True, capture_output=True)  # re-run keeps values
        with open(os.path.join(image, "etc/wizard-private-access.conf")) as handle:
            conf = handle.read()
        self.assertIn("serve_upstream = 8799\n", conf)
        self.assertIn("socket_group = 1000\n", conf)
        self.assertTrue(os.access(os.path.join(image, "usr/local/lib/wizard-private-access/wizard-private-access"), os.X_OK))
        self.assertEqual(os.readlink(os.path.join(image, "etc/systemd/system/multi-user.target.wants/wizard-private-access.service")),
                         "/etc/systemd/system/wizard-private-access.service")
        everything = [os.path.relpath(os.path.join(d, f), image) for d, _, fs in os.walk(image) for f in fs]
        self.assertFalse([p for p in everything if "tailscale" in p.lower() and "private-access" not in p])
        bad = subprocess.run(["sh", script, "--root", image, "--serve-upstream", "x"], capture_output=True)
        self.assertNotEqual(bad.returncode, 0)

    def test_rerun_over_commented_config_keeps_extra_keys(self):
        image = tempfile.mkdtemp(prefix="wpa-root-")
        os.makedirs(os.path.join(image, "etc"))
        with open(os.path.join(image, "etc/wizard-private-access.conf"), "w") as handle:
            handle.write("socket_group = wizard   # name or numeric gid\nserve_upstream = 8799 # port\n"
                         "tailscale = /opt/ts/tailscale\nstart_wait_seconds = 7\n")
        subprocess.run(["sh", os.path.join(ROOT, "install.sh"), "--root", image], check=True, capture_output=True)
        with open(os.path.join(image, "etc/wizard-private-access.conf")) as handle:
            conf = handle.read()
        self.assertIn("socket_group = wizard\n", conf)
        self.assertIn("serve_upstream = 8799\n", conf)
        self.assertIn("tailscale = /opt/ts/tailscale\n", conf)
        self.assertIn("start_wait_seconds = 7\n", conf)
        self.assertNotIn("#  name", conf)

    def test_unit_runs_helper_as_root_with_socket_directory(self):
        with open(os.path.join(ROOT, "wizard-private-access.service")) as handle:
            unit = handle.read()
        self.assertIn("ExecStart=/usr/bin/python3 /usr/local/lib/wizard-private-access/wizard-private-access", unit)
        self.assertIn("RuntimeDirectory=wizard-private-access", unit)
        self.assertIn("RuntimeDirectoryMode=0750", unit)


class StatusShape(HelperCase):
    def test_status_keys_match_contract(self):
        _, value = self.call("GET", "/v1/status")
        self.assertEqual(set(value), {"installed", "daemon", "backend_state", "auth_url", "dns_name", "tailnet",
                                      "https_enabled", "https_enable_url", "serve", "owner_login", "peers"})


if __name__ == "__main__":
    unittest.main()
