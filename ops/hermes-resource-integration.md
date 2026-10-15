# Post-resource-lanes Hermes compatibility candidate (not an activation)

## Lineage and scope

Merge the prepared resource-lanes release `35b37b808bd0051f23dbc81f0299c503364899b6` with the reviewed deployed-base compatibility branch `bbb428f4ef351539c7af57475c295362b1827d89`. Their common base is `e401bf2b48688ccef3f9360d2faf559009e87c1d`.

This is integration, not a replacement implementation. The resource parent retains its interactive reserve, provider-scoped cooldown, durable heavy work/continuation ownership, admitted-sibling stop/steer invalidation, helper receipt recovery/provenance, and safe run-context projection. No UX edits, Hermes upgrade, live source change, restart, native build or VM build belongs to this candidate.

## Conflict decisions (every conflicted hunk)

| Hunk | Chosen invariant |
| --- | --- |
| Service imports | Keep heavy integration **and** compatibility helpers. Neither feature replaces the other. |
| Service `hermesJson` error | Preserve structured upstream code/error and Retry-After, while retaining the caller's existing preserve-status behavior. Operator-worker admission needs the same permanent-error classification as direct admission. |
| Service continuation validation | Before the first parent HTTP dispatch, retain manual authority checking, heavy job/request/stop validation, and the resource branch's asynchronous helper validation. Once the actual parent wire body is frozen, same-key replay reconciles the attempted send; it is not a new continuation and must not be cancelled by a subsequently stale receipt. |
| Service parent admission error | Preserve structured error plus Retry-After, not status alone. |
| Queue launch failure | Classify permanent admission errors **before** retry/backoff. Keep provider scope and exponential cooldown for retryable failures. Bound only the locally generated exponential delay, never the supplied Retry-After or an already later scope deadline. Retain structured failure and safe explanation. |
| Queue tick | Keep interactive ordering/reservation and provider cooldown checks. Add literal-unknown session fencing without counting unknown as global occupancy. A reserved slot never bypasses a provider cooldown. |

The nonconflicted `backgroundResults.validateDispatch` also needed reconciliation: as in compatibility feature `5fa1d72`, skip mutable dispatch validation for a frozen parent-body replay. Its original internal marker still must match the durable service-written manual authority. Never trust client-supplied continuation priority or recovery authority.

Both wire bodies remain independently immutable: the Operator worker may have been attempted before its parent. The existing native LockedRunBridge lost-ack limitation remains documented in `scripts/acceptance/README.md`; this merge does not bypass its refusal or claim canonical recovery for native ambiguity. Legacy rows without a stored wire body retain the conservative migration behavior; do not invent missing historical request bytes.

## Verification and evidence boundaries

All tests run on the remote build/test host's external media volume, using its existing Node/dependency installation and exact unmodified Hermes v0.22.1 acceptance checkout. The integration-work run passed:

- Focused queue/resource/reserve/continuation/helper/compatibility/context set: **237 tests across 19 files**.
- Broad service suite: **704 passed, 3 existing opt-in skips; 60 files passed, 1 skipped**.
- Canonical harness: **PASS**, actual upstream authority/HTTP adapters with deterministic execution, including generation conflict, exact repeated resolution, one follower execution and no head replay. This is not a full gateway reboot or real-provider canary.

New overlap coverage is not just independent component testing:

- Unknown plus active-session-reader leases, interactive reserve, background saturation, manual interactive admission and durable restart in one queue.
- Permanent permission/idempotency/admission conflict with a Retry-After header does not poison provider cooldown or prevent the next human turn.
- Numeric and HTTP-date long Retry-After survive restart; manual reserved input waits within its busy provider scope while another provider proceeds.
- Restarted service treats stale helper/heavy/manual records differently at the attempted boundary: fresh dispatch is fenced, frozen replay is byte/key-identical. These cases use explicit durable crash fixtures, not a claim that a fake endpoint created real jobs.
- Actual manual Continue HTTP flow loses its acknowledgement, sees a newer human turn, restarts and retrieves the original receipt with identical wire bytes/key and one logical upstream execution. The existing unattempted lease/history/stop/steer tests remain in the focused and broad runs.

The final handoff records the immutable pushed commit, exact-source rerun logs and source-manifest verification separately. Existing evidence SHA-256 strings trigger six directory-mode secret-scan false positives; the unchanged repository ignore file covers their exact historical fingerprints. Scan the integration diff before committing; do not add broad secret exclusions.

## Parent-owned deployment prerequisites

1. Preserve the resource release's sole activation ownership. This candidate contains the prepared resource marker, not a promise that it is the final live marker. Re-read actual final live source and require ancestry/fast-forward reconciliation (including any later admission-fence/release-protection patches) before promotion. No separately named deployment admission-fence module/test is present at pinned `35b37b8`; the tested admission guards here are queue/continuation guards, not an assertion about external activation tooling.
2. Parent independently reviews the conflict decisions and exact-source test evidence, then follows the existing serialized resource-lane idle/drain and release-protection procedure. Do not wait for live idle as part of finishing this integration worker.
3. Retain all durable queue/job/receipt state. Compatibility adds dispatch-attempted, parent-body and worker-body columns. Old-source rollback is not automatically safe once ambiguous attempts or canonical unknown records exist; quiesce and review rather than deleting evidence or blindly retrying work.
4. Preserve the original provider/model and heavy helper/plugin setup. The real model-selected heavy-work canary and final live source/health readback remain release-owner gates; this isolated harness does not satisfy them.
5. UX compatibility is already live via its separately approved release; no UX promotion is included here.
