# Helper-status backend repair handoff

Scope: `feature/helper-status-preview`, based on `743046b`. Backend only; no deploy, push, merge, Hermes core changes, or Stock-lane integration.

## Repairs

- Continue requires JSON, validates Origin against the actual Host, rejects non-same-origin fetch metadata, and ignores forwarded/internal-header authority. No-Access loopback installations additionally reject DNS-rebinding Host/Origin equality. Public no-Access proxy deployments must set `WIZARD_HELPER_CONTINUE_ORIGINS` to their exact comma-separated browser origins; Access-protected deployments retain the existing validated outer authorization.
- Authenticated Continue and the automatic watcher share one private, in-process admission closure, delegation idempotency key, and request watermark. There is no unauthenticated self-fetch or externally addressable internal-admission bypass.
- Request watermarks carry the newest genuine user message ID, timestamp, and content fingerprint. Revalidation runs after asynchronous capability/body preparation and immediately before upstream dispatch. Durable queue rows persist the token, so restart/queue launch cannot resurrect superseded work. Old helper queue records without a token fail closed; transient owner leases remain queued rather than permanently cancelling recovery.
- A steer before helper completion remains part of the waiting request; a genuine owner turn after completion supersedes the findings. Returned/pending counts use deduplicated, validated `task_indexes`; absent indexes retain legacy goal counting.
- Answered completion requires a parsed qualifying terminal status at the end of a non-commentary assistant reply, not a marker substring or malformed/example/FYI tag. Owner `needs_you`/`check` gates, running-helper versus final-result authority, two-hour recovery, six-hour completed-result visibility, and existing receipt keys remain intact.
- Helper list reads use one bounded, batched delivery/time-index query, not one COALESCE table scan per listed session. Indexed successor seeks discover delivery values without a DISTINCT archive scan; unknown delivery values remain visible. Message evidence is bounded and timestamp/session-indexed. Truncated evidence suppresses the unavailable projection/Continue eligibility rather than inventing partial or zero counts. The Hermes source DB is read-only: no source schema/index changes.

No Stock implementation was copied. Its staged source was inspected read-only; these scoped primitives were authored in this candidate.

## Deterministic acceptance evidence

All sustained execution runs on Thales, under:

`${WIZARD_WORK_ROOT}/wizard-qa/helper-status-release-20261012/`

Environment:

```sh
export PATH=/opt/homebrew/bin:$PATH
export HERMES_HOME=${WIZARD_WORK_ROOT}/wizard-qa/helper-status-release-20261012/isolated-hermes
export TMPDIR=${WIZARD_WORK_ROOT}/wizard-qa/helper-status-release-20261012/tmp
cd ${WIZARD_WORK_ROOT}/wizard-qa/helper-status-release-20261012/svc
npm test
```

- `backend-before-repair.log`: all ten new must-fix regressions failed against the unmodified candidate. Verified admission/queue requests use explicit barriers, not sleep-based race windows.
- `backend-repair-full.log`: full suite passed (288 tests, 25 files). This includes existing receipt, follow-through, queue, stale-run, joined-capability, status, and service tests.
- `helper-backend-regressions.test.ts`: HTTP/Access/CSRF, steering, grouped counts, malformed/nonterminal status, and admission-after-await races.
- `helper-backend-lifecycle.test.ts`: generation ordering, manual/automatic identity, actual queue launch, restart, late queued-launch races, duplicate-free persisted receipts, source bounds, leases, Origin/Host rebinding, and source-index performance.
- `HELPER_SOURCE_INDEX_RECEIPT` in the logs: 100,000 archival delegation rows and 100,000 historical 1-KiB message rows; real `readHelperStatuses` projection used `idx_async_delegations_delivery` searches, no delegation full scan, and returned the one correct unresolved status. This is isolated fixture performance, not a live user-latency claim.

Fixtures/transports exist only in explicit tests. The final committed SHA and exact-snapshot remote receipt are returned separately to the release owner after commit. Parent owns fresh independent review, UI acceptance, merge, and release.
