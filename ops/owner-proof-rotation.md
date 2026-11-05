# Generated gateway proof containment

REUSE the existing CMS backup custody, host-maintenance and Agent Service deploy
leases, run stream keeper, drain/restart controller and restart reporter. No auth
implementation, CLI core, gateway, listener or application data is modified.

This script changes **only the configured generated proof** and restarts the
**same Agent Service artifact**. It does not deploy its own source branch.

## Mandatory ordering

1. The gateway owner loads its independently tested runtime proof-header deletion
   filter through the established same-PID gateway reload. A staged filter is not
   enough: `prepare`/`check` inspect the actual autosaved config and require it to
   match the currently adapted source. This is essential before a Service window:
   an ordinary owner request receiving a reverse-proxy 502 could otherwise expose
   the freshly generated proof again. This operation does not edit/reload Caddy.
2. Run the lightweight synthetic tests. Do not perform full builds on the VPS.
3. Prepare a fresh plan from the exact live Service and gateway generation, then
   check it. A prior plan is deliberately invalidated by source/container drift.
4. Launch `apply` through the existing restart reporter into the requesting thread.
   Do not invoke the container wrapper directly (including `--help`). Do not run a
   producer-only replacement. No additional owner restart reply is required when
   the existing keeper route is healthy.
5. Independently read `result.json`. Success means `status: verified`, not merely a
   reporter health message. The old proof must return 403, the new proof and the
   normal real-peer owner request must return 200. Store direct non-root peer must
   remain 403 and owner-gated metadata comparison must be 200. All app rows,
   settings, non-Service containers, neighboring units and keeper identity must
   remain unchanged; live run statuses must be retained, with no interrupted,
   cancelled or failed transition accepted as preservation.

The process disables core dumps and sets Linux `PR_SET_DUMPABLE=0`. Values stay in
private process memory/pipes, never arguments, stdout, journal or status files.
48 random bytes are generated only after preflight. The original proof and new
proof are encrypted through anonymous pipes into existing CMS custody and a
private decrypt roundtrip is required before mutation. The old proof is used
only for loopback negative checks; real-peer requests contain neither proof nor
injected identity. The protected 0600 file is replaced with a hash/inode CAS,
fsync and atomic rename in its existing directory. The captured verifier is
retired through `wizard_drain_restart.py restart wizard-mobile` (keeper path).

A failed cutover compensates **both producer and verifier**, then proves their
consistency. It never calls a rollback successful solely because a file was
restored. `rolled_back_consistent_security_not_contained` explicitly means the
exposed old proof is still valid. `recovery_required` requires operator handling
of the encrypted custody artifact; never print or decrypt it into a report.

## Host operation used for this incident

The staged host artifact root is:

```
/home/telos/.local/share/wizard-updates/approved-20261105/proof-rotation
```

After the gateway owner's loaded-filter receipt is verified:

```sh
python3 /home/telos/.local/share/wizard-updates/approved-20261105/proof-rotation/source/ops/owner-proof-rotation.py prepare --plan /home/telos/.local/share/wizard-updates/approved-20261105/proof-rotation/plan.json
python3 /home/telos/.local/share/wizard-updates/approved-20261105/proof-rotation/source/ops/owner-proof-rotation.py check --plan /home/telos/.local/share/wizard-updates/approved-20261105/proof-rotation/plan.json
python3 /home/telos/.hermes/scripts/wizard_restart_report.py --thread wizard_1792488825724_0377873b4123 --what 'Generated owner-proof containment; same Service artifact' --timeout 600 --verify-seconds 120 -- python3 /home/telos/.local/share/wizard-updates/approved-20261105/proof-rotation/source/ops/owner-proof-rotation.py apply --plan /home/telos/.local/share/wizard-updates/approved-20261105/proof-rotation/plan.json
```

Do not chain the reporter after a failed check. Its detached receipt is an honest
turn boundary; the parent independently reads the final `result.json` before
claiming containment. `plan.json`/`preflight.json`/`readback.json` are hash/status
artifacts only. The encrypted recovery file is outside the source checkout under
`~/.hermes/secure/owner-proof-rotation/`; never commit a live recovery artifact.

Tests:

```sh
python3 -m unittest discover -s ops -p test_owner_proof_rotation.py -v
```
