# Restricted agents: Claude app login and direct TLS grant

## Owner authorization and credential source

Only an owner record with **runtime.isolation=restricted, privacy=standard,
model.provider=anthropic** receives this grant. Private/unknown privacy and other
providers never inspect the Claude app, receive its mount or get a Claude warning.
There is no per-agent login, setup-token or credential-provisioning CLI/HTTP route.
Old per-agent credential files are ignored; this change does not read or delete
owner files. Any obsolete credential should be revoked/removed by its owner.

`RestrictedDriver.claude_source()` uses the pinned `claude_source.py` resolver to
inspect only running `wizard-claude-engine` container metadata and its exact
`/claude` mount. One resolver accepts both supported installed-app storage forms:

- Current: the app-owned external `wizard-ai-accounts-claude` named volume.
- App-owned shares (Store PR #19): the installed Claude app's compiled
  `data/claude` bind, implementing `mounts: [{app: wizard-claude,
  share: claude-login, path: /claude}]`.

Absent/stopped/ambiguous app metadata fails closed. No grants.json contents,
provider host guesses, ambient token/path overrides or new auth system is used.
The generated per-agent `runtime/claude-source.json` contains only source metadata,
not credentials. The future share compiler is authoritative for installing the
app's bind; the runtime does not invent a parallel grant store.

## Read-only projection and refresh ownership

The no-network, ro-root `claude-init` mounts the app **directory read-only** at
`/claude-app`. Directory mounting observes atomic app credential replacements.
It never modifies the app's ownership/modes or writes back. Root with only
CHOWN/FOWNER/DAC_OVERRIDE reads uid1000 0700/0600 files and publishes a separate
uid10000 0700/0600 config to this agent's size-capped local-driver **tmpfs** volume.
The seeder's only other mount is that tmpfs; it never mounts the agent home.

Every two seconds, it copies only the current access token, **real** expiry,
scopes and plan metadata. **No refreshToken, refresh lock or arbitrary CLI config
is granted.** Missing, invalid, expired or logged-out credentials remove the
projection; app login/renewal is followed without restarting the agent. A native
request already in flight may retain its prior access credential until it ends.

The agent gets **only the read-only tmpfs projection**, through the existing
`CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR=/run/claude-login` contract. Neither
source nor token env reaches agent/home-init/edge/egress. The supported stock
DirectSDK plugin remains unchanged and launches the official Claude CLI. There
is no token gateway. The app's official Claude Code login/test/auto-renew flow
remains the only refresh-capable actor **for this restricted consumer path**.

Important finding: this was not already true box-wide. Current nonrestricted
`compose_doc()` grants the complete login at `/claude` **RW**. The DirectSDK plugin
itself never reads/refreshes credentials, but forwards this directory to Claude
Code, which can refresh and rewrite `.credentials.json`. Standard legacy consumers
therefore remain refresh-capable; changing them or the app is outside this PR.
The read-only/access-only projection deliberately does not copy that co-ownership.

## Missing/disconnected login and lifecycle

Missing app: omit the grant override and start normally. Present app with no
valid login: the seeder reconciles to no credential but remains initialized and
healthy (no crash/restart or Compose dependency loop). Apply/start checks the
current app metadata and the exact-project seeder's quiet `--check`, returning
`status_detail=last_error=claude_login_missing` when unavailable. The Service
preserves that warning even with healthy agent ingress. Connect/renew in the
Claude app and apply/start to clear the persisted warning. Logout/expiry erases
the running agent's projection within two seconds; warning refresh is lifecycle
based, not a new background Service polling system.

Apply/start stops the agent before removing its exact-project seeder and syncing
managed home files, then uses `up --force-recreate --remove-orphans`. Stop removes
stale seeders even after a private/provider/grant change, **after** successful
agent stop. A failed stop must not revoke credentials under a running agent.

## Egress and security invariants

Unchanged: uid10000, cap-drop ALL, ro agent root, internal/inhibit-ipv4 sandbox,
private socket ingress, `security.redact_secrets: true`, and egress SNI passthrough
for exactly `api.anthropic.com platform.claude.com`. Native DirectSDK admission
uses HTTPSConnection, not HTTPS_PROXY; alias/SNI validation, public-only upstream
DNS, bounded ClientHello and encrypted TCP passthrough remain necessary. No new
login/telemetry/download host, MITM, port publication or plugin/core change.

`inspect_check.py --claude-login` independently authorizes the projection; source
must match `--claude-login-source volume:wizard-ai-accounts-claude` (default) or
`bind:/srv/app-data/core/wizard-claude/data/claude` from app metadata. Agent: RO
per-agent tmpfs only. Seeder: exact RO app source + writable tmpfs, no network or
home. I19/I20/I23 reject alternate-destination mounts of these sources, backing
paths and unknown/orphan seeders. I14 always rejects gateway token env.

This is not an enclave: restricted standard agents can read the app-wide access
credential. Stock OAuth redaction protects ordinary cat/tool/session/trajectory
persistence; deliberate encoding/copying or disabled redaction may still persist
it. Provider revocation affects the shared app account, not a per-agent provider
identity. Docker admins, swap/hibernation and in-flight native sessions are
outside this boundary. Do not claim malicious-agent no-persistence.

## Read-only image audit and synthetic evidence

Image: `ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2`, local image id
`sha256:312be4375a3c4b2ad5768ca6341e609fa28d206b089a401823816c0380dfd6e6`.
DirectSDK pin: `ef73726cfaf2fa0ee041e55572f406e2c24fed83`.
Official CLI: 2.1.296, binary SHA256
`24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de`.

Read-only source audit: `directsdk.py` maps the supported config env to native
`CLAUDE_CONFIG_DIR`, and spawns the CLI. The native plaintext backend writes and
chmods `.credentials.json` to 0600; native `xvr` stores refreshed OAuth through
`C.mutate`. Its inference-only branch avoids saving when refreshToken is absent.
The app source `server.py` delegates renewal to `run_test()` using official CLI;
usage/inference readers explicitly never rotate the refresh chain.

`conformance/docker_credentials.py` uses only synthetic app credentials, real
uid1000 0700/0600 source and uid10000/no caps/ro-root agent fixtures. Both fixed
and atomically rotated credentials left **zero raw access-token matches under
/opt/data** after ordinary terminal snapshot, unchanged dispatcher cat, real
AIAgent session/trajectory writes and DB close/reopen. Legacy-env and redaction-off
positive controls leaked as expected. Official offline login positive/negative,
RO projection, refresh-chain exclusion, source bytes/uid/modes unchanged and
logout/reconnect without restart passed. Every Docker fixture is no-network,
`--rm`, labelled `claude-app-grant-test`, and removed/absence-checked in finally.

No real login contents, router-grant values, live agents, live endpoints, model
inference, OAuth rotation, systemd, restart or deployment were exercised. Full
Thales conformance and future share-compiler end-to-end are not claimed.

## Upstream and release boundary

Store PR #22 owns runtime behavior, including the previous Service socket
adaptation moved upstream first. Service vendors exact bytes at the revision in
`restricted-agent/SOURCE.txt`, with every file digest checked by the helper.
No local runtime adaptation remains. Store #19 is not modified.

No merge/deploy is authorized. Before any later rollout: review both PRs, run the
full authorized remote gate, publish an immutable helper from pushed commits,
then owner-apply and verify redacted mounts/status/private exclusion and a
separately authorized short inference canary. Never fix permissions by changing
the app's uid/modes, widening egress or modifying the official plugin.
