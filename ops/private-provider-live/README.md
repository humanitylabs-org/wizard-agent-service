# Private-provider launch tools — green rehearsal, blocked production gate

Actual attempt 17 passed a–f, all six privacy checks, unexempted post-migration credential-location and exact final cleanup. The regression includes a real red-image vision-helper inference through its own in-seal client. Read `EVIDENCE-rehearsal.md`; raw owner fingerprints and complete receipts remain in private scratch, never in the public repository.

## Implemented and verified

- `live-run-all.py`: argv-only operation plan, no-drain/parent lifecycle gates, bounded live-base refresh, six-check/regression gate before migration and attempt-scoped rollback dispatch. Admission requires actual detailed migrated/vision evidence and zero surviving synthetic runtimes, not just green summary flags. It refuses a missing/incomplete production plan.
- `stage-candidate.py`, `merge_resolver.py`, `merge-resolutions.json`: actual Thales staging against discovered live Service base + current #161, same-tree runtime and #220 UX. Seventeen reviewed hunks across nine current-base files; unknown drift fails closed. Full focused staging suites passed after resolving the confidential-provider signature integration issue. See `MERGE-REVIEW.md`.
- `live_sources.py`: independently discovers/hashes owner CLI, manager API daemon and runtime-selected WAM source trees. These differ on the actual owner box; a convenient checkout is not proof of the selected runtime.
- `release_transaction.py`: allowlisted code-pointer/reviewed-text snapshots, durable receipts, compare-and-swap promotion, pending-write crash ownership, exact-target rollback and all-target foreign-drift rejection. Tests exercise the real scratch filesystem. Agent homes, data and credential-bearing assignments are rejected.
- `live-preflight.py`: read-only Runtipi/release/container/unit/UI/WAM-source fingerprints. Actual box fingerprint unchanged; full production-adapter readiness still correctly blocks.
- `legacy-*.py`, `rig-*.py`, `rehearse-guest.py`: real disposable guest inference/migration/removal/privacy/regression/reset, including UID-safe exact-container inspection and preserved phase failure logs.

## Lightweight tests

```sh
uv run --with pyyaml python -m unittest discover -s ops/private-provider-live -p 'test_*.py' -v
```

76 tests pass. Unit fakes and the filesystem helper do not substitute for complete production adapters.

## Remaining hard production gate

Complete deploy/install/live privacy/regression/Private-only API migration/verify/rollback adapters and their explicit argv plan are not finished. Existing product rollback rejects an already sealed agent; Service refuses clearing its sealed marker. Do not implement rollback by restarting an older runtime against that sealed record, or by directly reading/writing the Private directory. Use an explicit owner-authenticated, attempt-fenced product restore contract or obtain an approved alternate recovery design first.

The actual read-only preflight is BLOCKED despite unchanged fingerprints and green rehearsal/staging. No safe complete parent production invocation exists yet. Do not populate a plan with success-only commands or remove blockers to obtain a green report.
