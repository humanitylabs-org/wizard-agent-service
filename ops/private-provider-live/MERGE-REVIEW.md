# Candidate-only integration review

Reviewed live base `4be54416627ab3f578a951166a084e459e9edd9c` with #161 `5e445fca7c87da825e8d669fbf35e3e6eeeb5acb`. No live code or branch was merged.

- Retain live bounded body-search worker, explicit archive limits, Spaces tools, sharing confinement and chat layout.
- Combine migrated harness refresh with live permission-only-update filtering. Keep trusted runtime credential retirement before sealed publication.
- Preserve the current sharing prohibition, but do not reintroduce the obsolete one-argument confidential-provider call: the feature's function now requires installed app capabilities. Model choices retain catalogue validation on create/update; existing unsealed legacy Tinfoil must work before app installation. The first actual integrated staging run exposed 28 failures from that stale call; the corrected integration passes the full focused staging suites.
- Retain live stateHome projection and export provider admission + removed-agent fail-closed operation.
- Keep strict real calendar validation and its negative cases.
- Join the independent provider-admission parity row with the richer current Spaces row.
- Existing exact-hunk resolver still blocks any unknown live drift; staging must run all focused suites before publishing an artifact.
