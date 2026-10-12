# App installation integration candidate (12 Oct 2026)

Scope: production owner authorization, same-origin lifecycle proxy and app routing, registry/skills/gateway/launcher refresh. Isolated branch `feature/app-lifecycle-integration-20261012`; no live daily cutover or merge.

## Service seam

`WIZARD_APP_MANAGER_URL=http://127.0.0.1:8797` + server-only `WIZARD_APP_MANAGER_TOKEN`. Bridge needs actual host Runtipi install configuration; its CLI JWT stays host-side. Loopback Service accepts direct local requests or loopback Tailscale Serve with a principal; configured Cloudflare Access remains verified by existing verifier. Outer proxy must preserve original Host, and strip any user-supplied Tailscale identity before supplying verified identity. A non-loopback bridge is refused.

Owner rule without Cloudflare Access (`WIZARD_REQUIRE_CF_ACCESS=0`, the Wizard OS box/container default) applies to every control route, not only lifecycle: sessions, runs, files, bootstrap, store reads, app documents and `/wizard/v1/agent-context` without its token. The owner is a direct loopback caller with no forwarded headers, or a forwarded request whose `Tailscale-User-Login` is listed in `WIZARD_APP_OWNER_LOGINS`. A forwarded identity never counts without that list. A `WIZARD_APP_TRUSTED_PROXY_IPS` peer (the Docker gateway in front of a container's published port) is never the owner by itself; it needs a listed login, and the Service refuses to start with trusted peers and no owner list. Only `/wizard/health`, the token-authenticated gateway `/wizard/mcp` and token-authenticated `/wizard/v1/agent-context` skip the owner rule.

Packaging gate: a containerised Service must be published on `127.0.0.1` only. With a wildcard publication an app container could hairpin through the gateway and forge the login header. Installed app containers reach the Service only on its container address, which is never trusted.

Machine callers: this lane does not hand owner or gateway credentials to other apps. Consumer calls from app containers to `/wizard/hermes/api/sessions` or `/wizard/hermes/v1/runs` (Wisdom, CineQueue) are refused (403); that authenticated machine-caller contract is NOT exposed here. Speech-to-text for apps (`WISDOM_STT_URL`, multipart Voice Core) is not installed or exposed by this lane either.

Apps origin (`WIZARD_APPS_ORIGIN`/`WIZARD_APPS_PORT`) is limited: the control origin redirects `/apps/<id>/` there, but the shell's CSP has no `frame-src` for it and its frame check only confirms same-origin sandboxed documents, so the shell shows those apps as blocked (open in their own tab). Supported in-shell mode is the default same-origin sandbox: static views display inside the shell; app scripts run in an opaque origin, can't read their own fetch responses or write, and have no control authority. Interactive JavaScript apps are not claimed to work in the sandbox.

Browser obtains HttpOnly SameSite owner cookie and CSRF via `GET /wizard/v1/app-lifecycle/session`. Lifecycle writes require exact Origin/Host, CSRF header and stable Idempotency-Key. API paths remain stock `/api/apps/installed`, `/api/system/load`, `/api/apps/<id>:wizardapps`, marketplace app details/image and `/api/app-lifecycle/<id>:wizardapps/<action>`. Allowed actions install/start/stop/restart/update/uninstall. Public index proxy retains PR7 read-only contract. Auth failure, unsupported action, bad body, upstream error and unconfigured manager are explicit JSON failures. Manager tokens never reach browser or app upstream.

Projection routes each running registered app view to `/apps/<id>/`, resolved from its server-only loopback upstream. Constrained redirects and relative nested assets are preserved; owner auth/cookies are not forwarded. Browser app writes require same origin. Cookie-authenticated apps, root-absolute asset paths and WebSockets require app-specific base-path adaptation; they are not silently converted into reachable proof.

Every completed lifecycle write calls `bridge.refresh()` without Hermes restart; registry atomic updates cause the existing gateway watcher/pointer jobs to refresh. Launcher registry now exposes `refresh` and adapter reloads immediately. UI designs remain preview lane-owned.

## Receipts so far

Thales (`thales.local`), source mirror `/Users/thales/projects/wizard-os-integration/rollout-20261012/app-installation/service`. Shared lock `/Volumes/ThalesMedia/AndroidBuilds/worker.lock`. Remote npm ci audit zero vulnerabilities; read-only App views and agent bridge fixtures 17/17, standalone security tests 4/4 on 12 Oct. These are fixtures, not isolated Runtipi/host-Hermes end-to-end proof.

UX minimal adapter commit `23db0d10281f4b570ec845d0cb882b3bfda1fdcf` changes only `web/core/wizard-apps.js` and `web/core/apps.js`; cherry-pick this alone onto App views base. Preliminary integration branch has Apps views adapter carry commit; it is not a replacement for preview owner's visuals. Final exact reviewed SHA may follow fixes.

## Pending acceptance

Remote WAM fixture receipt, actual phone UI -> authenticated Service -> Runtipi install -> reachable app -> stock host Hermes gateway tool use inside reserved `wos-apps` Lima VM, failed install/duplicate/retry and unlink compatibility, focused independent review. Fresh/container-Hermes acceptance additionally requires Service-reachable app MCP addresses and exactly one wizard gateway, skills external dirs and wizard-os orientation plugin. Release status #2 supplied Triwizard evidence ending `NO_MCP_SERVERS_IN_HERMES_CONFIG`; doctor 7/7 is insufficient. Its owned candidate remains untouched. Packaging owns Service/UX images/compose; this lane declares the host bridge seam only. Existing participant VPSs and real James agent are excluded mutation targets.
