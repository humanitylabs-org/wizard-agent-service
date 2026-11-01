# Hermes runtime lock

This directory vendors wizard-os `tools/hermes_lock.py` and
`releases/hermes-lock.json` unchanged. The authority and approval workflow are
[Wizard OS #215](https://github.com/humanitylabs-org/wizard-os/pull/215).
Keep those copies byte-identical when promoting; never advance a runtime default
by changing a tag or an environment variable alone.

Normal, imported-plan and restricted-helper defaults now use the exact locked
GHCR manifest digest. CLI/environment image overrides must match the lock.
Restricted helper execution always passes `AGENT_IMAGE`, rather than inheriting
an ambient floating tag or the vendored Compose fallback. The vendored restricted
runtime and its SOURCE checksums are unchanged.

Existing non-import agents are not automatically converged to the default during
apply/start: immutable local image identities must match, or the reviewed
promotion plus an explicit `WIZARD_HERMES_PROMOTION=<id>` is required. Unknown or
ambiguous identity fails closed. Stop, delivery and inspection remain available.
This may refuse a config restart on an old/custom runtime until an operator
reviews it; it must not silently downgrade that runtime. Journalled imports and
recovery-image builds retain their separate explicit lifecycle/rollback authority.
Direct Docker/Runtipi administration or direct invocation of the vendored
Compose file remain administrator escape hatches, not managed upgrade paths.

The initial freeze is the existing September baseline, with the known compacted
history visibility limitation documented in Wizard's acceptance record. This is
not a claim of universal safety or permission to downgrade an existing host.
No live runtime is changed by this PR, and no release snapshot is cut. Before a
fleet rollout: non-author admin review, clean-VM fresh/alongside acceptance,
backup inventory, exact-source canary, bug review after seven complete public
days, recommendation then approval, and a coordinated window with tested rollback.
