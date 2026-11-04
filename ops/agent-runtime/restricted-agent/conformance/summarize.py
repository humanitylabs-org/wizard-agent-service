#!/usr/bin/env python3
"""Summaries for conformance receipts.
  summarize.py phase <dir> <phase>    print one phase's result
  summarize.py final <dir> <canary>   write summary.json, print RESULT PASS|FAIL (exit 1 on FAIL)

The final verdict runs BEFORE redaction and requires, for every phase: all in-agent and inspect checks
passed, and the stand-in service saw only agent routes, each with a bearer token and no identity
headers, including the A0 positive control; and the gates logged the refusals the agent saw (E9, E10,
A12). It also requires the inspect and egress self-tests to pass, a clean
teardown, and the canary in no receipt file of any kind."""
import glob
import json
import os
import re
import sys

PHASES = ("initial", "restart", "recreate")
AGENT_ROUTES = [("GET", re.compile(r"/wizard/v1/agent-context")), ("GET", re.compile(r"/wizard/mcp/?")),
                ("POST", re.compile(r"/wizard/mcp/?")), ("DELETE", re.compile(r"/wizard/mcp/?"))]
IDENTITY = re.compile(r"^(x-wizard-|tailscale-|x-forwarded-|forwarded$|cookie$|x-real-ip$)")

mode, out = sys.argv[1], sys.argv[2]


def load(name):
    with open(os.path.join(out, name)) as fh:
        return json.load(fh)


def backend(phase):
    path = os.path.join(out, f"{phase}-service-requests.jsonl")
    if not os.path.exists(path):
        return {"ok": False, "requests": 0, "problems": ["no request log captured"]}
    reqs = [json.loads(line) for line in open(path) if line.strip()]
    problems = []
    for r in reqs:
        route = r["path"].split("?", 1)[0]
        if not any(r["method"] == m and rx.fullmatch(route) for m, rx in AGENT_ROUTES):
            problems.append(f"non-agent route reached the service: {r['method']} {r['path']}")
        if not str(r["headers"].get("authorization", "")).startswith("Bearer "):
            problems.append(f"request without bearer token: {r['method']} {r['path']}")
        bad = [h for h in r["headers"] if IDENTITY.match(h)]
        if bad:
            problems.append(f"identity headers reached the service: {bad}")
    if not reqs:
        problems.append("positive control A0 never reached the service")
    return {"ok": not problems, "requests": len(reqs), "problems": problems}


def gate(phase):
    """The phase's in-agent refusals must be attributable to the gates themselves: egress logged both
    tunnel refusals (E9 TLS for an unlisted SNI, E10 non-TLS) and the edge logged the bad header (A12)."""
    path = os.path.join(out, f"{phase}-gate-logs.txt")
    events = []
    for line in open(path) if os.path.exists(path) else []:
        line = line[line.find("{"):].strip()
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    tunnel = [e for e in events if e.get("reason") == "tunnel is not TLS for the vetted host"]
    want = {"E9 SNI mismatch": any(e.get("tls") is True and e.get("sni") == "example.com" for e in tunnel),
            "E10 non-TLS": any(e.get("tls") is False for e in tunnel),
            "A12 bad header": any(e.get("reason") == "bad header" for e in events)}
    return {"ok": all(want.values()), "seen": want, "events": len(events)}


if mode == "phase":
    name = sys.argv[3]
    a, b, c = load(f"{name}.json"), load(f"{name}-inspect.json"), backend(name)
    print(f"  in-agent {a['summary']['passed']}/{a['summary']['total']} failed={a['summary']['failed']}")
    print(f"  inspect  {b['summary']['passed']}/{b['summary']['total']} failed={b['summary']['failed']}")
    print(f"  service  requests={c['requests']} ok={c['ok']} {c['problems'][:3]}")
    g = gate(name)
    print(f"  gates    ok={g['ok']} {g['seen']}")
    sys.exit(0)

canary = sys.argv[3]
phases = {}
for name in PHASES:
    a, b = load(f"{name}.json"), load(f"{name}-inspect.json")
    phases[name] = {"in_agent": a["summary"], "inspect": b["summary"], "service": backend(name), "gates": gate(name)}
selftest = load("inspect-selftest.json")["summary"]
egress_selftest = load("egress-selftest.json")["summary"]
teardown = load("teardown.json")
leaks = sorted(os.path.basename(p) for p in glob.glob(os.path.join(out, "*"))
               if os.path.isfile(p) and canary in open(p, errors="replace").read())
ok = (not leaks and not selftest["failed"] and not egress_selftest["failed"] and teardown["clean"]
      and all(not p["in_agent"]["failed"] and not p["inspect"]["failed"] and p["service"]["ok"] and p["gates"]["ok"]
              for p in phases.values()))
with open(os.path.join(out, "summary.json"), "w") as fh:
    json.dump({"result": "PASS" if ok else "FAIL", "canary_in_receipts": leaks, "inspect_selftest": selftest, "egress_selftest": egress_selftest,
               "teardown": teardown, "phases": phases}, fh, indent=1)
print("selftest", f"{selftest['passed']}/{selftest['total']}", "egress", f"{egress_selftest['passed']}/{egress_selftest['total']}", "teardown clean" if teardown["clean"] else teardown,
      "leaks", leaks)
print("RESULT", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
