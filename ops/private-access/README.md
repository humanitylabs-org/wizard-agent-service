# wizard-private-access

The box's only Tailscale driver for Wizard OS "Connect your phone". A root helper (Python 3 standard library,
no dependencies) that the Agent Service calls over a unix socket, so no app or container gets Tailscale
privileges. Contract: Wizard OS phone setup, section "Host helper".

| File | What |
| --- | --- |
| `wizard-private-access` | the helper (Python 3.9+ stdlib) |
| `wizard-private-access.service` | systemd unit (root; socket dir `/run/wizard-private-access`, 0750) |
| `install.sh` | installer for a Linux box or a guest image root (`--root DIR`) |
| `testing/fake-tailscale`, `testing/fake-systemctl` | test doubles: run the helper with no tailnet |
| `tests/` | unit tests (`python3 -m unittest discover -s tests -t tests`) |

## API

HTTP/JSON on `/run/wizard-private-access/sock` (socket 0660, group `socket_group`). Requests are handled one at a
time. Anything other than these four is `404`. Errors are `{"error": code, "detail": short text}`.

- `GET /v1/status` → `{installed, daemon: running|stopped|missing, backend_state, auth_url, dns_name, tailnet,
  https_enabled, https_enable_url, serve: {on, target}, owner_login, peers: [{id, name, os, online, last_seen}]}`.
  Read from `tailscale status --json` (`BackendState`, `AuthURL`, `Self.DNSName`, `Self.UserID`,
  `CurrentTailnet.MagicDNSSuffix`, `CertDomains`, `User[id].LoginName`, `Peer[].{ID, HostName, OS, UserID,
  Online, LastSeen}`) and `tailscale serve status --json` (`Web["<dns>:443"].Handlers["/"].Proxy`). Only peers
  owned by the same user as this node are listed; peer ids are hashed. `serve.on` is true only when `/` on 443
  proxies to exactly `http://127.0.0.1:<serve_upstream>`.
- `POST /v1/start {"hostname": "wizard"}` → enables and starts `tailscaled` if it is stopped, runs
  `tailscale up --reset --hostname=<hostname> --accept-dns=false` in the background and returns status with
  `auth_url` within ~5 s (it never waits for the human). A second start while a sign-in is pending reuses it.
- `POST /v1/serve` → `tailscale serve --bg --https=443 http://127.0.0.1:<serve_upstream>`. When HTTPS/Serve is
  not enabled on the tailnet the CLI prints an enable link and waits; the helper returns status with
  `https_enable_url` set (and stops waiting) instead of failing.
- `POST /v1/reset` → `tailscale serve reset`, then `tailscale logout`. `tailscaled` stays installed.

Never used: auth keys, Funnel, Tailscale SSH, subnet routes, exit nodes. Sign-in links are never logged.
Note: `--reset` returns every preference not named to its default, so a box whose owner had set Tailscale
preferences by hand (and is not currently signed in) loses them when "Connect your phone" signs it in. A box that
is already signed in (`Running`) is left as it is. `POST /v1/serve` replaces whatever Serve had on `/` at port 443.
`POST /v1/reset` succeeds only when Serve is off and the node is no longer signed in (`reset_failed` otherwise).

## Config: `/etc/wizard-private-access.conf`

```
socket = /run/wizard-private-access/sock
socket_group = wizard            # dedicated group (name or gid) allowed to use the socket; not a user's primary group
serve_upstream = 8799            # 127.0.0.1 port Serve forwards to: the Agent Service's tailnet listener
hostname = wizard
```

`serve_upstream` must be the Agent Service's **tailnet listener** (`WIZARD_TAILNET_PORT`, or the host port it is
published on). Never point it at a listener or proxy that adds an owner identity (for example a local owner
proxy that sets `Tailscale-User-Login`). See `docs/phone-setup.md`.

## Install

```sh
sudo ops/private-access/install.sh --serve-upstream 8799                       # a running Linux box (group `wizard`)
ops/private-access/install.sh --root /path/to/image --serve-upstream 8799 --socket-group wizard   # guest image build
```

The installer never installs, starts or signs in Tailscale. Tailscale stays unpaired until the owner taps
"Connect your phone".

## Test without a tailnet

```sh
python3 -m unittest discover -s ops/private-access/tests -t ops/private-access/tests -v
```

Another lane can run the real helper against the doubles:

```sh
export FAKE_TAILSCALE_STATE=/tmp/fake-ts.json WIZARD_PRIVATE_ACCESS_CONF=/tmp/wpa.conf
printf 'socket = /tmp/wpa/sock\nsocket_group =\nserve_upstream = 8799\ntailscale = %s\nsystemctl = %s\n' \
  "$PWD/ops/private-access/testing/fake-tailscale" "$PWD/ops/private-access/testing/fake-systemctl" > /tmp/wpa.conf
python3 ops/private-access/wizard-private-access &
ops/private-access/testing/fake-tailscale _complete-login owner@example.com   # after POST /v1/start
ops/private-access/testing/fake-tailscale _enable-https                       # after the https step
ops/private-access/testing/fake-tailscale _add-peer my-iphone iOS true
```
