# Agent Service in its own container (systemd host install)

For a box that already runs the Agent Service as a systemd **user** unit (for example `wizard-mobile.service`
installed by the deploy tool into `~/.local/share/wizard-mobile-server/current`). The unit keeps its name,
environment, port, restart policy and deploy/rollback flow; only `ExecStart` changes, so the service process
runs in a container instead of directly on the host.

| File | Install as |
| --- | --- |
| `Dockerfile` | runtime image (node + python3, no code baked in) |
| `wizard-agent-service-container` | `~/.local/bin/wizard-agent-service-container` (ExecStart/ExecStop) |
| `99-agent-service-container.conf` | `~/.config/systemd/user/<unit>.service.d/99-agent-service-container.conf` |

## What runs

`docker run --rm --init --network host --user <uid>:<gid> --read-only --tmpfs /tmp --cap-drop ALL
--security-opt no-new-privileges`, the account's home bound at the **same path**, working directory = the
unit's `WorkingDirectory`, entry = the installed release's `server/index.mjs`. Host networking and the
same-path home mount mean every configured address and file path (Hermes, Wizard Files, agent runtime,
state databases, attachment roots) is unchanged, so no environment value has to be rewritten. The unit's
environment is forwarded by variable **name** (`-e NAME`); secret values never appear in `docker` argv or
`ps`. Code is not in the image: a deploy that swaps `current` is picked up by the next restart, exactly as
for the native unit.

Defaults derive from the account running the unit (`$HOME`, `$XDG_DATA_HOME`, `id -u`/`id -g`, the unit's
working directory); override with `WIZARD_CONTAINER_*` variables listed at the top of the launcher.

## Why the systemd-side sandbox is relaxed

A systemd user unit has no `docker` group, so the launcher re-enters itself through `sg docker` (the account
must be in the `docker` group). `sg` needs setgid, and in a **user** unit:

- any path sandboxing (`ProtectSystem`, `ProtectHome`, `PrivateTmp`, `ReadWritePaths`, `ReadOnlyPaths`, ...)
  implies a private user namespace, where `sg` cannot setgid;
- `NoNewPrivileges`, `RestrictSUIDSGID` and seccomp-based options (`LockPersonality`, `RestrictAddressFamilies`,
  ...) imply `no_new_privs`, which also blocks `sg`.

The drop-in therefore resets those options. Isolation moves into the container instead: read-only root
filesystem, all capabilities dropped, `no-new-privileges`, the account's own uid (not root), a private
`/tmp`, and only the home directory bound in. The host process systemd supervises is just the `docker` client.

## Move an existing install into the container

```sh
# 1. Image (match NODE_VERSION to `node --version` on the host)
sg docker -c 'docker build --build-arg NODE_VERSION=22.22.3 -t wizard-agent-service-runtime:node22.22.3-py3 ops/host-container'
# 2. Launcher and drop-in
install -m 0755 ops/host-container/wizard-agent-service-container ~/.local/bin/
install -D -m 0644 ops/host-container/99-agent-service-container.conf \
  ~/.config/systemd/user/wizard-mobile.service.d/99-agent-service-container.conf
# 3. One restart (a few seconds, same as a deploy); wait until no run is active first
systemctl --user daemon-reload && systemctl --user restart wizard-mobile.service
# 4. Verify
sg docker -c 'docker ps --filter name=^wizard-agent-service$'
curl -fsS http://127.0.0.1:${WIZARD_PORT:-8923}/wizard/health
```

The drop-in must sort after every other drop-in that sets `ExecStart` (hence `99-`). Back up the run-queue and
upload databases before the restart if you want a rollback point; the container uses them in place.

## Undo

```sh
rm ~/.config/systemd/user/wizard-mobile.service.d/99-agent-service-container.conf
systemctl --user daemon-reload && systemctl --user restart wizard-mobile.service
```

The unit goes back to its previous `ExecStart` (the native node process) and its own sandbox options.
`ExecStopPost` removes the container on every stop, so nothing is left behind.

## Rehearsal

Run a copy of the unit on another port with `WIZARD_CONTAINER_NAME=<other>`, `WIZARD_CONTAINER_HOME_RO=1`
(home read-only) and `WIZARD_CONTAINER_RW="<copy>=<state dir>,..."` (fresh copies of the service's state
directories bound writable over the originals), pointing `HERMES_ORIGIN`/`WIZARD_INBOX_ORIGIN` at a dead port
or at GET-only forwarders, so the rehearsal can never write to live state.
