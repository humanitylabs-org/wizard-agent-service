# Supervisor + Reporter release candidate

REUSE: `DurableRunQueue`, the scheduler's authenticated delivery/readback callbacks, existing main loopback token, per-agent gateway credentials and restricted Unix-socket admission, shared finish/status instruction delivery, and `parseStatus`.
EXTEND: Scheduler job/occurrence records and completion observation; managed harness assets and restricted stopped-home synchronization; four-kind agent acceptance fixtures. Existing live code is preserved.
NEW: `server/supervisor.mjs` is the service-owned ledger/outbox, `server/reporter.mjs` the reusable pure report checker, and `wizard-supervisor-tools` a supported Hermes plugin. These are back-end capabilities, not a second UI component; no front end is introduced.

## Baseline preservation

The candidate starts on `origin/main` at `d2c6cab` (includes the shared finish instructions and plain Ready asks). The live `f6381279b9e5f85077084b2bff2366387120f19c` was **not** wholly content-present in main: the diff had 19 files, including newer scheduler imports, owner-thread write protection and raw scheduled-output reads. A real merge of the live commit preserves those changes; the two acceptance-manifest conflicts were resolved by retaining **both** features/checks. The live merge commit is in this branch's ancestry. No live service or agent home was changed while building this candidate.

## Runtime and state

- `WIZARD_SUPERVISOR_STATE_PATH` overrides the ledger; default is `state/wizard-mobile/supervisor.sqlite3` alongside schedules. SQLite WAL, full synchronous transactions, private directory/file modes. Reports, reviews, questions, builds, outcomes and a frozen delivery outbox survive restart.
- At most two open reviews; queued reviews are retained. Exact `(agent, thread, client_report_id)` retries return the original report. No fuzzy deduplication.
- Thread identity comes from the Hermes plugin's injected `session_id`. Agent identity comes from the loopback capability or per-agent credential/socket; the active run is resolved by the service's run queue. No identity/depth/parent fields are model parameters. Standalone non-Wizard CLI runs refuse rather than guessing which run owns the thread.
- Private agents and standard agents with `shared_with_agents=false` refuse **before** history/queue reads or ledger writes. This is the explicit v1 privacy-seal exemption, not a runtime-kind exemption.
- Every question, review wake, build and closing notice is a normal queued run. Nothing steers an active turn. A review gets two questions; after 30 minutes an unanswered question wakes it with `no answer`. Builder completion reports wake the review; a terminal builder without a report wakes it with its final state.
- Review/builder thread IDs are mechanically mapped to their parent review and depth one. Even feedback from those threads never opens a new review.
- Closing notice choice: `internal_notification` is an internal user-ingress event filtered from normal history, not an assistant-authored visible text writer. Reuse the specified fallback: one idempotent ordinary run in the origin thread, queued until idle, instructed to reply with exactly the stored plain line. The model may still disobey; the service does not write directly into Hermes-owned history.
- Reports use `report: status|digest` (default status). Every non-reminder/non-return occurrence freezes the format and report mode. On completed output the checker records `report_lint`; a failure freezes one `:reporter` corrective request in the same thread. Its receipt and `report_final_lint` are stored. Ambiguous admission retries the same queue key; bad rewritten output never triggers another rewrite. Existing recognized silent replies stay silent. Reminder behavior is unchanged.

## Plugin and skills delivery

Source of truth:

- `hermes-plugin/wizard-supervisor-tools/{__init__.py,plugin.yaml,tools.json}` — six tools: report, ask, answer, build, lessons, close.
- `skills/reporter/SKILL.md` and `skills/supervisor/SKILL.md`.
- `server/supervisor-assets.mjs` owns the exact three installed namespaces. The Agent Service image now includes these sources. No Hermes core changes.

Main and host-profile agents own their own Hermes homes, so installing them is an **explicit parent release step**, never an automatic traversal of other profiles. With their runtimes/cron stopped during the release, run once for **each explicitly approved home**:

```
node scripts/install-supervisor-assets.mjs --hermes-home <main-or-profile-home> --attach-cron-reporter
```

This copies only the new plugin and the two skills. The optional explicit cron step appends `reporter` to active agent cron jobs, preserving existing skills, making a same-home original backup, and skipping script-only tasks. Main/alongside tools reuse `WIZARD_HEAVY_ORIGIN` and `WIZARD_HEAVY_TOKEN`; a host profile may instead use its own configured `wizard` MCP URL and `WIZARD_MCP_TOKEN`. Do not give a non-main agent the main loopback token. Start/reload Hermes only as part of the parent's release so the plugin is discovered.

For Service-managed containers, `writeHarnessFiles()` installs the bundle into the agent's `home/`. A hash in the managed config stamp detects changed assets and the existing managed-harness migration applies them. For restricted containers the service writes `managed/`; the existing stopped-runtime, no-network `sync_home()` copies just these namespaces into the owned home, refusing a symlinked parent. The plugin calls the existing `/wizard/mcp` tool gateway, still pinned to that agent's socket. No new edge routes or vendored-runtime edits are needed. An imported/custom harness retains its owner-managed update boundary: install the bundle explicitly into its approved home (or restricted `managed/`) during the parent release before starting it; no import is silently rewritten.

The plugin prefers main-only loopback when configured, otherwise reads the existing configured Wizard gateway URL and own credential. No redirects or proxy inheritance. Only Hermes-injected session identity reaches the request. The service rejects an absent/ambiguous active run. A privacy-sealed agent without a gateway receives a clear local refusal; one with a credential is refused by the service as well.

## Staging and release checks

This branch/PR is a **candidate only**. Parent owns merge/promotion, plugin installation and live restart. Do not run the live deploy command from this worktree. Build/package the existing Service Dockerfile on the shared worker if an image is needed; the source archive is sufficient for the parent's normal deployment route.

Required verification commands:

```
npx vitest run tests/supervisor.test.ts tests/reporter.test.ts tests/scheduler.test.ts tests/run-queue.test.ts tests/run-queue-retention.test.ts tests/routed-run-queue.test.ts tests/agents.test.ts tests/thread-status.test.ts
npm run test:agent-parity
uv run --no-project --with 'PyYAML>=6.0.2,<7' python tests/test_supervisor_plugin.py
python3 ops/agent-runtime/test_agent_runtime.py
```

Acceptance covers synthetic service transports and deterministic state transitions, not live model compliance, a live install, or a real restricted container restart. Parent must smoke a fresh visible review/build/close after promotion using disposable public feedback; never use existing private material as a probe.
