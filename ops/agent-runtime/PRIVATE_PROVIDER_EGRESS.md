# Provider-app declared-host egress

This is a separate security boundary from the in-seal client's stateful firewall.
The Agent Service runtime owns both provider relay and egress networks, plus one
small system edge per provider app. The main agent can live in its own container;
neither it nor the provider process needs host networking or firewall privileges.

## Topology and enforcement

- `wizard-relay-<app>`: existing internal/no-host-address relay network, /24 from
  `10.252.0.0/16`. Clients and the selected provider only. Client policy remains
  enforced by the separate stateful client firewall, not by network membership.
- `wizard-egress-<app>`: runtime-owned internal bridge, IPv4-only /24 from
  `10.253.0.0/16`, `inhibit_ipv4=true`. Provider `.2`, system edge `.3`. No other peers.
- Provider: **only these two internal networks**, read-only, cap-drop ALL,
  no-new-privileges, external DNS directed to its own loopback (`dns: [127.0.0.1]`).
  Docker service-name DNS still works. No external interface, default internet
  route, host bridge address, IPv6, raw-socket capability or alternate DNS server.
- Nonempty `private_inference.egress`: `wizard-egress-proxy-<app>` is the sole
  externally attached system helper. Its CONNECT listener binds only its internal
  `.3:3128`; it is not published. The provider must use
  `HTTPS_PROXY=http://wizard-egress-proxy:3128`, with no bypass/other proxy variables.
- Empty egress: **no CONNECT listener or proxy**. A provider with owner UI/control
  ports may have `wizard-provider-edge-<app>`, running fixed incoming TCP routes
  only; it cannot be used as an arbitrary outgoing tunnel. With no incoming ports,
  there is no system edge container at all.
- Owner/Agent Service access uses the same system helper's fixed TCP ingress routes,
  republishing only the provider's existing **host-loopback TCP ports**. Provider
  PortBindings become inert when it has internal networks only. Wildcard/public
  bindings, publishing the relay port and UDP mappings fail closed. HTTP is passed
  without parsing/logging or adding forwarding headers: existing app auth remains.
  There is **one external helper, not an independent second management uplink**.

The stdlib `provider-connect-proxy.py` accepts only `CONNECT exact.name:443`.
No wildcards, suffix rules, IP literals, URLs, noncanonical names/ports or plain
HTTP. It requires a TLS ClientHello whose SNI exactly equals the CONNECT hostname
before opening an upstream connection. It resolves the hostname itself, rejects
the complete DNS answer if any address is nonpublic (including local/metadata/
IPv4-mapped local IPv6), then connects to that numeric answer without re-resolving.
Thus shared CDN addresses, alternate SNI, DNS changes/rebinding and IP bypass are
not equivalent to an allowed hostname. TLS remains end-to-end, never decrypted.
Limits: 8 KiB CONNECT headers, 64 KiB hello, bounded forwarding buffers, idle and
absolute timeouts, 64 MiB/64 PID container limits. Logs contain only successfully
validated host/port decisions, never headers, URLs, tokens, bodies or errors.

## Runtime lifecycle / installer prerequisites

`PrivateProviders.network()` calls `ProviderEgress.reconcile()` before minting a
client token. Runtime startup also reconciles installed private providers before
accepting API calls; stopped Docker containers are discoverable by their unique
Compose service label. Registry `running` status is desired state; owner-stopped
registry rows are not automatically restarted. No automatic private-agent client
restart is added here: that still requires the separate client-firewall boot gate.

Reconciliation sets `restart: no` and **stops the provider first**, validates DNS,
proxy and hardening prerequisites, validates/creates the owned egress network,
refuses unknown network peers/name conflicts, replaces the small helper, removes
**every other provider interface**, pins endpoints, and starts the provider last.
Network read-back must equal exactly the two internal networks. Any failure leaves
the provider stopped, never falling back to ordinary app networking. Changing hosts
replaces the helper while the provider is stopped, closing existing tunnels. Docker
restarts cannot bring an unguarded provider/helper back before reconciliation.

Installers must:

1. Build the reviewed system helper before starting this runtime:
   `docker build -t wizard-provider-egress:local -f ops/agent-runtime/Dockerfile.provider-egress ops/agent-runtime`.
   The base image is digest-pinned and there are no downloaded dependencies. This
   integration tag is not a claim of a published production image; production
   packaging must publish/pin its reviewed digest with the runtime release.
2. Ship provider images with explicit proxy support; environment variables alone
   are insufficient. Set the hardening/DNS/proxy properties above. Local providers
   must have no proxy env. Seed local model weights separately: offline inference
   never gets a temporary download exception or undeclared Hugging Face egress.
3. Start providers on an internal/no-host-address bootstrap network, never an
   ordinary shared app network. The updated Tinfoil recipe does this; it is initially
   offline/unreachable until runtime reconciliation establishes the narrow edge.
   The runtime removes bootstrap attachment when linking.
4. Publish owner ports only on host loopback in the effective install config and
   expose relay port only internally. The app's registry `view.local` must name
   that loopback origin. This lane intentionally refuses a public legacy binding
   rather than silently changing who can reach key-save/control routes.
5. After app recreation/update, invoke runtime reconciliation before exposing it
   or starting an agent. Do not have WAM/Compose reattach shared networks or apply
   an unconditional restart policy. This lane supplies the bootstrap recipe and
   runtime hooks, **not a change to the App Manager's installer lifecycle**. A fresh
   final-box integration test remains necessary for its generated effective config.

No host firewall, sysctl, kernel-module, live container, unit or owner-data change
is required to run the disposable proof. Migrating an actual legacy deployment
is an explicit installer/release action, not something these tests perform.

## Tinfoil outbound-stack audit

The provider fork's relay `http.client.HTTPSConnection` originally ignored proxy
environment variables. `upstream_connection()` now explicitly creates the proxy
connection and calls `set_tunnel(target, 443)`; TLS verifies the target normally.

The decrypting main-port SDK uses pinned Python `tinfoil==0.14.0`. Its attestation
bundle HTTP uses `requests`, and Sigstore/TUF uses a requests-backed fetcher; both
honor HTTPS_PROXY. But its custom EHBP `httpx.HTTPTransport` does **not** inherit
that env. The proxy-enabled adapter subclasses pinned `SecureClient` solely to
supply `HTTPTransport(proxy=...)` to its official EHBP transport. Official SDK
bundle, enclave certificate, report, code provenance and HPKE verification remain
enabled; no offline trust bypass, measurement override or plaintext retry exists.
The no-proxy legacy code path remains the original `TinfoilAI` constructor.

The default `GET atc.tinfoil.sh/attestation` was observed to alternate between
`router-0.tinfoil.sh` and `inference.tinfoil.sh`. Allowlisting arbitrary router
suffixes would violate the contract. Instead the SDK pins `inference.tinfoil.sh`
and the encrypted relay's existing **client-facing GET /attestation** requests an
upstream **POST /attestation** with fixed `enclaveUrl=https://inference.tinfoil.sh`
and `repo=tinfoilsh/confidential-model-router`. This is an intentional internal
spec correction: same client route/auth/bodyless request; the bundle is still
verified by the actual PR #16 client's official offline verifier. No client
inference body is parsed, modified or decrypted by the relay.

Declared egress now has exactly three hosts:

- `atc.tinfoil.sh`: complete attestation bundle, for relay and key-save/Test SDK.
- `inference.tinfoil.sh`: attested inference and bodyless model catalogue.
- **`tuf-repo-cdn.sigstore.dev`**: Python Sigstore trust-root metadata/targets refresh,
  genuinely required by key-save/Test and the existing decrypting gateway. With
  only the first two hosts, a fresh SDK failed `TUFError: Failed to refresh TUF
  metadata` caused by CONNECT 403. Adding this one exact host fixed it. No other
  Sigstore, Rekor, Fulcio, AMD KDS or GitHub hosts were observed/required: the
  complete bundle supplies certificates/provenance. Never disable root refresh
  merely to shorten the manifest.

`dash.tinfoil.sh` is a human browser key-management link, not app egress. Static
UI assets are local. Legacy Hermes dashboard registration is a separate internal
control-plane integration; it can report `unavailable` under the sealed topology,
not get undeclared internet/host access. In-seal inference does not depend on it.
Connect/Test attest and list models but **do not authenticate the key** (upstream
models accepts invalid keys); `credentialVerified: false` after save is expected,
not a proxy failure. Only an authorized inference establishes the key works.

The Tinfoil recipe's registry image digest deliberately remains its previously
published image. Review/release must publish and re-pin the new source image;
no invented registry digest is provided here. Tests build actual PR #3 source.
Local provider packaging needs the same DNS/bootstrap/restart prerequisites;
no local-model recipe was silently modified in this lane.

## Reproducible verification

```sh
cd ops/agent-runtime
python3 -m unittest test_private_providers test_provider_egress -v
docker build -t pp-test-egress-proxy -f Dockerfile.provider-egress .
# In reviewed PR #3 / PR #16 checkouts respectively:
docker build -t pp-test-egress-tinfoil -f app/Dockerfile .
docker build -t pp-test-egress-client images/wizard-private-client
# Back in ops/agent-runtime (opt-in paid inference):
python3 prove_provider_egress.py --key-env /path/to/existing/tinfoil.env
docker image rm pp-test-egress-proxy pp-test-egress-tinfoil pp-test-egress-client
```

The runner uses only `pp-test-` resources. It exercises the **actual reconciler**,
not hand-built equivalent networks: allowed TLS to inference/ATC, forbidden host/
IP/v6 literal/port80/plain-HTTP, blocked direct IPv4/IPv6/host/DNS, reconcile/restart
with the same probes, local no-proxy, preserved owner health/key-save/private-token
routes through fixed ingress, and a real completion from the PR #16 image through
the PR #3 relay behind the proxy. It additionally exercises the Python SDK's
existing decrypting EHBP path, and checks no probe codeword in app data/logs or
proxy logs. It saves the key only through the app's route into isolated **tmpfs**;
no host secret copy, Docker env/argv key, provider key in client, or emitted key.
All containers/networks are removed in `finally`; image cleanup is explicit.

Full fresh-final-box/Hermes/installer and client firewall/ciphertext capture proofs
remain distinct acceptance gates. This provider egress proof does not substitute
for those other security boundaries.
