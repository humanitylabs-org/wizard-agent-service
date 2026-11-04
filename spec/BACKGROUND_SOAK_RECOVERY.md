# Background recovery soak follow-up

The recovery watcher and manual discovery are independent background consumers. Neither may take a second turn while the session already has one.

## Busy follow-through

The SQL completion and idle-receipt finders previously checked leases and continuation gates, but not the Service's live queue/direct-run projection. Admission subsequently rejected a legitimate concurrent turn as `Agent already active`, and the watcher tried again every five seconds.

The watcher now uses the same `helperSessionActive` preflight as admission, including compressed roots and physical tips. A busy receipt stays unconsumed and is revalidated on a later tick. If another admission wins between preflight and admission, the structured `helper_session_busy` conflict also defers the receipt. Other admission failures remain errors. Admission is still the final race fence; discovery does not grant authority.

## Discovery deadlines and pagination

Discovery had an aggregate 40-second deadline on a sequential catalog walk and a five-second individual request deadline. A large or congested upstream could exhaust the aggregate budget and restart at page zero without ever reconciling the catalog. A full page's incorrect `has_more=false` could independently omit later sessions.

Discovery now retains an async-generator cursor between bounded slices: one 50-row catalog page, two concurrent history reads, or one idle receipt per slice. Normal list/project calls advance one slice without blocking Chats. Only a fully reconciled generation replaces the published snapshot; explicit Continue drains the current generation and retains dispatch-time revalidation. Each individual read starts with a five-second deadline, adapts to twice the last successful latency plus one second, and is hard-capped at ten seconds. Catalog and history budgets are separate. A timeout increases only that read class's budget up to the cap and retries once with a new signal. Persistent catalog errors remain logged and unavailable; they retain the failed page cursor and back off for the refresh interval, including explicit Continue. Writes are never retried by this mechanism.

A full page advances regardless of `has_more`; a short page terminates the walk. The bounded completeness fence is 50,000 rows; the former 10,000-row fence could never finish the live 10,345-plus-row catalog. A completed generation is reported once even when a polling interval exceeds the refresh interval, avoiding perpetual `scanning` with a fast cache expiry.

## Verification

`tests/background-soak-regression.test.ts` exercises deferred busy receipts, the admission race with stable idempotency identity, a simulated catalog that takes over 40 seconds, a falsely final full first page, transient timeout recovery, adaptive deadline bounds, two-read concurrency, resume-after-failure without page-zero replay, backoff, a catalog beyond 10,000 rows, and persistent-failure visibility. Existing HTTP/queue, compression, receipt-consumption, owner-gate and two-Service ownership tests must also pass.

Live acceptance requires the same 30-minute content-free health/home/scheduler authorization checks, stable Service PID/restart count, no legacy agent TCP listener, and a clean Service journal. A successful short test is not a completed live soak.
