# Restricted agents: per-agent Claude token and direct TLS grant

## Authorization and storage

`RestrictedDriver` grants a memory-only Claude config only for exactly `privacy=standard` and
`model.provider=anthropic` in the owner-managed record, and only when that agent has a valid
`claude.token`. Private/unknown privacy and other providers never receive it. Ambient helper
tokens are cleared, not inherited as authorization.

The secret uses `Agents.secret`, beside `runtime.key`/`gateway.key` in the agent folder, **not**
its home. The reader requires a readable regular, non-symlink mode-0600 file. Host-side ownership need not
match the helper uid (for example, a root helper can read an owner-provisioned secret). No host
secret is copied by home-sync. Compose gets only `CLAUDE_TOKEN_FILE` (the validated owner path),
never its contents; ambient helper token env is explicitly cleared. The no-network, ro-root seeder
`claude-init` alone binds that file read-only and atomically seeds `.credentials.json` into the
per-agent local-driver **tmpfs** `claude-session` volume, owned uid10000 with 0700/0600 modes.
The agent gets only this memory volume, using the plugin's supported
`CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR=/run/claude-login`; edge/egress/home-init receive none.
The seeder uses root with only CHOWN/FOWNER/DAC_OVERRIDE and never mounts the agent home. It must
remain running to retain the tmpfs mount (a one-shot loses it at last unmount before agent startup).
No shared login, refresh token or automatic refresh flow is granted. Local expiry is a non-refresh
sentinel; server expiry/revocation remains authoritative, so replace owner setup-tokens explicitly.
The model credential is still intentionally readable by this agent; it is not a credential enclave.

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
mode of the owner secret, image/core, upstream DirectSDK plugin or provider-identity migration is performed.
On every apply/start, stop the agent before home sync and remove its exact-project `claude-init`
container so a replaced owner file is rebound by the next seeder. Start/apply remove orphans;
stop removes seeders even if the record/token has since revoked the grant.

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
internal/inhibit-ipv4 sandbox remain intact. The socket-gateway lane replaces loopback edge
publication with private per-agent ingress/gateway Unix sockets; neither edge nor agent publishes
TCP ports. Provider aliases still point only at egress on sandbox, and egress alone has uplink.
SNI passthrough/CONNECT are independent of this ingress migration.

Custom `EGRESS_PASSTHROUGH_HOSTS` are rendered by upstream `passthrough.py` into an exact `!override`
Compose alias list (requires Compose 2.24.4+). The helper writes only that secret-free override in
`agent/runtime/passthrough.yml`; custom hosts must also appear in `EGRESS_ALLOWLIST_HOSTS`. The two
default aliases remain the only default passthrough hosts. Both renderer and runtime reject reserved
service names, all single-label aliases, invalid label syntax and special-use local/reserved suffixes;
all names must be multi-label public DNS syntax, and real destinations must independently resolve
only to globally routable IPs. No Statsig, telemetry, login UI or downloads.

## Redaction and conformance

I14 needs an independently supplied owner `--claude-token` grant for the config path and **always**
rejects gateway token env. I6 checks the actual session volume is size-capped local-driver tmpfs;
I22 checks the no-network seeder, exact mounts and independently supplied source path (the home bind's
sibling `claude.token`, or `--claude-token-file "$SECRET_FILE"` for named homes). I19/I20 reject
home-init/edge/egress leakage; I21 checks exact public-DNS passthrough aliases and allowlist.
`in_agent.py` no longer removes the Claude token before tools: it fails immediately if the unsafe env
is present. Ordinary production dispatch is covered separately in `conformance/docker_credentials.py`.
The helper's inspect route returns only lifecycle metadata, never container env; errors omit Compose
stderr/raw exception strings. Never publish raw production inspect/Compose config or secrets.
The Service explicitly writes the stock supported `security.redact_secrets: true` for restricted
standard/anthropic harnesses. The pinned image's `agent/redact.py` sk- pattern covers OAuth tokens
(`sk-ant-oat...`): ordinary dispatcher cat results are masked before state.db/trajectory persistence.
This is defense-in-depth, not an enclave. Accepted residual: the agent can deliberately read, encode,
copy, or disable redaction for its own credential; encoded/unknown token shapes may still persist.
The token is agent-scoped and revocable, and network use remains limited to allowlisted hosts.
Those hosts can receive agent-visible data. Docker admins can read the credential; host swap and
hibernation policy are separate from tmpfs memory backing. No malicious-agent no-persistence claim.

## Provenance and evidence

Base Store main: `afeb2073e8517420a4a3c8f3d3a1aaf341cc09e5`, including merged PRs #20 and #21.
The combined 32-file runtime keeps Service main `abea43d`'s explicit local per-agent socket-gateway
adaptation, including its heavy edge allowlist and socket conformance fixtures; this is no longer
an upstream-byte-exact runtime. `restricted-agent/SOURCE.txt` cites both sources and hashes every
actual vendored file. The helper requires both the grant security files and socket edge/inspect/
ingress probe manifest entries. Historical upstream-byte-equality claims below refer only to
those prior heads, not this locally adapted merge.

- Round 2 baseline (historical): focused runtime/offline census/token unittest suite **53 passed** with per-command isolated HOME/HERMES_HOME.
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

### Round 3 review fixes (historical baseline)

- Stock image read-only audit: local terminal treats `CLAUDE_CODE_OAUTH_TOKEN` as first-party and retains
  it in subprocess/snapshot env. No supported terminal named-var blocklist was found; a config-only
  sanitize list is not available in this pinned image. Selected supported file-config approach instead.
- Compose/seed/conformance guard unit: **13 passed**; passthrough unit: **27 passed**, including both
  alias gates rejecting reserved/single-label/bad-label names. Inspect selftest **65/65**; CONNECT **12/12**.
- Real stock image, no network, synthetic credential: ordinary `model_tools.handle_function_call`
  terminal invocation creates a snapshot. Legacy env positive control leaks into that snapshot; fixed
  grant has **zero matching files under `/opt/data`**, with no gateway token env. DirectSDK's unchanged
  offline setup-status sees usable login; uncredentialed negative control does not. Agent uid10000,
  cap-drop ALL and ro root are exercised. Production seeder script + real tmpfs volume, all fixture
  resources labelled/--rm and removed in finally with label-filtered absence verified.
- Credential-free internal-network transport rechecked **4/4**, verified TLS GET **404**, wrong-SNI denied.
- Service focused runtime/token/offline-census suite **58 passed** in isolated HOME/HERMES_HOME.
  New coverage includes secret-free path delivery, exact-project seeder rebinding/stop/revocation,
  public-DNS alias denial before Compose, and mandatory security manifest entries.
- All **26/26** upstream tracked files are byte-identical, SOURCE hashes valid; Service syntax and
  `git diff --check` pass.

### Round 4 review fixes (historical baseline)

- The three stopped-census failures reproduced locally at the Round 3 starting revision. The
  restricted fixture returned the **agent id for every Docker ps query**, including the new
  `claude-init` filter. Seeder cleanup then attempted an unsupported rm and aborted stop, so the
  Service could not seal the still-running home. The fixture now honors service filters; it does
  not suppress cleanup errors or bypass the real helper's census. Production helper stop now
  stops Compose first, then removes the exact-project seeder: failed stop never revokes a live
  agent's config. Census JSON bytes match the pregrant d49037d stop boundary with and without a
  synthetic grant, and the home file bytes/metadata are unchanged.
- Both previously failing Vitest files: **13/13 passed**, archived-main rollback required, no skips.
  Every Vitest file containing census/restricted/stop: **551/551 passed across 39 files**, no skips.
  Entire `ops/agent-runtime` Python suite: **60/60 passed**, including verify_vendored and new
  stop-failure / byte-identical census controls. All commands use isolated command-scoped homes.
- S2: credential exclusions match volume name, actual volume backing source and independent owner
  secret source at any destination, including home-init and unknown/orphan project services.
  Only the intended validated seeder is exempt. Inspect selftests: **82/82**; Store conformance
  Python tests: **43/43**. All **26/26** upstream files are byte-exact and SOURCE hashes valid.
- B2: read-only stock-image audit found the supported secret-redaction knob and OAuth-covering
  sk- regex (image build f97608f178d1ffeca59860195ab7da295f7c8e5f). Harness config now pins it on.
  Real uid10000 stock dispatcher `cat`, unchanged tool result passed to real AIAgent session and
  trajectory persistence, then database close/reopen: **zero token matches under /opt/data**.
  Redaction-off control persists the same synthetic OAuth-shaped credential in both state.db and
  trajectory_samples.jsonl; legacy env control still leaks to its terminal snapshot. No output
  pre-scrubbing/core edits. Deliberate encoded copying remains the accepted residual above.

No model request, real token provisioning, full agent conformance or production deployment is claimed.
The dispatcher and offline readiness proofs do not claim complete DirectSDK inference/admission.

### Round 5: merge with socket lane

- Merge (not rebase) of Service main `abea43d` into the grant branch. Helper start delegates to
  apply, retaining sealed-endpoint reconciliation via `--force-recreate` and stop-before-seeder
  removal. Service create/update/start prepare sockets before the helper and preserve/clear the
  missing-token warning. A combined socket/Claude fixture covers all three lifecycle paths.
- Inspect keeps the socket ingress probe and edge mount/no-TCP checks alongside independent grant,
  seeder/tmpfs gating and source-at-any-destination credential exclusions. Compose still separates
  sandbox-only socket edge from dual-network alias egress, with and without the Claude grant.
- Focused local checks: runtime Python **70/70**; vendored conformance Python **44/44**; inspect
  **82/82**; CONNECT **12/12**; Vitest **177/177 in 11 files**, archived rollback required, no skips.
  Socket Docker drill **66/66** across initial/restart/recreate, with verified clean teardown.
- Round-3 real stock-image credential and redaction probes rerun with synthetic OAuth-shaped data,
  uid10000/no caps/ro-root and labelled `--rm` fixtures: legacy-env and redaction-off leak controls
  positive; fixed dispatcher/session/trajectory/DB reopen and token rotation leave no credential
  matches under the disposable home; offline login positive/negative and gateway restart pass.
  Finally cleanup and label-filtered absence verified. No real credential or inference used.
- Review round 3 PASS and Thales `heavy_fd618261` ALL PASS apply to grant-only `1ee268d`.
  **This merge head needs its own independent recheck and fresh full Thales suite.**

## Deployment order — not executed; no main merge/deploy authorized here

1. Store PR #21 is merged. Independently recheck the merged **Service draft PR #92** and run the
   full Thales suite at its new head before considering a Service main merge; keep it draft.
2. Prepare/release an immutable helper from the pushed Service commit, including the exact vendored
   runtime and SOURCE.txt; validate digests before activation. Preserve the previous release for rollback.
3. Owner privately sets `claude.token` using the CLI above; no HTTP credential route is introduced.
4. Owner applies `archimedes-new` through the normal lifecycle control plane. Compose must recreate the
   agent/seeder for config/network changes; a bare container restart is insufficient.
5. Verify status/mounts/alias IP/hardening with redacted receipts and independently authorize `--claude-token`;
   verify a private agent still has no token, then run a separately authorized short Claude inference canary.
6. If anything fails, stop rollout and restore the prior helper/runtime configuration. Never repair by
   changing uid/capabilities, mounting shared credentials, widening SNI hosts or modifying the plugin.

Residuals: token expiry/revocation needs manual replacement+apply; public UDP DNS must be reachable
(configure approved public resolvers if not); A-only DNS intentionally fails closed without an IPv4
answer or on truncated replies; ECH is unsupported/refused; custom aliases need current Compose;
production inference and the full agent conformance run remain owner rollout gates. No live agent,
service endpoint, systemd or runtime release state was touched.
