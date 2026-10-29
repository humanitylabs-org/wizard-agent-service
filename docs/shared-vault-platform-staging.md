# Shared Vault platform integration — staging only

**HOLD: disabled by default; no live deployment or activation.**

## Component decision

- REUSE `principals.mjs` owner proof/access verifier and agent-only ingress, installed `apps.json` membership, `app-views.mjs` own-view publication and method-preserving API redirects.
- EXTEND one trusted-bootstrap `appOwnerRoutes` registration seam. Neither HTTP input nor app metadata can register executable code, a credential, a backend or a module path.
- EXTEND the existing `RestrictedDriver` and its socket-gateway stack with explicit per-agent app socket grants. No second runtime, alternate network proxy or core Hermes patch.
- SOURCE PACKAGE the unmodified candidate owner adapter and credential-free plugin, with exact upstream commit/hash and retained GPL license. The surrounding Service remains MIT; combined-distribution licensing needs independent review before publication. This is proposed source admission, not an approval claim.

## Owner bootstrap

`WIZARD_SHARED_VAULT_OWNER_CONFIG=/absolute/private/owner.json` is the sole activation input to the shipped `server/index.mjs`. Unset means no registration, secret read, proxy or API alias change. It contains exactly:

```json
{"publicOrigin":"https://owner.example.test","brokerOrigin":"http://127.0.0.1:8799","ownerTokenFile":"/absolute/private/owner-token"}
```

Use the unprivileged Service uid, a private 0700 parent and regular 0600 files. Symlinks and broad permissions fail startup. The token is reread and its ownership/permissions rechecked at each use; it is never serialized to app/agent metadata. The source-packaged module is SHA-256 checked at bootstrap and has no machine-local import dependency.

Only an installed app with exact ID `shared-vault` is admitted, checked on **each** request. Removing it immediately revokes the route. Registration runs after principal attachment and the normal agent ingress/path gates, before static/app routing; it also applies the access verifier. `owner` via proxy proof or access verifier is necessary. Anonymous, service, agent, box-only and forged headers cannot acquire broker authority.

The canonical route is `/wizard/apps/shared-vault/api/` with exact GET `status` and POST `connect`, `grant`, `revoke`, `disconnect`. Raw target/query/encoding/method matching occurs before handing the unchanged Node request to the adapter. Original Host/Origin are checked before backend header translation; writes require exact original Origin. Cookies, caller bearer, identity/forwarding headers and owner proof are not forwarded. Redirects/backend headers are not relayed. Ordinary Service HTTP parser limits remain in force and the adapter supplies bounded body/work/response handling.

The existing admitted own-view publication maps `/wizard/views/shared-vault/api/<exact-operation>` to the canonical route using **307 only**, never a token-injecting static proxy. Other installed app/view behavior is unchanged. This requires that the real installation have an admitted own-view publication. Ordinary WAM install does **not** silently opt in. The staged rig publishes the pinned app web source into a disposable installed registry/own-view; it does not verify WAM's install/update/uninstall lifecycle. A full WAM source-package admission and ordinary top-level/native app-url cutover remain a separate parent acceptance gate; do not call those done from this fixture.

## Restricted host grant

Run the existing unprivileged host helper from this complete source package with an explicitly supplied `--app-socket-grants /absolute/private/grants.json`. Do not copy only `agent_runtime.py`: it now imports the packaged sibling `app_socket_grants.py`. The new file and fixed plugin files ship with the helper source.

```json
{"schema":1,"agents":{"agent-a":{"app":"shared-vault","socket":"/dedicated/edge-publication/agent.sock","broker_uid":10002,"edge_uid":10003,"agent_uid":10000}}}
```

This is a trusted host file, not `agent.json` or a model-readable home. Default/missing agent entry means **no mount**. Duplicate cross-agent socket paths, unknown fields, UID collisions/zero/bools, nonrestricted/imported agents, missing/wrong-owner/wrong-mode sockets, unsafe paths and modified packaged plugins refuse. Every broker/edge/agent UID is positive and pairwise distinct; whole-agent uid is fixed at 10000. Only the exact read-only socket inode plus sealed credential-free `__init__.py` and `plugin.yaml` files are added. No edge directory/token/config, broker/provider data, Docker socket or owner Service socket is mounted.

The native frozen Hermes `plugins enable shared-vault` CLI runs as uid 10000 in an offline, capability-free initializer against only that agent's home and packaged plugin. No core edits, root fallback or custom dispatcher. A frozen runtime without that supported plugin API fails closed. Imported runtimes and the existing shared-Claude-login mount profile are deliberately not admitted in this minimal socket-only profile.

Before mounting authority, an empty no-mount one-shot checks the same frozen image/user/capability recipe and actual kernel identity. Root helpers, remote/remapped/rootless daemons or a daemon whose hostname does not match the local kernel host refuse. After start/recreate, the actual runtime PID 1 must have all four UIDs=10000, the initial unremapped uid map and local user namespace, no capabilities (including bounding/ambient) and NoNewPrivs=1. Outside-in Docker metadata must independently match the enforced userns/uid, read-only root, private namespaces, exact mounts and single internal/inhibit-IPv4 sandbox network. Failed verification stops the agent; no success result or unrestricted fallback. This is launch/restart admission, not continuous attestation against a hostile Docker administrator. The trusted app deployment must separately enforce/verify actual broker and edge identities; the app edge authenticates SO_PEERCRED and the host checks the socket owner.

Replacing an edge socket inode requires stopping the affected agent, stopping that edge, removing only its stale stopped socket, restarting edge and recreating the agent's exact-file bind. A directory bind is never a restart workaround. Trusted host grant revocation takes effect on the next helper reconciliation/recreation; immediate use revocation remains the broker owner's grant revoke. Never promise immediate mount removal from merely editing the file.

## Evidence and remaining gates

Fast tests: `npm run test:shared-vault-platform`; affected regression suites: `npx vitest run tests/agent-principals.test.ts tests/agent-sockets.test.ts tests/app-views.test.ts`.

`qa/shared-vault-platform/run.py` is a **not-yet-executed Forum gate**, requiring clean pushed exact commits, a fresh `/srv/work` root, nonroot native Docker, Compose `!override` support and a working pinned Chromium installation. Parent alone may submit it after source review. It uses real Service/Broker/edge/RestrictedDriver and two full pinned Hermes runtimes with native plugin discovery/tool dispatch. Only the official-CLI boundary responses and dedicated owner session are synthetic; no account, owner profile, invite, real provider token or model call is used.

Broker/edges/Service share a `network=none` namespace. The trusted local HTTPS test proxy reaches only a private Unix socket and adds proof **only** after checking a separate synthetic owner session. Agent fixture networks are internal/inhibit-IPv4; the test overlay removes egress uplinks before start, disables their egress program and sends non-local DNS to a dead loopback resolver. Thus containment does not trust the prior flawed DNS implementation. Image builds/browser downloads run on the trusted worker, never inside agents. Scratch projects, sidecar tags and all names are unique. Teardown is scoped to those projects and is verified.

The rig covers owner/anonymous/nonowner/CSRF, exact API paths, two agent tools/handles, A/B foreign-handle refusal, shell/proc/env/files/network/mount boundaries, broker direct denial, owner revoke and repeat after a stopped writer/edge/Service/full-runtime restart. It records exact commits, lock/source hashes and built image ID. Source syntax and local unit success are **not** claims this gate has passed.

Its result deliberately declares `wam_install_lifecycle=false`, `useful_login_task_end_to_end=false` and `production_activation=false`. It does not replace the app's separately reviewed DNS-pinning/private-browser fixture or prove a real useful account task. Parent must review that app revision and its receipt, WAM installation/ordinary owner URL admission and the combined isolation receipts before any activation. Only the owner can authorize an existing dedicated shared-only Bitwarden identity/collection, unlock it with the official tooling and explicitly grant an actual approved task. No accounts/invites are created here. 1Password/Vaultwarden remain outside this implemented scope; never imply their provider consent or adapters exist.
