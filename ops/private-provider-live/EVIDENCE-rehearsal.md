# Private-provider launch rehearsal — BLOCKED

## pp-rehearsal-5 (latest authoritative checkpoint)
- Full fifth attempt was executed and collected under the shared Thales worker lock: `REHEARSAL-LEGACY-FIX-5.json`. No sixth full run was launched; the explicitly authorized five-attempt cap is exhausted.
- **a PASS**: product-created synthetic legacy agent completed its canonical `PP_OK` turn. **b FAILED**: physical private-local install and override API readback passed; connect failed with `http.client.RemoteDisconnected` on the first credential POST. **c/d/e/f NOT RUN**; six privacy checks and migration/removal/regression remain unproven.
- The DATA_DIR token-location fixture fix is committed/pushed as `acbd705`. This attempt failed earlier than that read, on `/api/connect`, only about one second after install. Source confirms egress reconciliation returns after `docker start` without management readiness; a startup race is consistent with the observed failure, not yet proven by a successful replay.
- Added a bounded credential-free GET readiness gate after reconciliation and before reading/submitting the key. It retries startup disconnects only on GET, validates the provider contract, and never retries a credential POST or inference. Eight focused synthetic authentication/readiness tests pass; the complete lightweight tooling suite passes **52 tests** under `/usr/bin/python3` (which has PyYAML). This new fixture repair has **not** been exercised on a full rig replay because of the cap.
- Unconditional reset completed, with exact-target readback: provider key absent, provider volumes `[]`, apps `0`, synthetic agent directories `[]`. All jobs launched by this lane were collected; none are left running.
- Actual live read-only `DRY-RUN-5.json`: **BLOCKED**, two blockers (rehearsal not passed; production promotion/rollback adapters unfinished), authenticated Runtipi GET passed, all protected before/after fingerprints unchanged. No live mutation/restart or Private access occurred. Conditional production-tooling work was not promoted past its failed rehearsal gate; there is no safe production parent command yet.
- Deployment discovery: WAM #210 changes only `wam/cli.py` and `wam/registry.py` plus tests; it does not change the running daemon's `main.mjs`. Live Runtipi remains the exact rig-tested digest. The owner CLI selects an immutable WAM source release; the runtime separately selects its `--wam` source. A future adapter must stage the fixes into those actually selected sources, not merely the unrelated checkout, and continue using the authenticated lifecycle/user-config APIs. No daemon deployment or root-directory writes were performed here.
- Product CI was re-read: Service #161 at `5114d2d`, WAM #210 at `0a1e0192`, UX #220 at `f34c7a3` have passing relevant completed checks; image publication is intentionally skipped on feature PRs. No merges were performed.

## pp-install-fix continuation (historical; superseded by checkpoint above)
- No-key replay on the exact daemon reproduced `yaml.constructor.ConstructorError` for Compose `!override`. The API appends a newline, defeating exact override-string equality. Both the prior-value guard and PUT/GET readback now normalize trailing newlines only; unexpected content still fails. Ten focused redaction/guard tests passed.
- Reset previously missed `user-config/wizardapps/<id>`; cleanup now covers the nested store directories on pp-rig only.
- Subsequent no-key replay reached real daemon installation. Missing legacy dashboard form data failed generation without a container; an explicitly unused relay-only form value allows generation to advance. The daemon then returned `Fixed volume name tinfoil-private-data` from WAM's portable-storage compiler. The installer now keeps the provider-only credential volume in the owner Compose override through API GET/PUT/GET instead of feeding it through the portable-volume compiler. `networks: !override` remains intact.
- Found a genuine WAM registry integration bug: physical `_private` app URNs were excluded on ordinary registry rebuilds. WAM branch `fix/private-local-provider-projection`, commit `80c0a55c`, adds narrow provenance-checked canonical projection for installed attested local relays while retaining the physical lifecycle URN. Six real Python tests passed; the commit is pushed. Rehearsal uses that product implementation, not a one-off monkeypatch.
- Exact no-key API install passed as uid1000 (`NO-KEY-INSTALL.json`): fresh API returned null compose/env, lifecycle reached running, canonical provider capability persisted, API override readback matched, and reset had key absent / provider volumes [] / apps 0. This proof used WAM CLI commit `0a1e0192`; its root-owned grant fallback uses authenticated GET rather than permission changes. WAM PR #210 is pushed, 21 targeted tests pass, and all current GitHub checks pass.
- Full paid attempt 3 (`REHEARSAL-LEGACY-FIX-3.json`) passed legacy chat and physical provider installation, then failed in runtime reconciliation before key connect. Composite b remains failed; c–f did not run. Final reset again confirmed no key, volumes, apps, or synthetic agent dirs. One full attempt remains under the four-attempt cap. A no-key reconciliation diagnostic is queued under the shared Thales worker lease; do not duplicate it.
- The no-key diagnostic identified a second real product bug: Docker returned HTTP **499** from `engine_create`; `subprocess.run(input=...)` closes the `docker system dial-stdio` write side before creation finishes. Fixed in Service #161 at `5114d2d036afb655e86cd49c45fc7ea611559a2d` (pushed, no merge). The new transport retains its write side through the response, times out/kills/reaps, and withholds daemon bodies/stderr. Baseline code fails the real child-process regression; updated focused runtime suite passes **40 tests / 33 subtests**, unraisable exceptions treated as errors.
- Exact no-key API install **and runtime reconciliation** now pass with WAM `0a1e0192` and the digest-checked Service engine overlay (`SERVICE-ENGINE-FIX.json`, `NO-KEY-INSTALL.json`). Final reset again verified key absent / volumes [] / apps 0 / synthetic agents [].
- Full attempt 4 is queued under the shared Thales lease. Its connect adapter now requires one completed short SDK inference plus genuine `credentialVerified=true` readback; model-list verification alone intentionally leaves the product unconnected. Four adapter tests prove that stored-only, incomplete and unverified results cannot claim success.
- No live service lifecycle command has run. Protected live metadata was read only; production promotion remains unauthorized until all acceptance passes.

## Earlier lane: pp-legacy-fix — legacy chat baseline

- Root cause (a) is the synthetic fixture, not a demonstrated #161 backend bug. Actual `legacy-fix-diagnose.log` on Thales shows private API health 200, sessions 200, nonexistent session **404**, fabricated-id Service creation **503 agent_unavailable / agent.history**, and server-minted creation **201**. A subsequent canonical legacy turn completed with PP_OK. The unavailable-main unit regression passes on both main `9a59bcd` and #161-derived tooling; backend source still matches `888ecee` unchanged.
- Fixed product-created legacy-agent setup and canonical server-minted session admission in both turn adapters. Tooling commits `c309268` and `94bcbbd` are pushed; no admission/security policy was weakened. Focused Node suites **14/14**, main regression **1/1**, Python orchestration/projection/host/adapter suite **19/19**, and focused override/host/adapter suite **8/8** passed (overlapping suites, not additive unique totals).
- Attempt 1: **a passed**; **b failed before install** at the prior-empty user-config assertion; **c–f not run**, privacy **0/6**. The no-key reproduction preserved the exact assertion failure. The guard is now patched to accept only semantically empty/comment-only templates or this runner's exact bootstrap override, preserve comment-only appEnv, and refuse other meaningful config. Its five AST guard cases pass; the actual API metadata debug and full retry are still waiting for the shared worker lease.
- Attempt 1 final reset was separately read back: **provider_key_present false; provider_volumes []; apps 0; synthetic_agent_dirs []**. Receipt copied locally as `REHEARSAL-LEGACY-FIX-1.json`. No key is printed or written to Thales disk. This completed reset does not predict the state of the active retry.
- Full attempt 2 is already invoked directly as `run-locked.py ... legacy-lane.py 2`, under one lease with unconditional final reset; **do not submit a duplicate**. It writes `REHEARSAL-LEGACY-FIX.json`, `REHEARSAL-LEGACY-FIX-2.json`, and private `legacy-fix-2-<phase>.log`. A separate NO-KEY prior-config debug is also waiting and always resets. Source scripts and continuation details are in `HANDOFF-pp-legacy-fix.md`.
- No live mutation, protected VPS restart, owner Private data read, or Private message occurred. Production promotion/rollback operation adapters remain unfinished. This is not full rehearsal acceptance and does not authorize a live restart.

## Previous lane: pp-rehearsal-3 — BLOCKED after two baseline repairs

- Authorized route for this helper is the direct shared `run-locked.py` worker lease on Thales; no durable-helper admission is attempted. Other threads' VMs are untouched.
- Parent preparation completed: exact live amd64 WAM image and daemon-source hash match, owner uid1000 and all recorded root-owned/writability metadata match. `RIG-PREPARATION.json` is preparation-only evidence, not acceptance.
- During setup, exact-pinned Service/runtime ran as uid1000 on pp-rig (stopped by the final reset), with the digest-pinned client image staged (no sealed client container is yet proven). Removed retired `WIZARD_AGENT_HOST` / `WIZARD_AGENT_PORT` from the synthetic Service environment. Docker Hub returned HTTP 429 while redundantly rebuilding the sidecars; recovery reused existing images only after comparing every copied source file's SHA256 inside a network-none, read-only container with the immutable exported source. Three cached images matched. `rehearsal3-setup-cache-repair.log` records success.
- Rebuilt the attempt-scoped orchestration engine with guarded migration ordering, six-check requirement, fake-tested automatic rollback, exact-live-base staging requirement and a 600-second refresh budget. Added a real Thales candidate staging/build/test adapter. These components are not yet a complete production operation plan, and the dry-run must continue to reject missing operations or unpassed rehearsal evidence.
- Added a canonical projection extension for the real `_private` installed-app URN. It wraps the shared WAM projector, requires authenticated actual installation plus exact `local:` metadata, preserves the physical URN, and cannot synthesize an absent app. It does not replace the daemon or write root-owned app directories.
- Local orchestration/projection/merge-resolution/UI-fingerprint/recovery/preparation unit run: **32 passed**; these are fake orchestration tests, not paid inference/privacy acceptance.
- Check **a FAILED**: synthetic legacy agent `/health` and `/v1/models` returned 200, and the Service reported it running, but routed turn/session admission returned HTTP **503 `agent_unavailable` at `agent.history`**. Two baseline repair attempts did not produce a completed turn. Stop this acceptance path rather than spending more paid turns. Checks **b, c, d, e, f NOT RUN**; six privacy checks unproven.
- Final rig reset succeeded with separate exact-target readback: `provider_key_present=false`, provider volumes `[]`, installed apps `0`, remaining synthetic agent directories `[]`. See private `RESET-3.json`; no provider key remains in the canonical guest locations or remaining container environments.
- Actual `DRY-RUN-3.json` is **BLOCKED**, with two readiness blockers: unpassed exact-release rehearsal and unfinished production promotion/rollback operation adapters/plan. Authenticated Runtipi GET succeeded; the protected container/unit/release/UI fingerprints were unchanged. No live mutation, protected-unit restart, Private message or Private directory read occurred.
- Candidate merge staging preserved live chat/Spaces behavior and provider changes using eleven exact-reviewed conflict hunks. Actual merged Service suites passed **82 tests**; runtime suites passed **60 tests plus 42 subtests**. The final staging refresh **PASSED**: merged candidate `9912765e6d710840fbbc22dcde59dbf5009cb88e`, static UX **770/770 tests**, and a locally downloaded artifact whose SHA256 matches the remote receipt. Candidate staging is not rig acceptance.
- Raw owner-host receipts remain in the private lane rather than this public repository. No complete safe parent promotion command exists yet. Next options: inspect/repair the session-history fixture under a newly authorized attempt, or rebuild that disposable fixture with a functioning canonical session/catalog baseline; then rerun a–f and complete the production adapters.

## Resume: pp-rehearsal-2

- Recovered guest is reachable, marker `pp-private-providers`, uid/gid 1000. Before any reset, saved seven remaining probe scripts plus SHA256 inventory to `pp-launch/live/guest-saved/` on Thales and the matching control-plane directory. `/home/rig/pp-candidates` is absent: the old request/migration/installer adapters and `live_candidate.py` / `live_ops.py` did not survive the baseline reset.
- The recovered baseline is **not live-parity**: four Runtipi state directories are owner uid1000, while live directories are root-owned. Guest WAM is old `latest`, image `sha256:0a1f04fa318d05f02ae846440d5ac7b3e724e7025270bad7726cbda7494f1f6f`, main.mjs `27499acdf76556ede6181b0c067aad530070bf496f8da62d9ae603936a75e869`.
- Fresh read-only live inspect confirms WAM `sha256:07df73e79ee3bea5465cd27d90f99191317075e7a669678a8d066c51473d4116`, main.mjs `6e2b3e410f1e54fce473452d79102edc3c11e36ae69237e4ab232e8f43ebef42`. This digest is **linux/amd64**, while the guest is aarch64 with a `rosetta` binfmt registration. Exact-digest parity must therefore explicitly use amd64 rather than silently substituting an arm64 build.
- Staged `rig-prepare.py` for durable parent admission: marker/clean-fixture checks, immutable source validation/copy, exact pinned WAM/client pull, rig-only WAM replacement, root-owned metadata setup, and uid1000 read-back. This is prerequisite preparation, not a complete rehearsal or live-run orchestrator. Seven fake-orchestration safety tests passed. Thales `--validate` passed without VM mutation.
- Fresh `DRY-RUN-2.json` remains honestly **blocked**, with two readiness blockers: missing exact-release acceptance and unfinished full live orchestration. The before/after protected-container, unit and Service/runtime fingerprints are equal. Authenticated Runtipi GET succeeded; no provider is installed live. No key was read/injected, no paid turn occurred, and no live restart/mutation or Private access occurred.
- Checks (a)–(f) remain NOT RUN. This helper's actual durable submission (`pp-rehearsal-2-prepare-parity`) returned **HTTP 409 heavy admission refused**, no receipt and no running/queued job. The next required action is genuine-parent admission of `PARENT-SUBMIT-2.json`; do not bypass the refusal with a foreground SSH VM job. No additional James authorization or Miguel realtime code is needed for this prerequisite. Tooling checkpoint before this admission-result update: `6b17f3f21873797c06bb2c9f096364f9f35991f7` (pushed and remote SHA verified).

## Previous attempt

## Outcome
No launch acceptance is claimed. The disposable `pp-rig` VM reports **Broken**: its Lima host-agent socket refuses connections and guest SSH resets during key exchange. Its existing disk is present. Do not reset it before recovering the old guest-side scripts: the external-volume tree retains only some host/parity wrappers, while the previous live-run implementation may exist only under the guest's `pp-candidates` directory.

The native durable submission returned **HTTP 409, heavy admission refused** from this delegated helper. It did not return a job receipt; no recovery is running or queued. `PARENT-SUBMIT.json` is the exact updated recovery specification for the genuine parent to submit. The runner attempts at most two starts with one intervening forced stop of only `pp-rig`; it never replaces disks or touches live services.

## Requested checks

| Check | Result |
|---|---|
| Exact service/runtime + UX + pinned client deployment | NOT RUN: guest unreachable |
| No provider app: legacy synthetic Private chat/history | NOT RUN |
| 1. Relay ciphertext/EHBP capture | NOT RUN |
| 2. Hermes seal/client reachability | NOT RUN |
| 3. Client topology and egress | NOT RUN |
| 4. Provider-key location | NOT RUN; no key read or copied |
| 5. Stopped-provider terminal error/recovery | NOT RUN |
| 6. Provider logs/data codeword absence | NOT RUN |
| Explicit legacy migration/history/uid/gid retention | NOT RUN |
| Provider removal: visible fail-closed status | NOT RUN |
| Other-agent chat and vision helper regression | NOT RUN |
| Final reset: no key, zero apps | UNVERIFIED: guest unreachable; old baseline receipt is not current evidence |

## Source preparation completed
- Service/runtime source export: `888ecee067cde661f069875dc5915a7abe341103`.
- UX export: `f34c7a35a8d5f4adbca9eeb57cb83837b1664ba6`.
- Client: `ghcr.io/humanitylabs-org/wizard-private-client:0.1.0@sha256:c562bef2166e6e1054be8eed34229cf0ead4574002da28f8fe5d4f09ad0e6631`.
- **Prepared, not deployed/tested on rig:** relay-only provider `07eca5e30ca7873ab8cfda503175768fc55f66d4`, pushed as `defleur-agents/wizard-tinfoil` branch `ops/relay-only-launch`. This replays the seven relay commits through old `b2ad0d5` onto current upstream main `cbfa896fdd1d484f9c96c44d8b5ad7c20dc3474e`, preserving current billing/UI changes, without realtime SDK commit `9a32d08` or PR #4. Git ancestry check confirms exclusion. Two replay conflicts were resolved by keeping current version 0.3.1 and adding the relay descriptor response.
- Provider unit suite: **23 run, 1 skipped, zero failures**. No paid inference performed.
- Recovery safety suite: **3 passed** (healthy start, bounded broken-hostagent repair, two-failure disk preservation).
- All three exported archives on Thales match locally computed git-archive SHA256s; see `SOURCE-MANIFEST.json`.

## Live read-only discovery / actual dry-run
`live-preflight.py --dry-run` returned **BLOCKED**, not green. Its two explicit readiness blockers are absent exact-release rehearsal evidence and the not-yet-rebuilt complete `live-run-all` promotion/rollback implementation. This file is a real read-only preflight, not a substitute launch orchestrator.

The actual run successfully authenticated a Runtipi **GET** and established that the private-local provider app is absent. Before/after fingerprints of Service/Runtipi container IDs/start times, four protected user units' PIDs/start timestamps, and Service/runtime current release receipts were identical. No live mutation or restart occurred, and nothing was sent to Private. No private agent directory or messages were read.

Observed live deployment, requiring fresh re-discovery before any future promotion:
- Service release `b4114746e0373cd6aacae0f44655dd707eb10731` (`fix/replay-dedupe-memory`), **not** the mobile UX checkout's unrelated HEAD.
- Runtime release `f93a26b9eca83d31213b09de522c4f79dcfb930c`.
- WAM/Runtipi image `ghcr.io/humanitylabs-org/wizard-app-manager@sha256:07df73e79ee3bea5465cd27d90f99191317075e7a669678a8d066c51473d4116`.
- Live `/app/main.mjs` SHA256 `6e2b3e410f1e54fce473452d79102edc3c11e36ae69237e4ab232e8f43ebef42`.
- Root-owned Runtipi `app-data` is 0755, not writable by uid1000; live `user-config`, `apps`, `state` are currently 0777. Installation must still use API GET/PUT/GET and rehearsal must not exploit the looser directories.

## Durable handoff
The requested Service branch `ops/private-providers-live-run` contains the real read-only preflight, tested recovery runner, immutable release pins, source manifest, and this evidence. It does **not** contain a finished `live-run-all`. Working copies and sanitized actual dry-run receipt are retained in the requested local `pp-launch/live` directory and matching external-volume Thales directory. Archive staging is under the latter's `sources/`.

Next operation belongs to the genuine parent: submit the staged recovery job, consume its actual receipt, recover guest scripts without a disk reset, then continue exact-build rehearsal and full tooling reconstruction. **Do not ask James for a restart yet.** No new owner authorization or Miguel change is needed merely to admit recovery; Miguel's realtime SDK remains outside this relay-only release.
