# Owner response style

See wizard-os `spec/RESPONSE_STYLE.md` ([contract PR #284](https://github.com/humanitylabs-org/wizard-os/pull/284)) and [Wizard UX #631](https://github.com/humanitylabs-org/wizard-ux/pull/631).

The owner selects `response_style: summary | concise` through the existing settings API. Existing installs and missing preferences remain Summary. Production startup assigns genuinely new Wizard installs once using `crypto.randomInt(2)` before creating stores. Existing settings or Wizard queue/read-state files mark an upgrade. Reads and restarts never reassign.

`response_style_experiment` stays in the private local settings file: assignment, new/existing-install source, and bounded counts of actual switches to each style. No content, identifiers, timestamps or telemetry sink. PUT cannot forge it. Non-owner projections omit the owner preference and non-owner writes to that field fail.

Summary restores the pre-#210 finish-report text, with the owner's cold-read context addition. Concise preserves #210 by @oscarhenrycollins. Main and routed-agent run admission select at the next turn, including heavy continuations; already-admitted runs retain their original instruction contract. Scheduled reporter notifications retain their explicit short-format override.

Synthetic Forum full suite on the feature head: 125 Vitest files, 1,524 passed / 5 skipped; Node 56 passed / 1 skipped; parity gate 182 passed (including both style changes for all four runtime kinds); Python/import checks pass. Live branches are prepared separately and this change never deploys a running service.
