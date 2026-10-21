# Restricted agent runtime

Set `WIZARD_AGENT_ISOLATION=restricted` to create new agents in
`ops/agent-runtime/restricted-agent/`. Existing restricted agents use the same socket transport after
migration; other existing agents keep their runtime. `SOURCE.txt` records the upstream base and the
local socket adaptation's integrity digests. Old TCP conformance receipts are historical, not socket evidence.

## Service gateway: no privileged install

The Service creates `agents/<id>/gateway/gateway.sock` under its data directory (`WIZARD_AGENTS_DIR`,
else `$WIZARD_OS_HOME/agents`). The dedicated `gateway` directory is owned by the unprivileged Service
user, mode **0700**; its Unix socket is **0600**. No key, home, parent agents directory, Docker socket or
other agent's socket is mounted in edge. Edge runs as that same numeric uid/gid and mounts only its own
`gateway` directory read-write at `/run/agent-gateway`. The directory, rather than a single socket inode,
is mounted so a Service restart can replace its socket without recreating the edge container.

Every request needs both the agent's gateway token and the identity of the receiving socket. A token
for B on A's socket fails with `403 principal.agent_socket`, regardless of headers or peer IP. Socket
requests never accept owner proof or anonymous/loopback ownership. Only `/wizard/mcp` and
`GET /wizard/v1/agent-context` are served. Restricted tokens are refused on all TCP listeners.

`WIZARD_AGENT_PORT` and `WIZARD_AGENT_HOST` are **removed**, not a compatibility flag. Setting either
refuses startup before binding any port. There is no TCP agent-only listener, iptables call, sudo call,
root installer or firewall prerequisite. The main owner-facing listener and the loopback inbound agent
API relay are unchanged; keep the normal owner authentication/proxy configuration for those surfaces.

The Service opens sockets for stored restricted agents before accepting owner HTTP traffic and opens
new ones before asking the runtime helper to start Docker. The helper requires private, correctly owned
socket files and fails closed with `agent_socket_not_ready` if they are missing/unsafe. The Service and
runtime helper must run as the same unprivileged numeric uid/gid. Live sockets are never unlinked by
another instance; dead-process sockets can be recovered. A symlink, non-socket file or overly long Unix
socket pathname refuses startup. Keep the data path short (socket path at most 103 bytes).

## Docker / VM path requirement

Unix sockets must be in **the Docker daemon's Linux kernel** and the directory must be bind-mountable
by that daemon. Linux Docker on a VPS and the Linux guest in the Windows VM satisfy this when the
Service and helper run there. For a containerized Service, expose the same per-agent data root to the
trusted runtime helper/daemon with matching absolute paths and uid/gid.

Colima/Lima normally shares only `$HOME`. A host directory outside its configured shares cannot be
bind-mounted: choose a shared data directory or explicitly configure a share before running the Service.
A Mac-native Unix socket does **not** become connectable inside Linux merely because virtiofs/SSHFS
shows the file. Run the Service and runtime helper inside the Colima/Lima Linux VM (on a daemon-local
data path), or run the Service in a Linux container with appropriately shared Linux storage. Do not add a
TCP fallback. Conformance uses Docker named volumes for socket transport and streams source into
containers, so it works even when the host checkout is outside Colima's shares.

## Networks and ports

- Each agent retains its allocated /28 uplink (`10.250.0.0/16`) and sandbox (`10.251.0.0/16`). Index 0 is
  reserved for conformance; the first managed agent gets `.16/28`. Allocation is stored privately in
  `agent.json`; it is no longer an authentication authority.
- Agent and edge attach **only** to the internal sandbox with `inhibit_ipv4`; the host has no address
  on it. Edge has no host-gateway alias and no uplink. Its only Service transport is its own Unix socket.
- Egress is unchanged: sandbox + ordinary Docker uplink, HTTPS CONNECT with DNS/IP/SNI checks. It has
  no sockets, secrets, published ports or privileged host access. Like any ordinary app container on a
  bridge, egress itself may reach host addresses; the agent cannot use it to tunnel to private/host IPs.
  This is not a promise to isolate arbitrary code execution in the trusted egress sidecar from the host.
- The inbound API relay stays published on host loopback, authenticated by the agent's API key.

## Existing installations / legacy firewall

Migration is an explicit maintenance action, **not** something this source change does to a running box:

1. Stop restricted agent projects using the old runtime. Leave any installed firewall guard in place.
2. Update Service and runtime-helper source together; remove `WIZARD_AGENT_PORT`, `WIZARD_AGENT_HOST`
   and the helper's retired `--agent-listener-port` argument from deployment configuration. Keep owner
   proof/proxy authentication. Arrange the shared Linux socket path and matching user as above.
3. Start the Service, then recreate each restricted project with the new Compose (not just `restart`):
   it must lose edge's uplink/host-gateway alias and gain only that agent's dedicated socket mount.
4. Verify socket conformance, correct agent attribution and the absence of a TCP 8929 listener. Preserve
   old receipts; do not treat them as proof for the new runtime.
5. Only after **all** old restricted containers/listeners are gone, the administrator may optionally disable
   `wizard-agent-firewall.service` and run the legacy script's `remove` operation. Stopping that legacy
   unit alone deliberately leaves its rules installed. Leaving the guard installed is harmless and safer
   during a mixed-version migration; never remove it automatically from an installer or Service startup.

`ops/agent-runtime/agent-firewall.sh`, its unit and `test_agent_firewall.sh` remain for legacy/optional
operation only. New installations do not install/run them. This PR does not change any running firewall.

## Agent home contract

| | |
|---|---|
| Host path | `$WIZARD_OS_HOME/agents/<id>/home` |
| Container path | `/opt/data` (`HOME` and `HERMES_HOME`) |
| Owner | uid:gid `10000:10000`, mode `0700` |
| Managed files | `.env` and `config.yaml` staged by Service in `agents/<id>/managed/` |

`RestrictedDriver.sync_home` stops the agent and copies managed files using a one-shot, no-network,
read-only-root container with CHOWN/FOWNER/DAC_OVERRIDE only. It writes into a fresh temporary directory
and renames files to replace symlinks/FIFOs rather than follow them. Timeout removes the helper and
reports `504 agent_sync_timeout`. Lifecycle locks are per restricted agent; legacy drivers retain one
shared lock. Imports must run as uid 10000 inside the agent container. Shares still report
`409 agent_unavailable` until in-container placement exists.

The restricted runtime has no Tinfoil attestation sidecar. Tinfoil restricted agents remain refused with
`409 restricted_provider_unsupported`; private agents need a confidential provider or local model.

## Verification

`conformance/run.sh <receipts-dir>` covers the real Hermes dispatcher, mount/network checks, socket
visibility and host-port denial across fresh/restart/recreate phases. `test_agent_sockets.sh` is the
unprivileged transport/isolation replacement for the old privileged firewall test. Run both on a disposable
Docker host; never against live agent data. `tests/agent-sockets.test.ts` and `agent-principals.test.ts`
exercise real Node Unix HTTP listeners, credential/socket mismatch and the owner/TCP boundary.
