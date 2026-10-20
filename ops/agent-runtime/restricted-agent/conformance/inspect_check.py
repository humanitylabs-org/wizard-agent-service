#!/usr/bin/env python3
"""Outside-in checks of what Docker actually applied to the restricted agent's containers.

Usage:
  inspect_check.py <compose-project> <ingress host:port> <agent api key> [expected home bind source]
  inspect_check.py --selftest     # proves the mount and environment rules reject bad layouts

Without a home bind source the home must be the project's own named volume `<project>_agent-home`.
With one (VPS driver: a dedicated per-agent directory), the bind source must equal it exactly and may
not be a host home or system root."""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

FORBIDDEN_HOME_SOURCES = {"/", "/home", "/Users", "/root", "/var", "/etc", "/opt", "/srv", "/Volumes", "/mnt",
                          "/var/lib/docker", "/run", "/var/run", "/tmp"}
# Variables the compose file grants the agent, on top of whatever the image itself defines.
COMPOSE_ENV = {"HOME", "HERMES_HOME", "PATH", "API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_PORT",
               "API_SERVER_KEY", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy",
               "WIZARD_GATEWAY_URL"}


def mount_problems(mounts, project, home_source=None):
    """Return a list of problems with the agent's mounts (empty = exactly the intended two)."""
    problems = []
    home_volume, skills_volume = f"{project}_agent-home", f"{project}_system-skills"
    by_dest = {}
    for m in mounts:
        by_dest.setdefault(m["dest"], []).append(m)
    for dest, ms in by_dest.items():
        if len(ms) > 1:
            problems.append(f"{dest} mounted {len(ms)} times")
    extra = sorted(set(by_dest) - {"/opt/data", "/opt/wizard-skills"})
    if extra:
        problems.append(f"unexpected mounts: {extra}")
    home = (by_dest.get("/opt/data") or [None])[0]
    if not home:
        problems.append("home not mounted")
    elif not home["rw"]:
        problems.append("home is read-only")
    elif home_source is None:
        if home["type"] != "volume" or home["src"] != home_volume:
            problems.append(f"home must be volume {home_volume}, got {home['type']} {home['src']}")
    else:
        src = os.path.normpath(str(home["src"]))
        want = os.path.normpath(home_source)
        if home["type"] != "bind" or src != want:
            problems.append(f"home must be bind {want}, got {home['type']} {src}")
        if want in FORBIDDEN_HOME_SOURCES or want.count("/") < 3 or os.path.basename(want) in ("", ".ssh"):
            problems.append(f"home source {want} is a system or user root, not a dedicated directory")
    skills = (by_dest.get("/opt/wizard-skills") or [None])[0]
    if not skills or skills["type"] != "volume" or skills["rw"] or skills["src"] != skills_volume:
        problems.append(f"system skills must be read-only volume {skills_volume}, got {skills}")
    for m in mounts:
        if "sock" in str(m["src"]) or "sock" in m["dest"]:
            problems.append(f"socket mounted: {m}")
    return problems


def init_problems(init_mounts, agent_home):
    """home-init runs as root with CHOWN/FOWNER/DAC_OVERRIDE: its only mount must be the very home the
    agent was validated to use (same type and source), writable."""
    if agent_home is None:
        return ["agent home unknown"]
    if len(init_mounts) != 1:
        return [f"home-init must have exactly one mount, has {len(init_mounts)}"]
    m = init_mounts[0]
    same = (m["dest"] == "/opt/data" and m["rw"] and m["type"] == agent_home["type"]
            and os.path.normpath(str(m["src"])) == os.path.normpath(str(agent_home["src"])))
    return [] if same else [f"home-init mount {m} differs from agent home {agent_home}"]


def env_problems(env_names, image_env_names):
    extra = sorted(set(env_names) - set(image_env_names) - COMPOSE_ENV)
    return [f"environment not granted by image or compose: {extra}"] if extra else []


def selftest():
    p = "proj"
    good = [{"type": "volume", "dest": "/opt/data", "rw": True, "src": "proj_agent-home"},
            {"type": "volume", "dest": "/opt/wizard-skills", "rw": False, "src": "proj_system-skills"}]
    skills = good[1]

    def home_bind(src):
        return {"type": "bind", "dest": "/opt/data", "rw": True, "src": src}

    cases = {
        "good named volume": (good, None, True),
        "good dedicated dir": ([home_bind("/srv/wizard/agents/npa/home"), skills], "/srv/wizard/agents/npa/home", True),
        "whole host home, no expected source": ([home_bind("/home/telos"), skills], None, False),
        "whole host home declared as expected": ([home_bind("/home/telos"), skills], "/home/telos", False),
        "mac home declared as expected": ([home_bind("/Users/thales"), skills], "/Users/thales", False),
        "root bind": ([home_bind("/"), skills], "/", False),
        "bind differs from expected": ([home_bind("/srv/wizard/agents/other/home"), skills], "/srv/wizard/agents/npa/home", False),
        "foreign volume as home": ([dict(good[0], src="other_agent-home"), skills], None, False),
        "extra nested mount": (good + [{"type": "bind", "dest": "/opt/data/.ssh", "rw": False, "src": "/home/telos/.ssh"}], None, False),
        "docker socket": (good + [{"type": "bind", "dest": "/var/run/docker.sock", "rw": True, "src": "/var/run/docker.sock"}], None, False),
        "skills writable": ([good[0], dict(skills, rw=True)], None, False),
        "home missing": ([skills], None, False),
    }
    results = []
    for name, (mounts, src, expect_ok) in cases.items():
        ok = not mount_problems(mounts, p, src)
        results.append({"case": name, "expected_ok": expect_ok, "ok": ok, "pass": ok == expect_ok})
    home = good[0]
    init_cases = {
        "init: same home volume": ([dict(home)], home, True),
        "init: same dedicated dir": ([home_bind("/srv/wizard/agents/npa/home")], home_bind("/srv/wizard/agents/npa/home"), True),
        "init: host home bind": ([home_bind("/home/telos")], home, False),
        "init: root bind": ([home_bind("/")], home, False),
        "init: foreign volume": ([dict(home, src="other_agent-home")], home, False),
        "init: different dedicated dir": ([home_bind("/srv/wizard/agents/other/home")], home_bind("/srv/wizard/agents/npa/home"), False),
        "init: extra mount": ([dict(home), {"type": "bind", "dest": "/host", "rw": True, "src": "/home/telos"}], home, False),
        "init: read-only home": ([dict(home, rw=False)], home, False),
    }
    for name, (mounts, agent_home, expect_ok) in init_cases.items():
        ok = not init_problems(mounts, agent_home)
        results.append({"case": name, "expected_ok": expect_ok, "ok": ok, "pass": ok == expect_ok})
    env_cases = [(["PATH", "HOME", "LANG"], ["PATH", "LANG"], True), (["PATH", "ANTHROPIC_API_KEY"], ["PATH"], False),
                 (["PATH", "WIZARD_MCP_TOKEN"], ["PATH"], False)]
    for names, image, expect_ok in env_cases:
        ok = not env_problems(names, image)
        results.append({"case": f"env {names}", "expected_ok": expect_ok, "ok": ok, "pass": ok == expect_ok})
    print(json.dumps({"summary": {"total": len(results), "passed": sum(r["pass"] for r in results),
                                  "failed": [r["case"] for r in results if not r["pass"]]}, "checks": results}, indent=1))
    sys.exit(0 if all(r["pass"] for r in results) else 1)


if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
    selftest()

project, ingress, api_key = sys.argv[1:4]
home_source = sys.argv[4] if len(sys.argv) > 4 else None
CHECKS = []


def inspect(service, all_states=False):
    ids = subprocess.check_output(["docker", "ps", *(["-a"] if all_states else []), "-q",
                                   "--filter", f"label=com.docker.compose.project={project}",
                                   "--filter", f"label=com.docker.compose.service={service}"], text=True).split()
    return json.loads(subprocess.check_output(["docker", "inspect", *ids], text=True)) if ids else []


def check(cid, desc, ok, evidence):
    CHECKS.append({"id": cid, "check": desc, "pass": bool(ok), "evidence": evidence})


def drops_all(hc):
    return [c.upper() for c in (hc.get("CapDrop") or [])] in (["ALL"], ["CAP_ALL"])


def no_new_privs(hc):
    return any("no-new-privileges" in s for s in hc.get("SecurityOpt") or [])


agent = inspect("agent")
check("I0", "exactly one agent container running", len(agent) == 1, len(agent))
a = agent[0] if agent else {"Config": {}, "HostConfig": {}, "Mounts": [], "NetworkSettings": {"Networks": {}}}
hc, cfg = a["HostConfig"], a["Config"]
check("I1", "runs as uid 10000 (not root)", cfg.get("User") == "10000:10000", cfg.get("User"))
check("I2", "not privileged", hc.get("Privileged") is False, hc.get("Privileged"))
check("I3", "all capabilities dropped, none added", drops_all(hc) and not hc.get("CapAdd"),
      {"drop": hc.get("CapDrop"), "add": hc.get("CapAdd")})
check("I4", "no-new-privileges", no_new_privs(hc), hc.get("SecurityOpt"))
check("I5", "read-only root filesystem", hc.get("ReadonlyRootfs") is True, hc.get("ReadonlyRootfs"))
mounts = [{"type": m["Type"], "dest": m["Destination"], "rw": m["RW"], "src": m.get("Name") or m.get("Source")}
          for m in a.get("Mounts", [])]
problems = mount_problems(mounts, project, home_source)
check("I6", "exactly the intended mounts: own home (rw) and system skills (ro)", not problems,
      {"mounts": mounts, "problems": problems, "expected_home_source": home_source})
check("I7", "no socket or other host path mounted", not any("sock" in p or "unexpected" in p for p in problems), problems)
check("I8", "no published ports on the agent", not (hc.get("PortBindings") or {}), hc.get("PortBindings"))
nets = list((a.get("NetworkSettings") or {}).get("Networks", {}))
check("I9", "attached only to the sandbox network", len(nets) == 1 and nets[0].endswith("_sandbox"), nets)
n = json.loads(subprocess.check_output(["docker", "network", "inspect", nets[0]], text=True))[0] if nets else {}
check("I10", "sandbox network is internal and the host has no address on it",
      n.get("Internal") is True and (n.get("Options") or {}).get("com.docker.network.bridge.inhibit_ipv4") == "true"
      and not any(c.get("Gateway") for c in (n.get("IPAM") or {}).get("Config") or []),
      {"internal": n.get("Internal"), "options": n.get("Options"), "ipam": (n.get("IPAM") or {}).get("Config")})
check("I11", "host namespaces not shared",
      all((hc.get(k) or "") in ("", "private", "default") for k in ("PidMode", "IpcMode", "UTSMode", "UsernsMode"))
      and hc.get("NetworkMode", "").endswith("_sandbox"),
      {k: hc.get(k) for k in ("PidMode", "IpcMode", "UTSMode", "UsernsMode", "NetworkMode")})
check("I12", "memory (no extra swap), CPU and process limits set",
      hc.get("Memory", 0) > 0 and hc.get("MemorySwap") == hc.get("Memory") and hc.get("NanoCpus", 0) > 0
      and (hc.get("PidsLimit") or 0) > 0,
      {"memory": hc.get("Memory"), "swap": hc.get("MemorySwap"), "nano_cpus": hc.get("NanoCpus"), "pids": hc.get("PidsLimit")})
check("I13", "no devices passed through", not hc.get("Devices") and not hc.get("DeviceRequests"), hc.get("Devices"))
env_names = sorted(e.split("=", 1)[0] for e in cfg.get("Env") or [])
image_env = []
if cfg.get("Image"):
    image_env = [e.split("=", 1)[0] for e in json.loads(subprocess.check_output(
        ["docker", "image", "inspect", cfg["Image"]], text=True))[0]["Config"].get("Env") or []]
env_bad = env_problems(env_names, image_env)
check("I14", "environment is exactly image defaults plus the compose grants", not env_bad and bool(image_env),
      {"env": env_names, "problems": env_bad})
tmpfs = hc.get("Tmpfs") or {}
check("I17", "agent /tmp is the only tmpfs: nosuid, nodev, size-capped",
      set(tmpfs) == {"/tmp"} and all(o in tmpfs["/tmp"].split(",") for o in ("nosuid", "nodev"))
      and "size=" in tmpfs["/tmp"], tmpfs)

for svc in ("egress", "edge"):
    s = inspect(svc)
    shc = s[0]["HostConfig"] if s else {}
    check(f"I15-{svc}", f"{svc} sidecar: non-root, ALL capabilities dropped, read-only, no-new-privileges, limits",
          bool(s) and s[0]["Config"].get("User") == "65534:65534" and shc.get("ReadonlyRootfs") is True
          and drops_all(shc) and not shc.get("CapAdd") and no_new_privs(shc) and not shc.get("Privileged")
          and shc.get("Memory", 0) > 0 and (shc.get("PidsLimit") or 0) > 0
          and not [m for m in s[0].get("Mounts", []) if m["Type"] == "bind"],
          {"user": s[0]["Config"].get("User") if s else None, "ro": shc.get("ReadonlyRootfs"), "drop": shc.get("CapDrop"),
           "mounts": [m["Destination"] for m in s[0].get("Mounts", [])] if s else None})
    bindings = shc.get("PortBindings") or {}
    host_ips = [b.get("HostIp") for v in bindings.values() for b in (v or [])]
    if svc == "egress":
        check("I18-egress", "egress publishes no ports", not bindings, bindings)
    else:
        check("I18-edge", "edge publishes only the inbound relay, on host loopback only",
              set(bindings) == {"8642/tcp"} and bool(host_ips) and all(ip in ("127.0.0.1", "::1") for ip in host_ips),
              bindings)

init = inspect("home-init", all_states=True)
ihc = init[0]["HostConfig"] if init else {}
agent_home = next((m for m in mounts if m["dest"] == "/opt/data"), None) if not problems else None
init_mounts = [{"type": m["Type"], "dest": m["Destination"], "rw": m["RW"], "src": m.get("Name") or m.get("Source")}
               for m in (init[0].get("Mounts", []) if init else [])]
init_bad = init_problems(init_mounts, agent_home)
check("I19", "exactly one home-init: exited 0, no network, only CHOWN/FOWNER/DAC_OVERRIDE, read-only, "
             "no-new-privileges, sole mount = the agent's validated home",
      len(init) == 1 and not init_bad and init[0]["State"].get("Status") == "exited" and init[0]["State"].get("ExitCode") == 0
      and ihc.get("NetworkMode") == "none" and drops_all(ihc) and no_new_privs(ihc) and ihc.get("ReadonlyRootfs") is True
      and sorted(c.upper().removeprefix("CAP_") for c in ihc.get("CapAdd") or []) == ["CHOWN", "DAC_OVERRIDE", "FOWNER"]
      ,
      {"mount_problems": init_bad, "state": init[0]["State"].get("Status") if init else None, "exit": init[0]["State"].get("ExitCode") if init else None,
       "network": ihc.get("NetworkMode"), "add": ihc.get("CapAdd"),
       "mounts": [m["Destination"] for m in init[0].get("Mounts", [])] if init else None})


# The service side can still reach the agent's API (through the edge relay) and the key is enforced.
def get(key):
    req = urllib.request.Request(f"http://{ingress}/v1/models", headers={"Authorization": f"Bearer {key}"} if key else {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return repr(e)


with_key, without_key = get(api_key), get(None)
check("I16", "service reaches agent API with key (200) and is refused without it (401)",
      with_key == 200 and without_key == 401, {"with_key": with_key, "without_key": without_key})

print(json.dumps({"summary": {"total": len(CHECKS), "passed": sum(c["pass"] for c in CHECKS),
                              "failed": [c["id"] for c in CHECKS if not c["pass"]]}, "checks": CHECKS}, indent=1))
