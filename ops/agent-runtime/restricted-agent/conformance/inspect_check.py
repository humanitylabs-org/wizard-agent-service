#!/usr/bin/env python3
"""Outside-in checks of what Docker actually applied to the restricted agent's containers.

Usage:
  inspect_check.py <compose-project> <ingress socket inside fake-service> <agent api key> [expected home bind source] [--claude-login] [--claude-login-source volume:name|bind:/compiled/share/claude]
  inspect_check.py --selftest     # proves the mount and environment rules reject bad layouts

Without a home bind source the home must be the project's own named volume `<project>_agent-home`.
With one (VPS driver: a dedicated per-agent directory), the bind source must equal it exactly and may
not be a host home or system root."""
import json
import os
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecars"))
from hostname_policy import valid_public_hostname

FORBIDDEN_HOME_SOURCES = {"/", "/home", "/Users", "/root", "/var", "/etc", "/opt", "/srv", "/Volumes", "/mnt",
                          "/var/lib/docker", "/run", "/var/run", "/tmp"}
# Variables the compose file grants the agent, on top of whatever the image itself defines.
COMPOSE_ENV = {"HOME", "HERMES_HOME", "PATH", "API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_PORT",
               "API_SERVER_KEY", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy",
               "WIZARD_GATEWAY_URL"}


CLAUDE_LOGIN_VOLUME = "wizard-ai-accounts-claude"
CLAUDE_CONFIG_ENV = "CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR"


def mount_problems(mounts, project, home_source=None, claude_login=False):
    """Exact mounts; memory-only Claude config requires an independent owner grant."""
    problems = []
    home_volume, skills_volume = f"{project}_agent-home", f"{project}_system-skills"
    by_dest = {}
    for m in mounts:
        by_dest.setdefault(m["dest"], []).append(m)
    for dest, ms in by_dest.items():
        if len(ms) > 1:
            problems.append(f"{dest} mounted {len(ms)} times")
    allowed = {"/opt/data", "/opt/wizard-skills"}
    if claude_login:
        allowed.add("/run/claude-login")
        login = (by_dest.get("/run/claude-login") or [None])[0]
        if not login or login["type"] != "volume" or login["src"] != f"{project}_claude-session" or login["rw"]:
            problems.append("Claude config must be this agent's memory-only session volume")
    extra = sorted(set(by_dest) - allowed)
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


CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN"


def env_problems(env_names, image_env_names, claude_login=False):
    allowed = COMPOSE_ENV | ({CLAUDE_CONFIG_ENV} if claude_login else set())
    extra = sorted(set(env_names) - set(image_env_names) - allowed)
    problems = [f"environment not granted by image or compose: {extra}"] if extra else []
    if CLAUDE_TOKEN_ENV in env_names:
        problems.append("Claude token in gateway env would persist in terminal snapshots")
    if (CLAUDE_CONFIG_ENV in env_names) != claude_login:
        problems.append("Claude config must match the independent app-login grant")
    return problems


def passthrough_problems(env, aliases):
    hosts = set(env.get("EGRESS_PASSTHROUGH_HOSTS", "").replace(",", " ").split())
    declared = set(env.get("EGRESS_PASSTHROUGH_ALIASES", "").replace(",", " ").split())
    allowed = set(env.get("EGRESS_ALLOWLIST_HOSTS", "").replace(",", " ").split())
    # Docker supplies service/container aliases too; only dotted DNS aliases are provider aliases.
    actual = {a for a in aliases if "." in a}
    return [] if (hosts and hosts == declared == actual and hosts <= allowed
                  and all(valid_public_hostname(h) for h in hosts)) else ["passthrough hosts/aliases/allowlist mismatch"]


def sidecar_login_problems(mounts, project, expected_source, session_source=None, app_source=None):
    # Source identity is authoritative: a different container destination is not
    # a different credential. Also catch a bind of the volume's backing path.
    sources = {CLAUDE_LOGIN_VOLUME, f"{project}_claude-session"}
    sources.update(s for s in (expected_source, session_source, app_source) if s)
    return ["Claude login must never be mounted in a sidecar"] if any(
        m.get("Name") in sources or m.get("Source") in sources
        or m.get("Destination") in ("/claude", "/run/claude-login", "/claude-app")
        for m in mounts) else []


def claude_seed_problems(container, project, expected_source):
    problems = []
    cfg, host = container.get("Config", {}), container.get("HostConfig", {})
    if cfg.get("User") != "0:0" or host.get("NetworkMode") != "none" or not host.get("ReadonlyRootfs"):
        problems.append("Claude seeder must be ro-root, no-network root initializer")
    if (set(host.get("CapDrop") or []) != {"ALL"}
            or set(host.get("CapAdd") or []) != {"CHOWN", "FOWNER", "DAC_OVERRIDE"}
            or host.get("Privileged")
            or "no-new-privileges:true" not in (host.get("SecurityOpt") or [])
            or host.get("PidMode") == "host" or host.get("IpcMode") == "host"):
        problems.append("Claude seeder hardening mismatch")
    if container.get("State", {}).get("Status") != "running":
        problems.append("Claude seeder must retain the tmpfs mount")
    if any(e.split("=", 1)[0] == CLAUDE_TOKEN_ENV for e in cfg.get("Env", [])):
        problems.append("Claude token must not be in seeder env")
    mounts = container.get("Mounts", [])
    by_dest = {m.get("Destination"): m for m in mounts}
    if len(mounts) != 2 or set(by_dest) != {"/claude-app", "/run/claude-login"}:
        problems.append("Claude seeder must mount only the read-only app login and session tmpfs")
    secret, session = by_dest.get("/claude-app", {}), by_dest.get("/run/claude-login", {})
    if (not expected_source or secret.get("Type") != expected_source.get("type") or secret.get("RW")
            or (secret.get("Name") if secret.get("Type") == "volume" else secret.get("Source")) != expected_source.get("source")):
        problems.append("Claude seeder source must match independent app login, read-only")
    if session.get("Type") != "volume" or session.get("Name") != f"{project}_claude-session" or not session.get("RW"):
        problems.append("Claude seeder must use this agent's session volume")
    return problems


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
        "whole host home, no expected source": ([home_bind("/home/fixture"), skills], None, False),
        "whole host home declared as expected": ([home_bind("/home/fixture"), skills], "/home/fixture", False),
        "mac home declared as expected": ([home_bind("/Users/fixture"), skills], "/Users/fixture", False),
        "root bind": ([home_bind("/"), skills], "/", False),
        "bind differs from expected": ([home_bind("/srv/wizard/agents/other/home"), skills], "/srv/wizard/agents/npa/home", False),
        "foreign volume as home": ([dict(good[0], src="other_agent-home"), skills], None, False),
        "extra nested mount": (good + [{"type": "bind", "dest": "/opt/data/.ssh", "rw": False, "src": "/home/fixture/.ssh"}], None, False),
        "docker socket": (good + [{"type": "bind", "dest": "/var/run/docker.sock", "rw": True, "src": "/var/run/docker.sock"}], None, False),
        "skills writable": ([good[0], dict(skills, rw=True)], None, False),
        "home missing": ([skills], None, False),
    }
    results = []
    for name, (mounts, src, expect_ok) in cases.items():
        ok = not mount_problems(mounts, p, src)
        results.append({"case": name, "expected_ok": expect_ok, "ok": ok, "pass": ok == expect_ok})
    login = {"type": "volume", "dest": "/claude", "rw": True, "src": CLAUDE_LOGIN_VOLUME}
    for granted in (False, True):
        results.append({"case": f"direct app login never on agent {granted}",
                        "pass": bool(mount_problems(good + [login], p, claude_login=granted))})
    for mounts, expect_ok in (([], True), ([{"Name": CLAUDE_LOGIN_VOLUME, "Destination": "/alias"}], False),
                              ([{"Name": "other", "Destination": "/claude"}], False)):
        ok = not sidecar_login_problems(mounts, p, "/srv/apps/wizard-claude/data/claude")
        results.append({"case": f"sidecar login {mounts}", "pass": ok == expect_ok})
    for svc in ("edge", "egress", "home-init", "other-seeder"):
        for mount in (
            {"Type": "volume", "Name": "proj_claude-session", "Destination": "/alias", "RW": True},
            {"Type": "volume", "Source": "proj_claude-session", "Destination": "/alias", "RW": False},
            {"Type": "bind", "Source": "/docker/volumes/proj_claude-session/_data", "Destination": "/alias", "RW": False},
            {"Type": "bind", "Source": "/srv/apps/wizard-claude/data/claude", "Destination": "/alias", "RW": False},
        ):
            bad = sidecar_login_problems([mount], p, "/srv/apps/wizard-claude/data/claude",
                                        "/docker/volumes/proj_claude-session/_data")
            results.append({"case": f"{svc} alternate credential source {mount}", "pass": bool(bad)})
    results.append({"case": "unrelated sidecar volume allowed", "pass": not sidecar_login_problems(
        [{"Name": "proj_unrelated", "Destination": "/alias"}], p, "/srv/apps/wizard-claude/data/claude")})
    home = good[0]
    init_cases = {
        "init: same home volume": ([dict(home)], home, True),
        "init: same dedicated dir": ([home_bind("/srv/wizard/agents/npa/home")], home_bind("/srv/wizard/agents/npa/home"), True),
        "init: host home bind": ([home_bind("/home/fixture")], home, False),
        "init: root bind": ([home_bind("/")], home, False),
        "init: foreign volume": ([dict(home, src="other_agent-home")], home, False),
        "init: different dedicated dir": ([home_bind("/srv/wizard/agents/other/home")], home_bind("/srv/wizard/agents/npa/home"), False),
        "init: extra mount": ([dict(home), {"type": "bind", "dest": "/host", "rw": True, "src": "/home/fixture"}], home, False),
        "init: read-only home": ([dict(home, rw=False)], home, False),
        "init: login forbidden": ([dict(home), login], home, False),
    }
    for name, (mounts, agent_home, expect_ok) in init_cases.items():
        ok = not init_problems(mounts, agent_home)
        results.append({"case": name, "expected_ok": expect_ok, "ok": ok, "pass": ok == expect_ok})
    env_cases = [(["PATH", "HOME", "LANG"], ["PATH", "LANG"], True), (["PATH", "ANTHROPIC_API_KEY"], ["PATH"], False),
                 (["PATH", "WIZARD_MCP_TOKEN"], ["PATH"], False)]
    for names, image, expect_ok in env_cases:
        ok = not env_problems(names, image)
        results.append({"case": f"env {names}", "expected_ok": expect_ok, "ok": ok, "pass": ok == expect_ok})
    for granted, present, image_present, expected in ((True, True, False, True), (False, True, False, False),
                                                      (True, False, False, False), (False, True, True, False)):
        ok = not env_problems([CLAUDE_CONFIG_ENV] if present else [],
                              [CLAUDE_CONFIG_ENV] if image_present else [], granted)
        results.append({"case": f"login env {granted}/{present}/{image_present}", "pass": ok == expected})
        ok = not env_problems([CLAUDE_TOKEN_ENV] if present else [],
                              [CLAUDE_TOKEN_ENV] if image_present else [], granted)
        results.append({"case": f"token env {granted}/{present}/{image_present}", "pass": not ok})
    env = {"EGRESS_PASSTHROUGH_HOSTS": "api.anthropic.com platform.claude.com",
           "EGRESS_PASSTHROUGH_ALIASES": "api.anthropic.com platform.claude.com",
           "EGRESS_ALLOWLIST_HOSTS": "api.anthropic.com platform.claude.com"}
    for aliases, expected in ((["egress", "api.anthropic.com", "platform.claude.com"], True),
                              (["api.anthropic.com"], False),
                              (["api.anthropic.com", "platform.claude.com", "example.com"], False)):
        results.append({"case": f"passthrough aliases {aliases}",
                        "pass": (not passthrough_problems(env, aliases)) == expected})
    for granted, present, expected in ((True, True, True), (False, True, False), (True, False, False)):
        ok = not env_problems([CLAUDE_CONFIG_ENV] if present else [], [], claude_login=granted)
        results.append({"case": f"config env {granted}/{present}", "pass": ok == expected})
    session = {"type": "volume", "src": f"{p}_claude-session", "dest": "/run/claude-login", "rw": False}
    for granted, present, expected in ((True, True, True), (False, True, False), (True, False, False)):
        ok = not mount_problems([*good, *([session] if present else [])], p, claude_login=granted)
        results.append({"case": f"config mount {granted}/{present}", "pass": ok == expected})
    for name in ("agent", "edge", "egress", "localhost", "agent-service-host", "foo.localhost", "bad-.example.com"):
        reserved = {"EGRESS_PASSTHROUGH_HOSTS": name, "EGRESS_PASSTHROUGH_ALIASES": name, "EGRESS_ALLOWLIST_HOSTS": name}
        results.append({"case": f"reserved alias {name}", "pass": bool(passthrough_problems(reserved, [name]))})
    import copy
    for source in ({"type": "volume", "source": CLAUDE_LOGIN_VOLUME},
                   {"type": "bind", "source": "/srv/apps/wizard-claude/data/claude"}):
        login_mount = {"Type": source["type"], "Name" if source["type"] == "volume" else "Source": source["source"],
                       "Destination": "/claude-app", "RW": False}
        seed = {"Config": {"User": "0:0", "Env": []}, "State": {"Status": "running"},
                "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "CapDrop": ["ALL"],
                               "CapAdd": ["CHOWN", "FOWNER", "DAC_OVERRIDE"], "SecurityOpt": ["no-new-privileges:true"]},
                "Mounts": [login_mount, {"Type": "volume", "Name": "proj_claude-session", "Destination": "/run/claude-login", "RW": True}]}
        mutations = [({}, True), ({"State": {"Status": "exited"}}, False),
                     ({"Config": {"User": "10000:10000"}}, False),
                     ({"Mounts": seed["Mounts"][:1]}, False),
                     ({"Mounts": [dict(login_mount, RW=True), seed["Mounts"][1]]}, False)]
        for i, (update, expected) in enumerate(mutations):
            changed = copy.deepcopy(seed); changed.update(update)
            results.append({"case": f"seeder {source['type']} layout {i}",
                            "pass": (not claude_seed_problems(changed, p, source)) == expected})
        for wrong in (None, {"type": source["type"], "source": "wrong"}):
            results.append({"case": f"seeder wrong {source['type']} {wrong}",
                            "pass": bool(claude_seed_problems(seed, p, wrong))})
    results.append({"case": "agent session writable denied", "pass": bool(mount_problems(
        [*good, dict(session, rw=True)], p, claude_login=True))})
    print(json.dumps({"summary": {"total": len(results), "passed": sum(r["pass"] for r in results),
                                  "failed": [r["case"] for r in results if not r["pass"]]}, "checks": results}, indent=1))
    sys.exit(0 if all(r["pass"] for r in results) else 1)


if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
    selftest()

args = sys.argv[1:]
claude_login = "--claude-login" in args
if claude_login:
    args.remove("--claude-login")
login_source = {"type": "volume", "source": CLAUDE_LOGIN_VOLUME}
if "--claude-login-source" in args:
    pos = args.index("--claude-login-source")
    kind, value = args[pos + 1].split(":", 1)
    if kind not in ("bind", "volume") or not value:
        raise SystemExit("invalid Claude app source")
    login_source = {"type": kind, "source": value}
    del args[pos:pos + 2]
project, ingress, api_key = args[:3]
home_source = args[3] if len(args) > 3 else None
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
problems = mount_problems(mounts, project, home_source, claude_login)
expected_source = login_source["source"]
# Query even when ungranted, to detect stale/orphan credential mounts too.
volume_result = subprocess.run(["docker", "volume", "inspect", f"{project}_claude-session"],
                               capture_output=True, text=True, check=False)
volume = json.loads(volume_result.stdout)[0] if volume_result.returncode == 0 else {}
session_source = volume.get("Mountpoint")
app_source = expected_source
if login_source["type"] == "volume":
    app_result = subprocess.run(["docker", "volume", "inspect", expected_source], capture_output=True, text=True)
    if app_result.returncode == 0:
        app_source = json.loads(app_result.stdout)[0].get("Mountpoint")

if claude_login:
    options = volume.get("Options") or {}
    if volume.get("Driver") != "local" or options.get("type") != "tmpfs" or options.get("device") != "tmpfs":
        problems.append("Claude session volume is not memory-only tmpfs")
    if not all(x in options.get("o", "").split(",") for x in ("size=4m", "uid=10000", "gid=10000", "mode=0700", "nosuid", "nodev", "noexec")):
        problems.append("Claude tmpfs volume hardening mismatch")
check("I6", "exactly the intended mounts: own home, system skills and explicitly granted login only", not problems,
      {"mounts": mounts, "problems": problems, "expected_home_source": home_source, "claude_login": claude_login})
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
env_bad = env_problems(env_names, image_env, claude_login)
if claude_login and f"{CLAUDE_CONFIG_ENV}=/run/claude-login" not in (cfg.get("Env") or []):
    env_bad.append("Claude config directory must be /run/claude-login")
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
          bool(s) and s[0]["Config"].get("User") == ("65534:65534" if svc == "egress" else os.environ.get("AGENT_EDGE_UID", "65534") + ":" + os.environ.get("AGENT_EDGE_GID", "65534")) and shc.get("ReadonlyRootfs") is True
          and drops_all(shc) and not shc.get("CapAdd") and no_new_privs(shc) and not shc.get("Privileged")
          and shc.get("Memory", 0) > 0 and (shc.get("PidsLimit") or 0) > 0
          and (svc == "edge" or not s[0].get("Mounts")),
          {"user": s[0]["Config"].get("User") if s else None, "ro": shc.get("ReadonlyRootfs"), "drop": shc.get("CapDrop"),
           "mounts": [m["Destination"] for m in s[0].get("Mounts", [])] if s else None})
    login_bad = sidecar_login_problems(s[0].get("Mounts", []) if s else [], project, expected_source, session_source, app_source)
    if s and any(e.split("=", 1)[0] == CLAUDE_TOKEN_ENV for e in s[0]["Config"].get("Env", [])):
        login_bad.append("Claude token must never reach a sidecar")
    check(f"I20-{svc}", f"{svc} never gets the Claude login", not login_bad, login_bad)
    if svc == "edge":
        edge_nets = list(s[0]["NetworkSettings"]["Networks"]) if s else []
        edge_mounts = s[0].get("Mounts", []) if s else []
        expected_gateway_source = os.environ.get("AGENT_GATEWAY_DIR", "")
        check("I24-edge", "edge has sandbox only, no host-gateway alias, exactly its own socket directory",
              edge_nets == [f"{project}_sandbox"] and not shc.get("ExtraHosts") and len(edge_mounts) == 1
              and edge_mounts[0]["Destination"] == "/run/agent-gateway" and edge_mounts[0]["RW"]
              and ((edge_mounts[0]["Type"] == "volume" and edge_mounts[0].get("Name") == f"{project}_gateway-one")
                   or (edge_mounts[0]["Type"] == "bind" and edge_mounts[0]["Source"] == expected_gateway_source)),
              {"networks": edge_nets, "mounts": edge_mounts, "extra_hosts": shc.get("ExtraHosts")})
    bindings = shc.get("PortBindings") or {}
    if svc == "egress":
        check("I18-egress", "egress publishes no ports", not bindings, bindings)
        env = dict(e.split("=", 1) for e in s[0]["Config"].get("Env", []) if "=" in e) if s else {}
        networks = s[0].get("NetworkSettings", {}).get("Networks", {}) if s else {}
        aliases = [alias for name, net in networks.items() if name.endswith("_sandbox") for alias in net.get("Aliases", [])]
        alias_bad = passthrough_problems(env, aliases)
        check("I21-egress", "passthrough aliases exactly match allowed hosts", not alias_bad,
              {"aliases": aliases, "problems": alias_bad})
    else:
        check("I18-edge", "edge publishes no TCP ports", not bindings, bindings)

seeders = inspect("claude-init", all_states=True)
seed_bad = []
if claude_login:
    if len(seeders) != 1:
        seed_bad.append("expected exactly one Claude seeder")
    else:
        seed_bad.extend(claude_seed_problems(seeders[0], project, login_source))
elif seeders:
    seed_bad.append("ungranted Claude seeder")
check("I22", "Claude seeder matches independently authorized, isolated memory-only grant", not seed_bad,
      "; ".join(seed_bad) or "isolated seeder and app-login source match owner grant")

init = inspect("home-init", all_states=True)
ihc = init[0]["HostConfig"] if init else {}
agent_home = next((m for m in mounts if m["dest"] == "/opt/data"), None) if not problems else None
init_mounts = [{"type": m["Type"], "dest": m["Destination"], "rw": m["RW"], "src": m.get("Name") or m.get("Source")}
               for m in (init[0].get("Mounts", []) if init else [])]
init_bad = init_problems(init_mounts, agent_home)
init_bad.extend(sidecar_login_problems(init[0].get("Mounts", []) if init else [], project, expected_source, session_source, app_source))
if init and any(e.split("=", 1)[0] == CLAUDE_TOKEN_ENV for e in init[0]["Config"].get("Env", [])):
    init_bad.append("Claude token must never reach home-init")
check("I19", "exactly one home-init: exited 0, no network, only CHOWN/FOWNER/DAC_OVERRIDE, read-only, "
             "no-new-privileges, sole mount = the agent's validated home",
      len(init) == 1 and not init_bad and init[0]["State"].get("Status") == "exited" and init[0]["State"].get("ExitCode") == 0
      and ihc.get("NetworkMode") == "none" and drops_all(ihc) and no_new_privs(ihc) and ihc.get("ReadonlyRootfs") is True
      and sorted(c.upper().removeprefix("CAP_") for c in ihc.get("CapAdd") or []) == ["CHOWN", "DAC_OVERRIDE", "FOWNER"]
      ,
      {"mount_problems": init_bad, "state": init[0]["State"].get("Status") if init else None, "exit": init[0]["State"].get("ExitCode") if init else None,
       "network": ihc.get("NetworkMode"), "add": ihc.get("CapAdd"),
       "mounts": [m["Destination"] for m in init[0].get("Mounts", [])] if init else None})


# Include unknown/orphan services: only the exact validated seeder and agent
# may hold this grant, not another initializer with a different service label.
project_ids = subprocess.check_output(["docker", "ps", "-aq", "--filter",
    f"label=com.docker.compose.project={project}"], text=True).split()
project_containers = json.loads(subprocess.check_output(["docker", "inspect", *project_ids], text=True)) if project_ids else []
intended_ids = {c.get("Id") for c in agent + (seeders if claude_login and not seed_bad else [])}
other_bad = []
for container in project_containers:
    if container.get("Id") not in intended_ids:
        other_bad.extend(sidecar_login_problems(container.get("Mounts", []), project, expected_source, session_source, app_source))
check("I23", "no other project container receives Claude credential sources", not other_bad, other_bad)

# The probe runs in the Service namespace, not on the macOS host across a VM boundary.
try:
    service = inspect("fake-service")[0]["Id"]
    probe = subprocess.run(["docker", "exec", "-i", "-e", f"CONF_API_KEY={api_key}", service,
                            "python3", "-", ingress],
                           input=Path(__file__).with_name("ingress_probe.py").read_text(),
                           capture_output=True, text=True, timeout=30)
    evidence = json.loads(probe.stdout)
    ok = probe.returncode == 0
except Exception as e:
    ok, evidence = False, repr(e)
check("I16", "Service socket: health 200, authenticated API 200, wrong/missing keys 401, private inode", ok, evidence)

print(json.dumps({"summary": {"total": len(CHECKS), "passed": sum(c["pass"] for c in CHECKS),
                              "failed": [c["id"] for c in CHECKS if not c["pass"]]}, "checks": CHECKS}, indent=1))
