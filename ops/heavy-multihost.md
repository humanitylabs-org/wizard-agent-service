# Multi-host heavy jobs — prepared, not activated

## Ownership and placement

REUSE: the durable outbox, continuation authorization, remote spool/leases, light lane and authenticated loopback SSH bridge.
EXTEND: host routing, health projection and the native wizard-heavy tool schema/prompt.
NEW: no competing queue or runtime; `heavy-hosts.mjs` is operator configuration for the existing implementation.

Measured motivation: 646 jobs in ten days; queue wait p90 43 minutes, maximum 7.7 hours, 63 hours of lock occupancy. About 340 jobs were Linux scripts that did not need the Mac/Android lock.

`host` is `thales` or `forum`. Omission and explicit `thales` preserve the old command spec/hash and default RPC bytes. Old stored jobs without a host remain on Thales. The service persists placement before dispatch; submit/status/cancel/retries all use that same host. An unavailable host stays queued/retrying and is never rerouted. Different hosts poll independently, with one bounded failed RPC per host per tick. The loopback bridge uses the same routing function as native SSH.

Use Forum for Linux/amd64 scripts, acceptance rigs, Docker images, ISO/VM installs with KVM, Playwright, Android debug builds and x86_64 emulator QA. Use Thales only for macOS, Mac VM guests, Android signed release builds and the ARM release-candidate check. Never emulate amd64 on the Mac. Forum storage is scratch; preserve valuable results on the owner's external Mac media volume or R2.

This first release deliberately keeps **one heavy + one light per host**. Three generic workers would require redesigning the single orphan scan, inherited shared lock and agent/owner shared-capacity contract; that is not a small safe dispatcher change. Concurrency three remains a follow-up with explicit slot/recovery tests. Thales behavior and its production locks/spools are unchanged. The same Python file runs on Linux and macOS; the live base already had Linux disk/memory PSI guards, now exercised remotely.

## Configuration (release owner only)

Without `WIZARD_BUILD_HOSTS`, only the existing Thales route is enabled, using all existing single-host variables. To enable both, set on **both the service and SSH bridge**:

```sh
WIZARD_BUILD_HOSTS=thales,forum
# Existing single-host variables continue to describe Thales, unchanged.
WIZARD_HEAVY_FORUM_SSH_HOST=forum
WIZARD_HEAVY_FORUM_ROOT=/srv/work
WIZARD_HEAVY_FORUM_REMOTE_SCRIPT=/srv/work/heavy/releases/<reviewed-sha>/heavy-worker.py
WIZARD_HEAVY_FORUM_REMOTE_ROOT=/srv/work/heavy/production/spool
WIZARD_HEAVY_FORUM_REMOTE_LOCK=/srv/work/heavy/production/worker.lock
WIZARD_HEAVY_FORUM_REMOTE_PYTHON=/usr/bin/python3
```

Each host also accepts `WIZARD_HEAVY_<HOST>_ROOT`, `_SSH_HOST`, `_REMOTE_SCRIPT`, `_REMOTE_ROOT`, `_REMOTE_LOCK`, `_REMOTE_PYTHON`, `_AGENT_IMAGE`, `_DOCKER_BIN`, `_DOCKER_HOST`. Only Thales falls back to the old unqualified values. In particular Forum never inherits the Mac's Python, paths or Docker socket. Require absolute work roots. Do not enable Forum until its full SSH/worker configuration and disk reserve are ready. Unknown/disabled placement is refused. The sandboxed agent relay still accepts its existing Thales-only strict spec; enabling Forum for that separate grant surface is not part of this change.

Health adds `heavy.hosts.<name>` summaries (active, queued, worker_state, unavailable, cancellation_pending, max_active). All legacy fields and the interactive cap remain unchanged. `max_active: 1` is the original heavy-lane limit, not a combined heavy/light quota. Health reflects durable work observations, not an unsolicited network health probe.

## Isolated Forum installation

`ops/wizard-heavy-forum-staging.service` points **only** at `/srv/work/heavy/staging`; it does not consume production state. Install the reviewed worker bytes at `/srv/work/heavy/candidate/heavy-worker.py` and install the unit in the worker user's systemd user directory. Start, but do not enable, this staging unit. The optional `--serve` mode periodically recovers all existing host/light/agent spools; normal CLI RPCs still self-start dispatchers exactly as before. Exclusive dispatcher/resource/execution locks remain the authority, not the supervisor.

`KillMode=process` intentionally stops only the supervisor: existing executors retain leases and their original cancellation/deadline checks across supervisor restart. It is not a cancellation command. Use the queue cancel operation for jobs. No production Mac service installation is needed for this optional mode.

## Verification and promotion

Run `npm ci && npm test` on Forum with Node >=22.5 (the suite uses node:sqlite), Python PyYAML and python-dotenv. The portable-path test needs a real Git index, so copy a Git checkout or initialize/index an exact source copy. Run `python3 tests/heavy-worker.remote.py` on both hosts with isolated `TMPDIR` roots; all locks are temporary. Run `tests/heavy-plugin.remote.py` against actual, hash-recorded Hermes secret_scope imports, not a mock. The portable-path guard now distinguishes public host enum identifiers from concrete SSH/scp targets; only the plugin's explicit durable-output destination phrase is allowed as policy text.

Before activation, the parent must:

1. Re-read the current live release and merge/reconcile all later changes. This candidate starts from the observed live release, which contains upstream work not yet on main. Review the PR's inherited commits separately; do not replace live with an older main checkout.
2. Review exact-source test/evidence hashes and the host/concurrency limitation. Preserve existing local/remote queue databases and receipts. Prepare immutable code on both hosts; do not change the Mac production lock or spool paths.
3. Provision a separate Forum production state/lock root and SSH trust. Copy the reviewed worker to an immutable release path, not the mutable staging candidate. Configure the host map consistently on the service and bridge; preserve all existing Thales values. Install the plugin only through the supported plugin boundary. No Hermes core changes.
4. Arrange the existing serialized idle/drain activation window. Do not restart the live service, live plugin or Mac worker merely to finish this branch. Run the existing app-parity/source-protection checks before live promotion.
5. Read back the release, legacy health and per-host health; run a model-selected Forum canary and a default Thales canary, then verify continuation, stop/steer and cancellation. Isolated CLI/HTTP fixtures are not that live model-driven proof.
6. Stop/remove the staging service when no longer needed. For rollback stop new submissions first, retain both hosts' spools and service receipts, and explicitly own pending completion/cancellation. Never reassign a Forum job to Thales or delete remote state to replay it.

This PR neither activates nor reconfigures the live service, the installed Hermes plugin, or Thales production.
