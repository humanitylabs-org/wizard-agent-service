# Private-provider launch rehearsal — BLOCKED

## Resume: pp-rehearsal-2

- Recovered guest is reachable, marker `pp-private-providers`, uid/gid 1000. Before any reset, saved seven remaining probe scripts plus SHA256 inventory to `pp-launch/live/guest-saved/` on Thales and the matching control-plane directory. `/home/rig/pp-candidates` is absent: the old request/migration/installer adapters and `live_candidate.py` / `live_ops.py` did not survive the baseline reset.
- The recovered baseline is **not live-parity**: four Runtipi state directories are owner uid1000, while live directories are root-owned. Guest WAM is old `latest`, image `sha256:0a1f04fa318d05f02ae846440d5ac7b3e724e7025270bad7726cbda7494f1f6f`, main.mjs `27499acdf76556ede6181b0c067aad530070bf496f8da62d9ae603936a75e869`.
- Fresh read-only live inspect confirms WAM `sha256:07df73e79ee3bea5465cd27d90f99191317075e7a669678a8d066c51473d4116`, main.mjs `6e2b3e410f1e54fce473452d79102edc3c11e36ae69237e4ab232e8f43ebef42`. This digest is **linux/amd64**, while the guest is aarch64 with a `rosetta` binfmt registration. Exact-digest parity must therefore explicitly use amd64 rather than silently substituting an arm64 build.
- Staged `rig-prepare.py` for durable parent admission: marker/clean-fixture checks, immutable source validation/copy, exact pinned WAM/client pull, rig-only WAM replacement, root-owned metadata setup, and uid1000 read-back. This is prerequisite preparation, not a complete rehearsal or live-run orchestrator. Seven fake-orchestration safety tests passed. Thales `--validate` passed without VM mutation.
- Fresh `DRY-RUN-2.json` remains honestly **blocked**, with two readiness blockers: missing exact-release acceptance and unfinished full live orchestration. The before/after protected-container, unit and Service/runtime fingerprints are equal. Authenticated Runtipi GET succeeded; no provider is installed live. No key was read/injected, no paid turn occurred, and no live restart/mutation or Private access occurred.
- Checks (a)–(f) remain NOT RUN. The next required action is durable admission of `PARENT-SUBMIT-2.json`; do not bypass helper admission refusal with a foreground SSH VM job. No additional James authorization or Miguel realtime code is needed for this prerequisite.

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
