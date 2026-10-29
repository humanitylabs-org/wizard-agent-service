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
- Focused Service Vitest (`agents-json-cache`, unchanged `legacy-private-compat`, `private-provider-launch`, `private-providers`, `agents-legacy-migration`, `agents`): 6 files, **66 passed**.
- `uv run --with pytest python -m pytest ops/agent-runtime ops/private-provider-rig -q`: **175 passed, 1616 subtests passed** (VPS, 18.35s).
- Four real-HTTP `private-provider-admission` matrix checks: **4/4 passed** (main, actual `/p/` profile, legacy TCP container, actual mode-0600 Unix restricted transport).
- Quality `40116357281` on `67c3bab` **passed** after replacing #88's inherited auto-migration cache expectation. Full exact-new-head CI follows review fixes below.
- Review repairs: avoid duplicate management-port publication by recreating the stopped provider without bindings before the ingress helper claims them; retain named/anonymous mount identity and internal endpoints, and send inspected configuration only through Engine stdin. Repeated reconciliation preserves management mapping. Skip malformed unrelated records, explicitly reject unsupported legacy deletion before RPC, add per-kind HTTP admission evidence, remove rig personal-path defaults, and distinguish scanner fixture bytes from secrets.
- `git diff --check`: clean. `tests/legacy-private-compat.test.ts`: byte-for-byte unchanged from main.
- Tests cover no app, install alone does not migrate, explicit migration, uid/gid/history preservation, unknown identity, missing/unhealthy capability, app removal/status/fail-closed admission, both vision routes, and Unix-only sealed edge.

## Remaining release gates
Full Service suites on durable Thales worker and exact-head GitHub Quality CI are pending; results will be appended, not inferred from focused tests.
No real-Docker/attestation/live provider cutover acceptance is claimed. **Keep PR unmerged until live acceptance.**
