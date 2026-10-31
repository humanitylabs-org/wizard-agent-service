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
