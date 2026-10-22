# Restricted agent runtime

Least-privilege container runtime for one managed Hermes agent (first user: James's daily agent, "NPA").
It runs the stock Wizard Hermes image unmodified; all restriction comes from how it is run.

## What the agent gets

| | |
|---|---|
| Process | `hermes gateway run` as uid/gid 10000, PID 1 is `tini`. Never root: the image's s6 root bootstrap is skipped and `home-init` (no network, CHOWN/FOWNER/DAC_OVERRIDE only) does the one root task, owning the home. |
| Privileges | `cap_drop: ALL`, `no-new-privileges`, not privileged, no devices, private IPC/PID/UTS. |
| Filesystem | Read-only root. Writable: its home volume (`/opt/data`) and a 1 GB `/tmp` tmpfs. System skills read-only at `/opt/wizard-skills`. No host path, socket or secret mounted. |
| Network | Only `sandbox` (Docker `internal: true`: no route out, no DNS for outside names). Two sidecars sit on it. |
| Internet | Via `egress`: HTTPS CONNECT to port 443 of allowlisted hostnames only; no plain HTTP, IP literals, other ports, or names resolving to private/loopback/link-local/CGNAT addresses. |
| Agent Service | Via `edge`: requests with this agent's bearer token (checked against a sha256 the edge holds) to `/wizard/mcp` and `GET /wizard/v1/agent-context` only. Owner/identity headers are dropped, paths are strict (no `..`, `%`, `//`), one request per connection. Everything else is answered 401/403/400 at the edge. |
| Inbound | The service reaches the agent API through the edge relay published on host loopback (`AGENT_INGRESS_BIND`), with the agent's `API_SERVER_KEY`. |
| Limits | 4 GB memory (no swap), 2 CPUs, 512 pids, 8192 open files. Sidecars 128 MB / 0.5 CPU / 64 pids each. |

## Environment contract (set by the driver)

| Variable | Meaning |
|---|---|
| `AGENT_PROJECT` | Compose project, e.g. `agent-<id>` |
| `AGENT_HOME_VOLUME` | Named volume or absolute host dir for the agent home (default: project volume) |
| `AGENT_API_KEY` | The agent's inbound API key (its own; the service presents it) |
| `EDGE_TOKEN_SHA256` | sha256 hex of the agent's gateway token (`WIZARD_MCP_TOKEN` in the home `.env`) |
| `EDGE_UPSTREAM_HOST` / `EDGE_UPSTREAM_PORT` | The service's agent-only listener (VPS: the uplink gateway IP) |
| `AGENT_UPLINK_SUBNET` | Unique /28 per agent from 10.250.0.0/16 (outside Docker's default pools) (default `10.250.0.0/28`) |
| `AGENT_SANDBOX_SUBNET` | Unique /28 per agent from 10.251.0.0/16 for the agent-only network; the host has no address on it (default `10.251.0.0/28`) |
| `AGENT_INGRESS_BIND` | Host loopback address:port for inbound (default `127.0.0.1:18642`) |
| `EGRESS_DECLARED_TCP` | JSON list of exact `{alias,address,port,relay_port}` grants. Empty by default. Tailnet IPv4 only; unique simple lowercase aliases and relay ports; port 443 cannot bypass TLS policy. |
| `EGRESS_TCP_RELAY_HOST` | This agent's uplink gateway IPv4 (first host of its /28). Required only with declared TCP grants. |
| `EGRESS_ALLOWLIST_HOSTS` | Space-separated hostnames; `*.example.com` allows subdomains |
| `AGENT_MEM_LIMIT`, `AGENT_CPUS`, `AGENT_PIDS_LIMIT` | Resource overrides |

```sh
docker compose -f compose.yml -p agent-<id> up -d --build
```

## Conformance (acceptance test 6)

`conformance/run.sh <receipts-dir>` starts a disposable copy with an empty home and a stand-in Agent
Service, plants synthetic canaries (fake host-home file, fake SSH key, fake control-plane secret) on the
host and in the stand-in service, then runs `conformance/in_agent.py` inside the agent. Every probe goes
through Hermes' own tool dispatcher with its normal tools (`terminal`, `read_file`, `write_file`), with
Hermes' approval guard off so the container is what is tested. It also checks what Docker applied
(`inspect_check.py`). It runs three phases: fresh, after `restart`, after `down`/`up` with the home kept.
Expected result for each isolation item is denied; positive controls prove probes work. Receipts have
synthetic values redacted. Exit 0 only on full pass.

## Declared tailnet TCP (not the Private seal)

Disabled by default. The owner can grant individual alias/address/port entries to a restricted
non-private agent. For each entry the trusted host runs a fixed-destination relay, bound only to
this agent's uplink gateway and high `relay_port`. The relay invokes userspace Tailscale `nc` with
fixed argv for that one address/port; it does not parse a destination from the connection.
The agent holds neither the Tailscale socket nor a SOCKS proxy credential. It asks this egress
proxy for `CONNECT <alias>:<port>`; only the literal declared tuple is accepted. All other
non-443 targets (including numeric IPs, host SSH and other tailnet targets) remain refused.
The host must firewall relay access to the relevant /28, remove that rule and stop the relay on
agent teardown. The Service driver validates grants, supplies the per-agent gateway, and owns
host relay lifecycle separately. A declaration does not itself start a relay or edit the firewall.
Run `python3 conformance/test_declared_tcp.py` plus `conformance/egress_selftest.py` before image
packaging. Full container tests must also prove direct SSH is unreachable and refused CONNECT
requests never arrive at any upstream. This extension grants no permission to change a Private
agent's in-seal network or its provider relay.

## Network guarantees and residual risks
- The agent's network is `internal` with `inhibit_ipv4`: the host has no address on it, so the agent
  cannot open a connection to any host service (sshd, Agent Service, Docker API). Conformance N1/K2/D3
  scan every address of that /28 plus the usual host aliases.
- Egress tunnels only TLS whose SNI equals the vetted allowlisted host; raw bytes and SNI mismatches are
  closed (E9, E10). Residual: a client could still send a different HTTP `Host` inside a TLS session for
  an allowed SNI (domain fronting at a CDN that permits it). Closing that needs TLS interception, which
  this runtime deliberately does not do.
- The edge rejects header names that are not HTTP tokens and values with CR/LF/control characters (A12).
- The two sidecars are trusted components with uplink access. On the VPS, firewall the uplink range so
  they reach only the Agent Service listener (see `requests/C-runtime-driver.md` in the migration notes).
