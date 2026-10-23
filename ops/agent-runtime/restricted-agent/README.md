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
| Internet | Via `egress`: HTTPS CONNECT, plus exact-host SNI TLS passthrough on port 443; no plain HTTP, IP literals, other ports, or names resolving to private/loopback/link-local/CGNAT addresses. |
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

## Claude app login grant

Load `compose.claude-login.yml` only for an independently owner-authorized record:
`runtime.isolation: restricted`, `privacy: standard`, `model.provider: anthropic`.
Private/unknown privacy and other providers must not inspect or mount this source.
The driver resolves the installed `wizard-claude-engine` container's exact `/claude`
mount through `claude_source.py`: legacy `wizard-ai-accounts-claude` named volume,
or the Claude app's compiled `data/claude` share bind. No grant-file values, ambient
credential overrides, invented provider login or HTTP token gateway are involved.
This is compatible with Store #19's `mounts: [{app: wizard-claude, share: claude-login,
path: /claude}]`: the login remains owned by that app in either storage form.

A no-network/root/ro-root `claude-init` mounts the **source directory read-only**
at `/claude-app` (not a single file, so atomic app rotation is visible). Its only
other mount is the per-agent local-driver **tmpfs** `claude-session`. Root has only
CHOWN/FOWNER/DAC_OVERRIDE to read uid1000 0700/0600 source files and publish a uid10000
0700/0600 projection. It never chowns/chmods/writes the source. Every two seconds
it projects only `accessToken`, real `expiresAt`, scopes and plan metadata: **never
refreshToken** or arbitrary CLI files. Logout, invalid login and expiry erase the
projection. Renewal belongs to the app's official Claude Code login/test/auto-renew
flow; the seeder has no network and no refresh chain. Consumers cannot co-refresh.

The agent mounts only the projection **read-only**, at `/run/claude-login`, with
`CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR` pointing there. No raw app mount or token
env reaches the agent, home-init, edge or egress; no credential is copied into the
home. The unchanged stock DirectSDK plugin uses the official Claude CLI, not a token
gateway. The seeder stays up to retain tmpfs and observes refresh/logout without
agent recreation. Missing login is healthy initialization with no credential, not
a restart loop; the Service reports `claude_login_missing` and clears it after a
connected login and apply/start. Missing/stopped app metadata omits the grant.
Stop the agent before seeder removal/home sync. Revocation removes stale seeders.

`inspect_check.py --claude-login` is independent authorization, never inferred from
a container env. `--claude-login-source volume:wizard-ai-accounts-claude` (default)
or `--claude-login-source bind:/srv/app-data/core/wizard-claude/data/claude` must
match the installed app metadata. I6 checks the RO per-agent tmpfs; I22 checks exact
RO app source and no-network seeder; I14 rejects gateway token env. I19/I20/I23
reject credentials at **any** destination in home-init, edge, egress and unknown
project containers, including volume backing paths. I21 retains exact SNI aliases.

`conformance/docker_credentials.py` uses **only synthetic app login fixtures** and
the real stock image, uid10000/cap-drop/ro-root. Ordinary terminal snapshot and
unmodified dispatcher cat -> AIAgent session/trajectory -> DB reopen must leave no
raw credential under `/opt/data` with the pinned `security.redact_secrets: true`.
Legacy-env and redaction-off controls must leak to prove sensitivity. Rotation,
logout/reconnect, source ownership/modes and refresh-chain exclusion are checked.
All Docker fixtures are labelled `claude-app-grant-test`, `--rm`, no-network, with
finally cleanup and label-filtered absence verification. No live login is used.

This grants an app-wide access credential to a trusted restricted standard agent,
not an enclave or per-agent provider identity. Deliberate encoded copying or disabling
stock redaction can still persist the credential. Revoke access in the app/owner
record; Docker administrators, host swap and stale in-flight native sessions remain
outside this boundary. Nonrestricted legacy consumers still mount the full login RW
and can refresh via the native CLI; sole-refresh ownership is enforced by **this
restricted path**, not retroactively claimed for every existing consumer.

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
The socket ingress migration is independent of this egress path: provider aliases still target
only egress on sandbox, which alone has the uplink; edge uses its own mounted Unix sockets
and has no published TCP ports. Neither alias renderer nor SNI policy routes through edge.
The CONNECT listener remains on 3128. Both share a 64-connection cap, 300s idle/drain timeout and
64 KiB ClientHello cap (10s total handshake deadline). No port is published; binding 443 as uid 65534 uses a namespaced unprivileged
port sysctl, not an added capability. No Statsig, telemetry, interactive login or download hosts added.

For custom `EGRESS_PASSTHROUGH_HOSTS`, render `python3 passthrough.py > aliases.yml` and pass
`-f aliases.yml` **after** `-f compose.yml`. Compose 2.24.4+ `!override` replaces aliases rather than
merging them. The Service does this automatically. Each custom host must also be in
`EGRESS_ALLOWLIST_HOSTS`; alias/allowlist mismatch fails closed. Both renderer and runtime reject
single-label/reserved service names (`agent`, `edge`, `egress`, `localhost`, `agent-service-host`),
invalid DNS labels and special-use local/reserved suffixes. Names must be multi-label public DNS
syntax; resolved destinations must still independently be globally routable. The renderer contains no credentials.

Focused checks: `conformance/test_claude_login.py` (Compose rendering), `test_passthrough.py`
(parser/fuzz/DNS/bounds/redaction), `test_claude_seed.py`, `egress_selftest.py`, and `inspect_check.py --selftest`.
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
- Edge has sandbox only and only its own Service socket mounted. Egress retains ordinary uplink access but
  has no sockets or host privileges; its CONNECT gate refuses host/private destinations. No host firewall install.
- See `docs/restricted-agent-runtime.md` in the Service repository for path/uid requirements, Colima/Lima
  same-kernel constraints and migration from the legacy optional firewall. Compose v2.24.4+ is needed for
  test overlays using `!override`. `test_agent_sockets.sh` runs socket/host-port conformance against the real
  Service modules, including socket identity mismatch, missing foreign mount, inbound socket health/authentication, wrong-key refusal and zero published agent/edge ports.
