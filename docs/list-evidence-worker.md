# List evidence worker and fair polling (main-based)

Rebuild live `4de50f5` on shared main without the live privacy/Notes/reach-out stack or the CPU-cache feature. The worker uses current main's `readHermesSessionTruth`; it does not import missing optimized readers from the live stack. The separate #300 CPU-cache PR remains necessary. Reconcile its integration hunk after #300 merges, without discarding either capability.

- The list's existing evidence algorithms run read-only in one lazily started worker. Only the selected main history path, IDs and ephemeral evidence cross the worker boundary; no queue/recovery controllers or credentials.
- Snapshot supervisor discovery/stamps use the same lane. List projection/schema/ordering remain in the original service path.
- The full-list self-check stays on the original main reader, not the worker helper, retaining an independent correctness oracle.
- A failed worker logs once and falls back to the original in-thread behavior. Service drain rejects pending work and awaits termination. Worker failure/timeout is not a promise of bounded interactive latency; degraded fallback is observable in lane statistics.
- Per-run status refresh serializes by public run ID, rather than waiting for a global tick that can be stalled on another run's backend. Durable queue admission/dispatch remains in the existing queue.

CI runs the seven synthetic fairness regressions plus the normal suite: worker/local equivalence, supervisor signals, no HTTP-thread SQLite during worker evidence, separate inputs/next-write visibility, fallback, shutdown and per-run poll dedupe. No current p95 speed claim, Forum pressure benchmark or phone proof is asserted. The live #299 draft's older speed results are not evidence for this rebuilt head.

Before ready: exact-head CI, rebase/integration after #300, independent list-oracle comparison on representative synthetic receipts, 5k-row fairness/stress benchmark on Forum, and review of concurrent global-tick/per-run terminal updates. No live deployment or private-agent state is needed for any of these checks.
