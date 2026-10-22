# Bring your Hermes — NO production cutover performed or authorized

## Current decision: sealed Archimedes, no new root surface

James, 2026-10-22: use existing agent-bound heavy jobs on day one. No sudoers
line, firewall change, host TCP relay, SSH proxy, Thales key or raw shell route.
Machines is a separate design lane. This supersedes the previous TCP/SSH runbook.

- Service PR: humanitylabs-org/wizard-agent-service#85.
- Working branch: `feature/hermes-agent-import`, merged with current `main`.
- Preserved old work: `feature/restricted-declared-tcp-egress-archive` at
  `db1a0e9d4a9e6030ac728d97b1f9462e2eab80ce` (pushed before removal).
- Existing main sidecar source/image only; no new sidecar build is required.
- Private host evidence: `EVIDENCE-RESTRICTED-3.md` in the owner's import scratch.

## Separate release prerequisite (not permission to change live services)

Deploy reviewed Service/host-helper support only in a separately authorized
release. A live Service without imported-harness guards can overwrite imported
configuration on later UI changes. Do not install just the CLI in isolation.

The Service must expose `import_capabilities` on owner `GET
/wizard/v1/agent-options`, with `socket_prepare:true`, `heavy_enabled:true`,
`heavy_sandbox:true`. Its existing relay requires `WIZARD_AGENT_HEAVY=on` and
`WIZARD_AGENT_HEAVY_SANDBOX=on`. No rehearsal may restart, reconfigure or stop
Service, the main gateway, Private, or Tailscale to obtain these settings.

The owner-only `prepare-import` action provisions only a reserved importing
agent's Unix gateway socket. It does not invoke Docker/runtime or rewrite the
home. Admission health runs over `gateway/ingress.sock`, never a published port.

## Reduced-copy rehearsal (not full-home acceptance)

1. Verify source config hash and before-disk/agent-list baseline. Verify the
   preloaded `restricted-agent-sidecars:local` contents match main. Fail before
   any copy/registration if live Service capabilities are absent.
2. Never copy the live large `state.db`. Read it through a bounded last-week
   reduction and create a fresh reduced DB; keep total source copy <2 GB and
   reduced DB <500 MB. Preserve actual identity, skills, memory backend/facts.
   Mark imported sessions hidden; pause all cron and disable messaging.
3. Review every `credentials` item. James approved the existing GitHub OAuth
   `hosts.yml` as one explicit file grant (2026-10-22), scopes `gist`, `read:org`,
   `repo`, `workflow`: same authority as main, not a Private-seal change. Carry
   no owner proof, Docker credential, host heavy token or SSH directory/key.
   Agent-owned HTTPS gitconfig resets helpers then uses `!gh auth git-credential`.
   Provider sign-in stays on the source provider; never rotate a shared refresh
   credential. Use only explicitly approved access-only rehearsal inputs.
4. Approve the separate `grant_items` entry `grants.heavy` and set
   `grants.heavy:true`; James approved this for Archimedes 2026-10-22. All choices
   are covered by the approval hash. Keep unknown dependencies unapproved. Scan
   warnings `needs Machines/heavy job` are not implicit authority grants.
5. Apply only the copied paused home as `archimedes-rehearsal`. The registry
   allocates its network pair; external fsynced journals support crash-safe undo.
   Preserve inode, seal uid/gid 10000 and mode 0700; approved workspace is RW,
   context RO, with no owner-home, Docker or Private-agent mount.
6. Record literal uid-10000 exit codes for `gh auth status` =0,
   `git -C <workspace>/wizard-os fetch --dry-run` =0, workspace write/delete =0,
   context write refused, no docker.sock, Private-agent path absent, host uid
   1000 unable to read sealed home, no published ports, and SSH to Thales/VPS
   both refused. Confirm paused cron, disabled messaging and grant readback.
7. Through the live Service CREATE session → PATCH `hidden:true` → GET literal
   true **before any message**. Fail closed otherwise. Run one original-provider
   `anthropic/claude-opus-5-5` turn: actual `gh auth status`, existing fact_store
   recall, and one `wizard_heavy_submit` using this agent's own key. Tiny light
   probe: `argv:["/usr/bin/uname","-a"]`, timeout 60, stable key
   `hermes-import-rehearsal-heavy-probe`, and the assigned per-agent worker root.
   Observe Service/worker receipt at bounded intervals (up to ~5 minutes), require
   terminal `completed`, exit code 0 and correct agent/session binding. Never
   use the host-heavy route or claim pending/queued means completed.
8. Always attempt undo, reduced-copy/journal deletion and agent-list/config
   readback even after failure. Record apply/undo seconds, free disk before/after,
   no rehearsal containers, no copied credentials, unchanged live config hash
   and unchanged service activity. Preserve recovery files only if undo fails.

## Cron / outside-machine dependencies

Inventory live `cron/jobs.json` read-only; list names/purpose/mapping privately.
Do not edit, disable or migrate original jobs in rehearsal. Keep scheduled jobs
paused in the copy. Host reachability/watchdogs, resource cleanup, backup health,
restore/FTS recovery and host-service repair remain with the recovery host for
now. Stage/test/build jobs may map to scoped heavy jobs; source staging, logs,
artifact retrieval, disk checks and machine administration require explicit job
contracts or the future Machines component, not a backdoor SSH route.

## Current rehearsal result

Rework tests pass in an isolated HOME/HERMES_HOME/WIZARD_OS_HOME/TMPDIR. The actual
live attempt fails before copying: the unchanged live Service has no
`import_capabilities`/socket-only preparation API, and agent-heavy enable/sandbox
flags are absent (relay defaults off). Existing main sidecar image contents match
the updated main source after PR #92 merged. No new image or pending build submit
is needed. No apply/undo was run; all live execution gates remain open. Evidence
records the literal failing code and baseline/cleanup readbacks. Do not deploy or
reconfigure the Service within this rehearsal to make the test green.

## Production remains NO-GO

A reduced-copy pass does not authorize a live move, default change, messaging or
cron takeover. Still require an owner-attended approved window, verified encrypted
remote backup, full-home compatibility/scope evidence, writer/future-launcher
fence, independently working recovery, renewable same-provider sign-in, and
qualified old/new thread/default routing tests. Keep Service-owned queues and
files independent of the moved source. Do not fabricate a second recovery by
labelling the still-live original main record.

Independent recovery preparation and rollback design: `docs/hermes-recovery.md`.
It uses a separate HERMES_HOME/runtime, not a profile beneath the moved source.
Preparing recovery files is not permission to deploy/start/repoint a live unit.
Any future cutover journals its exact service/routing state and restores it on
rollback. One messaging/cron writer only. Never enable a second scheduler copy.

## Undo contract

Use the external `imports/<id>/journal.json`, including after failed apply. Undo
locks the same lifecycle file, holds admission, downs only the imported compose
project, reverses sealed rename into private staging, restores original bytes and
inodes and removes only import-owned assets/credential copies. Partial backups
never become rollback inputs. Pointer/default conflicts fail closed. Read back
source inode/config, restored original agent list, absent import target/container
and copied credentials. No original unit is changed during paused rehearsal.
Retain only non-secret evidence and verified remote backups after cleanup.
