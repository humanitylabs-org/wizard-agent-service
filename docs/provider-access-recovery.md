# Saved requests after an AI sign-in outage (staging only)

REUSE: the durable run queue, provider backoff ledger, outbox and normal locked-model delivery.
EXTEND: `waiting_reason=provider_access`, `retry_after`, and bounded retry lineage on the existing queue row. Extend the existing thread status and list projection, not a second recovery UI.
NEW: synthetic-only preview/rehearsal fixtures; no second runtime or credential implementation.

Enable only on an isolated candidate with `WIZARD_PROVIDER_ACCESS_RECOVERY=1` (or `providerAccessRecovery: true` in a fixture). Default remains off; this branch is not approved for live promotion.

Only normalized zero-token authentication preflight failures qualify. The queue keeps the original body, trusted attachment paths, model/provider and service-owned helper/heavy continuation. It releases the failed upstream receipt's capacity but keeps the request waiting. It does not retry content failures, owner stops, uncertain transports or ordinary admission errors.

Recovery evidence is the **next completed successful direct run on the same provider** (any model). An acknowledgement alone is not enough. There is no paid polling request and no credential scraping: signing in without any subsequent successful request does not wake this queue. Another provider's success never wakes it. A six-hour deadline, preserved across restarts/manual retries, returns it to Failed + Retry when success is not observed.

A source-derived idempotency key is shared by manual Retry and automatic recovery. A single transaction inserts the child with its inherited deadline/authority and retires the waiting source. FIFO recovery order uses the original source ordering, without changing run timestamps. Interactive capacity reservations and per-thread leases remain enforced. One automatic attempt is allowed; if that attempt also fails, the saved request stays available for manual Retry. Manual retry while still signed out can wait again within the original deadline.

Heavy result resumes keep their service-owned job authority: the source-linked retry must exactly match the original body, continuation and attachment paths. Validation still rejects stopped/superseded jobs, changed bodies, live mutation owners and stale request generations. Helper dispatch keeps its existing newer-human-turn and token-age fences; access recovery does not extend those permissions.

## Rehearsal

```
node --test tests/provider-access-recovery.node.mjs tests/retry-sign-in-outage.node.mjs
npx vitest run tests/heavy-continuation-admission.test.ts tests/heavy-contracts.test.ts tests/heavy-invalidation.test.ts tests/helper-continuation-evidence.test.ts tests/helper-backend-lifecycle.test.ts
```

The preview backend `qa/provider-access-preview.mjs` has a synthetic upstream supplied in-process; it has no live Hermes origin, owner state database, accounts, agents, scheduler, credentials or files. The read-only shell proxy must target that backend, never the live backend. Synthetic preview data files must not link to the owner's generated files.
