# Private-provider launch tools — blocked checkpoint

These tools do **not** currently authorize production promotion. The real disposable-rig baseline has failed session/history admission; checks b–f and the six privacy checks have not run. Read the lane's private `REHEARSAL-3.json`, `RESET-3.json`, and `DRY-RUN-3.json` receipts. Raw owner-machine fingerprints and credentials must not be committed to this public repository.

## Implemented and unit-tested

- `live-run-all.py`: explicit argv-only operation plan, snapshot/receipt ordering, no-drain requirement, bounded drift refresh, six-check/regression gate before migration, and attempt-scoped rollback after writes. It deliberately refuses a missing/incomplete production plan.
- `stage-candidate.py`: Thales-locked, bounded staging from the discovered live Service SHA plus the provider pin. `merge_resolver.py` permits only byte-identical reviewed merge hunks; unknown conflicts block before any hunk is written. It tests the merged Service/runtime and the exact static UX source before packaging.
- `local_projection.py`: canonical provider identity projected only from an actually installed, provenance-checked private-local app, retaining its physical URN.
- `live-preflight.py`: read-only Runtipi/ownership/release/container/unit/UI fingerprints. It does not read agent homes and cannot turn missing acceptance into readiness.
- `rig-rehearse-3.py`, `rehearse-guest.py`, `probe-guest.py`: disposable-guest adapters. Only the setup/legacy-baseline path has been exercised; later phases remain unproven.
- `rig-reset-3.py`: pp-rig-only credential/container cleanup with exact reset readback, tested on the disposable guest.

Run lightweight tests with:

```sh
python3 -m unittest discover -s ops/private-provider-live -p 'test_*.py' -v
```

## Remaining release gates

1. Repair the synthetic session/history admission fixture under a newly authorized rehearsal attempt. A healthy agent API is not successful Service turn admission.
2. Execute and retain real checks a–f and six privacy checks, including successful inference, migration identity/history retention, removal failure closure, regression, and reset.
3. Implement and test the production operation adapters and explicit launch plan: snapshot, stage, deploy, install, privacy, regression, migrate, verify, rollback. Unit fakes are not substitutes for those adapters.
4. Run the full read-only production dry-run with no readiness blockers and unchanged protected fingerprints. Only the owning parent may invoke production lifecycle operations.

Do not populate a plan with success-only shell commands or remove readiness blockers to obtain a green report. No safe complete parent promotion command exists at this checkpoint.
