# Hermes v0.22.1 compatibility acceptance

This is a Wizard-side HTTP adapter, **not a Hermes upgrade or a second execution authority**. Hermes owns admission, generation fences, controls, execution and settlement. No WebSocket transport, heartbeat inference, core patch, database mutation of the owner's runtime, or full VM image rebuild is required by this patch.

## Exact upstream contract

Tested upstream tag `v0.22.1` points to commit `297552a9d646119871391d202509822cd86330df` (annotated tag object `28106ea1a3230177edb30a0a4e8a099d839bbc2f`). The acceptance runner refuses other commits or a modified upstream checkout.

Source, not inferred feature names:

- `gateway/platforms/api_server.py`: `features.run_unknown_resolution` is true iff the adapter's runner has `session_authority`. `endpoints.run_unknown_resolution` advertises `POST /v1/runs/{run_id}/resolve-unknown` conditionally. Approval's feature is `run_approval_response`, while its endpoint key is `run_approval`. Do not invent `features.run_clarify` or a generic canonical-mode boolean.
- `gateway/run_runtime.py` builds the ordinary gateway's canonical profile authority. The isolated probe explicitly calls the real `initialize_session_authority`; it does not use an invented enabling environment flag.
- `gateway/platforms/api_server_authority_runs.py`: GET exposes `admission_id`, `execution_generation`, and `pending_controls`. Approval/clarify use `request_id` = displayed `prompt_id` and the displayed `execution_generation`. Clarify adds `answer`; approval adds `choice`.
- Resolve-unknown accepts **exactly** `admission_id` and integer `execution_generation`. Stop remains separate and rejects unknown with `409 unknown_execution`. An exact repeated recovery returns the committed receipt.
- `permission_denied`, `idempotency_key_conflict`, and `admission_conflict` are permanent **admission** failures, not generic capacity. Control 409s never turn an admitted run into a new submission. Unclassified legacy 409s retain the old retry path.

## Execution placement and reproducing

Run on the build host's data volume, with disposable homes and loopback listeners only. Set `ACCEPTANCE_ROOT`, `WAS_SOURCE`, and `HERMES_SOURCE` to owned checkouts under that volume. Node 22.23.2 and Python 3.14.6 were exercised. The Python requirements file is the actual isolated acceptance environment's frozen dependency set, not a production dependency change.

```sh
export PATH=/opt/homebrew/bin:$PATH
export TMPDIR="$ACCEPTANCE_ROOT/tmp"
mkdir -p "$TMPDIR" "$ACCEPTANCE_ROOT/evidence"
git clone --depth 1 --branch v0.22.1 https://github.com/NousResearch/hermes-agent.git "$HERMES_SOURCE"
python3.14 -m venv "$ACCEPTANCE_ROOT/venv"
"$ACCEPTANCE_ROOT/venv/bin/python" -m pip install -r "$WAS_SOURCE/scripts/acceptance/requirements.txt"
cd "$WAS_SOURCE"
npm ci --ignore-scripts
npm test -- tests/hermes-compat.test.ts tests/hermes-compat-proxy.test.ts tests/run-queue.test.ts tests/stale-run-guard.test.ts tests/hermes-http-readers.test.ts
HERMES_SOURCE="$HERMES_SOURCE" "$ACCEPTANCE_ROOT/venv/bin/python" scripts/acceptance/canonical.py
cd "$HERMES_SOURCE"
HERMES_HOME="$ACCEPTANCE_ROOT/upstream-home" "$ACCEPTANCE_ROOT/venv/bin/python" -m pytest -q \
  tests/gateway/test_api_authority_runs.py \
  tests/gateway/test_api_unknown_resolution.py \
  tests/gateway/test_api_pending_daemon.py \
  tests/gateway/test_api_runs_native_session_refusal.py \
  tests/gateway/test_api_source_binding.py
```

Run broad WAS regression separately with `npm test -- --maxWorkers=2`. The final run passed 578 tests with 3 platform-skipped tests. An earlier load-sensitive `voice-context-parity` queued-note test failed both the unchanged base and the candidate on the tested Mac; it uses the real host dispatch-health gate without a deterministic health reader. Preserve those baseline logs alongside the passing final rerun rather than hiding the transient failure. Focused compatibility tests inject health and exercise actual transport boundaries.

### What the evidence means

- `tests/hermes-compat*.test.ts`: synthetic HTTP/queue controls. Unknown and future statuses fence their session while freeing global worker capacity; multiple unknowns, process reopen, frozen attempted input, migration, exact wire replay, Retry-After, explicit guidance refusal, permanent failures and legacy conflict retries.
- `scripts/acceptance/canonical.py`: **real unmodified upstream canonical authority and HTTP handlers behind candidate WAS**. The upstream fixture claims a head, replaces authority and adapter, and produces the actual unknown state. A fixture-only WAS receipt import represents its already-known publicRunId; no unknown execution result is fabricated. It checks fresh-GET stale fencing, stop409, exact resolution/repeat, real follower execution once without head replay, and local projection settlement. Model execution is deterministic and no full gateway reboot is claimed.
- Exact upstream tests additionally start a disposable gateway against a loopback model fixture and exercise canonical run execution, approval/clarification controls and native-owned session refusal. This is not the user's live Hermes or a real-provider inference benchmark.
- UX `qa-hermes-compat.cjs` is a real phone-sized browser with **synthetic intercepted transport**. It covers displayed identity, stale recovery, two-view stale approval, clarification, legacy approval, draft retention, stop409 and Back. Do not conflate it with end-to-end browser-to-live-Hermes proof.

## Rollout / rollback constraints

- Ship WAS and UX through their existing release paths, from pushed named-branch commits. Protected/default branches still require PRs. Parent reviewer owns activation; this lane did not activate either release or restart any live service.
- WAS needs its normal service/container restart. UX is static web assets; no native package or guest rebuild. A later upstream Hermes upgrade/restart is a separate approval and operational gate.
- Database migration adds `dispatch_attempted` and `dispatch_body`. Existing rows are conservatively marked attempted because historical dispatch cannot be inferred from `status='queued'`; their key, hash, original input and status are unchanged. New never-attempted rows remain editable.
- New attempts persist the exact decorated upstream bytes before POST. An ambiguous response retries that same key and body; guidance cannot mutate it. Existing historical rows cannot retroactively recover wire bytes that the old service never stored.
- Unknown rows are not terminal, are not automatically cleared, and never run the legacy empty-steer abandonment probe. Only an advertised explicit recovery control is available. Permanent admission failures keep user-safe explanations; raw error classification remains scoped to admission.
- Additive columns can remain during source rollback, but an old WAS does not understand unknown fencing or immutable attempts. **Do not roll back only WAS after enabling a canonical runtime with unresolved unknown/ambiguous work.** Quiesce delivery, retain the queue, and review the exact upstream state first; never delete/re-key affected records to make a rollback appear healthy.
