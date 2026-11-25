# Local app routes

wizard-app-manager issue 629. On for everyone: the `wizard/local-app-routes` switch was approved and removed, and a
value still saved for it in the Look file is ignored. `WIZARD_LOCAL_APP_ROUTES=0` turns the routes off for one box.

## What it does

On a box that is not on Tailscale (yet), the shell is opened at the box's own loopback address
(`http://127.0.0.1:<shell port>/`, an SSH tunnel, or a Mac guest's forwarded port). Installed apps with a page then
have only their raw loopback port, which the launcher refuses as a view URL, so they list as backend-only and can't be
opened. This service serves each app page at the same path Tailscale Serve would give it:

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

From `apps.json` (written by the App Manager). When this service shares the host network (alongside boxes,
`WIZARD_APPS_MCP_ADDRESS=url`): the page's loopback address, `view.local` or `view.url` (`http://127.0.0.1:<port>`).
When it runs in a container (fresh boxes, `WIZARD_APPS_MCP_ADDRESS=internal`), the app's address on its gateway
network: `view.internal` when present, else the origin of `mcp.internal` (`http://<app id>:<port>`) when `mcp.url` uses
the same published port as the page. apps.json gives the page and the MCP the one published port, so both reach the
same container port, which `mcp.internal` names (Files: published 8794, served on 8080). An app page with no MCP on
that port and no `view.internal` gets no route in a container and stays as it was.

Code: `server/local-app-routes.mjs`; tests: `tests/local-app-routes.test.ts`.
