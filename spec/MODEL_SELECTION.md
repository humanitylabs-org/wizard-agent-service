# Deliberate model selection contract (candidate)

This describes the Wizard-owned adapter boundary, not a new provider router or a Hermes core change. Economical selection and owner provider configuration are outside this contract.

## Custody

- A deliberate selection is `{model, provider, version, state}`. `version` is a server-owned revision scoped to the thread. A native Hermes lock timestamp is imported only for a thread without Wizard selection custody: native chat execution rewrites that lock and cannot represent deliberate picker intent.
- Picker POST adds `selection_version` (previous confirmed revision) and `selection_request_id` (stable identity for lost-ack replay). A confirmed response includes `selection` and `runtime.selection_version`. A missing old-client revision can reassert the exact existing route, but cannot change an acknowledged selection. A new thread can establish its explicit draft route without an existing lock.
- The server persists pending intent before the native model-lock call. Unknown outcomes remain pending/fail-closed, including after restart. The same request can recover; a competing choice or Send cannot assume success. A proven pre-execution rejection restores the previous choice.
- Every new message captures exact model, provider and revision at Send. The service rejects obsolete/conflicting never-admitted requests with HTTP 409 and a recoverable `model_selection_*` error. It does not run a substitute.
- Durable queue replay resolves exact original request identity BEFORE checking today's choice. A previously admitted message executes its captured route even after a later picker change. The trusted dispatch capability is an adapter init option, never a caller JSON field. Browser outbox, recording recovery and native capture retain the captured revision with the immutable body/key.
- Missing revision on a legacy matching send is accepted; mismatching routes fail visibly. No model/provider family has privileged routing policy. Provider unavailability does not authorize substitution.
- Display reconciliation retains the highest confirmed revision. A delayed list response cannot erase a newer picker acknowledgement. Pending/uncertain picker outcomes block sends without dropping draft custody.

## Integration gates before release

The candidate currently integrates the main-agent native bridge and the shared web model/outbox paths. It is **not release accepted**. Agent-qualified/private selection custody, display-provider/transport aliases, routed queue enforcement, active-runtime steer checks, full offline/retry/browser coverage, phone/desktop two-skin evidence, stock-Hermes integration, exact-head CI, app parity, disposable actual-entry live canary and drain-aware deployment remain mandatory gates. Existing routed-provider stripping is not evidence of exact-route enforcement. Do not publish a main-only change as universal/private routing acceptance.

REUSE: existing model chip, outbox, RunQueue, native LockedRunBridge, durable run events.
EXTEND: acknowledged selection revision, immutable captured route, pre-admission conflict, replay ordering, native runtime checks.
NEW: minimal adjacent deliberate-choice custody (`model-selection.mjs`), needed because native execution mutates its own lock. No scheduler or credential store.
