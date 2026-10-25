# pp-key-scrub final attempt handoff

## Product
- Worktree: `/home/telos/.hermes/cache/scratch/pp-launch/service`, branch `feature/private-providers-launch`, pushed commit `e3b0dae`; #161 checks green.
- Credential retirement is before seal publication, restart-fenced by a count/path receipt, explicit rollback from host source only. Five scrub, twelve scanner, sixteen focused registry tests passed.
- Tooling suite: 58 passed. No merges or production mutation.

## Actual checks collected
- Attempts 10/11: a,b passed, c readiness race (Docker Running before history API).
- Attempt 12: a,b passed, c 4/6; fixed duplicate session titles.
- Attempt 13: a,b,c passed (all six c checks). Product migration 200, retained home inode/1000:1000, canonical history validation passed; migrated run remained queued, so d is not accepted; e/f not reached.
- The SSH tool disconnected after 420s; reporting then hit BrokenPipe. Separate receipt/log collection completed. Reset removed directories but missed generic sealed `agent` services; follow-up readback proved survivors. Do not claim that reset fully clean.
- Fixed reset to cover exact synthetic Compose projects and synthetic-home mounts and assert zero synthetic containers. This is staged and unit-tested, not yet whole-rig-proven.

## Admission result
The delegated submission returned HTTP **409 heavy admission refused**. There is no receipt and no running or queued attempt 14. The temporary host credential staging file was removed and absence separately verified. Genuine-parent admission is required; restage the source before submission.

## Exactly one attempt remains: 14
Staged Thales cwd: `/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live`.
The runner performs a corrected **initial reset** before setup, then a–f, unexempted post-migration key-location, and corrected final reset/readback. e/f and key-location still run independently if the migrated inference fails, without marking d passed.

Preferred durable submission (do not nest run-locked under the worker's inherited lock):
- Stable submission identifier — `pp-key-scrub-final-14`
- cwd: directory above
- argv: `/opt/homebrew/bin/python3`, `run-key-scrub-final.py`
- lane: `heavy`
- timeout_seconds: `1800`

The wrapper consumes a **0600 owner-only** `.pp-key-scrub-14.env` staged in that cwd, unlinks it immediately, passes its bytes only on stdin to `legacy-lane.py 14`, and verifies host staging absence. Never put values in argv or chat. If delegated durable admission is refused, remove that staged file immediately, then have the genuine parent restage from its existing host source and submit the same stable job key. Do not bypass admission or start an attempt 15.

After completion, collect `REHEARSAL-LEGACY-FIX-14.json`, all `legacy-fix-14-*.log`, and `RESET-3.json`; read exact final reset target independently. Update `EVIDENCE-rehearsal.md`, push tooling, and re-read #161 checks. Current fully clean reset is unverified until corrected work executes. Another worker owns the shared lock; do not stop it. The lane's own waiting reset PID was cancelled using exact argv verification.

Hard boundaries remain: only disposable pp-rig mutations; no production restarts, no private agent data, no Private messages, no provider values in logs, no merges.
