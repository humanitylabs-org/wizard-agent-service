# Private provider runtime

Provider identity is the installed app id. `apps.json` entries containing `private_inference` populate
`/wizard/v1/agent-options`; models are fetched from each running app's `/api/connection`. Stopped apps
remain visible with `available: false`, an error, and no invented model list. `migrateProvider` maps
`tinfoil`/`local` aliases to `wizard-tinfoil`/`wizard-local-model` for catalogue comparisons; unknown IDs
remain unchanged. Legacy records retain their raw provider and transport until an explicit owner migration.

## Compatibility and migration (pp-mergeable)

With no provider app, legacy Tinfoil agents retain their TCP runtime and attestation sidecar, and local
agents retain `WIZARD_LOCAL_MODEL_URL` / `WIZARD_LOCAL_MODEL_KEY`. Listing, chat and start never infer a
migration from privacy or app installation. Main's `tests/legacy-private-compat.test.ts` is unchanged.

To opt in, the owner PATCHes `/wizard/v1/agents/<id>` with `{"migrate_private_provider":true}`. The provider
must be installed, running, declare a valid `private_inference` relay capability, and respond healthy with
the selected model. The explicit migration preserves recorded non-root uid/gid (or asks the trusted runtime
to resolve the existing numeric container identity and home mount); unknown/root identities fail closed.
Managed files move to `managed/`; the existing home/history are retained, not recursively reassigned.
New agents selecting a canonical installed provider opt into the sealed route at creation.

`runtime.private_client` is the per-agent seal marker. Once set, provider removal/health failure produces
HTTP 503 `private_provider_unavailable` and an explicit error status; there is no legacy/plaintext fallback.
The sealed edge uses main's per-agent Unix gateway and ingress sockets, not a reintroduced TCP listener.
The #105 vision helper uses the agent's own Tinfoil route for both legacy and migrated agents; sealed configs
contain no provider key or key environment reference. No live migration is performed by this PR.

## Configuration

The runtime accepts `--apps-json <registry>` (default: the agents directory's sibling `apps.json`) and
`--client-image ghcr.io/humanitylabs-org/wizard-private-client:0.1.0`. The tag is a configurable
integration placeholder, not a claim that a published image exists. The client image contract is
port 3301, uid/gid 1000, PROFILE `tinfoil` or `passthrough`, RELAY_URL, RELAY_TOKEN_FILE and MODELS.
`--proxy-image` and `--tinfoil-key-file` retain main's legacy meaning and are never read for migrated agents;
`--client-image` configures the separate sealed client image.

Run the service as the owner, with access to the Docker daemon. As for the existing restricted runtime,
the Agent Service needs its agent-only listener (`WIZARD_AGENT_PORT`, default 8929) and the existing
`agent-firewall.sh` installed by the trusted box installer. This unchanged host-INPUT
policy does not depend on bridge netfilter. Private-agent peer isolation uses
per-agent internal networks and address-bound listeners: no module, bridge sysctl,
private-client firewall helper, or owner sudo action is required.

## Isolation and lifecycle

Both the Runtipi and plain-compose entry points dispatch private-inference agents to the same sealed
Compose subdriver. They must not let Runtipi attach Hermes or its client to the shared application
network. On an explicit apply/start, an old WAM-managed agent project is stopped before the sealed
project starts. Non-private agents retain their original driver. The `compose_doc` generator supports
both main-service naming conventions. The vendored restricted runtime and its SOURCE.txt hashes are
not edited.

- Hermes: only the per-agent internal sandbox, bridge `inhibit_ipv4=true`; no published API port,
  provider key, egress proxy, shared app network or internet route. A non-root uid owns only its home.
- Edge: sandbox + uplink, gateway-token hash and a fixed gateway API allowlist; publishes only the
  inbound API relay on host loopback. Restricted-mode home syncing remains unchanged. Owner-managed
  homes retain their existing uid and share/upload behavior rather than silently changing permissions.
- Client: per-agent sandbox + per-agent relay, read-only rootfs/token mount, uid 1000,
  cap_drop ALL, no-new-privileges. API listens on the sandbox IP only via LISTEN_HOST;
  provider peers cannot open the plaintext API. External DNS forwards only to loopback.
- Relay: one internal IPv4 /24 from 10.252.0.0/16 **per agent**, no host bridge address,
  named wzpr-<agent-hash>. Exactly that client and its provider container; the provider
  joins one such network per link as `<app-id>-relay`. Ownership, subnet, IPv4 inhibit,
  alias and exact allowed peers are validated; unsafe networks fail closed.
  Tinfoil binds its management server only to the egress interface, so its non-relay
  ports and token-mint route are not exposed to relay clients.
- Mint: POST /api/private-clients with the agent id; validate token shape and the exact contracted relay
  URL. Bind a 0400 token file from `agents/<id>/runtime`, never from the Hermes-visible home. Rotation
  stops the old client first. Switch/delete revokes through the original saved control-plane origin;
  revocation failure is visible and retains the record for retry. DELETE retains the owner's home/history.
- Failures: provider status/connection failures reject new runs and starts without consulting public
  provider credentials. Hermes uses `provider: custom`, `api_key: none`, the client base URL and an empty
  fallback list. Provider keys never enter the runtime path; legacy Tinfoil key lines are stripped.

Private services have `restart: "no"`; startup reconciles provider topology, retains
all valid linked networks and removes orphaned owned per-agent networks before
admission. Unlink/revoke disconnects the provider and removes that agent's network.
Private agents restart only through the trusted runtime, never an unrestricted fallback.

## Tests and boundaries

`npm test`; `uv run --with pytest python -m pytest ops/agent-runtime -q`.
Provider protocol tests use a real loopback HTTP server; Docker/network mutation is mocked in unit tests.
The existing agent authentication/permission tests use an explicitly stubbed installed provider and, for
private MCP calls, an explicitly simulated trusted edge. These are not attestation or live-Docker proof.

`test_agent_firewall.sh` runs only in a disposable privileged `--network none`
container. No test modifies production firewall rules, containers, units or owner state.
Peer/ciphertext acceptance uses two real agents on the disposable Thales rig with
br_netfilter absent; see PRIVATE_PROVIDER_EGRESS.md.

Whole-system attestation/ciphertext capture, actual provider image integration, and provider-app egress
acceptance are separate gates. Provider-app egress now has its own runtime-owned CONNECT/system-edge implementation and disposable Docker + real Tinfoil/client proof; see PRIVATE_PROVIDER_EGRESS.md for topology, installer prerequisites and remaining final-box integration gates.
