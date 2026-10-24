# Private providers — pp-mergeable evidence

Base: origin/main `682e9283497e77bc4d4c61a4f4f6bb7c87350877`.
Replay source: #88 `8555cf772daf7fd6b737420b697a7af71be0f0d5` (squashed layer; main history retained).

## Contract / implementation
- No app: legacy Tinfoil TCP/sidecar and local-model environment config remain. Read/list/start/chat never implicitly migrate.
- Explicit owner PATCH `migrate_private_provider: true` requires a declared installed relay capability and healthy model endpoint. Numeric non-root identity is preserved; unknown identity is refused before publication. Home/history retained.
- Migrated agents retain a per-agent marker. Provider loss gives 503 / `private_provider_unavailable`; no legacy or public fallback.
- Per-agent internal relay network, exact CONNECT/SNI egress, current main Unix gateway/ingress, and #105 vision helper retained.
- No live box, service, private home, or private container data was accessed or changed.

## Reuse plan
REUSE: main's legacy runtime route, provider aliases, Unix ingress/gateway, config writer and #105 vision helper.
EXTEND: installed-app private provider catalogue, explicit owner migration, restricted runtime identity and sealed Compose generator, admission/status tests.
NEW: provider protocol/egress modules and disposable rig from #88; no UI or parallel shared implementation.

## Verified locally (synthetic fixtures)
- `npx vitest run tests/legacy-private-compat.test.ts tests/private-provider-launch.test.ts tests/private-providers.test.ts tests/agents-legacy-migration.test.ts tests/agents.test.ts`: 5 files, **64 passed**.
- `uv run --with pytest python -m pytest ops/agent-runtime -q`: **162 passed, 1609 subtests passed** (VPS, 16.22s).
- `git diff --check`: clean. `tests/legacy-private-compat.test.ts`: byte-for-byte unchanged from main.
- Tests cover no app, install alone does not migrate, explicit migration, uid/gid/history preservation, unknown identity, missing/unhealthy capability, app removal/status/fail-closed admission, both vision routes, and Unix-only sealed edge.

## Remaining release gates
Full Service suites on durable Thales worker and exact-head GitHub Quality CI are pending; results will be appended, not inferred from focused tests.
No real-Docker/attestation/live provider cutover acceptance is claimed. **Keep PR unmerged until live acceptance.**
