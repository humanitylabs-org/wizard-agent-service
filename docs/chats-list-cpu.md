# Chats CPU diagnostics and safe hot-path changes

`GET /wizard/list-cache` keeps its existing authorization and fields. It now adds:

- `head_ms`: time projecting the newest canonical batch in `createHybridProjector`.
- `hot_ms`: remaining hybrid projection work (including fingerprints, hot/warm/sweep selection and row assembly). These exclude the service's canonical-list and hot-id discovery; `last_build_ms` remains the total build time.
- `speed.event_loop`: `delay_p50_ms`, `delay_p99_ms` from Node's 20-ms event-loop-delay histogram, `utilization` from `performance.eventLoopUtilization`, and actual `window_ms`. One tumbling approximately 60-second window is retained, or the current partial window before the first rollover. The timer is unref'ed and disabled with the server lifetime.
- `speed.routes`: cumulative handler-entry-to-finally `count` and `total_ms`, keyed by the JSON tuple `[method, templated path, client class, Host, X-Forwarded-Host, Forwarded host]`. The client class is `HeadlessChrome` or `other`. Identity segments and unknown route words become `:id`; query strings and raw forwarded client addresses are discarded. Header values are bounded. There are at most 256 buckets, including `[overflow]`; concurrent requests cannot exceed this limit. Streaming handler time includes its awaited work, not necessarily socket completion for piped static responses.

Run/heavy queues log `[queue-speed]` with queue identity and rounded duration only when a tick exceeds 50 ms, at most once per minute per queue. These are elapsed times, not attributed CPU samples.

## Identical decisions, less repeated work

- `DurableHeavyQueue.rows()` owns one recursively frozen snapshot. `PRAGMA data_version` invalidates writes from other SQLite connections; a dirty flag invalidates every post-construction own write (`save` and `submit`, including cancellation, delivery and supersession via `save`). Constructor migrations precede the first snapshot. `get()` still returns an independent mutable record. Presentation, status and summary callers use the snapshot without mutating it. Queue loops skip already-terminal polling and monotonically fenced continuation snapshots, but retain fresh reads before decisions and after awaited RPC/admission boundaries.
- `saveCatalog` ignores `at` when the id set, `complete` and `seal` are unchanged. `at` is schema-validated, never consumed for freshness or absence authority. The pin loop remains outside the no-op write guard. Catalog invalidation/sealing still persist when their values change.
- `latestForSession` finds `MAX(rowid)` through the existing session index, then fetches that row by rowid. This preserves insertion order, including same-time UUID ties and timestamp reversals, without sorting full saved requests.
- The exact live base `8ac791b901266fb0244cee9b3bcc786d980977a6` **already excludes expired sign-in failures before hydration**, using the covering FIFO index and recovery-window bound. That implementation and its four-runtime regression tests are retained; no redundant query rewrite is claimed here.

## Focused verification

New regressions run with:

```sh
nice -n 19 node --test tests/chats-list-cpu.node.mjs tests/speed-meter.node.mjs
```

They are also registered in the existing Quality workflow without changing dependency manifests. The existing HTTP cache test checks the diagnostic payload through a real isolated server. Existing run-queue, heavy-queue, agents, background-results, routed-queue, session-list and agent-parity suites exercise unchanged outcomes.

On an archive of the exact live base with only the new CPU tests and modified cache HTTP test overlaid: **6 failed, 1 passed**. Failures cover repeated parsing, mutable snapshot, redundant per-job reads, catalog rewrite, sorting latest-run lookup and missing diagnostics. The passing submit test is an existing correctness invariant, not a newly fixed bug. Existing recovery-window tests also pass on the base, as expected.

## Copy-only micro-benchmark

Measured with `nice -n 19`, 15 samples per measurement, median elapsed milliseconds on a CPU-contended host. SQLite files and sidecars were copied to isolated scratch directories and passed `PRAGMA quick_check`; only those copies were opened read-write. No real worker transport or continuation was dispatched. The heavy tick used failing local transport/current callbacks to prevent external actions. Catalog observations disabled the unrelated pin index for both revisions.

| Measurement | Exact live base | Candidate |
| --- | ---: | ---: |
| Three unchanged heavy `rows()` calls, 1,094 jobs | 39.5794 ms | 0.0262 ms |
| JSON parses across those three warmed unchanged reads | 3,282 | 0 |
| Heavy `_tick()` on the copied ledger | 122.5363 ms | 41.4524 ms |
| Re-observe unchanged 369,089-byte catalog | 15.7985 ms | 5.4477 ms |
| Catalog rewrites across 15 observations | 15 | 0 |
| Sign-in resume poll, 2,441 copied run rows | 7.6390 ms | 8.2811 ms |
| Hydrated sign-in records per poll | 8 | 8 |
| Latest-run lookups for 50 busiest sessions | 13.5260 ms | 9.9238 ms |

Sign-in polling itself does not show an improvement in this noisy sample: the requested age filter was already live. These are isolated hot-path results, not a claim about end-to-end Chats latency or deployed CPU. Activation and live observation are deliberately outside this PR's staging authority.


## Unchanged newest-head reuse

The hybrid projector now keys **head as well as cold rows** by the complete raw
canonical session row and the existing per-thread queue/background/direct/Supervisor
stamps. Queue stamps include insertion rowid, public id, status and `updated_at`;
main-agent heavy snapshot stamps include the complete job (including delivery/resume
and receipt changes). Head keys additionally include the original position and the
local owner-write revision. Title/pin/agent fields are already in the canonical row.
Owner writes conservatively invalidate the head; hot or non-cacheable live/failed/
waiting/helper rows still project every build.

Sparse changed rows share one bounded truth-read batch instead of opening the same
readers once per isolated position. Original per-row positions travel through the
20-row cooperative slices and message enrichment, retaining the exact global
48-row history-preview cap. The head flag never becomes a cold projection. A row
moving into or out of the head is rebuilt. Pending first-send enrichment can append
rows outside canonical ids, so that uncommon path deliberately retains the original
full-head projection until the pending rows enter the canonical list.

The signature does **not** claim to cover every transcript/helper/reconnect or
wall-clock input. Each head id has a deterministic, rolling refresh age between
30 and 60 seconds; an expired row is never reused on a build. An idle service does
not run projection without a list build. The existing joined ten-minute full
self-check remains unchanged and now validates reused head ids as cached rows too.
The real HTTP regression runs that self-check, with `check_differences = 0` and
`check_live_differences = 0`.

`GET /wizard/list-cache` adds per-last-build `head_reused` and `head_projected`.
`last_projected`/`last_cached` now include reused head rows correctly; `cache_rows`
includes all retained canonical rows. `head_ms` includes canonical fingerprint
preparation as well as actual head work.

### Focused evidence

The ten tests in `tests/chats-list-head.node.mjs` are imported by the existing
`tests/session-list-cache.node.mjs` entry point (no dependency-manifest change).
On the requested exact base `a639e6742e60f7739a7790034f67ec83129c652f`, the new
head suite reports **1 passed, 9 failed**. Full-projection identity is an inherited
invariant, not a newly fixed failure. Candidate focused runs:

- `nice -n 19 node --test tests/session-list-cache.node.mjs tests/session-list-cache-http.node.mjs`: **28 passed, 0 failed**.
- `nice -n 19 node --test tests/chats-list-cpu.node.mjs tests/agent-service-cpu.node.mjs`: **12 passed, 0 failed**.
- `nice -n 19 node --test tests/speed-meter.node.mjs tests/ready-thread-speed.node.mjs`: **14 passed, 0 failed**.
- `nice -n 19 node --test tests/session-list-http.node.mjs tests/list-working-after-reply.node.mjs tests/open-ask.node.mjs`: **30 passed, 0 failed**.
- `nice -n 19 node node_modules/vitest/vitest.mjs run tests/run-queue-projection.test.ts tests/run-queue.test.ts tests/run-queue-retention.test.ts --maxWorkers=1`: **18 passed, 0 failed; 3 files**.

### Copy-only head benchmark

`node scripts/bench-chats-head.mjs <base-archive> <candidate-archive> <scratch>`
requires both archives inside scratch. Copy `run-queue.sqlite3` and `heavy.sqlite3`
plus available WAL/SHM sidecars into scratch first and provide dependency links in
the archives. Run with `nice -n 19`. The script checks copied ledgers with
`PRAGMA quick_check`, creates a separate synthetic 1,100-session Hermes database,
and refuses any non-fixture fetch or write admission. It instruments **only the
archives** to access the real Service projection; no hook ships in production.
It never reads the real Hermes state database or contacts a live service.

Seven warmed samples, exactly twenty spread-out title changes in the newest 100
(including changes above and below the preview cap); copied ledgers contained
2,470 run rows and 1,096 heavy jobs. Their main-agent signature shapes are mapped
onto synthetic ids. Workers/transports are not started. This measures the real
core with synthetic transcripts, not deployed end-to-end latency or the observed
3.2-second live workload; history previews are already warm in both versions.

| Median measurement | Requested base | Candidate |
| --- | ---: | ---: |
| Hybrid build | 26.086 ms | 9.211 ms |
| `head_ms` | 22.210 ms | 7.705 ms |
| Head reused / projected | 0 / 100 | 80 / 20 |
| All projected rows | 100 | 20 |

All 1,100 outputs were deep-equal to the real full Service projection in every
sample of both revisions. An initial contiguous-span implementation was slower
for scattered changes; batching sparse rows with explicit positions removed that
reader overhead. No live benchmark, service restart or activation is included.

### Follow-up: owner-write churn and pending first sends

The original head cache had two independent global blockers:

- `localRevision` changed for **every** non-GET/HEAD request. Passing it as
  `headContext` meant unrelated read-state/MCP/phone writes discarded all 100 head
  entries. Snapshot invalidation still needs this broad revision; row reuse does not.
- The copied queue returned six recent unfinished candidates; the read-only main
  state lookup found one visible, unarchived, parentless **zero-message** session.
  Its mere presence made `reuseHead=false` for every thread, indefinitely while
  that failed first send remained in the seven-day candidate window.

The direct core's owner-controlled global signature now contains installed app
**IDs** (not catalog timestamps/names) and main failure-dismissal records. Raw
canonical rows already carry title, pin, model and session changes. Operator
workers affect only operator projection, which does not use this cache. Subjects,
title history, spaces/UI filing, agent metadata and follow-ups are applied by
shared decoration on every snapshot build, not retained in cached core rows.
A changed core context also invalidates cold rows. Broad snapshot touch behavior,
hot/live handling, outside stamps, rolling 30–60-second head ages and the joined
ten-minute full self-check are retained.

Pending first-send exceptions are projected fresh separately, inserted after
exactly their original 20-row slices. The original slice order and even duplicate
pending occurrences are deliberately retained: this patch does not silently fix
that pre-existing difference between the cached/full-core slicer and the legacy
cache-off 100-row HTTP path. Failed pending rows are not cached. Reader failure
still falls back to the old full-head path.

`head_blocked` counts the first reason for each re-projected canonical head row:
`missing`, `context`, `hot`, `live`, `changed`, `age`, or the conservative
`pending_first_send` reader-failure fallback. `head_extras` counts the separately
projected exceptional rows; they are intentionally not included in canonical
`head_projected`.

Copy-only churn harness: `scripts/bench-chats-head-churn.mjs BASE_ARCHIVE
CANDIDATE_ARCHIVE SCRATCH`. Both archives must be inside SCRATCH, and only they
are instrumented. Before running, use SQLite's read-only source connection and
backup API to make WAL-consistent `run-queue.sqlite3` and `heavy.sqlite3` copies.
Create `scoped-state.db` with the source sessions/messages schemas and only the
newest 1,100 visible root human-session shapes plus the candidate zero-message
session; retain source identity/timestamp/count/flags, replace titles and prompt
text, and insert two synthetic visible user/assistant messages per nonempty
session. Create an index on messages(session_id). Keep leases/helper tables
empty in this synthetic workload. Never copy or scan the full message corpus.
All preparation reads of the source main state use `mode=ro`; no private agent
home or state is accessed. This is a bounded shape fixture, **not** a complete
owner-transcript or live-latency benchmark.

The exercised fixture had 1,100 canonical rows, one pending first send, 319 queue
session stamps and 1,104 main heavy jobs. Both ledger copies passed
`quick_check`. Two consecutive real canonical-reader calls on the scoped copy
were deep-equal; all 319 queue signatures and 1,104 heavy JSON inputs remained
stable. Thus volatile signature generation was not an additional blocker on
unchanged copies. Real active-job writes can still change their own sessions.
Age expiry is expected rolling work, not an explanation for 100/100 every 10 s.

Six ten-second builds per scenario, with 8/8/9 unrelated touches repeated twice
(exactly 50 per simulated minute). Standard medians, including the mean of the
middle pair for six samples:

| Scenario | Before reused/projected | After reused/projected | Before head_ms | After head_ms |
| --- | ---: | ---: | ---: | ---: |
| Unchanged, no pending | 75 / 25 | 75 / 25 | 26.503 | 19.849 |
| Owner touches only | 0 / 100 | 75 / 25 | 59.284 | 24.394 |
| Pending first send only | 0 / 100 | 75 / 25 | 55.386 | 37.959 |
| Both (realistic churn) | 0 / 100 | 75 / 25 | 59.240 | 63.124 |

Every output is deep-equal to the **real full core** in all 48 measured builds
(1,100 rows without pending; 1,105 with the retained pending duplicates). The
first three churn builds after the fix reused 88 and projected 12 rows each
(four hot, eight non-cacheable); later builds also exercised rolling expiry.
The final noisy combined timing was slightly slower, despite much less row
projection. Do not claim deployed latency or a wall-clock win from this fixture.

Regression evidence: six focused new cases fail on 89be760c and pass after the
fix. The real HTTP periodic self-check, including pending exceptions, reports
zero cached/live differences and zero fallbacks. The declared
`head-row-owner-write-parity` fixture covers main, host-profile, container and
restricted HTTP/socket boundaries; it is synthetic evidence, not live or browser
acceptance. No full suite, deployment or activation is part of this follow-up.

## Truth dedupe (follow-up to head-row reuse)

Live profile, 30 s, main thread 90% busy: 48.7% in the list projector, 38.4% in
`readHermesSessionTruth` (read once by the projector and again per row through
background-results `isBusy`), 8.6% in per-receipt `receiptConsumed`, 6.3% in
owned-open-work reads (once for helper status, once for follow-ups), and
prepare/step overhead in SQLite. Changes, all output-identical:

- one truth read per build, shared with `isBusy`; build-local follow-up memo
  shared by truth and helper status (never kept between builds);
- prepared statements cached per read-only handle (`server/read-only-sqlite.mjs`);
  the service-owned truth connection reopens when the store file is replaced;
- receipt consumption in one batched query per build, same 513-row fence;
- automatic full self-check every 30 minutes (was 10), same oracle;
- speed meter keeps fixed `/wizard/v1/<endpoint>` words separate from `:id`.

Copy-only benchmark (`scripts/bench-chats-truth.mjs`, 1,100 synthetic sessions
over copied queue/heavy ledgers; 100 head + 25 hot projected; median of 3, VPS
under load): see the PR for the numbers. Every output deep-equals the original
full projector across all 1,100 rows.
