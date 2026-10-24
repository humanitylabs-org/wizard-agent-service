# Phone setup ("Connect your phone") — Agent Service and box integration

The owner opens **Setup → Use Wizard on your phone** on the computer. Wizard signs this box in to the owner's
own Tailscale account, turns on Tailscale Serve, and the phone opens `https://<machine>.<tailnet>.ts.net/`
signed in as the owner. Nothing about a particular owner, tailnet or machine is in this repository: every
address is discovered from the box's own Tailscale status and stored in Wizard OS settings.

## Pieces

| Piece | Where | Role |
| --- | --- | --- |
| `wizard-private-access` | `ops/private-access/` (root, systemd) | the only process that drives `tailscale`; unix socket API |
| `server/phone-setup.mjs` | Agent Service | setup state machine, settings writes, phone detection |
| `/wizard/v1/setup*` routes | `server/service.mjs` | owner-only API for the Setup app |
| tailnet listener | `server/index.mjs` `WIZARD_TAILNET_PORT` | the only upstream Tailscale Serve may forward to |
| settings-driven verifier | `server/tailnet-access.mjs` | PR15 Serve verifier, origin/logins from settings per request |

## API (owner-only)

Same access rule as the other `/wizard/v1/*` routes on each listener. Writes need `Content-Type:
application/json`, are refused when `Sec-Fetch-Site` is anything but `same-origin`/`none`, and an `Origin` must
match the request's host. On the tailnet listener the PR15 verifier also requires `Origin` on every write. Reads
are refused cross-site too (a poll can turn Serve on). On an unauthenticated box-local listener the `Host` (and
any `X-Forwarded-Host`) must be loopback, an IP literal, a single-label or `*.localhost` name, or one of the box's
own configured addresses (`network.base_url`, `network.aliases` — the only way a `.local` name counts —
`access.tailscale.origin`), so a DNS-rebound page cannot enroll the box into someone else's tailnet.

- `GET /wizard/v1/setup` → `{ first_run, items: [{ id: "phone", title: "Use Wizard on your phone", state: todo|in_progress|done }] }`
  - With `WIZARD_SETUP_MODE=alongside`, also returns `launch_mode: "alongside"`: no automatic Setup/tour on existing-Hermes installs. No setting or completion flag is written by this read. Other modes keep VM onboarding.
  - An already configured host-managed private address, before the first recorded phone visit, makes the phone item `done` with `phone_ready: true`. This is a checklist-copy hint ("ready to open" instead of "connected"), not a general availability capability; after a recorded visit it is omitted and the existing connected copy applies. `phone_seen_at` stays untouched. A helper outage never trusts a stale host address.
- `POST /wizard/v1/setup/seen` → `{ ok: true }`; records `setup.seen_at`.
- `GET /wizard/v1/setup/phone` → `{ step, auth_url, https_enable_url, wizard_url, device_name, phones, install_url, error }`
  with `step` one of `unavailable` (no helper socket / Tailscale not installed), `off`, `signin`, `https`,
  `serving`, `phone_seen`. Poll it every 2 s while the screen is visible; once the owner has pressed start,
  a poll that finds the box signed in but not serving asks the helper to turn Serve on (at most every 5 s).
- `POST /wizard/v1/setup/phone/start` → helper start (sign-in link), then serve once signed in; returns the phone object.
- `POST /wizard/v1/setup/phone/reset` → clears the settings below first (access is revoked even if Tailscale does not
  answer), then helper reset (serve reset + logout). A failed helper reset is reported in `error`; later polls never
  re-record the enrollment, because recording requires a start that has not been reset.

### Settings written (`$WIZARD_OS_HOME/settings.json`)

On reaching Running + serving:

```json
{
  "network": { "base_url": "https://wizard.tail1234.ts.net", "aliases": ["<previous base_url host>", "..."] },
  "access": { "tailscale": { "origin": "https://wizard.tail1234.ts.net", "owner_logins": ["owner@example.com"] } },
  "setup": { "seen_at": "…Z", "phone_started_at": "…Z", "phone_seen_at": "…Z" }
}
```

`owner_logins` is the login of the Tailscale user that owns this node (`User[Self.UserID].LoginName`). Reset
removes `access.tailscale`, clears `base_url` (the old tailnet host stays in `aliases` so old links still fold),
and clears `setup.phone_*`. Unknown keys in the file are preserved; an unreadable file is never overwritten.

`phone_seen` = a request reached the tailnet listener, passed owner verification and carried a phone/tablet
user agent, **or** an iOS/Android device of the owner is online in the helper's peer list after enrollment.

## Access rules (PR15, unchanged and extended)

- Env wins: `WIZARD_TAILNET_ORIGIN` + `WIZARD_TAILNET_LOGIN` together pin the verifier exactly as PR15 did (a
  partial or invalid pair still fails startup).
- With neither set, the verifier reads `access.tailscale` from settings **on every request**, so enrollment
  activates phone access without a restart and reset revokes it at once. When the env pair is set, settings
  neither grant nor revoke access and reset answers `error: "access_pinned_by_environment"`. Until both an origin and an owner are
  present, every request through it is refused. Invalid settings are ignored (fail closed).
- `WIZARD_AUTH_MODE=tailscale` without those env values is now valid: the main listener is settings-driven.
- Everything PR15 refused is still refused (tests in `tests/phone-setup.test.ts` and `tests/auth-runtime.test.ts`):
  a `Tailscale-User-Login` from a peer that is not the trusted Serve proxy, a non-owner login, a wrong `Host`,
  cross-origin or cross-site requests, and writes without a same-origin `Origin`.
- The tailnet listener never serves `/wizard/mcp` or `/wizard/v1/agent-context` (box-only), whatever the identity.

## Topology the box (and the Try Wizard guest) must use

```
phone ──tailnet──▶ tailscaled Serve  https://<machine>.<tailnet>.ts.net:443
                        │  (sets Tailscale-User-Login itself, strips client copies)
                        ▼
              127.0.0.1:<serve_upstream>   ← helper config serve_upstream
                        │  (published port of the Service container, or the bare-box port)
                        ▼
              Agent Service tailnet listener  WIZARD_TAILNET_PORT   ← owner verification ALWAYS on
                        │  static shell files only (GET/HEAD, no identity/cookies forwarded)
                        ▼
              Wizard shell static files: WIZARD_UX_DIR inside the Service, or WIZARD_TAILNET_SHELL_ORIGIN

computer ─▶ Mac app 127.0.0.1:48023 ─▶ guest local proxy :8924 (adds owner@wizard.local) ─▶ shell :8796 ─▶ Service main port
            (unchanged; never reachable from Serve)
```

Rules (release gates for every box and the Try Wizard guest):

0. **Every listener on the box binds loopback only** (or a container network that is not the tailnet). Joining
   the tailnet gives the box a `100.x` address on `tailscale0`; anything bound to `0.0.0.0`/`::` becomes reachable
   by every device the tailnet policy allows, without Serve. The local owner proxy (`:8924`, which adds
   `owner@wizard.local`), the shell (`:8796`) and the Service's published ports must stay on `127.0.0.1`.
   The Try Wizard guest's source config binds all three to `127.0.0.1`; keep it that way and attach the check's
   output from the built guest to its release receipt. Check (TCP listeners; tailscaled's own sockets excluded):
   `ss -Hltnp | grep -v '"tailscaled"' | awk '{print $4}' | grep -Ev '^(127\.|\[::1\]|\[::ffff:127\.)'` prints
   nothing (a deliberately exposed `sshd` is the only acceptable exception). The helper does not enforce this yet: on a Linux box that
   publishes services on `0.0.0.0` (for example a dashboard on :80), signing in makes them reachable from the tailnet.
1. **Serve points only at the Service's tailnet listener.** Never at the shell port, the local owner proxy
   (`:8924`), the Service's main port, or anything that sets `Tailscale-User-Login`/`owner@wizard.local`.
   The tailnet listener does not trust the main listener's mode: even with `WIZARD_AUTH_MODE=none` on the main
   port, every request on the tailnet listener must be the enrolled owner through Serve.
2. The tailnet listener and its published port bind loopback only (`127.0.0.1:<serve_upstream>:<WIZARD_TAILNET_PORT>`).
   Inside a container, `WIZARD_CONTAINER=1` makes the container gateway the trusted Serve peer, as in PR15.
3. No Funnel, no Tailscale SSH, no routes, no exit node, no auth keys, no node state in images.
4. `settings.json` is now an authorization input (`access.tailscale`). Only the Service and owner-trusted box tools
   (installer, setup server) may write it; never mount it writable into an app or agent container. Other writers
   must preserve keys they do not own (`updateSettings` in `server/wizard-os-settings.mjs` does). Settings-driven
   mode accepts exactly one owner login, the one recorded at enrollment. The agent must run as a different Unix
   user than the Service (or in its own container without this file) and must not be in the helper's socket group;
   otherwise it can replace the owner login.
5. The helper socket group must be a dedicated group (default `wizard`, a system group), not a login user's
   primary group: membership lets a process sign the box out of Tailscale or start a new sign-in.

### Agent Service (container) changes for a box or the Try Wizard guest

```yaml
services:
  wizard-agent-service:
    environment:
      WIZARD_TAILNET_PORT: "8789"                               # container-side tailnet listener
      WIZARD_PRIVATE_ACCESS_SOCKET: /run/wizard-private-access/sock
      # one of, so phones get the shell from the tailnet listener:
      WIZARD_UX_DIR: /wizard-ux                                 # shell build mounted read-only (preferred), or
      # WIZARD_TAILNET_SHELL_ORIGIN: http://wizard-shell:80     # shell container on the same docker network
      # leave WIZARD_TAILNET_ORIGIN / WIZARD_TAILNET_LOGIN unset: settings drive them
    ports:
      - 127.0.0.1:${APP_PORT}:8787                              # unchanged main port (local owner path)
      - 127.0.0.1:8799:8789                                     # Serve upstream (helper serve_upstream = 8799)
    volumes:
      - /run/wizard-private-access:/run/wizard-private-access   # helper socket dir (helper keeps the dir across restarts)
    group_add: ["${WIZARD_PRIVATE_ACCESS_GID}"]                   # gid of the helper's dedicated socket group
```

Keep the main listener's current mode (`none` behind the Mac local proxy). A shell that runs in host-network
mode on `127.0.0.1:8796` is not reachable from a bridge container; use `WIZARD_UX_DIR` there.

### Host

```sh
sudo ops/private-access/install.sh --serve-upstream 8799                 # Linux box (creates system group `wizard`)
ops/private-access/install.sh --root "$IMAGE_ROOT" --serve-upstream 8799 --socket-group wizard   # guest image build
# the image build must create the `wizard` system group with a fixed gid and pass that gid to the Service's group_add
```

Try Wizard guest: re-enable `tailscaled` as an installed-but-unpaired service at first boot (or let the helper
start it on demand: `POST /v1/start` runs `systemctl enable --now tailscaled`), keep stripping
`/var/lib/tailscale/*.state` from the image, and install the helper as above.

## Verifying a box

0. The listener check in rule 0 prints nothing.
1. `curl --unix-socket /run/wizard-private-access/sock http://x/v1/status` → `installed: true`, `backend_state` not `Running`.
2. Setup → Connect your phone → sign in → (enable HTTPS if asked) → step `serving`, settings show `access.tailscale`.
3. On the phone (same Tailscale account): `https://<machine>.<tailnet>.ts.net/` loads the shell; step turns `phone_seen`.
4. A second Tailscale account on the same tailnet gets `403`.
5. Reset → step `off`; the phone gets `403`; the computer still works.
