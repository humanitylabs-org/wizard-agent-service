# Public phone release feed

The host App Manager's `wam phone-sync` mirrors the public release pointer. The Agent Service only reads files;
it never fetches GitHub, installs a phone app, or changes a box update setting.

- Host: `${RUNTIPI_ROOT}/app-data/wizard-os/phone/` (stock: `$HOME/runtipi/app-data/wizard-os/phone/`).
- Container: `/wizard-os/phone/`, inherited from the existing
  `${ROOT_FOLDER_HOST}/app-data/wizard-os:/wizard-os:ro` mount in `runtipi/docker-compose.yml`.
- `WIZARD_PHONE_FEED_DIR` overrides the directory. Without it, `server/index.mjs` derives `phone/` beside
  `WIZARD_APPS_JSON_PATH` (or the normal Wizard OS home). Old pinned compose definitions already have the
  apps.json mount and therefore need no new mount for a new Service image to read the mirror.
- `GET` and `HEAD` only: `/reports/wizard-os/latest.json` and
  `/reports/wizard-os/wizard-os-<semver>.apk`. Other methods return 405 with `Allow: GET, HEAD`.
- These **public release bytes only** bypass principal and Tailscale identity checks. The updater supplies only
  Origin and Accept headers, no cookies or credentials. Every other route retains its existing gate.
- Missing files, unapproved names, traversal and symlinks return JSON 404 `{"error":"no_phone_release"}`,
  including when the feed directory does not yet exist. Never serve the SPA fallback.
- Feed: `Cache-Control: no-cache`. APK: streamed 200 with an exact Content-Length and no redirects.
  Both GET and HEAD have the same headers. Range requests are not needed by this updater.

## Stock front door

The split shell's `wizard-ux/packaging/nginx.conf.template` has a catch-all
`location / { proxy_pass $wizard_api$request_uri; ... }`, not just `/wizard/` proxies. Thus `/reports/wizard-os/`
reaches this Service on the shell origin without a Caddy rule. The dedicated Service `createTailnetIngress`
listener also enters the same handler, before the Tailscale identity gate. Tailnet access remains required at the
network layer; do not publish this origin to the Internet on behalf of an owner.

## Baseline and verification

Before this change, on main `d0bbe4b09a165e7e0c25e7a719935e6674c004a2`, an unauthenticated fixture GET with
Origin + Accept to this exact path returned:

- box-local (`requireAccess:false`): **404**, `application/json; charset=utf-8`, `{"error":"not_found"}`;
- `createTailnetIngress` without an owner verifier: **403**, same JSON content type, `{"error":"access_required"}`.

These were local main-code probes, not calls to an owner's live box. They were not SPA HTML.

Run `node --test tests/phone-feed.node.mjs`. The integration case starts the actual Wizard Service and its
Tailscale ingress with no usable authentication, fetches the feed and APK, and proves private settings still
return 403. The test is included in `npm run test:unit`.

A release must include both the Service image and the App Manager commit/installer that enables
`wizard-phone-sync.timer`. A check-only box needs one explicit box update to acquire that code. Until the public
pointer is published the sync logs a clean no-op and this route returns JSON 404.

## Pre-updater phone pairing finding

The Setup UI is in **wizard-ux**, not this repository: `web/setup/setup.js`, `step3` (around lines 257–264),
currently renders the step-3 QR/connect payload and `urlRow(wiz)`. That is the location for an
“Install / update the phone app” action: read the same-origin `/reports/wizard-os/latest.json` and link to its
relative `url` (resolved against the feed URL), rather than hardcoding a release version or linking to raw JSON.
Step 2 links to Tailscale, not to the Wizard APK. No Setup UI or live owner configuration is changed here.
