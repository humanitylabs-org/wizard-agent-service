# Hermes owned open work

Each owned follow-up must plainly be started (a real handle and when it lands),
or a clear question asking the owner whether to start it. “Want me to start X?
Reply yes” is resolved as an owner decision; “say the word”, “if you want”, and
“mine to finish” without dispatch are not. A leading You/James/Owner label wins
over mentions of Archimedes later in the item. Hermes gets the additional
`OWNED_OPEN_WORK_INSTRUCTIONS`; the routed-agent prompt is unchanged.

## Evidence and enforcement

- `server/owned-open-work.mjs` is pure policy: extract explicitly agent-owned
  **Still open:** items, count successful handle-creating calls, and project
  unmet done/FYI reports as `status: running`, `wizard_waiting_on: owned_work`.
  Owner decisions (`needs_you`, `check`) and other agents are untouched.
- `server/owned-open-work-follow-through.mjs` reads the explicitly mounted Hermes
  `state.db`, read-only. It pairs assistant `tool_calls` with tool results by
  `tool_call_id`. Direct and deferred calls normalize `mcp__` prefixes; a single
  deferred call may return bare `{id, name, nextRun}` JSON (the name is the schedule
  title, not the tool). Multi-call wrappers require positional result envelopes.
  Calls after the triggering input pay for new items. Real retained earlier-turn
  handles in the same thread can pay for explicitly restated started/scheduled
  items; compaction does not revoke evidence. Reporter rewrites are not new runs.
  Unknown schemas or incomplete evidence are not treated as zero handles.
  Stream events omit results/arguments, are bounded and disappear on restart;
  the run queue alone misses native/locked runs. The persisted transcript is the
  common restart-safe source for both execution paths.
- A five-second watcher finds recent Wizard finishes without needing a browser
  open. It uses the **same private admission function**, durable queue and
  model-lock preparation as delegation follow-through. Its input starts
  `[Wizard follow-through]` and the existing Wizard history projection labels
  it `role: system`, `display_kind: run_context`, from `Wizard follow-through`,
  never an owner-authored message.
- A separate service SQLite file records a unique claim for the owner request
  chain as well as the triggering run/user and reply identity before admission.
  Retained human boundaries survive compaction; scheduled wakeups and reporter
  rewrites cannot authorize another correction in that chain. A genuine new
  owner request starts a new chain. Stable
  idempotency keys and service-only continuation metadata carry the identity
  through the normal queue. Admission and eventual dispatch revalidate the
  exact reply, request boundary, age and session lease. A newer owner turn or
  decision revokes authority. No claim is written into Hermes' database.
- Exactly one correction is allowed. Its own reply is never prompted again;
  if it still lists unmet work it falls back to FYI with its ask unchanged,
  without an owned-work spinner. Admission failures and expired authority also
  fall back without claiming work is running. An uncertain admission is not
  automatically retried by this policy (the durable queue owns transport retry).

## Follow-ups do not hold a verified finish

Only Hermes receives this distinction. A done/FYI reply must explicitly report a
verified/tested/fixed outcome before **Still open:**, identify optional follow-up
items as follow-ups, state they are started, and name exact handles created in
that reply's run. Only those matching handles are non-holding. A required helper
or heavy result still holds, including mixed required/optional jobs; a handoff
with no status, a check/owner gate, a prose-only or old handle, or an unverified
outcome never gets this exemption. This is deliberately narrower than accepting
earlier handles as credit for an explicitly restated schedule.

The existing heavy-status guard, heavy list wait, helper status/result projection
and supervisor-build wait all use those same identities. Work still executes and
returns its own result; it simply cannot suppress the already verified fix's done
alert. Required heavy-job false-done protection and routed-agent behavior remain
unchanged.

## Options

The installed entry point keeps automatic owned-work nudges off unless
`WIZARD_OWNED_OPEN_WORK=on`; the prompt rule still applies. The controller itself
is available for Hermes when `hermesStatePath` is explicitly provided and
`ownedOpenWork` is not false. Portable
HTTP-only installations do not expose complete tool-result evidence, so this
policy deliberately does not infer dispatch or start corrective runs there.
`ownedOpenWork: false` disables it, and the existing `followThrough: false`
ownership switch also disables it on staging services sharing Hermes.

`ownedOpenWorkStatePath` overrides the separate claims file; otherwise it is
beside `runQueueStatePath` (suffix `.owned-open-work.db`), or beside the mounted
Hermes DB (suffix `.wizard-owned-open-work.db`). Preserve this file with service
state across deploys. `ownedOpenWorkIntervalMs` overrides the watcher interval.
Tests can inject `ownedOpenWorkReader` and `ownedOpenWorkFinder` without an HTTP
backdoor or new public mutation route.

## Safe check after deployment

Run from the deployed release directory (Node 22.5+):

```sh
node scripts/verify-owned-open-work.mjs
```

Or, with the deployed release directory in `RELEASE`:

```sh
node "$RELEASE/scripts/verify-owned-open-work.mjs"
```

This imports the **installed release's** modules, creates a disposable synthetic
`state.db` under `TMPDIR`, feeds it a Hermes done reply with an undispatched
Archimedes-owned item, and asserts:

1. `before.status` is `running`, `before.wizard_waiting_on` is `owned_work`, and
   the status ask is `Starting the follow-up work it listed.`
2. Two evaluations produce exactly one **synthetic** continuation.
3. An unmet continuation reply becomes FYI with its original ask; no second
   continuation is created.

Expected JSON ends with `real_dispatches: 0` and `passed: true`. No owner state,
real run, scheduler, worker, deployed configuration or service is modified.
The integration regression in `tests/owned-open-work.test.ts` additionally
exercises the actual service session-list path, private continuation admission,
durable queue and history labelling against a fake upstream.
