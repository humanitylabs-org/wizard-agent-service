# Chat feature parity

The manifest at `qa/agent-parity/features.json` is the machine-readable inventory. It is a contract register, not a claim that every row has passed. Missing evidence remains **fail**. Fixture, browser and live matrices must be distinguished. Never substitute shared-helper unit results for per-kind integration results.

## Discovery

Baseline source: service `72d1a25`, UX `e3668d2e`; commit subjects reviewed for 2026-08-22 through 2026-10-22. Main-only implementations found in `server/service.mjs` include the durable run queue, screenshot receipt recovery, background continuations, media projection and list/status/title enrichment. Routed execution instead enters `server/agents-http.mjs`. Shared UX code does not prove equivalent upstream payloads.

History/test families included: attachment transport and profile routing; private-history/credential boundaries; hidden canaries; resumable uploads and Files; thread title/status/subject backfills; Ready/unread/list windows; voice capture/transcription/recovery; durable outbox/idempotency; queue and model locks; async helpers and heavy relay; media/content disposition; app binding/provenance; skin, back/reading and notification contracts. `reference_tests` identify existing supporting suites, NOT independently earned matrix passes.

## Required evidence

- Fixture: real Wizard HTTP boundary plus synthetic upstream; host profile prefix and restricted Unix socket are exercised, without model inference.
- Browser: actual DOM/decoded image geometry and state transitions for a main and agent thread on Thales. Shared code or static regex is not DOM proof.
- Live: fresh disposable agents and threads only, exact mobile API, verified cleanup of their containers/networks/dirs. Never reuse an existing private agent.
- Gates: no missing runtime kinds, duplicate IDs/cells, undeclared features, unexecuted fixture contracts or fabricated exemptions. A new chat feature adds an entry plus a per-kind check in the same PR.

## Inventory

| ID | Layer | Per-kind check |
|---|---|---|
| chats-focus | ux | `wizard-ux/qa-chats-focus.cjs`: synthetic main/routed browser acceptance; disposable live runtime evidence remains required |
| session-create | server | HTTP fixture |
| native-images | server | HTTP fixture |
| image-history-reload | server | HTTP fixture |
| file-upload | server | HTTP fixture |
| file-durable-copy | server | HTTP fixture |
| file-history | server | HTTP fixture |
| idempotent-resend | server | HTTP fixture |
| steer | server | HTTP fixture |
| stop | server | HTTP fixture |
| tool-progress | server | HTTP fixture |
| model-picker | server | HTTP fixture |
| status-hidden | server | HTTP fixture |
| retry-input | server | HTTP fixture |
| session-archive | server | HTTP fixture |
| session-rename | server | HTTP fixture |
| screen-context | server | HTTP fixture |
| media-contract | server | HTTP fixture |
| nonimage-files | server | Required; not implemented in fixture runner |
| queue-busy | server | Required; not implemented in fixture runner |
| queue-restart | server | Required; not implemented in fixture runner |
| status-list-state | server | Required; not implemented in fixture runner |
| automatic-titles | server | Required; not implemented in fixture runner |
| subjects | server | Required; not implemented in fixture runner |
| helper-continuation | runtime | Required; not implemented in fixture runner |
| heavy-relay | runtime | Required; not implemented in fixture runner |
| assistant-media | server | Required; not implemented in fixture runner |
| download-links | server | Required; not implemented in fixture runner |
| read-receipts | server | Required; not implemented in fixture runner |
| session-search | server | Required; not implemented in fixture runner |
| session-delete | server | Required; not implemented in fixture runner |
| voice-notes | server | Required; not implemented in fixture runner |
| dictation | ux | Required; not implemented in fixture runner |
| transcription | server | Required; not implemented in fixture runner |
| regenerate | ux | Required; not implemented in fixture runner |
| ready-needs-you | ux | Required; not implemented in fixture runner |
| working-milestones | ux | Required; not implemented in fixture runner |
| image-thumbnail | ux | Required; not implemented in fixture runner |
| copy-share | ux | Required; not implemented in fixture runner |
| notifications | ux | Required; not implemented in fixture runner |
| back-contract | ux | Required; not implemented in fixture runner |
| appearance | ux | Required; not implemented in fixture runner |
| reading-position | ux | Required; not implemented in fixture runner |
| outbox-offline | ux | Required; not implemented in fixture runner |
| history-pagination | server | Required; not implemented in fixture runner |
| tool-approval | server | Required; not implemented in fixture runner |
| app-context | server | Required; not implemented in fixture runner |
| private-isolation | runtime | Required; not implemented in fixture runner |
| model-lock | server | Required; not implemented in fixture runner |
| error-recovery | ux | Required; not implemented in fixture runner |
| thread-links | ux | Required; not implemented in fixture runner |
| pending-first-send | ux | Required; not implemented in fixture runner |
| memory-compaction | runtime | Required; not implemented in fixture runner |
