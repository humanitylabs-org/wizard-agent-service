# Attempt-fenced post-seal restore

REUSE existing owner-authenticated agent PATCH, runtime RPC authentication, lifecycle/process locks, original drivers and host-side legacy source.
EXTEND migration source metadata with nonsecret original model/runtime and attempt identity; introduce explicit two-phase rollback with persistent restart fence.
NEW none; no UI or second runtime implementation.

Only an explicit owner rollback for the matching migration attempt can restore the legacy confidential route. It never changes privacy/permissions or reads a credential from the agent home. The runtime checks the host source before stopping the sealed writer, removes sealed runtime and revokes the private client, fences starts, then Service regenerates legacy harness files and publishes legacy metadata. Runtime commit injects the active credential from the host source, clears the scrub/restore fences and applies the original driver. Interrupted publication remains fenced and retryable. Old code pointers may be restored only after rollback/readiness readback.

Acceptance: synthetic Service tests for wrong attempt, normal-update seal invariants, host-source refusal and retry; runtime lock/fence tests; actual rig migration, completed sealed inference, forced verify failure, owner rollback, completed legacy inference plus retained canonical history. No live writes in this lane.
