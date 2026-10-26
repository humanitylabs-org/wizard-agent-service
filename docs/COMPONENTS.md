# Agent Service component inventory

The shell/app UI inventory remains in wizard-ux `docs/COMPONENTS.md`.
This repository adds no front-end implementation. Its reusable back-end components
are listed here so new capabilities have an explicit owning module rather than
being copied into apps or runtime-specific forks.

| Capability | Entry points | Reuse and verification |
| --- | --- | --- |
| Supervisor review ledger and Reporter checker | `Supervisor` (`server/supervisor.mjs`), `lintReport` (`server/reporter.mjs`), `installSupervisorAssets` (`server/supervisor-assets.mjs`) | Reuses durable run admission and scheduler delivery/readback; all four runtimes use the same service and supported Hermes adapter. Private/siloed callers refuse. Covered by Supervisor/Reporter suites and `supervisor-reporter` in the agent acceptance matrix. |
