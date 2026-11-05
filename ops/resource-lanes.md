# External heavy work and responsive conversations

## Contract and boundaries

This is an opt-in native Hermes plugin + Agent Service extension, not a core patch.

1. `wizard_heavy_submit` receives runtime-injected `session_id`. The service captures the current direct run, request watermark and effective model route. It durably writes a receipt **before** any SSH call. The agent acknowledges the receipt and finishes its ordinary turn. No active mutation owner is silently released or bypassed.
2. A separate asynchronous outbox submits the stable job ID to a Thales SQLite spool. The dispatcher runs one process group under the **existing shared Android/VM worker lock**. Queued/remote-running jobs own no interactive admission slot.
3. Completion admits one logical continuation using `wizard-heavy-<job_id>` through `DurableRunQueue`; both admission and dispatch revalidate ownership. Typed instructions, steering and stop durably invalidate **every** old continuation, including completed siblings already admitted to the run queue. The invalidation bit is independent of the saved admission receipt ID. Sibling completions and their authorized follow-up checks remain in the same original request generation and resume serially only while it is valid. Admission selects the unique running/launching mutation owner, not the latest inserted receipt: a newer queued sibling is not a new request or an approval gate. An unrelated newer human/helper request still fences the old generation; idle/completed origins and helper child sessions without a native owner remain refused.
   - A completion is evidence, not instructions or new authority. Inspect it before a repair/rerun; already-authorized necessary follow-up does not require another `go`, but explicit owner approval gates and new-scope authorization still apply.
   - Submission from a delegated child is intentionally refused. The child stages source and returns the exact stable key/spec; the genuine owning thread submits it, without asking the owner to repeat existing authorization. Never manufacture a user turn, edit queue state, or impersonate a parent session.
   - Continuation request bytes are frozen before admission. Replaying an ambiguous pre-upgrade admission reuses the durable run's original bytes, so guidance updates cannot conflict with its stable idempotency key.
4. Continuations pin the original provider/model with `require_model_lock:true`. Stock Hermes can expose runtime metadata only after a turn ends; the continuation then waits for that exact origin run's metadata. It never substitutes the current default route. Operator/private helper runtimes without a direct origin are refused rather than guessed.
5. A remote restart never blindly reruns claimed commands. A per-command process-group owner retains the shared worker lock and execution lease across dispatcher loss, continues checking durable cancellation and the original persisted deadline, records its result, then terminates its **own** group. Recovery never signals a database PID: the caller itself pins the group identity, avoiding PID-reuse/check-then-kill races. The replacement dispatcher finalizes the receipt only after the execution lease releases, then advances the queue under the shared lock. A claim without a verified execution lease/result becomes `interrupted`, never re-executed. A service restart replays stable remote IDs and stable continuation IDs. Losing acknowledged remote state never recreates a build automatically.

**Not an automatic migration:** existing synchronous terminal/build calls already running keep their leases. This feature does not stop them. New work must use the native tool. The plugin contributes a supported system-prompt section telling the model that a durable receipt is a legitimate turn boundary; it does not monkey-patch the model loop or forcibly terminate an uncooperative model. Final activation must include a model-driven tool canary.

## Limits and health

- Keep `WIZARD_MAX_ACTIVE_THREADS` unchanged (live deployment was 12). This patch does not raise it or alter provider accounts/quotas. Tests use a smaller cap to prove separation.
- Interactive dispatch no longer requires idle CPU. Linux admission retains a conservative safety floor of 512 MiB `MemAvailable` and memory full PSI avg10 below 20%. These are safety stops, **not a measured maximum concurrency recommendation**. Unknown Linux memory health fails closed. Non-Linux relies on its existing bounded run cap.
- Remote work reuses the current helper's 20 GiB free-disk floor, macOS's own *critical* memory-pressure level, and one existing shared worker lock. A failed health read waits rather than starting work.
- **Light lane (`lane: "light"`).** Short packaging work — Docker image packaging that reuses prebuilt/audited binaries, static or web app builds, small canaries — runs in its own spool (`<root>/light/jobs.sqlite3`) under its own exclusive lock (`<root>/light/packaging.lock`), one job at a time, FIFO, with the same disk/memory guards and never-retry recovery. It never waits behind Android, emulator or VM work, and a heavy-only dispatcher (including an older release) cannot see or claim light jobs. Light jobs are capped at 900 seconds. Their `WIZARD_HEAVY_LOCK_FD` is the packaging lock, so `android-build-thales` fails closed (`inherited lock identity mismatch`) inside a light job. A spec without `lane` is byte-identical to before and runs under the shared lock. Measured motive (16–19 Oct 2026): 30 light jobs needed 0.3 h of work and waited 4.8 h behind heavy jobs; Messenger image builds of 13–28 s waited 8–31 min.
- Admission HTTP 429 / Retry-After produces durable per-route backoff, including HTTP-date headers and exponential fallback. Provider-owned retries inside Hermes are unchanged. Resource wait, provider wait and terminal task failure remain distinct.
- Existing `/wizard/health` fields `queue.max_active`, `active`, `queued`, `dispatch_paused`, `liveness_available` remain. Additive fields: `lane`, `provider_waiting`, `heavy.{active,queued,worker_state,unavailable,cancellation_pending}`. `busy_external` means another existing lock owner, not a fabricated running queue job.

## Provisioning (parent/release owner; no live restart during active turns)

Use one stable remote spool on the external volume, distinct from immutable worker code:

```
WIZARD_HEAVY_STATE_PATH=<persistent-service-state>/heavy.sqlite3
WIZARD_HEAVY_TOKEN=<random-secret-at-least-32-characters>
WIZARD_BUILD_HOST=<existing-ssh-alias>
WIZARD_HEAVY_ROOT=<absolute-remote-work-root>
WIZARD_HEAVY_REMOTE_SCRIPT=${WIZARD_HEAVY_ROOT}/<immutable-release>/scripts/heavy-worker.py
WIZARD_HEAVY_REMOTE_ROOT=${WIZARD_HEAVY_ROOT}/<persistent-state>/heavy-queue
WIZARD_HEAVY_REMOTE_LOCK=${WIZARD_HEAVY_ROOT}/AndroidBuilds/worker.lock
WIZARD_HEAVY_REMOTE_PYTHON=/opt/homebrew/bin/python3
```

Set `WIZARD_HEAVY_ROOT` (fallback `WIZARD_WORK_ROOT`) on the service and any SSH sidecar to the **remote** allowed root, not a local VPS directory. SSH transport forwards that value to the worker, including detached children. With neither set, submit/worker refuse: `heavy lane not configured: set WIZARD_HEAVY_ROOT`. `WIZARD_BUILD_HOST` selects the SSH target; legacy `WIZARD_HEAVY_SSH_HOST` remains a fallback. The Android helper requires the same root and host and carries them in its prepared command; optional `ANDROID_HOME` / `ANDROID_SDK_ROOT` select the remote SDK.

Secrets are supplied through protected environment files, never prompts/tool arguments, repo files or process arguments. Plugin origin must be loopback. Install `hermes-plugin/wizard-heavy` through the supported Hermes plugin mechanism and give its runtime:

```
WIZARD_HEAVY_ORIGIN=http://127.0.0.1:<agent-service-port>
WIZARD_HEAVY_TOKEN=<same-secret>
```

`hermes plugins doctor <plugin-directory> --ci` must pass. Do not alter Hermes core. Only the selected profile/plugin runtime is in scope.

The plugin resolves both variables with supported `agent.secret_scope.get_secret` inside each call and prompt callback. In a multiplexed gateway, a scoped miss stays closed even if another profile's values exist in `os.environ`. Use native plugin enable/hot-load for new sessions; a gateway restart is not required for that boundary. The service's scheduling activation remains a separate release-owner operation. Standalone plugin harnesses must run with the actual Hermes Python/import environment; do not mock `secret_scope` or add an environment fallback to make a fixture pass.

### Minimal container compatibility

The currently deployed custom Agent Service image has **no SSH executable**. Do not try to repair a running container or rebuild the full guest. Run `server/heavy-rpc-server.mjs` on the host using `ops/wizard-heavy-rpc.service` and the same protected heavy environment file. The sidecar listens only on loopback and uses the host's existing SSH trust/config. Set in the container's service environment:

```
WIZARD_HEAVY_RPC_ORIGIN=http://127.0.0.1:18788
```

The sidecar has no queue or authority of its own. Restarting it preserves job identities/state. Native installations with working SSH may omit it. Do not put SSH private keys inside an image. The native release helper copies `server/`, so the RPC entry is deliberately there.

### Android helper migration

`scripts/android-build-thales.py` preserves the current host helper implementation and adds `--prepare-only` and inherited-lock support. Install this version as the helper **only after comparing against any newer host edits**; preserve the original executable mode. Keep source/signing/security/placement guards intact.

Run the normal helper command with `--prepare-only` and its usual output directory. It stages the real source and returns `cwd`, `argv`, source revision/hash and remote receipt path without executing Gradle or acquiring/waiting on the worker lock. Pass that exact `cwd`/`argv` to `wizard_heavy_submit` with a stable semantic key. The remote dispatcher supplies `WIZARD_HEAVY_LOCK_FD`; the helper verifies the shared lock inode and uses the inherited lease instead of deadlocking on a second flock. Existing synchronous invocations remain backward-compatible. After completion, inspect/fetch the normal helper's remote receipt/artifacts; no APK should be claimed solely from the outer process receipt.

## Safe activation/readback

1. Fetch the pushed candidate and latest shared branch/live SHA. Verify candidate contains live and concurrent fixes. Protected branches change by reviewed PR only.
2. Run sustained tests on Thales under `$WIZARD_WORK_ROOT`, save immutable SHA + source hashes. Stage immutable server/plugin/worker/helper code. No full guest rebuild.
3. **Do not run the legacy deploy helper blindly:** its missing-release path runs the full test suite on the VPS and its activation immediately restarts the live service. Use verified remote evidence and an already prepared immutable release, or the release owner's remote staging procedure. Verify `RELEASE_SHA`, `SERVER_TREE`, origin and ancestry before switching anything.
4. Provision the sidecar/worker stable state and protected env; prove the current container can reach the loopback RPC and read a canary receipt. The sidecar alone does not activate scheduling.
5. Parent arranges a genuine idle window/continuation. Never cancel live threads to create idle. Preserve both SQLite stores and all remote spools. Activate the exact reviewed candidate, then plugin/helper at the supported runtime boundary.
6. Read back live release SHA, service health (legacy fields intact, max cap unchanged), plugin doctor and a **model-driven** `wizard_heavy_submit`. With one real remote job running and another queued, get a useful ordinary model answer; then verify originating continuation model locks, one logical receipt per job, steering/stop fencing and cancellation. Preserve evidence.
7. Rollback only in a safe idle window. Disable new tool submissions first; retain all new durable tables/spools. Never delete or recycle job IDs. Rolling the service back removes automatic completion consumption, so the parent must explicitly own draining/recovery; it is not safe to erase evidence and rerun jobs.

## Forum future-only per-run trimming (explicit opt-in)

This is **not** a `/srv/work` cleaner. There is no directory discovery, age cutoff,
weekly sweeper, adoption command, historical reconciliation, or startup cleanup.
Every existing directory/job is outside its authority, including completed ones.
A new worker alone reclaims **zero** old bytes. No changes to `~/wizard-local`,
`~/.wizard-secure`, `AndroidBuilds` or `android-sdk` are authorized.

### Preparation, ownership and retention

Only on Linux with `WIZARD_HEAVY_HOST=forum`, an operator/producer can prepare a
brand-new, single-submission run before staging input:

```sh
WIZARD_HEAVY_HOST=forum WIZARD_HEAVY_ROOT=/srv/work \
  /usr/bin/python3 <candidate>/scripts/heavy-worker.py \
  --root /srv/work/heavy/production/spool \
  --lock /srv/work/heavy/production/worker.lock \
  --prepare-run --run-purpose ephemeral --disposable build --disposable cache
```

Use the returned `path` as the native job's `cwd`. It is a new exclusive-created
`/srv/work/heavy/managed-runs-v1/<random-id>` directory. Stage inputs only after
preparation; never move an old directory into this namespace. The external
`/srv/work/heavy/run-ownership-v1/<id>.json` binds device/inode/uid, the original
lease inode, purpose, and selected slots. The in-run `run-manifest.json` is
preserved evidence, **not** deletion authority. Native RPC admission binds the
run to one exact job ID/spec; duplicate submission remains idempotent, but
cross-job reuse, changed commands and cross-lane reuse are refused. This does not
add fields to specs or alter existing receipt/spec hashes.

- Preparation defaults to `--run-purpose retained`, with no disposable slots.
  Nothing opts into disposal implicitly. Existing producers continue unchanged.
- Weekly launches **must** use `--run-purpose weekly-launch` (always retained).
  A `weekly-launch`, `weekly_launch` or `weekly/launch` argv token independently
  vetoes trimming even if incorrectly declared ephemeral. There is no weekly
  deletion timer. Launches cannot lose retention via a mutable in-run manifest.
- To preserve the entire run, create `RETAIN` before completion. To preserve
  specific outputs/subtrees, add relative paths to `retain.json`, e.g.
  `{"paths":["build/published.o","cache/shared-output"]}`. Missing, invalid,
  oversized or unreadable retention/reference evidence fails closed.
- Treat ephemeral runs as private single-job storage. Before publishing links to
  another job/external consumer, add their targets to `retain.json` (or use
  `RETAIN`). Do not use an ephemeral run as a shared source/cache directory.

### Exact deletion boundary

Only regular single-link files **inside explicitly selected** `build`, `cache`
or `tmp` slots, with suffix `.o`, `.obj`, `.class`, `.pyc`, `.pyo` or `.bc`, are
candidates. This deliberately conservative initial allowlist does **not** remove
source trees, arbitrary temp files, node modules, archives, packages, ISO/VM disks,
unknown files or directories. Widening it requires a separate reviewed policy
change, not an operator-supplied glob.

Names containing result/evidence/manifest/receipt/submission/admission/preflight/
log/screenshot/output/artifact/weekly-launch are excluded even with a bulk suffix.
All JSON, logs, screenshots and other result/evidence files remain in place. Paths
referenced by retained text/JSON/log evidence or the native worker stdout log are
also excluded. Scans are bounded (100,000 regular files; 8 MiB per retained text
file and 16 MiB total textual references); exceeding limits retains the run.

Both heavy and light executors inherit a per-run shared lease in addition to the
existing resource/execution locks. Trimming takes its exclusive nonblocking lease
only after process-group lease release and durable terminal receipt creation.
Any symlink, hardlink, special file, device crossing or mount (including same-device
bind mounts) anywhere under the run blocks the whole pass. All unlink operations
are rooted at the registered directory fd, use no-follow traversal, and recheck
file identity/size/mtime. No recursive `rm`, directory removal or link following.

A read-only root-aware probe uses exactly
`/usr/bin/sudo -n -- /usr/bin/lsof -nP -F p +D <new-run>` to detect active cwd/fds/
mapped executables, including root/container descendants. Only the trimming PID's
own pinned descriptors are excluded. Missing sudo/lsof, diagnostics, timeout,
unknown probe state or another process retains the run. **No sudoers or process
permissions are changed by this feature.** Existing Forum noninteractive sudo
availability must be independently reviewed; without it this safely retains.
No discovered process is signalled. Cooperating queue users are fenced by the
lease/single-job admission; arbitrary privileged processes that ignore leases
remain outside this same-user housekeeping contract.

A durable exclusive-created `<id>.<job-id>.trim-intent.json` records candidate
identities before the first unlink; inability to persist it vetoes deletion.
A separate exclusive-created `<id>.<job-id>.trim.json` records removed names,
unlinked byte counts, skips and errors in the ownership registry. Those bytes
are nominal unlinked file sizes, not claimed physical free-space recovery.
The job result, exit code, receipt, log hashes and continuation semantics never
change on cleanup failure. No retry after crash/skip; queued cancellations,
ambiguous interrupted claims and historical terminal receipts are not swept.

### Candidate verification and parent-owned rollout

Run `python3 tests/heavy-worker-trim.unit.py` for tiny source-only safety fixtures.
Full real-process regression and lifecycle proof is deliberately a **native light
job**, not an SSH loop: `scripts/heavy-run-trim-canary.py --stage <new-stage>`.
It verifies its staged source hashes, runs the unit, sandbox and existing worker
regression suites, then exercises candidate heavy/light RPC lifecycles using
isolated spools/locks under its own NEW `runtime/`. It checks success, exit-7
failure, default/weekly retention, duplicate submission, linked evidence hashes,
real escaped-process retention and post-exit idle certification. Logs, receipts,
trim reports, manifests and `evidence/summary.json` all remain in that new stage.
Nested heavy-labelled fixtures are tiny printing processes, not builds, and do
not acquire/release the production shared lock. Parent must submit the sealed
spec through `wizard_heavy_submit(host='forum', lane='light')`; staging alone is
**not** queue/admission acceptance or production activation.

1. Review candidate/manifest and independently read back every staged file hash.
   Admit the returned real light canary; inspect all suite logs and summary.
2. Stage **both** `heavy-worker.py` and its sibling `heavy-run-trim.py` in one
   immutable release. Stage helper/canary sources as needed for evidence only.
3. Parent, in an approved idle window, points the Forum RPC script setting and
   Forum supervisor ExecStart to that exact same release. Preserve all spools,
   locks, receipts and old immutable releases. Back up any changed local env/unit
   files first. No Thales/plugin/core changes are needed. No activation is part
   of this source PR. Existing detached jobs may finish with their old release.
4. Read back both settings, live worker hash and service health. Only then allow
   producers to call `--prepare-run`. Native production light-lane acceptance is
   still required; an isolated candidate canary is not a production cutover.
5. Rollback: stop preparing new ephemeral runs; revert only worker/RPC release
   pointers in a safe window. Keep all ownership records, run data and spools.
   Never delete old/new runs, replay IDs or sweep retained/skipped work.

## Verification commands

The lightweight worker regression fixtures run on macOS or Linux with temporary roots (no builds). For sustained suites, use the configured build host with external-storage `TMPDIR` and the worker toolchain on `PATH`:

```
npm ci --no-audit --no-fund
npm test
python3 tests/heavy-worker.remote.py
# Actual Hermes source + its dependencies; no credentials required:
PYTHONPATH=<hermes-source> <hermes-python> tests/heavy-plugin.remote.py
```

Remote Python tests use temporary isolated locks and lightweight subprocesses: real duplicate RPCs, dispatcher crash followed by cancellation, independent recovered deadline expiry, TERM-resistant descendants, unrelated/reused diagnostic PID safety, old-schema ambiguous claims, running/queued cancellation and inherited Android lock. They do not bypass the production lock to build anything. The plugin fixture uses the real Hermes `secret_scope` module with synthetic values and loopback HTTP, including fresh/concurrent profile scopes, missing scope/token/origin, and single-profile compatibility. It is not a model-selected live canary.

`scripts/resource-lanes-canary.mjs` is a bounded disposable staging service using the real configured Hermes and real Thales RPC. It never restarts live. It requires an isolated `CANARY_STATE_DIR`, `HERMES_HOME`, `WIZARD_OS_HOME`, the real API key in environment, and `CANARY_REMOTE_DIR` pointing to the pushed/tested external-volume checkout.

- Default: real targeted test workload under the production shared lock, full answer/continuation check. If another owner's long job holds the lock, do not kill it.
- `CANARY_BUSY_ONLY=1`: prove real ordinary-model response and cancellation while that existing production lock remains occupied; deliberately executes no build.
- `CANARY_LIGHTWEIGHT=1`: full real-process/model/continuation path on a test-only lock, **only a sleeping/printing process, never a build**.
- `CANARY_RPC_BRIDGE=1`: exercise the SSH-less-container bridge transport. Optional `CANARY_CONTAINER_NAME` makes a read-only request from the actual running container, passing credentials by environment name only.

The canary invokes the **registered native plugin handler from a harness**, not from model-selected tools in the live runtime. Evidence must say so. This proves the seam without prematurely activating a live plugin; the final model-driven activation canary remains mandatory.

## Review entry points

- `server/run-queue.mjs`: unchanged cap, session ownership, per-route Retry-After persistence, same-millisecond durable generation order.
- `server/heavy-queue.mjs`: durable submission, ambiguous response retry, cancellation races, remote-state loss, continuation dedup.
- `server/heavy-integration.mjs`: origin/request generation, sibling completions, exact runtime route and final dispatch fence.
- `scripts/heavy-worker.py`: durable claim before spawn, flock/process groups, orphan conservatism, terminal receipt hash, shutdown/cancel.
- `server/service.mjs`: internal bearer-only endpoint, steer/stop/new-turn fences, bounded history reads, additive health, close ordering.
- `server/heavy-rpc-server.mjs`: loopback-only authenticated SSH boundary for current container.
