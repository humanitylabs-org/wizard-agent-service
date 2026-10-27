# Agent Service component inventory

The shell/app UI inventory remains in wizard-ux `docs/COMPONENTS.md`.
This repository adds no front-end implementation. Its reusable back-end components
are listed here so new capabilities have an explicit owning module rather than
being copied into apps or runtime-specific forks.

| Capability | Entry points | Reuse and verification |
| --- | --- | --- |
| Supervisor review ledger and Reporter checker | `Supervisor` (`server/supervisor.mjs`), `lintReport` (`server/reporter.mjs`), `installSupervisorAssets` (`server/supervisor-assets.mjs`) | Reuses durable run admission and scheduler delivery/readback; all four runtimes use the same service and supported Hermes adapter. Private/siloed callers refuse. Covered by Supervisor/Reporter suites and `supervisor-reporter` in the agent acceptance matrix. |
| Heavy result ownership, delivery notices and completion-status guard | `DurableHeavyQueue` (`server/heavy-queue.mjs`), `createHeavyIntegration` (`server/heavy-integration.mjs`), `guardHeavyStatus` (`server/thread-status.mjs`) | Reuses the existing run queue, per-job SQLite JSON records and shared main/routed presentation. Heavy siblings and automatic retries share an owner generation; owner steering still fences them. Dropped results become context on the next successfully dispatched turn. All four runtime kinds are covered by `tests/heavy-status.test.ts`; ancestry and restart by `tests/heavy-continuation-admission.test.ts`. |
| Agent-owned helper and Supervisor wait projection | `readSupervisorBuildWaits` (`server/supervisor-wait.mjs`), `isHumanRequest` / `currentOwnerResult` (`server/delegation-receipts.mjs`) | Extends shared list/session truth and cache stamps; retains real requests across compaction, excludes machine inputs, and projects the existing Supervisor ledger without adding a scheduler. Existing follow-through admission owns continuation delivery. Covered by `tests/owed-helper-work.test.ts` and `tests/helper-continuation-evidence.test.ts`. |
| Live run events for model-locked turns | `RunEventLog` (`server/run-event-log.mjs`), `LockedRunBridge.events` (`server/locked-run-bridge.mjs`) | Hermes serves `/v1/runs/<id>/events` only for `POST /v1/runs` runs; locked turns run in `chat/stream`, so the bridge records those frames in native event names and the service serves them for queued and direct reads. Reuse it for any other stream-admitted run instead of polling. Covered by `tests/locked-run-events.test.ts` and `tests/run-event-log.node.mjs`. |
