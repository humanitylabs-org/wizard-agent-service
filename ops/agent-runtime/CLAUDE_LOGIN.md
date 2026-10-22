# Restricted agents: box Claude login grant

## Scope and authorization

`RestrictedDriver` adds the pinned `compose.claude-login.yml` override only when
`uses_claude_login()` sees exactly `privacy=standard` and `model.provider=anthropic` in the
owner-managed agent record. Private, missing/unknown privacy, and other providers receive no
login override and no login permission probe. There is no environment-variable opt-in.

Only the agent service mounts `wizard-ai-accounts-claude` at `/claude`. Its environment points
DirectSDK there. Edge, egress, home-init and home-sync never get the volume. The existing uid
10000, cap-drop ALL, no-new-privileges, read-only root and internal-only sandbox remain unchanged.
The metadata-only preflight is a separate short-lived container running as the same uid, with
no network, no capabilities, no credential reads/writes and no output returned to the caller.

## Why rw and why the uid prerequisite is a rollout blocker

Claude Code rotates single-use OAuth refresh tokens and atomically replaces 0600 files. A read-only
mount is not safe for durable refresh. A shared rw grant intentionally allows use/modification of
the box login and grants the whole login directory, not just a scoped per-agent credential.

Before stopping an existing agent, the helper checks that the external volume exists and its
private directory and credential files belong to uid 10000 and are accessible/writable as that uid.
Symlinks, foreign owners and group/world-readable credentials fail closed. Missing login returns
`claude_login_missing` (409); incompatible metadata returns `claude_login_permissions` (409).
A timed-out probe is removed and returns `claude_login_check_timeout` (504).

Every writer of the shared login (including the Claude app and existing standard agents) must use
the same effective uid. Simply adding a group or ACL does not survive atomic mode-0600 replacement.
The helper does not chown/chmod, relax capabilities, copy credentials, change provider identity or
migrate the Claude app. Operator verification of writer identity is still required: directory
metadata alone cannot prove how another application will write its next replacement.

A read-only metadata inspection of the existing box login found directory uid/gid 1000:1000 mode
0700 and credential files mode 0600 owned by 1000. A no-network uid-10000 readability-only probe
returned inaccessible. No credential contents were read/printed and no live volume was changed.
**This branch therefore intentionally refuses on that existing volume until a separately approved
shared-writer identity migration is complete. It is not a drop-in live fix.**

## Egress and remaining inference question

The installed Claude Code binary names `https://platform.claude.com/v1/oauth/token` as its refresh
endpoint; the [official network documentation](https://code.claude.com/docs/en/network-config)
confirms it. The optional override adds only `platform.claude.com`. Inference host
`api.anthropic.com` was already allowed. No Statsig, telemetry, downloads or interactive login
hosts are added. A trusted custom `EGRESS_ALLOWLIST_HOSTS` must include the refresh host itself.

A separate static audit of the installed DirectSDK plugin found that its admission relay constructs
`http.client.HTTPSConnection(target.hostname, ...)` directly and does not consult `HTTPS_PROXY`.
That may block inference on the internal-only sandbox even after this login grant is provisioned.
No Hermes/core/provider-plugin changes were authorized or made here. A proxy-aware provider path
and an approved isolated inference canary are required before claiming end-to-end Claude works.
No real OAuth refresh or model request was attempted.

## Provenance and verification

Upstream: https://github.com/humanitylabs-org/wizard-app-store/pull/21,
branch `feature/restricted-claude-login`, commit `84fe907a91824851c172c367a1b2ed48423a988a`.
All 18 vendored runtime files match this commit byte-for-byte; `SOURCE.txt` records their SHA-256s.
`verify_vendored()` now requires the override to be listed as well as matching all listed digests.

- `python3 -m unittest ops/agent-runtime/test_agent_runtime.py ops/agent-runtime/test_offline_census.py`:
  49 passed, with per-command isolated HOME/HERMES_HOME.
- `python3 ops/agent-runtime/restricted-agent/conformance/test_claude_login.py`: 4 passed;
  real Docker Compose rendering only, no application containers.
- `inspect_check.py --selftest`: 39/39 passed. I6 requires an independently supplied
  `--claude-login`; I14 checks the matching config directory; I19/I20 reject helper/sidecar leakage.
- Disposable no-network Docker volume proof: 6/6 passed (private uid10000 accepted, uid1000 denied,
  ro mount denied, non-private mode denied, symlink denied, atomic 0600 replacement remains usable).
  The volume held synthetic fixtures only and was removed afterward.
- `verify_vendored()` and `git diff --check`: passed.

Full container conformance, refresh concurrency and actual inference remain rollout gates.

## Future deployment steps — not executed

1. Resolve shared-writer uid compatibility and the DirectSDK proxy question in separately approved
   changes. Do not work around either by relaxing the restricted agent boundary.
2. Review the upstream and Service PRs; obtain deployment authorization. Neither is merged here.
3. Prepare an immutable helper release from the pushed Service commit, including the entire pinned
   restricted runtime directory; validate hashes before activation. Updating only agent_runtime.py
   is insufficient. Preserve the previous helper release as the rollback target.
4. Release/activate that helper through the normal operator release procedure, then request `apply`
   for `archimedes-new` from the owner control plane so Compose recreates the agent with the override.
   Do not use a bare container restart: mount configuration must change.
5. Read back exact mounts/environment/hardening; pass `--claude-login` only after confirming the
   owner record is standard/anthropic. Verify private agents still have no login mount. Run a short
   approved Claude chat and durable refresh check without logging any credentials.
6. On failure, stop rollout and restore the previous helper release/configuration; do not force
   permissions or widen egress. No live endpoints, containers or services were changed in this task.
