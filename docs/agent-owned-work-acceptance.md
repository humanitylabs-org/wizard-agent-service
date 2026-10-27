# Agent-owned work must stay in Working

## Shared implementation

- REUSE: existing helper receipt admission, machine-authored receipt prefix and idempotency key; no transcript or Hermes database writes.
- EXTEND: shared owner-result/request boundary, continuation watermark and session truth to retain genuine requests across context compaction.
- EXTEND: shared list projection and its snapshot/per-thread cache stamps with the existing Supervisor build/review ledger.
- NEW: `server/supervisor-wait.mjs`, a read-only, bounded projection for that ledger; no second builder scheduler or delivery path.

## Contract

A request made inactive by compaction still supersedes an older owner gate. Machine rows never become owner requests. A genuine `needs_you` or `check` after the latest real request still wins. Recovered helper results stay agent-owned until answered, using the existing follow-through watcher for continuation admission. If the delegation ledger was already cleaned, a typed machine completion plus its matching structured tool dispatch can provide a new witness; the dispatch timestamp supplies the conservative two-hour deadline, so delayed completion delivery cannot renew authority. A plain user-pasted completion marker, missing or changed dispatch, or stale dispatch still fails closed.

Supervisor parents remain in Working while an open review has an unreported build, including a builder whose initial dispatch run ended to wait for its own helper. Waits expire after twelve hours from build creation, with legacy rows using the builder session start. Reporting, closing the review, or a builder final answer subsequently integrated into the parent's final answer releases the wait. A premature parent `done` does not settle an unfinished builder. Ledger transitions invalidate both the list snapshot and the individual parent row.

## Regression coverage

`tests/owed-helper-work.test.ts` exercises the real list API and the existing automatic follow-through watcher, covering:

- a thread whose helper results arrive after compaction stays in Working until answered;
- a supervisor thread waiting on its builder stays in Working;
- an older owner gate versus an inactive latest genuine request;
- real post-request owner gates, machine-input exclusion and compacted supersession;
- receipt idempotency, terminal answer release, builder dispatch ending, reporting, review closure, legacy timestamps and bounded expiry.

Live acceptance must separately show the recovered continuation is machine-authored and the Config drift thread is running or has a real answer. A read-only shadow comparison is evidence of projection behavior, not proof of deployment or continuation admission.
