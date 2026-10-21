# Bring your Hermes — future owner cutover (NOT EXECUTED)

## NO-GO until every gate is satisfied

This is a runbook, not approval to run it. Retain installation-specific measurements and blockers in the owner's private acceptance report, not a shared PR. Do not cut over until source/image compatibility, full-home rehearsal scope, provider sign-in, git/gh/build-host SSH and a separately healthy system-recovery agent are verified. A staged durable build is packaging only; it does not install or start anything on the live box.

Measure the full home and free space before any copy. Do not copy a large live state.db, hardlink writable data, or pretend a portable-subset rehearsal satisfies “everything except state.db.” Either approve that documented exception or perform a complete stopped-home rehearsal on an adequately sized private remote volume. Large archives/snapshots belong on encrypted remote storage, not a second local copy.

## Before the window

1. Pin the importer and companion spec commits already pushed to GitHub. Deploy the reviewed Service/host-helper support in a **separate authorized release window**. This task did not restart/reconfigure either live service. Without the imported-harness guard, a later UI start can overwrite imported configuration; do not deploy just the CLI in isolation.
2. Complete the staged source-pinned image build on the remote light lane. Compare its install-stamp revision, Hermes/SQLite versions and backup/schema implementation to the source. Run stock archive/API checks and the reduced-home history/memory checks with that image. Verify git, gh, Python/Node/uv, curl/jq/SQLite and `ssh -o BatchMode=yes BUILD_HOST true` from a real agent terminal. Do not treat a `command -v` inventory as proof of the SSH workflow.
3. Approve a narrow project worktree mount and a build-host-only identity/config/known_hosts; never mount the owner home or entire `.ssh` authority. The key must not grant SSH back into the Wizard host. Do not carry owner-proof, runtime-helper, Docker or private-agent master credentials. Recheck the mount seal against symlinks/nested Wizard roots.
4. Supply reviewed, digest-pinned Wizard plugin/system-skill packages. Preserve holographic `memory_store.db` and the declared memory backend; do not translate it into markdown-only/builtin memory. Confirm all needed provider sign-ins resolve **without** bootstrapping old host plugins/secret-manager authority. Establish a renewable imported-agent grant in a separate owner login flow if the canary's access-only grant is insufficient; never rotate a shared original refresh grant during rehearsal.
5. Provision a **separate** system-recovery Hermes home/runtime, preserving the old Agent Service API/key route and restricted owner-only recovery semantics. If the source is also the current host/main agent, marking its old record `recovery` does not create a second runnable home. Verify recovery directly before moving the source; do not start a competing messaging/cron copy. Recovery may use its own approved host tools; the imported agent must not inherit them. Snapshot/revert any recovery-only unit changes separately.
6. Read and record (no credential values): current default id, main role, source config hash, service active/enabled states, source-home inode/device, image digest, network and unused port, free space, agent list, source session/skill/fact/job counts. Identify and stop all alternate source launchers/timers/workers in the agreed window; record how each is restored. A writable-FD census is not a fence against an unaccounted future launcher.
7. Ensure a private encrypted remote backup exists and is verified. Same-home import is a rename, not a backup. Keep the import journal/originals outside all agent mounts. Do not purge quarantine until undo is no longer required.
8. Tell the owner: messaging/cron has exactly one writer. During the window the original gateway stops; do not send manual control messages through it. Messages may queue at the messaging provider; delivery/replay behaviour must be checked, not assumed. Existing Wizard threads retain their `(agent_id, session_id)`; new threads use the newly selected default only after routing is changed.

## Prepare the approved plan (read-only)

Set these in the owner's shell from verified deployment configuration, not from a chat containing credentials:

```sh
export PATH="$IMPORT_CHECKOUT/ops/agent-runtime:$PATH"
export IMPORT_AGENT_ID=archimedes
export HERMES_HOME="$SOURCE_HERMES_HOME"
export IMPORT_PLAN="$PRIVATE_IMPORT_WORK/plan.json"
export IMPORT_JOURNAL="$WIZARD_OS_HOME/agents/$IMPORT_AGENT_ID/import-journal.json"

wizard agent import hermes scan "$HERMES_HOME" --owner-home "$HOME" --out "$IMPORT_PLAN"
```

Review every outside dependency. Edit the plan, leaving unknown/unapproved things behind. For the real move choose `move:true`, `path_preserving:true`, `mode:"take-over"`, the pinned tested image, the verified network/gateway URL/port, and `source_units:["hermes-gateway.service"]` **only if that is the discovered actual unit**. Select explicit project mounts, credential copies, environment names, reviewed plugins/MCPs and Wizard asset packages. Imported messaging and Hermes cron remain the only active owner after the source unit stops; Wizard scheduler migration is not part of this flow.

```sh
wizard agent import hermes approve "$IMPORT_PLAN"
```

Rescan/reapprove on critical config, dotenv, cron or plugin changes. Never edit the source home to make the plan pass.

## Execute only after a fresh, explicit owner authorization

The following commands were **not** run against the live source:

```sh
wizard agent import hermes apply "$IMPORT_PLAN" --id "$IMPORT_AGENT_ID" \
  --wizard-home "$WIZARD_OS_HOME" --allow-source-stop
```

Apply records which declared units were active, stops them, checks writers, renames the source into the agent's own home on the same filesystem, writes a non-symlink pointer, quarantines per-machine code/old Wizard wiring, adds new per-agent API/MCP keys and starts the pinned container. No host shell, Docker socket or peer-agent home is mounted. The original data is not duplicated.

Health gates, before switching default:

- GET the exact new agent via `/wizard/v1/agents`; require `status:running` and the expected model/provider. Existing agents/default must remain unchanged so far.
- Read an imported hidden history by explicit `agent_id`; compare session/message and fact counts, identity, skill hashes and memory provider to the preflight baseline. Keep all verification traffic hidden: CREATE → PATCH `hidden:true` → GET and assert literal true **before any message**; abort if not true.
- Send one bounded verification turn through Agent Service to that hidden session. Have it run the required git/gh/SSH tool flows. Inspect actual tool exit codes and reply, not a self-reported list of capabilities. Avoid irreversible outside effects.
- Verify old source unit and every alternate launcher remain stopped and no process still writes the pointer directory. Verify the new copy is the **only** messaging/cron owner; source jobs exist exactly once. Do not enable Wizard scheduling for these jobs.
- Verify independent system recovery still answers an owner-only explicit request, with no messaging/cron responsibility and no access path for anonymous/agent-key callers.

Only then select the default and label the previous main agent as recovery:

```sh
wizard agent import hermes route-default "$IMPORT_JOURNAL" --acknowledge-cutover
```

Read back settings and `/wizard/v1/agents`: new id default, old main `role:recovery`, unrelated agents unchanged. Verify a new normal chat and voice admission route to the new default, while an existing qualified thread still resolves to its old pair. Verify recovery does not participate in normal model/default routing. Never expose owner proof or keys in the evidence.

### Owner-attended proof of messaging, cron and build-host work

These checks also require the new authorization; none were run against the real source in this task.

- From the owner's existing Telegram chat, send a unique `Reply CUTOVER_TELEGRAM_<nonce> exactly` message. Require one reply from the imported gateway and none from the stopped original. Correlate the new agent's run/session receipt without logging the bot token. Do not poll `getUpdates` with a second client while the gateway is running.
- For a cron proof without a model call, create a disposable script in the **new container only**, then schedule one occurrence. These flags were checked against the pinned source's stock cron parser. Record the returned job id, wait for completion, check one output line and one completed occurrence, then check again after another tick. Do not manually run the job to manufacture the proof.

```sh
export IMPORT_CONTAINER="agent-$IMPORT_AGENT_ID"
docker exec "$IMPORT_CONTAINER" /opt/hermes/.venv/bin/python -c 'import os,pathlib; h=pathlib.Path(os.environ["HERMES_HOME"]); (h/"scripts/cutover_once.py").write_text("import os,pathlib\np=pathlib.Path(os.environ[\"HERMES_HOME\"])/\"cron-cutover-proof.txt\"\nwith p.open(\"a\") as f: f.write(\"fired\\n\")\nprint(\"CUTOVER_CRON_ONCE\")\n")'
docker exec "$IMPORT_CONTAINER" sh -c '/opt/hermes/.venv/bin/python -m hermes_cli.main --ignore-rules cron create 1m --name wizard-import-proof --script "$HERMES_HOME/scripts/cutover_once.py" --no-agent --repeat 1 --deliver local'
docker exec "$IMPORT_CONTAINER" /opt/hermes/.venv/bin/python -m hermes_cli.main --ignore-rules cron list --all
# Only after the recorded job has completed (and again after another tick):
docker exec "$IMPORT_CONTAINER" /opt/hermes/.venv/bin/python -c 'import os,pathlib; p=pathlib.Path(os.environ["HERMES_HOME"])/"cron-cutover-proof.txt"; assert p.read_text().splitlines()==["fired"]; print("exactly one firing")'
# After the evidence is captured, remove only the returned disposable job:
docker exec "$IMPORT_CONTAINER" /opt/hermes/.venv/bin/python -m hermes_cli.main --ignore-rules cron remove "$PROOF_JOB_ID"
```

Delete only `scripts/cutover_once.py` and `cron-cutover-proof.txt` inside this new home after recording the proof; neither belongs in the source restored by undo. Inspect that proof job's record in `cron/jobs.json` before deleting it; all pre-existing job ids/counts must still match the window baseline. If a second occurrence or a source launcher appears, stop/undo rather than adding a Wizard scheduler copy.

- In a hidden Agent Service thread addressed explicitly to the imported id, have its **terminal tool** run `git --version`, `gh --version`, `ssh -o BatchMode=yes -o ConnectTimeout=10 $BUILD_HOST true`, then one disposable build-host-only operation under `$REMOTE_BUILD_SCRATCH` (for example a syntax check of a small script staged there). Verify actual tool-event exit codes and the remote artifact, and delete that disposable remote folder. A `docker exec` probe alone does not prove the agent's tool flow. Do not run a host-shell command, install a local SDK, mount the Docker socket or copy broad owner SSH credentials to pass this gate.

## Message gap and rollback threshold

Record measured apply/undo time, selected-session scope, missing capabilities and failed gates in the private acceptance report. A capped recent-session subset is an explicit exception, not a full last-week rehearsal. If an uncapped reduction exceeds the agreed budget, stop and delete it; never silently truncate it or claim acceptance. Directory rename does not copy state.db, but the full writer/metadata census, image startup and provider warmup can be longer. Reserve an owner-attended window and time each gate. If health is not up within the 120 s health budget, any privacy/routing assertion fails, jobs overlap, or recovery is unavailable: keep new messaging/cron stopped and undo immediately. Do not retry blindly with both copies active.

## Undo (also valid after failed apply)

```sh
wizard agent import hermes undo "$IMPORT_JOURNAL"
```

Undo removes only the labelled imported container (including anonymous volumes), restores original config/dotenv/cron bytes and quarantined data, moves the same home back, restores journalled default/main role if routing occurred, and starts only source units recorded active before apply. A changed pointer or unrelated settings/main-record edit is a **stop**, not permission to overwrite owner changes. Resolve the conflict with the recorded snapshots, then rerun. The returned archived receipt supports idempotent undo.

Restore any separately recorded alternate-launcher and recovery-runtime changes from the window checklist; the importer cannot undo unrecorded operator actions. Verify the exact original source path/inode/config hash, expected service active/enabled states, default/main role and agent list. Verify original messaging/cron once, then prove the imported target record/container/credential copies/transport archive are gone. Service-owned hidden canary pin/run receipts may remain as historical projections; do not edit its cached indexes offline or call those live agents.

## Aftercare

Keep only the non-secret acceptance report/journal and the verified encrypted remote backup. Delete transport archives, reduced rehearsal homes and any temporary scoped credential copies. Report before/after disk space and the measured interruption. Quarantine is reversible original data; schedule its encrypted remote archival/purge only after the owner accepts the new agent and the rollback window ends. Never leave a second active messaging or cron copy.


## Gate 5 — independent host recovery (proposed replacement/addition)

Implementation and isolated proof are available on `feature/hermes-agent-import`
(`c7bd959`, guide/link follow-up `4813fce`). See `docs/hermes-recovery.md` and
`EVIDENCE-RECOVERY.md`. **The proof did not deploy recovery on the live VPS and is
not approval to cut over.** Keep this gate open until the following production
checks are completed during the separately approved window.

### Why a separate HERMES_HOME, not a profile

Use `~/.hermes-recovery` with stock `HERMES_HOME`. A profile under
`~/.hermes/profiles` would move with the source. The recovery implementation also
exports the exact clean Hermes code revision and creates a new dependency venv
under `~/.local/share/wizard-recovery`; it never depends on the moved
`~/.hermes/hermes-agent` tree or its editable-package mapping/shebang. Preserve
the uv-managed base interpreter outside the source home.

### Before the move (approved owner action)

```sh
ops/agent-runtime/wizard agent import hermes recovery-home prepare \
  --source "$HOME/.hermes" \
  --home "$HOME/.hermes-recovery" \
  --runtime "$HOME/.local/share/wizard-recovery" \
  --port 8867 --acknowledge-host-access
```

This creates files only. It refuses overlap, existing targets, missing skills,
dirty source code and an occupied port. It installs/enables no unit, rewrites no
Service environment, changes no routing and starts no runtime. Source provider
and model are preserved; unsupported credential arrangements fail rather than
changing provider. No daily DB/history, cron, messaging configuration/tokens,
MCP or home plugins are copied. The recovery SOUL explicitly says James opens
it on purpose; only `hermes-agent`, `wizard-live-updates` and
`hermes-remote-operations` are included.

For this VPS's observed Anthropic/borrowed-Claude-Code route, recovery retains
the owner's actual HOME and uses the existing host Claude Code credential store
outside `.hermes`, with stock shared refresh locking. Confirm that the everyday
container has its own reviewed sign-in disposition. Never fork a writable
single-use refresh grant into two independently refreshing copies; if necessary
complete a separate login to **the same provider**, not a provider switch.

Start recovery using the rendered API-only listener, first as a plain process or
under a separately approved user unit. The rendered `recovery.service` is only a
template: choosing/installing/enabling a production name requires explicit
cutover approval. Do not use `hermes gateway` for this home.

```sh
R="$HOME/.local/share/wizard-recovery"
"$R/venv/bin/python" "$R/listener.py" "$R/recovery.json"
# Another owner shell:
ops/agent-runtime/wizard agent import hermes recovery-home probe --runtime "$R"
```

Record authenticated `/api/sessions` success, unauthenticated 401, and **one
owner-authorized same-provider model turn**. The fixture proof covered the HTTP
API, not real OAuth inference/refresh. Verify local shell, read-only Docker info
and user-systemd access; recovery has normal owner authority, not new root
privileges. Verify no messaging or scheduler process and no cron responsibility.

### Service route / registration (do not do this in rehearsal)

The existing main id `hermes` is the recovery slot; it remains an external
runtime. Do not create an ordinary container agent called recovery.

1. Record the previous Service environment/settings/main metadata and the
   chosen recovery unit's installed/enabled/active state in the window checklist.
2. Merge the private recovery runtime `agent-service.env` into the host Service's
   approved deployment configuration. It supplies the new loopback
   `HERMES_ORIGIN` and matching generated `WIZARD_HERMES_API_KEY`. This is an
   explicit upstream/key change; preserve the old values for rollback. Never
   print this file, key or owner proof. Preserve trusted owner ingress and
   `WIZARD_OWNER_PROOF_FILE` configuration. Do not replace the whole Service env.
3. Preserve/migrate Service-owned queues/read models and explicit file paths out
   of the moved home as a separate state-plane check. Merely repointing the
   upstream does not move those files. A containerized Service needs a separately
   reviewed route to the host; the recovery listener intentionally binds loopback.
4. After imported Archimedes is ready, run the already-required owner
   `route-default JOURNAL --acknowledge-cutover`. The importer now journals the
   real main metadata path **`agents/.main-agent.json`**, sets its role to recovery
   and selects the imported default. It does not apply the recovery Service env.
   Alternatively use the existing owner APIs after removing bindings/grants and
   changing the default; do not bypass the Service's promotion preconditions.
5. Apply the Service restart/reload only through the approved cutover mechanism.
   Read back the exact main recovery role, default and one authenticated recovery
   request through Service with explicit `?agent=hermes` owner selection. Prove
   anonymous/guest/agent-key callers cannot open it; recovery must not become a
   default, app member/binding, data-grant participant, model route or automatic
   queue/voice/background-work destination.

### Rollback

Importer undo restores the previous default and real main metadata, but does not
reverse unrecorded operator environment/unit actions. Restore the saved Service
upstream/key and any Service state-path changes, then restore the source
services using the existing cutover journal. Stop/remove only the separately
recorded recovery unit if the owner chooses; leaving recovery available is safe
provided it retains no cron/messaging role. Verify both original source and
recovery ownership explicitly rather than starting competing gateway copies.

### Isolated evidence already completed

Actual fake-home move into a throwaway Docker container preserved its directory
inode; original source-code path disappeared. A separately installed host
recovery runtime then answered authenticated sessions on its own port, rejected
unauthenticated sessions with 401, accessed host Docker and the systemd user bus,
and resolved only the maintenance toolsets/skills. The plain process, imported
container, temporary network and all temporary homes/runtime were removed; the
move was undone. No unit was installed/enabled and no live Service/gateway was
contacted. Live `~/.hermes/config.yaml` SHA-256 stayed
`f23e58e316a08a8965579ff00d70731f09779ff43ebfee9a95c5fdcaeef9be31`.

The implementation closes the **design/isolated-runtime proof** portion of gate
5, not production provisioning, real sign-in/model-turn proof or live Service
route/readback. Do not infer that other cutover gates have passed.
