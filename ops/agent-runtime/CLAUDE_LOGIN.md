# Restricted agents: per-agent Claude token and direct TLS grant

## Authorization and storage

`RestrictedDriver` grants `CLAUDE_CODE_OAUTH_TOKEN` only for exactly `privacy=standard` and
`model.provider=anthropic` in the owner-managed record, and only when that agent has a valid
`claude.token`. Private/unknown privacy and other providers never receive it. Ambient helper
tokens are cleared, not inherited as authorization.

The secret uses `Agents.secret`, beside `runtime.key`/`gateway.key` in the agent folder, **not**
its home. The reader requires a regular, non-symlink, helper-owner-owned mode-0600 file. No host
secret file is mounted into the container or copied by home-sync. Only the agent's Compose env
gets the token; edge/egress/home-init receive none. This is the long-lived `claude setup-token`
credential supported by unmodified DirectSDK: no automatic refresh and no credential-file writes.

Owner-side CLI (no HTTP route, stdin only; do not put credentials in argv, shell history or chat):

```sh
secure-token-source | python3 agent_runtime.py --agents-dir "$AGENTS_DIR" set-secret "$AGENT_ID" claude.token
```

`secure-token-source` denotes the owner's private input mechanism, not a bundled command. The CLI
validates the agent, bounds input, atomically replaces a 0600 file, fsyncs the file and directory,
and emits no secret. Reapplying/recreating the agent is required after setting/rotating a token.
Only synthetic fixtures were used for testing; no real token was created, requested, read or printed.

The incompatible shared-volume override and uid-permission probe have been removed from the restricted
path. The normal/nonrestricted runtime's pre-existing shared login behavior is unchanged. No ownership,
mode, image/core, upstream DirectSDK plugin or provider-identity migration is performed.

## Missing-token behavior

Absent/invalid tokens do **not** prevent startup. `apply`/`start` return success with
`status_detail=last_error=claude_token_missing`; no credential preflight failure or crash loop.
The Service persists that warning and exposes it even when the agent health probe succeeds.
A later owner-provisioned token followed by apply/start clears it. Other runtime failures keep their
existing handling. Private agents never receive this Claude-specific warning.

## Direct TLS without modifying the plugin

DirectSDK admission uses `http.client.HTTPSConnection`, ignoring HTTPS_PROXY. The pinned upstream
egress now accepts port 443 on its **sandbox alias IP only**, beside the existing CONNECT listener.
Docker's exact aliases default to `api.anthropic.com platform.claude.com`, so `getent hosts
api.anthropic.com` in the internal-only sandbox returns egress's sandbox IP, not the public IP.

The gate reassembles/validates ClientHello and accepts only a hostname present in the passthrough
list, its declared/receiving Docker aliases and the exact allowlist. It rejects missing/malformed SNI,
IP literals, ECH, oversized/truncated hellos, alias mismatch and plaintext before upstream connect.
An SNI cannot reveal which same-IP alias the client originally looked up; membership plus receiving-IP
validation is the enforceable boundary. TLS remains end-to-end with the real host certificate.

To avoid resolving its own aliases, egress queries explicit public IPv4 DNS resolvers over its uplink
(default `1.1.1.1 8.8.8.8`, configurable `EGRESS_UPSTREAM_DNS`), validates bounded replies and all
returned IPs as globally routable, then splices encrypted TCP to port 443. Both listeners share a
64-connection cap, 300s idle/drain timeout and 64KiB/10s ClientHello limits. No MITM, TLS termination,
other destination ports or new public port bindings. Existing uid10000, cap-drop ALL, ro agent root,
internal/inhibit-ipv4 sandbox and loopback-only edge publication remain intact.

Custom `EGRESS_PASSTHROUGH_HOSTS` are rendered by upstream `passthrough.py` into an exact `!override`
Compose alias list (requires Compose 2.24.4+). The helper writes only that secret-free override in
`agent/runtime/passthrough.yml`; custom hosts must also appear in `EGRESS_ALLOWLIST_HOSTS`. The two
default aliases remain the only default passthrough hosts. No Statsig, telemetry, login UI or downloads.

## Redaction and conformance

I14 needs an independently supplied owner `--claude-token` grant; ungranted/image-baked/empty token env
is denied. Shared-login grants are now always refused. I19/I20 reject home-init/sidecar secret leakage;
I21 checks exact passthrough aliases and allowlist. `redact.py` scrubs token env/key values without
requiring a real token in argv. `in_agent.py` removes the token before importing tools, redacts evidence,
and adds credential-free alias/direct-TLS/wrong-SNI probes. The helper's inspect route returns only
lifecycle metadata, not container env, and errors never log Compose stderr or raw exception messages.
Never publish raw Docker inspect/Compose config from a provisioned agent. Docker administrators can
inspect env, and this deliberately grants the model credential to the agent; it is not an exfiltration-
proof credential enclave. Allowed Anthropic endpoints can still be used to send agent-visible data.

## Provenance and evidence

Upstream PR: https://github.com/humanitylabs-org/wizard-app-store/pull/21,
branch `feature/restricted-claude-login`, commit `453b5b0b049002e9fffcd83e1c754e848c5711e7`.
All 22 upstream files are vendored byte-for-byte with hashes in `restricted-agent/SOURCE.txt`.
The helper requires the base/token Compose files, alias renderer and both egress/DNS sources in that manifest.

- Focused runtime/offline census/token unittest suite: **53 passed** with per-command isolated HOME/HERMES_HOME.
  Includes synthetic atomic CLI, private/ambient denial, missing-token start/apply, no HTTP secret route,
  secret-free sync/errors, exact custom aliases and an in-process fake-network Service status regression.
- Compose rendering: **5 passed**. Passthrough parser/fuzz/DNS/bounds/redaction unit suite: **25 passed**,
  including 4,000 deterministic random/structured mutations and every truncation of a real ClientHello.
- CONNECT gate selftest: **12/12**. Inspect selftest: **46/46**.
- Disposable Docker internal-network probe: **4/4**: DNS alias, getent, verified real TLS certificate with
  credential-free `HTTPSConnection('api.anthropic.com',443)` GET returning **404**, and distinctive
  `TLSV1_ALERT_ACCESS_DENIED` for example.com SNI aimed at the egress IP. Labelled --rm containers/networks
  are removed in finally; label-filtered readback found no leftovers.
- Upstream `bun test`: **78 passed** after installing the lockfile's missing dependencies.
- Vendored hash/full-byte comparison, Python/Service syntax and `git diff --check`: passed.

No model request, real token provisioning, full agent tool-dispatch conformance or production deployment
is claimed. The real TLS proof covers transport, not DirectSDK's complete inference/admission path.

## Deployment order — not executed; no merge/deploy authorized

1. Owner reviews/merges **Store PR #21**, then **Service draft PR #92** (keep draft until review).
2. Prepare/release an immutable helper from the pushed Service commit, including the exact vendored
   runtime and SOURCE.txt; validate digests before activation. Preserve the previous release for rollback.
3. Owner privately sets `claude.token` using the CLI above; no HTTP credential route is introduced.
4. Owner applies `archimedes-new` through the normal lifecycle control plane. Compose must recreate the
   agent for env/network changes; a bare container restart is insufficient.
5. Verify status/mounts/alias IP/hardening with redacted receipts and independently authorize `--claude-token`;
   verify a private agent still has no token, then run a separately authorized short Claude inference canary.
6. If anything fails, stop rollout and restore the prior helper/runtime configuration. Never repair by
   changing uid/capabilities, mounting shared credentials, widening SNI hosts or modifying the plugin.

Residuals: token expiry/revocation needs manual replacement+apply; public UDP DNS must be reachable
(configure approved public resolvers if not); A-only DNS intentionally fails closed without an IPv4
answer or on truncated replies; ECH is unsupported/refused; custom aliases need current Compose;
production inference and the full agent conformance run remain owner rollout gates. No live agent,
service endpoint, systemd or runtime release state was touched.
