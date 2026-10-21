# Host recovery Hermes for a moved main home

`wizard agent import hermes recovery-home prepare` creates an **independent,
owner-operated host maintenance agent**. It does not register, start, stop, install
or enable any system service, change the default agent, or contact Agent Service.

## Layout and decision

- State: `~/.hermes-recovery` (`HERMES_HOME`, a stock Hermes mechanism).
- Code/dependencies: `~/.local/share/wizard-recovery/code` and `venv`.
- Host `HOME` stays the owner's actual home. The terminal backend is `local`;
  normal host Docker and user-systemd authority remains available. No new sudo or
  root privileges are granted. Treat its API key as host-shell authority.
- Do **not** use `~/.hermes/profiles/recovery`: that profile and the original
  `~/.hermes/hermes-agent` checkout/venv would move with the source home.

Preparation exports the clean install's exact Git commit and independently
installs its pinned, already-installed Python distributions in a new venv. It
never keeps the source editable-package mapping, bin/hermes shebang, venv or code
symlink. The base interpreter must be outside the source install (normally the
uv-managed interpreter under `~/.local/share/uv/python`). That interpreter and uv
are host runtime prerequisites and must not be removed at cutover. A dirty code
checkout, an unavailable pinned wheel, overlap, pre-existing target, linked
credential, missing maintenance skill or occupied port fails closed. This is a
small code/runtime copy, **not** a home backup; it does not copy `state.db`.

## Prepare (owner approval required; not an automatic apply side effect)

```sh
ops/agent-runtime/wizard agent import hermes recovery-home prepare \
  --source "$HOME/.hermes" \
  --home "$HOME/.hermes-recovery" \
  --runtime "$HOME/.local/share/wizard-recovery" \
  --port 8867 --acknowledge-host-access
```

Run before moving the source, while its code/venv metadata and skills are still
available. `--install` can explicitly select an existing clean Hermes checkout;
otherwise it is `$SOURCE/hermes-agent`. The JSON receipt contains paths, revision,
provider/model and source-config hash, never secrets. New homes/runtime roots are
0700 and credential/config files 0600. Failure removes only newly created targets.

Only the three maintenance skills `hermes-agent`, `wizard-live-updates` and
`hermes-remote-operations` are copied, including their reference files. `SOUL.md`
identifies old Archimedes as a recovery agent James opens deliberately. No daily
history, cron files, profiles, messaging tokens/platform configuration, MCP or
installed home plugins are copied. The allowlisted API toolsets are terminal,
files, skills and web; cron/delegation are disabled. No fallback provider chain is
inherited. The standalone listener constructs stock `APIServerAdapter` without
starting `GatewayRunner`, messaging adapters or a cron scheduler.

### Sign-in continuity (same provider, not a replacement provider)

The source's explicit `model.provider` and `model.default` are preserved. Only that
provider's `auth.json` entries and its supported dotenv names are selected; other
provider pools and host/messaging secrets are not copied. The initial supported
provider credential allowlist is Anthropic, OpenAI Codex, OpenAI, OpenRouter and
Nous; unknown providers fail instead of silently switching.

For the VPS's currently configured **Anthropic / Claude Code borrowed OAuth**
route, the authoritative sign-in is the host's `~/.claude/.credentials.json`,
**outside** the moved Hermes home. Recovery keeps the same host HOME and borrows
that same host sign-in using stock Hermes' shared credential refresh lock. Do not
copy that single-use refresh grant into another writable host credential file.
The everyday container must have its own reviewed credential disposition.

Hermes-owned OAuth copied from `auth.json` or `.anthropic_oauth.json` needs care:
if both daily and recovery runtimes would own independent writable copies of a
single-use refresh grant, complete a separate login to the **same provider** for
recovery before starting both. Do not consider an API health response proof that
OAuth inference or refresh works. External secret-manager sources and
credential commands need an explicitly reviewed same-provider setup; preparation
does not copy secret-manager configuration or arbitrary host files.

## Start/probe (plain process, no service installation)

```sh
R="$HOME/.local/share/wizard-recovery"
"$R/venv/bin/python" "$R/listener.py" "$R/recovery.json"
# In another owner shell:
ops/agent-runtime/wizard agent import hermes recovery-home probe --runtime "$R"
```

The listener cleans inherited profile/provider/messaging environment before
loading its own selected dotenv. It binds **127.0.0.1 only** on the specified port,
requires a freshly generated API bearer key, and handles SIGTERM/SIGINT. Probe
makes an authenticated `GET /api/sessions`; it performs no model inference.
`GET /health` is stock Hermes' public minimal liveness endpoint; session/tool/run
APIs still require the bearer key. Loopback/key isolation is for trusted host
processes, not an OS-user security boundary.

`recovery.service` is a **rendered template only**, with absolute paths, 0077
umask and no shell-expanded credentials. Installing/enabling a production-named
unit is a later, explicit cutover action, not part of preparation or rehearsal.
Do not run `hermes gateway` for this runtime: use its API-only listener so cron
and messaging cannot be activated accidentally.

## Agent Service registration and owner-only admission

The existing main id **`hermes`** remains the external main-runtime slot; there is
no second ordinary container registry entry for recovery. At approved cutover:

1. Probe recovery on its new port and explicitly prove a same-provider model turn
   with the owner-approved sign-in. Preserve all pre-cutover service environment
   and registry bytes for rollback using the existing cutover journal/process.
2. In the **host Agent Service** environment, apply the private
   `agent-service.env` generated in the recovery runtime. It sets exactly
   `HERMES_ORIGIN=http://127.0.0.1:8867` (or the chosen port) and
   `WIZARD_HERMES_API_KEY` to recovery's generated key. Never print this file or
   return it to a client. Merge it using the existing service deployment path;
   do not blindly replace the service's whole environment. Preserve owner auth
   settings (`WIZARD_OWNER_PROOF_FILE`/trusted owner ingress). A containerized
   Service needs a separately approved host-network route: loopback is intentional.
3. `route-default JOURNAL --acknowledge-cutover` changes the default to imported
   Archimedes and writes **`$WIZARD_OS_HOME/agents/.main-agent.json`** with
   `role: recovery`. This is the actual main metadata file read by `agents.mjs`,
   not `agents/hermes/agent.json`. Undo restores the original metadata/settings.
   Alternatively use the existing owner-authenticated settings and
   `PATCH /wizard/v1/agents/hermes {"role":"recovery"}` APIs, which enforce the
   default/binding/grant preconditions. Do not bypass those preconditions.
4. Reload/restart only Agent Service through its approved cutover path, then read
   back the actual registry role, default and an authenticated recovery request
   through Service. A role flag alone does not re-point the runtime.
5. Verify guest/agent principals cannot list/open recovery; owner requests must
   explicitly select `?agent=hermes`. Recovery must not appear in default routing,
   app membership/bindings, agent grants, model routing or automatic queued work.

These admission rules already exist in Service's `default-agent-recovery` suite.
This change fixes importer's metadata/undo path to the actual main registry file.
Preparation **does not** apply its generated Service environment, move Service's
read models/queues, or restart the live Service. Those paths must also survive
removing `~/.hermes`; the recovery home is not a substitute for migrating the
Service's state plane. Roll back the Service environment as well as importer
`undo` if the cutover is reversed; undo deliberately leaves recovery usable.

## Verification

`npm test` includes ten hermetic recovery-preparation regressions via
`scripts/test-hermes-import.mjs`, with isolated HOME/HERMES_HOME/WIZARD_OS_HOME/
TMPDIR. They exercise provider/secret selection, minimal files/skills, host
terminal, environment scrubbing, no service installation, move survival,
pre-existing targets, linked source files, overlap, busy port and failed-install
cleanup.

Explicit real-runtime rehearsal (opt-in; uses only fake agent credentials):

```sh
uv run --no-project --with PyYAML --with python-dotenv python \
  tests/hermes_recovery_rehearsal.py \
  --install "$HOME/.hermes/hermes-agent" --skills-source "$HOME/.hermes" \
  --image "$REVIEWED_LOCAL_IMPORT_IMAGE" \
  --evidence "$PRIVATE_EVIDENCE_DIR/recovery-rehearsal.json" \
  --confirm-isolated-rehearsal
```

It reconstructs a disposable source install, provisions a fully independent
runtime, performs real importer apply/move into a throwaway Docker container,
starts recovery as a plain process after the source install path disappears,
checks authenticated sessions/unauthenticated 401, proves read-only host Docker
and systemd-user-bus access, checks the registry's recovery role, terminates the
listener, undoes the import and removes the network, container and temporary
homes. No production unit is installed/enabled and no live Service/gateway is
contacted. Before/after live config hashes are recorded. It intentionally does
not prove paid inference or OAuth refresh with James's real credentials.
