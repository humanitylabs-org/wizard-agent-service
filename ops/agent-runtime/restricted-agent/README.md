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
| `EGRESS_ALLOWLIST_HOSTS` | Space-separated hostnames; `*.example.com` allows subdomains |
| `AGENT_MEM_LIMIT`, `AGENT_CPUS`, `AGENT_PIDS_LIMIT` | Resource overrides |

```sh
docker compose -f compose.yml -p agent-<id> up -d --build
```

## Optional box Claude login grant

The trusted driver may add `-f compose.claude-login.yml` **only** when the agent record has
`privacy: standard` and `model.provider: anthropic`. Missing/unknown privacy does not grant access.
Private agents and other providers use the base compose file only. Never infer authorization from an
agent-controlled environment variable, label, or a volume already present on the host.

This override mounts the external `wizard-ai-accounts-claude` volume **only in `agent`**, at `/claude`,
and sets `CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR=/claude`. Neither `home-init`, `edge`, nor `egress`
gets the login. The base runtime remains credential-free. The grant intentionally gives this agent
access to the box Claude account and all data in that login directory; it is not a per-agent token.

**Read-write, not read-only:** Claude Code refreshes single-use OAuth tokens and atomically replaces
its credential file. A read-only mount can consume a refresh token without persisting its successor.
The directory and credential files must therefore be privately owned by uid 10000, and **every writer
of this shared login, including the Claude app, must run as the same uid**. A one-time chmod/group/ACL
workaround is not sufficient: a writer replacing a file with mode 0600 can lock the other uid out.
Do not relax modes, add capabilities, run the restricted agent as root/uid 1000, copy credentials into
its home, or chown the live shared volume automatically. The Service driver checks compatibility
before stopping an existing agent, returns `claude_login_permissions` on failure, and does not migrate
the provider's ownership. Provisioning/migrating all login writers needs a separate approved rollout.
A missing external volume returns `claude_login_missing`; it is never created by the preflight.

The override adds only `platform.claude.com` to default egress for token refresh. Evidence: the shipped
Claude Code binary uses `https://platform.claude.com/v1/oauth/token`; the official
[network requirements](https://code.claude.com/docs/en/network-config) list this host for refresh.
`api.anthropic.com` was already allowed for inference. No need to allow `claude.ai` (interactive login),
`console.anthropic.com` (not used by this installed CLI), Statsig, telemetry, or download hosts. The
DirectSDK plugin disables nonessential traffic. A trusted `EGRESS_ALLOWLIST_HOSTS` override still
replaces the default and must include the refresh host if this grant is used.

For outside-in checks, pass `--claude-login` to `inspect_check.py` only after independently verifying
the owner grant. I6 rejects the login by default, or a wrong source/type/mode/duplicate even when
granted. I14 requires the matching config environment; I19 and I20 deny login mounts in helpers and
sidecars. Never derive the expected grant from the inspected container itself.

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
- The two sidecars are trusted components with uplink access. On the VPS, firewall the uplink range so
  they reach only the Agent Service listener (see `requests/C-runtime-driver.md` in the migration notes).
