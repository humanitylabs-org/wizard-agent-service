# Restricted agent runtime

Least-privilege container runtime for one managed Hermes agent.
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
| Inbound | The Service reaches the agent API over private `/run/agent-gateway/ingress.sock` (0600, same uid); edge relays to `agent:8642` on sandbox with the agent's `API_SERVER_KEY`. No published TCP port. |
| Limits | 4 GB memory (no swap), 2 CPUs, 512 pids, 8192 open files. Sidecars 128 MB / 0.5 CPU / 64 pids each. |

## Environment contract (set by the driver)

| Variable | Meaning |
|---|---|
| `AGENT_PROJECT` | Compose project, e.g. `agent-<id>` |
| `AGENT_HOME_VOLUME` | Named volume or absolute host dir for the agent home (default: project volume) |
| `AGENT_API_KEY` | The agent's inbound API key (its own; the service presents it) |
| `EDGE_TOKEN_SHA256` | sha256 hex of the agent's gateway token (`WIZARD_MCP_TOKEN` in the home `.env`) |
| `AGENT_GATEWAY_DIR` | Dedicated per-agent gateway directory containing `gateway.sock` (daemon-visible Linux storage) |
| `AGENT_EDGE_UID` / `AGENT_EDGE_GID` | Numeric unprivileged Service owner; edge runs as this identity |
| `AGENT_UPLINK_SUBNET` | Unique /28 per agent from 10.250.0.0/16 (outside Docker's default pools) (default `10.250.0.0/28`) |
| `AGENT_SANDBOX_SUBNET` | Unique /28 per agent from 10.251.0.0/16 for the agent-only network; the host has no address on it (default `10.251.0.0/28`) |
| `EDGE_INGRESS_SOCKET` | Private inbound Unix socket (Compose sets `/run/agent-gateway/ingress.sock`); `AGENT_INGRESS_BIND` is retired |
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

## Network guarantees and residual risks
- The agent's network is `internal` with `inhibit_ipv4`: the host has no address on it, so the agent
  cannot open a connection to any host service (sshd, Agent Service, Docker API). Conformance N1/K2/D3
  scan every address of that /28 plus the usual host aliases.
- Egress tunnels only TLS whose SNI equals the vetted allowlisted host; raw bytes and SNI mismatches are
  closed (E9, E10). Residual: a client could still send a different HTTP `Host` inside a TLS session for
  an allowed SNI (domain fronting at a CDN that permits it). Closing that needs TLS interception, which
  this runtime deliberately does not do.
- The edge rejects header names that are not HTTP tokens and values with CR/LF/control characters (A12).
- Edge has sandbox only and only its own Service socket mounted. Egress retains ordinary uplink access but
  has no sockets or host privileges; its CONNECT gate refuses host/private destinations. No host firewall install.
- See `docs/restricted-agent-runtime.md` in the Service repository for path/uid requirements, Colima/Lima
  same-kernel constraints and migration from the legacy optional firewall. Compose v2.24.4+ is needed for
  test overlays using `!override`. `test_agent_sockets.sh` runs socket/host-port conformance against the real
  Service modules, including socket identity mismatch, missing foreign mount, inbound socket health/authentication, wrong-key refusal and zero published agent/edge ports.
