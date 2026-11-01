# Stock native compatibility — bounded source verdict

**Status: primary native byte contract understood; private-route compatibility NOT admitted. No product matcher change.** This is evidence classification, not a release or privacy waiver.

## Bound evidence

Stock Hermes revision `f97608f178d1ffeca59860195ab7da295f7c8e5f`. Captured job `heavy_aa7fd254fdea43df944514268cbd7cd6`. Complete evidence manifest SHA256 `0326f165a1326b5f95fc46e4310b24d6caa816fc9932e66d2b96c66ddbafd28a`: all 539 members verified against bytes before copying this synthetic subset. Both complete native indices were independently checked for every request/response hash and size. `tests/fixtures/stock-native-20261101/provenance.json` binds copied original paths/hashes; no temporary path is needed to run the offline tests. Original failed receipt is preserved unchanged.

## What the source actually guarantees

- `gateway/platforms/api_server.py:329-341,2024-2104`: explicit requested provider/model goes through `resolve_runtime_provider`; base URL, provider, credentials and pool are returned together, without modifying global config.
- `hermes_cli/runtime_provider_custom.py:139-168,191-207,522-579`: new-style saved entries match `custom_provider_aliases` of display and config key, then legacy entries; first matching configured entry wins. Named provider resolves to its endpoint but transport provider becomes `custom` (`_custom_runtime`,455-464). A shared model is not ambiguity evidence: model membership/uniqueness never attests endpoint identity. An alias collision is not resolved by guessing. Explicit endpoint overrides/pools are part of actual resolution and cannot be silently ignored by a Wizard fingerprint.
- `api_server.py:2260-2278,3903-3944`: primary main-agent fallback is disabled for a confirmed request lock. `_hermes_api_runtime.provider` records the resolved primary provider at construction; final metadata compares actual provider/model to that resolved canonical provider/model, not literally to the logical saved provider. It emits requested IDs separately. There is **no endpoint URL/fingerprint, logical resolved_route, or title-egress attestation in final metadata**.
- Actual captured `/chat` final provider is `custom` for both generic and named requests. Named requested provider remains `custom:fixture-local`, final lock `confirmed`. Stream `run.started` actual provider/model are empty and lock `accepted`; assistant delta and tool progress arrive *before* the confirmed final. None of those early events is output permission. `/v1/runs` final has actual primary runtime and requested IDs but **no model_lock**; do not manufacture one. Legacy session creation/projection has saved model config, not selected/confirmed execution custody.

## Title egress: default is NOT blindly global, but confinement is absent

Pinned paths and lines below are source evidence, not a claim that the two-endpoint diagnostic has already run:

1. `agent/turn_context.py:170-228`: every non-skipped API-server primary turn can schedule auto title, passing actual agent provider, model, base_url, api_mode and API key in `main_runtime`. It copies runtime context into the worker.
2. `agent/title_generator.py:407-464,561-603,655-720`: sends the user's opening snippet (up to 2000 chars) to `call_llm(task="title_generation", main_runtime=...)` in a background thread. Auto titles can retry greeting/provisional titles through early exchanges. This is user-content inference, not metadata.
3. `agent/auxiliary_client.py:4483-4554,4593-4623,4833-4878`: with task provider `auto` and no explicit override, the scoped main runtime endpoint is inherited. For two custom providers with the same model, noncurrent requested B should title at B, **not configured global A**, on the normal path. Do not diagnose a global-route leak merely from final transport `custom`.
4. **Fundamental blocker:** `auxiliary_client.py:6020-6094,7261-7273` independently re-reads `auxiliary.title_generation`/legacy task routing. Explicit task provider, model, base_url, API key/mode can supersede main runtime. Nothing threads the native request model lock into this title routing decision. An explicit configured title provider A can receive the B turn's opening text while primary final still truthfully says B's canonical transport `custom` and `confirmed`.
5. `auxiliary_client.py:4410-4448,4998-5059,7610-7693,7798-7839`: explicit task `fallback_chain`, main `fallback_providers` and final-main retry are independent auxiliary failure routes. Discovery of arbitrary logged-in providers is gated by `fallback_chain=="all"` (3053-3064); do not overclaim automatic arbitrary discovery. Nevertheless *configured* fallback A can receive user text after B title fails. Primary lock disabling main-agent fallback does not disable this auxiliary path. Even if primary output is withheld, title content has already left.
6. `auxiliary_client.py:2410-2455,6020-6094`: provider/model readers prefer scoped runtime, but task config is read independently. A catalogue read or frozen primary selection is not a bound snapshot of all auxiliary config across awaits/background execution. Fingerprint/recheck after inference cannot undo egress.

Wizard itself exposes title persistence/renaming but this audit found no separate title-inference call in the locked native bridge. The implicated native auto-title path is below the Wizard bridge. No change to title generation, route policy, or Hermes core was authorized.

## Admission decision

Do **not** broaden the current Wizard matcher from literal logical provider to canonical `custom` based on unique model, requested-only fields, fixture labels, or a whole-catalogue fingerprint. A valid primary final is necessary but insufficient to certify *all user-content egress*. This source cannot uphold a selected/private endpoint boundary for all supported task override/fallback/drift configurations merely by displaying the requested provider. Keep fail-closed private selection and exact saved logical provider; do not relabel legacy unlocked admissions as deliberately selected.

A future minimal Wizard-owned option would need a **pre-egress**, immutable/custodied admission contract covering the entire native primary + auxiliary routing closure and every retry/recovery. This task does not assume that exists or disable product titles to manufacture it. If that confinement cannot be implemented without core changes, the honest result is a fundamental blocker. No speculative product mapping is included here.

## Wire oracle v2 (not a waiver)

Per original two-turn adapter: metadata(alpha), reply(alpha), **title(alpha)**, metadata(beta), reply(beta). Both adapters together: **6 total inference = 4 reply + 2 title; 4 metadata**. The old runner's exact-four-ALL-inference assertion was ours, not an owner criterion. Keep original failed receipt intact. The new classifier requires exact pinned source prompt hash (including default language rule/examples), response schema, two-message shape, complete request key set, and `/v1/chat/completions`; matching the repeated user text alone is insufficient. Titles remain billed/content-bearing inference. Unchanged original adapter keeps all five replay/stale/provider assertions. Replay/stale/wrong-provider still add zero calls; no additional count thresholds are inferred.

## Broad compatibility taxonomy / deliberately open

- Actual native field/phase mismatch: committed raw capture tests document it; no broad fixtures get invented `resolved_route` or synthetic confirmation.
- Early output: gate all assistant/progress content until a confirmed final; source diagnosis here does not claim existing product satisfies that gate.
- Migration/recovery: preserve actual admitted route custody or typed refusal requiring fresh intent. Never silently reauthorize unlocked legacy/private data.
- Narrow UX contract fixture: active-run GET now includes the four known run identities and session s1, initial old-Opus runtime is confirmed. Guard and all 22 contract checks stay intact.
- Retained compat's three known baseline failures (ambiguous frozen dispatch and two Operator restart cases) remain unwaived. Unchanged focused passes may be inherited only through the parent's exact-head dependency evidence. Broad suites, full CI, skins/browser, release acceptance and deployment remain open.
