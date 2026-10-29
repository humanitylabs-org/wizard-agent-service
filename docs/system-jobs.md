# Host system jobs

System jobs are deterministic host commands: backups, reachability checks and disk maintenance. They do not open chats, consume model turns or belong to an agent. Agent schedules stay in `server/scheduler.mjs`; that scheduler still deliberately refuses `no_agent` work.

## Scope and reuse

- REUSE: Agent Service owner principals, bounded JSON/same-origin checks, SQLite `acquireLease`, cron-parser, and the existing `scheduleNotifier` → Notifications-slot app `notify` tool from the scheduled-alert work (#130).
- EXTEND: the Agent Service owner API and lifetime management with a host-only registry; the shared notifier selects and calls under the same main-agent identity.
- NEW: `server/system-jobs.mjs`, a backend host timer adapter/registry; `scripts/system-job-trigger.mjs`, a bodyless private IPC trigger; `scripts/system-jobs.mjs`, an owner console over the existing owner API. No new frontend, component, app, model tool, credential service or second notification transport.

Current milestone: Linux host installation, systemd **user** timers, owner console/API, disabled migration. Equivalent timer adapters can implement `apply(job)` later. A shell settings view and container-to-host remote executor are deliberately not included. A containerized Agent Service must not turn on this host mode or mount the host control directory into agents. These commands run on the machine hosting the service; an imported check which contacts another machine remains a normal host command, not a newly provisioned remote worker.

## Authority and provisioning

All switches default off/unset. Provision these explicitly on the **host Agent Service**, not an agent:

| Environment key | Meaning |
| --- | --- |
| `WIZARD_SYSTEM_JOBS_STATE_PATH` | Absolute service-owned SQLite registry path; provision alone to inspect/import without timer execution. |
| `WIZARD_SYSTEM_JOBS_IMPORT_HOME` | Explicit read-only Hermes source home (prefer an exported snapshot with `cron/jobs.json` and script references). No inferred home and no source writes. |
| `WIZARD_SYSTEM_JOBS` | `1` starts host timer reconciliation, private IPC and notification retry. |
| `WIZARD_SYSTEM_JOBS_SOCKET` | Short absolute Unix socket path (under a host-only 0700 directory; socket 0600). |
| `WIZARD_SYSTEM_JOBS_UNIT_DIR` | Absolute user systemd unit directory recognized by this service user's manager. |

A production host must already have a usable systemd user manager and persistence after logout (lingering or equivalent). Provisioning it is an operator action, never performed by the importer. The service's own systemd unit must use `KillMode=control-group` (the systemd default), so a service process crash/stop cannot leave child commands executing alongside a replacement service. Do not run this host execution mode in an agent container. Keep the registry, socket and timer directory off every agent mount. SQLite state and WAL files belong in a private directory, not a shared owner-files folder.

Exactly one Agent Service writer holds an OS-released SQLite exclusive lease for the registry's entire lifetime, including same-process instances. A second writer refuses startup before timer reconciliation or IPC cleanup. Unit names contain generated safe IDs, never owner text. Only this writer generates units or changes the registry; timer processes merely send a bodyless due-job trigger. No legacy cron or crontab writer is involved.

The service computes the next occurrence with cron-parser in an explicit IANA timezone and writes a single UTC `OnCalendar` instant, with `Persistent=true`. This avoids silently changing cron's day-of-month/day-of-week OR semantics or DST rules by translating the expression to systemd syntax. The host timer is the only schedule clock: no polling execution loop. After a due callback, the next timer is armed before the command starts. Missed intervals coalesce to one occurrence; no backlog storm. A future/stale, disabled or overlapping callback is refused. One-shot definitions turn off after their single admission. Editing/disabling future times does not stop an active command.

On restart, enabled timers reconcile from the registry; unfinished executions become `interrupted` and queue a failure notification. They are **not automatically replayed**: a backup or cleanup may already have made changes. Graceful stop kills active process groups and drains their outcomes before releasing the writer lease. Timer-update errors are visible on the definition and queue a failure notification; enable/update and startup reconciliation fail closed. A timer IPC failure is also visible in the user's systemd journal; the Agent Service must be available for scheduled admission. This feature does not claim to survive an unavailable Agent Service as an independent daemon. Systemd preserves the outstanding timer time for service recovery.

## Owner console and API

Use the ordinary owner ingress with the owner proof: the service reads it from `WIZARD_OWNER_PROOF_FILE` (host mode refuses to start without one, and the system-jobs API accepts only that proof, never a credential-less box caller or an access header), and the CLI sends it from `WIZARD_OWNER_PROOF`, supplied by the deployment secret store. `WIZARD_ORIGIN` selects the service. HTTPS is required except for loopback. Credentials are environment key names only; never put values in command arguments or job definitions.

```sh
node scripts/system-jobs.mjs list
node scripts/system-jobs.mjs create < definition.json
node scripts/system-jobs.mjs edit JOB_ID < changes.json
node scripts/system-jobs.mjs enable JOB_ID
node scripts/system-jobs.mjs run JOB_ID
node scripts/system-jobs.mjs disable JOB_ID
node scripts/system-jobs.mjs import < import-options.json
```

The list shows the name, ID, enabled state, schedule/timezone, last-run time, outcome and timer errors. The owner API is `/wizard/v1/system-jobs`: `GET` lists; `POST` creates disabled; `PATCH /:id` edits/enables/disables; `POST /:id/run` with `{}` admits once; `POST /import-hermes` previews/imports. Agent and internal service credentials are not owner approval. No new model tool can enable host execution. Writes reuse same-origin JSON enforcement.

Example generic definition (paths are deployment-specific, not baked into service code):

```json
{
  "name": "Daily backup",
  "command": ["/usr/local/bin/encrypted-backup"],
  "cwd": "/srv/maintenance",
  "when": {"cron": "0 3 * * *"},
  "timezone": "Europe/London",
  "timeoutSeconds": 3600,
  "envKeys": ["BACKUP_PASSWORD_FILE"],
  "notify": "failure"
}
```

Schedules support one of five-field `cron`, `every` (whole minutes, 1–525600), or `once` (ISO timestamp with offset). `command` is an argument array, never implicitly a shell. Use an explicit interpreter when required. Commands inherit only `PATH`, `HOME`, `LANG`, `TZ` and explicitly chosen environment **key names**. Do not put secret values in arguments; use existing deployment environment/file references. Choose a stable interpreter for Python environments and verify the working directory/dependencies before enabling. These are owner-trusted host scripts with the service user's authority, not a sandbox for untrusted programs.

## Notifications and output

Failure, spawn error, timeout or interrupted execution queues a plain-language notice in the same Notifications app path as scheduled agent alerts. Raw command, exception and stderr text are never included. `notify: "failure"` is the default and discards stdout as well. `notify: "output"` explicitly opts into sending successful nonempty stdout (first line title, remaining text message); empty output or `[SILENT]` remains quiet. This is for watchdog scripts whose output is already owner-safe. Capture is bounded at 16 KiB; oversized output is discarded rather than leaking partial logs. Existing `notificationFromOutput` parsing is reused. Nonzero exits still send only the generic failure notice, even with output enabled.

Notifications persist in a SQLite outbox and retry every 30 seconds while host mode is active, without the six-hour aging bug reviewed on #130. An unavailable app or revoked bridge capability leaves delivery pending. As in #130, delivery is **at least once**: the app's `notify` tool has no supported occurrence-id parameter. A crash after app commit but before local acknowledgment can duplicate a notice; it cannot silently drop it. The adapter receives a stable occurrence key for a future app-supported idempotency contract. No parallel thread/Helm/ntfy transport was added.

## Hermes migration and cutover

1. Export/copy the source `cron/jobs.json` into a read-only snapshot outside live runtime state. Import reads that one explicit snapshot; it never edits Hermes cron, state.db, config, services or timers.
2. Preview with `{"dryRun":true,"timezone":"SOURCE_IANA_ZONE"}`. `ids` can select source IDs. Source IDs must be valid and unique; invalid identifiers are rejected, not repaired. Agent jobs are skipped; only `no_agent: true` with a script is admitted. Unsupported/chained/finite-repeat definitions are rejected for review.
3. Import with the same options and `dryRun:false`. Every imported definition is **disabled**, regardless of the original enabled state. Reimport is idempotent across restarts and never overwrites an owner-edited/enabled definition. No timers are installed by import.
4. Review each imported command, working directory, interpreter, secret references, dependencies and timezone. Relative Hermes scripts resolve under the selected source home's `scripts/`, with the existing shared canonical-path guard rejecting traversal and symlink escapes; `.sh`/`.bash` use bash; Python keeps an explicit absolute `interpreter` when present, otherwise starts as `python3` for owner review. Without an explicit working directory, commands retain the script's parent directory as cwd. The snapshot must not replace the actual retained script path at execution time: edit the command to its permanent host location before deleting a snapshot. Work referring to a moved machine/path needs an owner edit, not generated per-owner service code.
5. Decide whether each watchdog's successful output should become a notification (`notify:output`). Existing scripts that post through old delivery services need their deployment configuration updated; the importer cannot rewrite arbitrary script internals or guarantee their side effects. It never runs an imported script to inspect it.
6. At the owner's coordinated cutover, stop the corresponding old scheduler authority outside this feature, then explicitly enable **one reviewed job at a time** and run/check it. Do not enable both schedulers for the same maintenance task. The importer cannot prove an old cron is stopped and does not turn it off. This PR performs no actual cutover.
7. To roll back, disable each enabled Wizard definition first, confirm no active execution, then restore old scheduler authority. Do not remove lock inodes or copy a live SQLite registry while its writer is active.

The migration map's host-script bucket is input for selecting IDs, not an embedded owner-specific list. There is no owner name, machine inventory, backup command or copied credential in the implementation.

## Evidence

`tests/system-jobs.test.ts` uses synthetic jobs, isolated Hermes snapshots, fake systemctl and a private fixture Unix socket. It covers disabled import/reimport, per-job enable, real child success/failure/timeout, owner list/API, failure notification/retry, second-writer refusal (same and child process), overlap/one-shot/missed intervals and safe unit rendering. It never installs a live timer or reads live Hermes state. Existing scheduler tests remain part of regression coverage; CI runs the complete repository suite.
