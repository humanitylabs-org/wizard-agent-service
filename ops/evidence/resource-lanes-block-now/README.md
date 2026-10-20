# Resource-lanes BLOCK_NOW repair evidence

Executed source: `996b3f7c6325f1944a87907bf36eae71562bdca7`, branch `feature/resource-lanes-20261015`. The containing evidence-only commit does not change executable source or tests. `source-manifest.json` binds all 119 tracked runtime/test/package files; hashes matched before and after the remote run and after retrieval.

## Results

- Full integrated Vitest: **582 passed, 0 failed, 3 skipped**. The skips are the existing opt-in `host-container-launcher.test.ts` cases, not heavy-lane tests. Full machine-readable output is `vitest.json`.
- Real subprocess/RPC suite: **7 passed** (`process.log`). Includes dispatcher crash → cancel → process-group termination → next queued job, separate recovered deadline expiry, a TERM-resistant grandchild, one execution marker despite duplicate submission, poisoned/reused diagnostic PID safety, old-schema ambiguous claims, and inherited Android lock compatibility.
- Plugin fixture: **4 passed** (`plugin.log`). Real `agent.secret_scope`, not a fake resolver: fresh turn scopes, concurrent profile scopes, scoped/unscoped misses, both origin/token, prompt callbacks, and single-profile compatibility. Synthetic credentials and an isolated loopback server only.
- Negative controls against original `2d5174e`: all five invalidation regressions fail. Stop launches one stale sibling; steer launches two; both reproduce across reopened stores. The original plugin fails scoped success/miss cases while its single-profile control passes. Failure output is retained in `baseline-*.log` (one trailing whitespace removed for Git hygiene).

All execution ran on Thales under `/Volumes/ThalesMedia/Development/resource-lanes-20261015`; final run redirected HOME, HERMES_HOME, WIZARD_OS_HOME and TMPDIR into isolated external-volume state, capped Vitest at two workers, and used fixture-only subprocess locks. No build, production lock bypass, service restart, live deployment, live plugin install, provider change, or credential change occurred.

`receipt.json` records UTC timestamps, commands, exit codes, durations, source verification counts, and log hashes. Remote originals: `evidence/block-now-996b3f7/`. The actual Hermes import closure was copied unchanged from source commit `818c13be1dc4fd28987e1e881a9408224afd4535`; its hashes are in the receipt. Thales's older installed checkout lacked `agent.secret_scope`, so the fixture used that exact copied source and an isolated venv with `ruamel.yaml==0.19.1`, without changing installed Hermes.

## Safety boundaries and remaining owner gates

- Admission IDs are diagnostic receipts, not launch permission. `continuation_invalidated` persists independently and is checked at final dispatch. Both stores reopening preserves the fence and receipt IDs.
- The new per-command executor survives **dispatcher** death, retains inherited leases, enforces the original persisted deadline, and terminates its own group. Recovery never signals a persisted PID. Missing/ambiguous execution ownership is never automatically replayed. These tests do not claim arbitrary simultaneous executor death, detached children, or storage-failure recovery.
- Parent owns independent re-review, approved concurrent-delta integration, activation and the final **real model-selected** live canary. This evidence proves source/fixture behavior, not live adoption.
- Thread-recovery candidate `991b78394074386643fd1289bf9bc94d3f5b2eb3` (`fix/helper-continuation-evidence-20261015`) was deliberately not merged before its owner's approval. Preserve that accepted delta at the parent-owned integration point and re-run affected combined checks. No helper-continuation/delegation-receipts/helper-status source was edited here.
