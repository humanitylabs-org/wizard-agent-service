# Wizard scheduler — backend slice 1 (#47)

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
  otherwise new jobs/imports use the current owner `clock.timezone` setting
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

Set `HERMES_HOME` explicitly. `{ "dryRun": true }` reads
`<HERMES_HOME>/cron/jobs.json` **read-only**, validates it, and previews paused
copies without changing either store. `{ "dryRun": false }` creates paused
copies of supported `schedule.kind: cron/interval/once`, name, prompt/skills,
and model. Repeating import (including after restart/deleting a copy) reports
`already imported` using a durable source-job ledger. There is no automatic
switch-over or source write. Script/no-agent jobs report exactly
`not imported: script job`; malformed/unsupported jobs are reported individually.

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
