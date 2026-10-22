# Background recovery soak follow-up

The recovery watcher and manual discovery are independent background consumers. Neither may take a second turn while the session already has one.

## Busy follow-through

The SQL completion and idle-receipt finders previously checked leases and continuation gates, but not the Service's live queue/direct-run projection. Admission subsequently rejected a legitimate concurrent turn as `Agent already active`, and the watcher tried again every five seconds.

The watcher now uses the same `helperSessionActive` preflight as admission, including compressed roots and physical tips. A busy receipt stays unconsumed and is revalidated on a later tick. If another admission wins between preflight and admission, the structured `helper_session_busy` conflict also defers the receipt. Other admission failures remain errors. Admission is still the final race fence; discovery does not grant authority.

## Discovery deadlines and pagination

Discovery had an aggregate 40-second deadline on a sequential catalog walk and a five-second individual request deadline. A large or congested upstream could exhaust the aggregate budget and restart at page zero without ever reconciling the catalog. A full page's incorrect `has_more=false` could independently omit later sessions.

Discovery now retains an async-generator cursor between bounded slices: one catalog page, eight concurrent history reads, or one idle receipt per slice. Normal list/project calls advance one slice without blocking Chats. Only a fully reconciled generation replaces the published snapshot; explicit Continue drains the current generation and retains dispatch-time revalidation. Each individual read remains bounded to five seconds and may retry a timeout once with a new signal. Persistent catalog errors remain visible and unavailable; writes are never retried by this mechanism.

A full page advances regardless of `has_more`; a short page terminates the walk. The existing 10,000-session completeness fence remains. A completed generation is reported once even when a polling interval exceeds the refresh interval, avoiding perpetual `scanning` with a fast cache expiry.

## Verification

`tests/background-soak-regression.test.ts` exercises deferred busy receipts, the admission race with stable idempotency identity, a simulated catalog that takes over 40 seconds, a falsely final full first page, transient timeout recovery, and persistent-failure visibility. Existing HTTP/queue, compression, receipt-consumption, owner-gate and two-Service ownership tests must also pass.

Live acceptance requires the same 30-minute content-free health/home/scheduler authorization checks, stable Service PID/restart count, no legacy agent TCP listener, and a clean Service journal. A successful short test is not a completed live soak.
