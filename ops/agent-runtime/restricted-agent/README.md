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
| Internet | Via `egress`: HTTPS CONNECT, plus exact-host SNI TLS passthrough on port 443; no plain HTTP, IP literals, other ports, or names resolving to private/loopback/link-local/CGNAT addresses. |
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

## Per-agent Claude token grant

The trusted driver loads `compose.claude-token.yml` only for owner-managed records with
`privacy: standard`, `model.provider: anthropic`, and an agent-scoped `claude.token` secret.
It passes that secret only as `CLAUDE_CODE_OAUTH_TOKEN` in `agent`. This is the long-lived
`claude setup-token` token supported by the unmodified DirectSDK plugin, not shared refresh state.
No shared login directory is mounted, no refresh file is written, and uid 10000 stays unchanged.
Private/unknown privacy and other providers receive no token, including from the helper's ambient env.
The shared-volume override has been removed: uid-1000 0700/0600 writers are incompatible with uid 10000.
Missing tokens do not prevent startup: the helper reports `claude_token_missing` without restart loops.

`inspect_check.py --claude-token` is an independent owner grant, never inferred from container env.
I14 rejects absent/empty/ungranted token env; helpers/sidecars must never receive it. Receipts scrub
Claude env values in `redact.py`; `in_agent.py` removes the token before importing tools/snapshotting env.
Do not print `docker compose config`, raw inspect, or helper env in production. Docker administrators
can still inspect container env; the agent intentionally has its own model credential.

## Direct TLS passthrough

The unchanged DirectSDK admission relay uses `http.client.HTTPSConnection`, ignoring HTTPS_PROXY.
Egress now also listens on sandbox port 443; Docker aliases for **exactly** `api.anthropic.com` and
`platform.claude.com` route those names to its sandbox IP. It reassembles a bounded ClientHello,
requires a valid SNI in both `EGRESS_PASSTHROUGH_HOSTS` and the independently declared aliases and
allowlist, and verifies that Docker DNS maps it to the receiving interface. Missing SNI, ECH,
IP literals, malformed/oversized hellos, and mismatched names are refused before upstream connect.
It resolves the real upstream with explicit public IPv4 DNS resolvers (`EGRESS_UPSTREAM_DNS`, default
`1.1.1.1 8.8.8.8`) over its uplink, **never Docker alias DNS**, vets all returned addresses as public,
then splices TCP. TLS/certificates remain end-to-end; there is no plaintext proxy or MITM on 443.
The CONNECT listener remains on 3128. Both share a 64-connection cap, 300s idle/drain timeout and
64 KiB ClientHello cap (10s total handshake deadline). No port is published; binding 443 as uid 65534 uses a namespaced unprivileged
port sysctl, not an added capability. No Statsig, telemetry, interactive login or download hosts added.

For custom `EGRESS_PASSTHROUGH_HOSTS`, render `python3 passthrough.py > aliases.yml` and pass
`-f aliases.yml` **after** `-f compose.yml`. Compose 2.24.4+ `!override` replaces aliases rather than
merging them. The Service does this automatically. Each custom host must also be in
`EGRESS_ALLOWLIST_HOSTS`; alias/allowlist mismatch fails closed. The renderer contains no credentials.

Focused checks: `conformance/test_claude_login.py` (Compose rendering), `test_passthrough.py`
(parser/fuzz/DNS/bounds/redaction), `egress_selftest.py`, and `inspect_check.py --selftest`.
`conformance/docker_passthrough.py` uses labelled, disposable --rm containers/networks with an internal
sandbox, real getent/DNS comparison, certificate-validating credential-free HTTPS GET (any status),
and a distinctive TLS access-denied alert for example.com SNI aimed at egress:443. Cleanup is in finally.

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
