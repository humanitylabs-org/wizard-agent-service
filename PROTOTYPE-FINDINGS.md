# Stage-2 browser-trust prototype findings

**Default-off, synthetic only, not merge-ready.** This fixes a proposed contract shape; it is not approval to migrate the 48 apps or enable any live box. No native/media/stream transport, owner-fetch relay, app-visible shell token, global Origin:null authorization, real app data or phone proof.

## REUSE / EXTEND / NEW

- REUSE Oscar/Miguel's #327 registered opaque frames, shell-only token wrapper, appearance/Back/field/share/transcription handlers, and #100 server possession gate.
- EXTEND that channel, not a parallel RPC: `hello` -> client offers one MessagePort as `ready` -> shell challenge/response -> `connected`. Application messages and replies then use only the admitted document port. WindowProxy messages cannot invoke services. The port closes on load/detach; old async replies cannot reach the replacement document.
- NEW `core/app-state.js` is one shared shell-owned IndexedDB adapter. NEW Service `browser-adapters.mjs` is a fixed synthetic operation registry, not a proxy. The two migrated fixtures live only under `tests/fixtures/browser-trust/`.

## Contract deltas versus ADAPTER-SKETCH.md

1. **Only one data operation ships:** `fixture.notifications.list` accepts exactly `{limit:1..20}` and returns one reviewed synthetic DTO shape. Production names, stable cursors, writes and outcome/status APIs are not implemented. Unknown operations and extra identity/URL fields fail closed.
2. **State is a separately granted `state.local` capability.** Both the installed `browser_contract.operations` allowlist and a separate trusted grant resolver must admit it. A manifest alone grants nothing. Production WAM grant/install lookup is deliberately not connected: the synthetic runner injects trusted installation and grant callbacks. These callbacks resolve installation ID, publisher/source, installed commit and permission revision; no frame supplies them.
3. **Namespace follows installation and source within this one local owner/browser profile.** Commit/permission revision changes revoke handles but do not erase same-installation drafts. Reinstall or publisher/source change gets a new namespace. Multi-owner/profile-account switching and future server-side canonical draft durability are not claimed.
4. **Only persistent JSON state v1 ships.** `read({area,key})`, `write({area,key,value,ifRevision,operationKey})` and `transaction({area,operationKey,changes})` use per-key revisions. A change is exactly `{kind:'put',key,value,ifRevision}`. Delete, session/cache areas, enumeration/export, subscriptions, schema upgrades beyond v1 and local blobs are not shipped. Values are limited to 32 KiB, 16 keys/transaction and 64 KiB request, with a 5 MiB maximum approved value quota.
5. **Write receipts are bounded, not permanent.** The newest 256 receipts use a separate 512 KiB budget, atomically with value writes. Recent exact retries return the original result. An evicted retry fails CAS with `conflict` rather than reapplying; callers must reread, not blindly replace newer drafts. Acknowledgement follows transaction completion and receipt readback. Browser disk loss, quota eviction, private-mode storage and cross-device recovery are not backup guarantees.
6. **Migration is a reviewed synthetic map, not arbitrary app-import.** Only source `synthetic:fixture-drafts` may copy `fixture-drafts.legacy.v1` into `draft`. Hash, value/revision and migration marker commit together and are read back. Legacy bytes remain. Re-reading rolled-back legacy bytes never replaces a newer adapter draft. A new publisher with the same display ID is not allowed to inherit them. Old-state rollback here means restoring the legacy localStorage bytes, not rolling back the entire browser IndexedDB database.
7. **Prototype authority/lifetime is bounded:** grants are re-resolved for every admitted data/state call. A state call already admitted can finish its atomic local commit; revocation denies the next admission. A document/binding is limited to 4096 requests and one hour; reload to obtain a new channel. There is no production revocation event bus or background capability lease.

## What is proven now

- Focused UX state/channel tests: CAS, atomic multi-key conflict, source/install separation, schema/size/quota denial, migrated draft readback, same-profile SDK reload and legacy rollback, request replay, stale generation, wrong source, grant callback refusal, retained-ack retry, and >2100 autosaves in a small value quota.
- Focused Service tests: fixed schemas/output, independent grants, extra/forged identity, unknown/cross-app operation, stale binding/generation, replay, changed source/commit/permissions, uninstall, revoked handle/grant, default-off HTTP and owner gate.
- Canonical strict fixture style check reports no findings. Changed-line whole-repo style ratchet has zero errors (existing warnings retained). COMPONENTS size gate must pass before commit.
- Claude Opus independently found receipt exhaustion and cached binding failure; both fixed with regressions. Follow-up: PASS for default-off synthetic scope. Reviews are in `docs/browser-trust-review/`.

## Not proven / required parent-run gate

The child cannot submit durable work (409 restriction). The exact forum job stages the r5 hostile-page pattern extended with the two fixtures, fixture identity/grant resolvers, browser migration/autosave/reload/old-legacy-rollback/recovery, revoked grants, and four in-shell screenshots (both fixtures on Nebula and Sepia). It must run on forum before screenshot inspection or a browser PASS is claimed. Full repository suites are included as separate phases, not inherited from the earlier source heads. No screenshots have yet been produced or viewed by this child. Any browser or baseline failures remain visible in phase logs/receipt; no test filtering to manufacture a green suite.
