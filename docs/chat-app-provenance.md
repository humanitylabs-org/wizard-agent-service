# Explicit chat app provenance

Wizard Agent Service projects `wizard_app_id` independently of the session's source, title, subject, and attention state. This identifies work actually performed in an app, not topics mentioned in a conversation.

## Producers

- Final agent replies may add `"app_id":"topics"` to the existing hidden `WIZARD_STATUS_V1` JSON. Attention still requires valid `state` and `ask`; provenance can use an app-only marker. Complete and unfinished markers remain stripped from visible history and previews.
- Publishers may set latest final assistant `display_metadata.app_id`, alongside their existing `report_id` / `report_topic` fields. Object or serialized JSON metadata is accepted. An explicitly present metadata `app_id` takes precedence over the marker, including invalid values (fail closed).
- Use exact installed IDs, not names, aliases, subjects, thread titles, or inferred matches. Agent instructions explain actual app operations, omission for unrelated work, and no automatic carry-forward. App-routed view context helps choose work but is not proof of app work.

## Registry and freshness

`normalizeAppId` preserves the ID verbatim and enforces the App Manager checker grammar `[a-z0-9][a-z0-9-]{1,40}`. Projection crosschecks against the same `readApps` catalogue as `/wizard/v1/apps` (managed apps and launcher links), with native builtin `usuals` / Food added. No bespoke managed-app allowlist. Catalogue and crosschecks are reread for runs/lists, so installs and removals need no service restart.

Canonical SQLite latest visible final assistant metadata/marker takes priority over preview history and applies to every page. A newer genuine user request immediately removes provenance; a subsequent unrelated assistant reply without explicit provenance does not inherit it. Compaction nudges/internal messages, commentary, inactive rows, and user-supplied markers are not producers. Schemas without `display_metadata` remain supported without a migration.

App provenance alone follows a unique compression continuation, excludes tool/delegate/branch/reset forks, and fails closed on ambiguous/missing/cyclic/over-bound continuations. A newer explicit report appended to the root can supersede older tip history. Existing status/activity projections are unchanged. Without canonical DB truth, the existing latest-visible history reader supplies provenance; an unavailable history fails closed. Old unmarked replies are not reclassified or backfilled by guesses. Frontend retains the exact legacy app-owned Topics channel fallback separately.

## Verification and release ownership

Normal Vitest discovery includes `tests/thread-app-provenance.test.ts`: validation/XSS, independent marker/metadata producers, state/title/subject/source preservation, dynamic catalogues including arbitrary future app IDs and Food, unknown IDs, canonical whole-list/pagination, stale previews/history failures, unrelated follow-up requests and replies, old schemas, equal timestamps, compaction, and compression forks.

Full baseline/candidate npm suites are run only on `$WIZARD_BUILD_HOST`, under `${WIZARD_WORK_ROOT}/WizardQA/chat-app-provenance-20261014`, with `${WIZARD_HEAVY_ROOT}/AndroidBuilds/worker.lock`. Receipts identify exact source SHAs, commands, exit codes, log paths and source file hashes. The service has no frontend build script or browser surface of its own; integrated UI/browser QA belongs to the parent release owner.

No deploy, restart, push, Hermes-core modification, DB migration, new dependency or endpoint is part of this artifact. Parent owns integration and activation. Read-only runtime receipt `.qa/runtime-safety.json` captures actual active queue/upstream IDs. `direct` queue records are gateway-owned HTTP `/v1/runs`, not an in-process Agent Service executor; stock gateway :8642 and Wizard Node service are separate systemd cgroups. Gateway source `gateway/platforms/api_server_runs.py` retains adapter-owned tasks and detaches SSE subscribers without cancelling execution. `DurableRunQueue.close()` only clears its timer and closes its queue DB. A routine Agent Service restart therefore does not own/stop these upstream runs, but the parent must recheck ownership and upstream IDs before/after any activation; this artifact does not claim a performed restart-survival test.

## Reusable QA lessons

- Check both baseline and candidate when an existing Vitest suite mixes runner conventions; never count pre-existing collection failures as new feature failures.
- Keep timestamp ties deterministic using real table rowid, but do not add rowid ordering to views: it can force obsolete message bodies to materialize and break indexed-seek guarantees.
- Use canonical message metadata for publisher provenance. Preserve publisher/source data rather than repairing app IDs or classifying title/body strings.
