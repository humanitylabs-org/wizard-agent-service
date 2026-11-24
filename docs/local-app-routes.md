# Local app routes (switch `wizard/local-app-routes`)

wizard-app-manager issue 629. Off by default: the owner's `wizard/local-app-routes` switch in the Look file
(`Pages/wizard-look/look.json`), read at runtime. `WIZARD_LOCAL_APP_ROUTES=1` / `0` forces it on or off for a box.

## What it does

On a box that is not on Tailscale (yet), the shell is opened at the box's own loopback address
(`http://127.0.0.1:<shell port>/`, an SSH tunnel, or a Mac guest's forwarded port). Installed apps with a page then
have only their raw loopback port, which the launcher refuses as a view URL, so they list as backend-only and can't be
opened. With the switch on, this service serves each app page at the same path Tailscale Serve would give it:

- a page served at `/` gets `/<app id>/` (the prefix is stripped before the app sees it);
- a page with its own `view.path` (Files at `/files/`) keeps that path unchanged.

`GET /wizard/v1/apps` then gives such an app that path as its `url` (only when the app has no openable view and only
for a request to the loopback address), so the existing view-URL rule accepts it unchanged. WebSockets on the path go
through too.

## Who may use it

Only a request that came straight to the box's loopback address: `Host` is `127.0.0.1`, `localhost` or `[::1]`, it did
not come through Tailscale Serve, it carries no `Tailscale-*` or `Cf-*` header, and its principal is the owner. Anything
else gets `403`. Cross-site requests (`Sec-Fetch-Site`) and writes with a foreign `Origin` are refused. The app gets no
forwarding headers (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`) and none of the owner's Wizard credentials
(`X-Wizard-Owner-Proof`, `X-Wizard-Shell-Token`, `Authorization`), so it sees exactly what it sees on its own loopback
port, which anyone on the box can already reach.

Never routed: the shell, agents, apps with an `owner_proof` (they need the owner edge), and the shell's own top-level
paths (`/wizard/`, `/wizard-os-home/`, `/api/`, ...).

## Where the app is

`apps.json` (written by the App Manager): `view.local` or `view.url` (the app's published `http://127.0.0.1:<port>`),
used when this service shares the host network (alongside boxes, `WIZARD_APPS_MCP_ADDRESS=url`), or `view.internal`
(`http://<app id>:<view port>/...` on the app's gateway network), used when it runs in a container (fresh boxes,
`WIZARD_APPS_MCP_ADDRESS=internal`).

Code: `server/local-app-routes.mjs`; tests: `tests/local-app-routes.test.ts`.
