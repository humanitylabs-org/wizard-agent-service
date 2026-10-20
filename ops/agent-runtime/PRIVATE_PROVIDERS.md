# Private provider runtime

Provider identity is the installed app id. `apps.json` entries containing `private_inference` populate
`/wizard/v1/agent-options`; models are fetched from each running app's `/api/connection`. Stopped apps
remain visible with `available: false`, an error, and no invented model list. Old `tinfoil`/`local`
records read as `wizard-tinfoil`/`wizard-local-model`; the next write persists the canonical id.

## Configuration

The runtime accepts `--apps-json <registry>` (default: the agents directory's sibling `apps.json`) and
`--client-image ghcr.io/humanitylabs-org/wizard-private-client:0.1.0`. The tag is a configurable
integration placeholder, not a claim that a published image exists. The client image contract is
port 3301, uid/gid 1000, PROFILE `tinfoil` or `passthrough`, RELAY_URL, RELAY_TOKEN_FILE and MODELS.
`--proxy-image` remains an alias; `--tinfoil-key-file` is accepted, logged as deprecated and never read.

Run the service as the owner, with access to the Docker daemon. As for the existing restricted runtime,
the Agent Service needs its agent-only listener (`WIZARD_AGENT_PORT`, default 8929) and the existing
`agent-firewall.sh` installed by the trusted box installer. Private-client policy additionally requires
rootful Docker's iptables DOCKER-USER hook and `br_netfilter` with
`net.bridge.bridge-nf-call-iptables=1`. Missing support fails before the client starts; there is no
unrestricted fallback. Loading kernel modules/changing host firewall policy is an installer action,
not something a provider app or the model can request.

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
- Client: sandbox + provider relay network, read-only rootfs/token mount, uid 1000, cap_drop ALL,
  no-new-privileges. Static client IPs let trusted host rules admit only Hermes -> client:3301 and
  client -> the provider's relay IP/port, plus established replies. Other peers/host destinations are
  denied. Docker resolves the relay alias; external DNS forwarding is directed to the client's own
  loopback (no external DNS server).
- Relay network: one internal IPv4 /24 from 10.252.0.0/16 per app, no host bridge address. Provider
  containers are located by their unique Compose service label and attached as `<app-id>-relay`.
  Unsafe existing networks, ambiguous containers, exhausted addresses and wrong mint origins fail closed.
- Mint: POST /api/private-clients with the agent id; validate token shape and the exact contracted relay
  URL. Bind a 0400 token file from `agents/<id>/runtime`, never from the Hermes-visible home. Rotation
  stops the old client first. Switch/delete revokes through the original saved control-plane origin;
  revocation failure is visible and retains the record for retry. DELETE retains the owner's home/history.
- Failures: provider status/connection failures reject new runs and starts without consulting public
  provider credentials. Hermes uses `provider: custom`, `api_key: none`, the client base URL and an empty
  fallback list. Provider keys never enter the runtime path; legacy Tinfoil key lines are stripped.

Private services deliberately have `restart: "no"`: after a host/Docker restart volatile host rules
must be rebuilt by the runtime before a client starts. Until then requests fail visibly. A future
boot reconciler must reapply policy *before* restoring running state; changing this to an unconditional
Docker restart policy would reopen the relay/peer exposure window.

## Required spec clarification

An undifferentiated `agent net: internal: true` is not the whole isolation contract. The safe topology is
an internal sandbox with **no host bridge IP**, a separate edge-only uplink for the gateway/API relay,
and a separate internal provider relay network for the client. `internal: true` alone does not prevent
container -> host connections. The client also needs stateful host FORWARD/INPUT rules: network
membership alone does not prevent provider/other-client peers from invoking its unauthenticated API.
The private subdriver bypasses Runtipi's shared-app networking rather than pretending its defaults are
isolated. The spec should name these prerequisites and the policy-before-restart requirement.

## Tests and boundaries

`npm test`; `uv run --with pytest python -m pytest ops/agent-runtime -q`.
Provider protocol tests use a real loopback HTTP server; Docker/network mutation is mocked in unit tests.
The existing agent authentication/permission tests use an explicitly stubbed installed provider and, for
private MCP calls, an explicitly simulated trusted edge. These are not attestation or live-Docker proof.

`test_agent_firewall.sh` and `test_private_client_firewall.sh` run only in a disposable privileged
`--network none` container. The latter requires the bridge-netfilter kernel feature even for its
routed-traffic test; a host without that feature must be repaired by its owner/installer or tested on
an isolated VM, not by weakening the preflight guard. No test should modify production firewall rules,
containers, systemd units or owner state.

Whole-system attestation/ciphertext capture, actual provider image integration, and provider-app egress
acceptance are separate gates. See PRIVATE_PROVIDER_EGRESS.md for the last gate.
