# Private seal: combined migration preparation, Round 11

**Staged synthetic preparation only. Not an installer, live approval, or migration acceptance.**

REUSE the accepted Round10b transport/Compose evidence, the existing production seal renderer, provider-key injector, restricted socket edge, stock Hermes image, Service app grants and installed Runtipi API. EXTEND only disposable QA in this round. No second runtime, daemon guard, provider adapter or UI implementation is added. The existing working preview is not rebuilt or stopped.

## Exact selected-source preservation contract

Read-only selection was refreshed during Round11. Fail closed and regenerate this contract if ANY selection moves before combined rehearsal or owner admission.

| Surface | Selection to preserve |
|---|---|
| Live Agent Service | `3ecfd3718fd318005e128fb2ba18f40d48949f18` |
| Independently selected agent runtime | `9f6855f4ed16806d89e6ee4b04deb9a2bdcb4e55` |
| Hosted shell | `1f38e65de1d91c4bc9ce06dc1bd765d2a42dc68b` |
| Service fallback shell | `1f38e65de1d91c4bc9ce06dc1bd765d2a42dc68b` |
| WAM CLI AND API | `543431650de49764833126dc6edc2e8a24c32fc1` |
| Runtime's independent WAM source | `888a61c948bd701f6f2e7cb6fd876795f43fdcc4` |
| Actual Runtipi daemon source | `fead192e9fb2d560fd3b875d092819b32e7189b6` |
| Daemon image identity | `sha256:f2e1be459cf8e8ffc41225a3a676c7a704db6fd96c857a5e2b774c8eee6446d4` |
| Current Tinfoil app source | `9a32d0869618b7855949aebd7aebff87ed215a14` |
| Current Tinfoil app image | `wizard-tinfoil:owner-9a32d08`, `sha256:012e8b936f0f1b9207f268ef39fdee06712a25c6f883b4cfdf5c610a97fc0d19` |
| Stock client | `ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2`, image `sha256:06833b65195fc0dbe7cd136705da29defe42e2474eff2391e66ab00db3744476` |
| Official attestation proxy | `ghcr.io/tinfoilsh/tinfoil-proxy:0.2.3`, image `sha256:cbfababef82676898b0700a5f4895479a92468e99671156cb41fd7d685ee60e2` |

The audit's earlier hosted `367a0b99` and fallback `f0a92607` are NOT the current shell selections. Both now select `1f38e65d`, which carries the later saved-message retry/connection-warning fix. Preserve it on BOTH surfaces. No shell change is needed for the seal.

**Do not deploy PR244 wholesale as the live Service.** At the accepted Round10b head `13980de`, its merge-base with selected Service `3ecfd37` is `7020b709ad8c8afcdf8f177072e1f211c4bcede6`, not `3ecfd37`. A selected-Service-to-candidate diff removes 138 lines in `server/incognito.mjs` and changes the newer agent/grant code. The independently selected runtime `9f6855f` IS an ancestor of the candidate. A future composition must port only the reviewed seal/credential/gateway changes onto the selected Service, preserve the newer Service Incognito/app/Recorder/Mizel binding and grant fixes, and package the runtime from its independent selected source. This round does not claim that composition is built or rehearsed.

Never substitute the old Oct25 installer, frozen shell archive, relay-only Tinfoil replacement or an old candidate approval. Keep inference, confidential search, live transcription and AI connection on the current Tinfoil app. Keep both allowed model identifiers and fallback-off unchanged. Synthetic Mizel/Recorder fixtures do not prove current live recordings or binding data; those remain private and uninspected.

## What the next native runner measures

1. Actual restricted edge container and actual inhibited-bridge client, talking to a synthetic Service over its per-agent Unix socket. The existing grant test exercises Mizel + Recorder calls, ungranted Notes refusal, TCP token refusal and revocation of an already initialized session. These are real Service routes with synthetic apps, not live app content.
2. Actual unchanged selected daemon image, Postgres and queue, inside a disposable nested Docker engine whose only host data bind is the revision-owned staging tree. Real Runtipi HTTP endpoints install from a fresh synthetic Git catalogue, restart, restart the daemon, start again, update a changed recipe, disable owner user-config, attempt the direct lifecycle bypass, re-enable, and restore recipe v1 in a fresh forward-version rollback envelope. Inspect effective container networks, override hashes, recipe versions and generated home/key fixture hashes after each step.
3. Actual unchanged stock Hermes API starts/completes a synthetic conversation against an explicitly NON-AI OpenAI fixture, observes status while its provider is stopped, cancels a still-retrying run before restore, and requires a completed new run afterward. Never convert retrying into a terminal failure. This is a deterministic stock-client regression, NOT attested Tinfoil recovery evidence.
4. Send a real generated one-pixel PNG request, not a model-ID lookup. A deterministic fixture validates receipt of image bytes. Separately the installed sealed client's request goes through the official attested Tinfoil path with an invalid generated fixture key. Record attestation metadata and the real rejection status, never claim image understanding or a successful paid completion.
5. Destroy the exact runner-owned nested engine, client, provider and gateway containers/networks; remove the generated database/key/home work. No VM is started. No Docker prune or cleanup of another owner is permitted. A supervisor timeout may still require exact-label cleanup; the parent must verify zero leftovers after the job.

All fixtures are generated. No owner Private home, chats, recordings, container contents or prompt is consumed. The invalid test key is never a rotation or retirement operation. Old evidence is not overwritten. The source manifest and selected daemon image archive are hash-bound before parent submission.

## Disabled-user-config blocker: mandatory fail-closed gate

The existing runtime refuses a disabled or changed override on readback. This is necessary but is NOT protection against Runtipi's own UI/direct lifecycle endpoint. The selected daemon's `getBaseComposeArgsApp` omits the final owner override whenever `userConfigEnabled=false`, and its disable endpoint currently updates that flag independently. Round11 deliberately measures the direct path against a synthetic sleeping client and generated invalid key.

A source-level expectation or a driver-only refusal does not pass this gate. A generic start error, missing registry image, failed dependency, a post-start watchdog, or observing and then stopping an exposed container also cannot pass. Keep `RUNTIPI_ADMITTED=false`. Do not alter the real daemon to make the test green. Closing this gap needs reviewed lifecycle-owned mandatory enforcement across install/start/restart/update/restore/daemon recovery (or another explicitly admitted complete enforcement point), then a fresh disposable rehearsal. This round adds no competing guard implementation.

## Future combined synthetic migration / rollback rehearsal

This is the required order for a NEW, reviewable candidate, not an executable live runbook:

1. Freeze a fresh manifest for all selections above and the exact candidate diffs, archive identities, provider capabilities and grant/binding API shapes. Stop if any baseline changed. Keep Service, runtime, WAM CLI/API, runtime WAM and both shells as separate artifacts; do not collapse their selections.
2. Build the composition on those exact public sources. Create generated passive fixture homes with known identity/history/memory/config files, synthetic grant bindings and OLD-SYNTHETIC/NEW-SYNTHETIC keys. Hash/count only the fixtures. No owner home copy is authorized.
3. Rehearse a Service-owned, attempt-fenced migration transaction: prove idle admission, snapshot generated state through the installed product API, stop only fixture clients, render the sealed recipe, move ONLY synthetic provider credentials through the trusted runtime, and verify no fixture provider key remains in client-visible files. Prove every named selected delta survives. No operator home edit or raw backup extraction.
4. Start only after mandatory lifecycle enforcement and effective topology readback succeed. Require official inference/search attestation, a real synthetic text completion and native search, an image-content request with its actual capability outcome, Incognito start/send/Close, synthetic app grants and Mizel/Recorder binding, and preserved provider inference/search/transcription/AI-connection contracts. Re-run all original six privacy checks with their actual scopes. TLS packet metadata is NOT decrypted EHBP framing.
5. Stop the provider during an actual stock-Hermes run on this SAME composition. Record terminal failure or bounded retrying/cancel honestly; no completed/fallback answer may occur. Restore, wait for both attestations, and require a completed new synthetic run and search. The local OpenAI fixture results from step 3 above do not satisfy this gate.
6. Inject failures before/after every transaction boundary. Roll back using a FRESH attempt-bound product restore, restoring the installed row before backup restore when required. Verify fixture identity/history hashes, provider capability/grant/binding contracts, exact source selections and original running/stopped state. The Round11 recipe rollback is not a backup/credential rollback substitute.
7. Measure cold-start/restart, failure and rollback elapsed time on the full admitted composition. Do not reuse the old 90–180 second estimate as measured downtime. Preserve passing immutable artifacts and all failed receipts. Parent independently verifies detailed gates, provenance and zero owned leftovers.

Only AFTER that synthetic composition passes may the owner receive ONE fresh, scoped live decision covering downtime, trusted-runtime credential rotation, old credential copies and encrypted old backups, exact rollback authority and expiry. Existing backups may still contain old valid credentials; a codeword/log scan or new key location does not retire them. No such live authority exists in this round.
