# Deliberate model selection contract (candidate)

This describes the Wizard-owned adapter boundary, not a new provider router or a Hermes core change. Economical selection and owner provider configuration are outside this contract.

## Custody

- A deliberate selection is `{model, provider, version, state}`. `version` is a server-owned revision scoped to the thread. A legacy lock is imported once at initial revision 1, not at its mutable native timestamp: native chat execution rewrites that lock and cannot represent deliberate picker intent.
- Picker POST adds `selection_version` (previous confirmed revision) and `selection_request_id` (stable identity for lost-ack replay). A confirmed response includes `selection` and `runtime.selection_version`. A missing old-client revision can reassert the exact existing route, but cannot change an acknowledged selection. A new thread can establish its explicit draft route without an existing lock.
- The server persists pending intent before the native model-lock call. Unknown outcomes remain pending/fail-closed, including after restart. The same request can recover; a competing choice or Send cannot assume success. A proven pre-execution rejection restores the previous choice.
- Every new message captures exact model, provider and revision at Send. The service rejects obsolete/conflicting never-admitted requests with HTTP 409 and a recoverable `model_selection_*` error. It does not run a substitute.
- Durable queue replay resolves exact original request identity BEFORE checking today's choice. A previously admitted message executes its captured route even after a later picker change. The trusted dispatch capability is an adapter init option, never a caller JSON field. Browser outbox, recording recovery and native capture retain the captured revision with the immutable body/key.
- Missing revision on a legacy matching send is accepted; mismatching routes fail visibly. No model/provider family has privileged routing policy. Provider unavailability does not authorize substitution.
- Display reconciliation retains the highest confirmed revision. A delayed list response cannot erase a newer picker acknowledgement. Pending/uncertain picker outcomes block sends without dropping draft custody.

## Integration gates before release

The candidate implements main and per-agent deliberate custody, mapped routed native streaming, active-runtime steer guards, immutable admitted transport bindings and qualified picker/recovery maps. Registry display providers are never stripped before admission. The adapter resolves only the configured, allowlisted native transport from that agent’s own model catalogue; unknown custom aliases fail visibly before inference. Existing unproven routed queue rows cannot be retroactively claimed as locked.

It is **not release accepted**. The exact-head targeted/full comparative suites, all offline/retry/browser paths, phone/desktop two-skin evidence, stock-Hermes integration, required CI, app parity, disposable actual-entry canary and drain-aware deployment remain mandatory. No existing owner configuration or defaults are changed. The first forum full suites failed and their evidence is retained; new static checks are not runtime acceptance.

REUSE: existing model chip, outbox, RunQueue, native LockedRunBridge, durable run events.
EXTEND: acknowledged selection revision, immutable captured route, pre-admission conflict, replay ordering, native runtime checks.
NEW: minimal adjacent deliberate-choice custody (`model-selection.mjs`), needed because native execution mutates its own lock. No scheduler or credential store.
