# Wizard scheduler — backend slice 1 (#47)

Deterministic host commands (backups, watchdogs and disk maintenance) have a separate [host system jobs](system-jobs.md) owner registry and systemd user timers. Agent prompts stay here; script-only migration is disabled by default and never writes the Hermes source.

The Agent Service owns schedules. It does not scan cron output, append finished
reports to Chats, or run another agent's cron process. A scheduled occurrence is
an ordinary run in the destination thread; Hermes writes the answer there.

## Activation and state

- **Off by default.** Only `WIZARD_SCHEDULER=1` starts the timer. CRUD/import and
  explicit **run now** remain available without the timer. This PR does not
  deploy anything, disable Hermes cron, or change an installer's configuration.
- `WIZARD_SCHEDULER_STATE_PATH` overrides the SQLite store; its default is
  `<HERMES_HOME>/state/wizard-mobile/schedules.sqlite3` alongside the run queue
  (the existing home-resolution convention applies when HERMES_HOME is unset).
  The service's normal authority-directory lease also covers this store.
- `WIZARD_SCHEDULER_TIMEZONE` overrides the owner's default IANA timezone;
  otherwise new jobs use the current owner `clock.timezone` setting
  (default `Asia/Bangkok`). Each job can override it. UTC occurrence keys are independent
  of timezone/DST. `cron-parser` handles five-field cron and DST.
- The loop checks every 15 seconds and drains on service shutdown. State uses
  WAL + `synchronous=FULL`; the directory/file are owner-only on creation.

## API

All routes have the existing owner/service principal and configured Access
checks. Agent/container credentials cannot manage schedules. Cross-site browser
requests are rejected. Bodies are bounded to 128 KiB.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/wizard/v1/schedules` | `{schedules: [...]}` |
| POST | `/wizard/v1/schedules` | Created job (201) |
| PATCH | `/wizard/v1/schedules/:id` | Edited job; `enabled:false/true` pauses/resumes |
| DELETE | `/wizard/v1/schedules/:id` | `{deleted:true}` |
| POST | `/wizard/v1/schedules/:id/run` | Durable occurrence receipt (202), then ordinary run admission |
| POST | `/wizard/v1/schedules/import-hermes` | `{dryRun, results:[...]}` |

Example create body:

```json
{
  "name": "Project · Feature",
  "when": {"cron": "0 9 * * *"},
  "timezone": "Asia/Bangkok",
  "agent": "main",
  "prompt": "Report material changes only.",
  "enabled": true
}
```

`when` has exactly one key: `cron` (five fields), `every` (minutes, at least 1),
or `once` (ISO timestamp with an explicit offset/Z). `model`, `skill` and
`thread` are optional. At least one of prompt/skill is required; skill execution
is an instruction to load and follow the named skill, not an arbitrary script.
`agent:main` maps to the registry's main Hermes agent. Other agent IDs use the
same existing routed-agent send API; absent/recovery agents fail closed.

Omitting/nulling `thread` reserves a stable session ID at first occurrence,
then creates it with the job name (`Schedules · <name>` if no middle-dot title
was supplied). Subsequent runs use the same thread. An existing session ID is
not re-created. Changing agents on a bound job requires an explicit thread
choice. Model overrides travel in the ordinary run/session payload.

### Delivery: thread or notification

`deliver` is `thread` (default) or `notification`. A thread job posts its answer
into its chat thread as today. A `notification` job is a one-way alert with no
conversation to own it (watchers, health checks, "tell me when"): the run still
happens in its thread so history is kept, but its input tells the agent to write
only a short title line plus one or two sentences and to end with `[SILENT]`, so
the thread stays quiet. On completion the service sends that text to the box's
`notifications` slot (the `slots.notifications.default` app in `apps.json`, else
the only running provider) through the agent bridge's `notify` tool. `lastRun.outcome`
is `notified`. A failed send records `failed` with "Notification not delivered; will
retry" and retries on the next refresh. Notification occurrences stay observed for 7 days (other runs: 6 h), so a long run or a slot
outage still sends. The scheduler reads the run with `X-Wizard-Schedule-Raw: 1` plus its internal token, so it sees the
text before the `[SILENT]` display scrub; owners always get the scrubbed view. Delivery is at-least-once: ntfy has no
client idempotency key, so a send whose reply is lost is sent again (a duplicate bell row beats a lost alert). An empty or stopped slot is checked when the
occurrence is claimed: that occurrence is delivered to the thread instead, so nothing
is lost. `kind: return` (Boomerang) is always a thread. Reports the owner replies in
stay `thread`.

## Idempotency, recovery and catch-up

One SQLite transaction inserts the immutable occurrence outbox payload and
advances the job's next-occurrence cursor. The key is exactly
`schedule:<jobId>:<scheduledInstantISO>`. The session identity and exact run
payload are frozen before external calls. The existing authenticated internal
`deliveryCall` (also used by share delivery) calls the ordinary session-create
and run-admission routes, including the durable main-agent queue and its
payload/idempotency checks. A successful admission acknowledges the outbox;
a lost response retries that same key/body, never a second output-post call.
Other agents retain their ordinary runtime's idempotency contract.

The occurrence ledger has **no seen-list cap**. Schedule-keyed main queue
receipts are also excluded from terminal retention, so a crash between admission
and scheduler acknowledgment remains deduplicable after a long outage. This
intentionally trades small persistent growth for delivery safety. Back up the
scheduler store together with the run queue; deleting either authority is not a
supported deduplication reset.

After downtime/forward jumps, each due job claims only its latest missed
instant and advances straight to the future. If an earlier admission is still
uncertain, it retries only that pending receipt instead of also creating a new
catch-up. Duplicate/concurrent ticks and backward clock jumps cannot rewind
the cursor. A once-job is disabled at claim time, and its original occurrence
key survives pause/resume/restarts. Resume of a recurring paused job starts a
fresh interval/future cron boundary rather than replaying paused windows.
Manual runs are explicit new occurrences at the request instant; requests in
the same millisecond coalesce. Pausing does not cancel an already claimed run;
deleting cancels unadmitted outbox entries but never removes idempotency history.
A 202 run-now response is a durable receipt, not proof the agent has completed
(or even admitted) the run. With the timer off, failed manual admission retries
on the next manual request or when scheduling is enabled. Errors stay pending
without reflecting arbitrary upstream exception/credential strings into state.

### Last and next run (additive read-only projection)

Every job in GET and the job returned by POST/PATCH includes:

```json
{
  "lastRun": {
    "scheduledFor": "2026-10-21T00:00:00.000Z",
    "startedAt": "2026-10-21T00:00:01.000Z",
    "finishedAt": "2026-10-21T00:00:09.000Z",
    "outcome": "posted",
    "error": null
  },
  "nextRun": "2026-10-22T00:00:00.000Z"
}
```

`lastRun` is null before any occurrence. Otherwise it is the latest durable
occurrence by scheduled instant (including run-now), never the job's edit time or
unrelated activity in its destination. `outcome` is `running` after admission or
while queued/running, `posted` for completed nonempty visible output, `notified` when a `deliver: notification`
answer reached the notifications slot, `silent` for
completed empty/[SILENT] output, and `failed` for failed/cancelled/interrupted runs
or an admission failure awaiting exact-key retry. Admission is not completion.
`error` is null or short service-owned copy; raw upstream errors/output are never
copied into this projection. Admission retry clears its error on success.

Run status is refreshed on the scheduler tick and before GET/PATCH via the ordinary
exact run-ID/agent route. Last observations persist in the existing occurrence
SQLite ledger (additive schema migration); completed observations survive restart
and upstream retention. A lookup outage preserves the durable observation, not a
fabricated failure. `startedAt` is nullable until known (or first observed running);
`finishedAt` is nullable until terminal and uses runtime time when provided, else
first terminal observation time. Old receipts can be enriched by exact-ID lookup;
unavailable upstream history cannot retrospectively recover exact timestamps.

`nextRun` is a UTC ISO rendering of the durable `nextAt` cursor for enabled
cron/interval/once jobs, null while paused or after a claimed one-shot (including
pause/resume). It describes the schedule cursor, not a promise of worker capacity
or proof the opt-in timer is active. Existing numeric `nextAt` remains for
compatibility. Both new fields are read-only and rejected in write bodies.
Clients format these ISO instants in the owner's clock timezone and retain an
unavailable fallback when connecting to older services without these fields.

## Reminders and onboarding tips from chat (`server/onboarding.mjs`)

The `wizard` MCP gateway serves two built-in tools beside `wizard_apps` whenever the scheduler has state, so any
agent on any box (container agents included, which never load the host-only `wizard-schedule` Hermes plugin) can:

- `wizard_remind` `set` / `list` / `cancel`: a `remind` job for the calling agent (`when` is `morning`,
  `overnight` or an ISO timestamp with offset). It arrives in its own `Reminder · …` thread.
- `wizard_tips` `start` / `stop` / `status`: the opt-in five-day drip. Five one-shot `remind` jobs share one
  service-chosen thread titled `Wizard · Tips` (`group: wizard-tips`): tip 1 a minute after opting in, tips 2–5
  at the next 08:30 owner-time mornings. Starting again while tips are pending is a no-op.
- `wizard_follow_up` `create` / `list` / `stop` (`server/follow-ups.mjs`): a `watch` job bound to the calling
  agent's current thread (spec/thread-follow-up-watchers.md). A routed agent may watch only a thread it owns; the
  main agent reaches it through the `wizard-os` plugin, which injects its session id, so it is unlisted for main.

The thread, title and group are set by the service (`Scheduler.create(input, placement)`); the HTTP body cannot
supply them. When the timer is off (`WIZARD_SCHEDULER` is not `1`) both tools answer with an error instead of
saving a job nothing would deliver. The Runtipi package sets `WIZARD_SCHEDULER=1`. The `wizard-guide` system
skill (wizard-app-manager `system-skills/`) tells the agent when to use them.

## Silent reports

`[SILENT]` at either boundary of the final answer (ignoring a Wizard status
trailer) suppresses the **whole answer**, not just that token. The existing
message/status projection marks it hidden/empty; the Wizard history projection
drops it, and the preview plus canonical session-truth readers exclude it.
The synthetic `[Wizard schedule]` input is internal too. Neither advances the
last visible assistant/user/activity clocks used by unread state. Canonical
Hermes history is not rewritten and the service never marks a whole thread
seen, which could swallow a concurrent real reply.

Scheduled SSE text is delayed until terminal completion so a trailing sentinel
cannot flash on screen; silent terminal output is empty. Non-silent scheduled
reports appear at completion. Buffering is bounded and fails closed for
unterminated/oversized text; full history is still authoritative. Ordinary
interactive streaming is unchanged.

## One-time, paused Hermes import

Set `HERMES_HOME` explicitly. `{ "dryRun": true }` (the default) reads
`<HERMES_HOME>/cron/jobs.json` and optional `config.yaml` **read-only** and
previews paused copies without changing either store. `{ "dryRun": false }`
creates paused copies of supported `schedule.kind: cron/interval/once`, name,
prompt/skills and model. The first skill maps to `skill`; remaining skills become
“Also load and follow…” prompt lines. All source rows are considered, including
paused/completed rows; every imported copy has `enabled:false`.

Import timezone precedence is **row `timezone` → top-level Hermes config
`timezone` → `UTC`**, never the Wizard owner clock. Missing config is fine;
unreadable/malformed config or an invalid configured timezone fails the request
rather than silently shifting jobs. The optional `threads` map binds source job
IDs to existing Wizard chat IDs, using the same identifier validation as schedule
`thread`. Without a mapping, the first occurrence creates its usual new chat:

```json
{ "dryRun": true, "threads": { "source-job-id": "existing-thread-id" } }
```

Each result includes `status`, `timezone`, `nextRun` (UTC ISO), `thread` and
`promptLength` (the final stored prompt's JavaScript string length). Unlike the
ordinary paused job projection, import `nextRun` previews its candidate cursor
**if enabled**, even though the copy remains paused. Unsupported rows have null
`nextRun`/`promptLength`; malformed rows have null unavailable fields. Existing
imports show their saved copy's fields, or null fields if the copy was deleted.
`already imported` uses the durable source-job ledger across restart/deletion;
a repeated request does not retarget or rewrite the saved copy.

Agent jobs with a pre-run `script` get an instruction to run its shell-quoted,
absolute path under `<HERMES_HOME>/scripts/` first in the terminal and use full
stdout as context. Paths escaping that directory (including existing symlinks)
are rejected. `.sh`/`.bash` use `bash`; other extensions use the row's Python
`interpreter` when supplied, otherwise `python3`; existing interpreter symlink
targets must also have a Python executable name. The command uses an existing
absolute row `workdir` or the script's parent directory. An explicit usable
workdir also becomes a whole-turn instruction: resolve relative paths there,
explicitly cd for later commands, and load the project's applicable AGENTS.md.
This establishes context by instruction, not a persistent runtime cwd change.
The prompt requests configured `cron.script_timeout_seconds` (default 3600), reports script errors,
and suppresses empty output or a final JSON `{"wakeAgent":false}` gate.

Every imported prompt ends with a generic delivery override: the final answer
is posted in this Wizard chat, not sent by a separate chat-posting script/tool;
`[SILENT]` is only for genuinely empty reports. Pure `no_agent` jobs remain
unimported with the status:
`not imported: script-only system job (no agent turn) — move to a host timer or Supervisor health check`.
Malformed/unsupported jobs are reported individually. Import never executes a
script, disables Hermes cron, modifies its source, or enables a migrated copy.

**Fidelity limits:** Hermes' live clock also considers `HERMES_TIMEZONE`, managed
config overlays and server-local time; this file-based importer intentionally uses
the portable precedence above. Hermes executes pre-run scripts *before* the
agent, with its selected runtime/managed Python environment, sanitized env,
redaction, lifecycle/prompt-injection guards, cancellation and process-tree
termination. Wizard's imported pre-run is an agent instruction, not an equivalent
host executor: dependencies/paths must be available to that agent, its terminal
limits still apply, and an empty/wake-gated run still starts an agent turn.
Hermes-specific repeat counts, runtime context/notepads and delivery transports
are not migrated. Review the preview before enabling copies, and disable the
corresponding Hermes jobs separately to avoid running both schedulers.

## Verification

`tests/scheduler.test.ts` is discovered by normal `npm test`. It covers restart
and ambiguous-admission dedupe past queue retention, concurrent/duplicate
ticks, downtime, rollback/DST/timezone behavior, one-shot resume, CRUD/auth,
thread reuse, feature flag/lifetime, silent history/preview/unread and fragmented
SSE, plus read-only paused import and re-import safety.

Run the ordinary full suite single-worker with isolated HOME, HERMES_HOME,
WIZARD_OS_HOME and TMPDIR (no developer cron/state reads):

```sh
node scripts/test-isolated.mjs
```

Scheduling UI, MCP schedule management, templates and installer cron cut-over
are separate slices. Do not enable both schedulers for the same migrated jobs.
