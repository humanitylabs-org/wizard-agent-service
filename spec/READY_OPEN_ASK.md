# Ready follows an open owner action

A helper, an unanswered helper result, a heavy job or a Supervisor builder is background work, not owner attention. A final reply must always carry its Wizard status line, even on a handoff.

`server/open-ask.mjs` owns the pure decision shared by main and routed session lists. Feed visible final assistant replies in arrival order and the most recent genuine user timestamp. Preserve earlier `needs_you`/`check` asks after progress, unmarked replies and `done` while background continues. A newer owner message clears the ask. Without background, `done`/`fyi` replaces it. A newer ask replaces the previous one.

- An open ask is Ready and supplies `wizard_attention`. Concurrent work supplies `wizard_background: helper|heavy` independently.
- Background without an ask stays Working. `done` never makes an open ask.
- `check` cannot make a pending heavy job Ready. Keep the heavy completion guard for `check`, not `done`.
- A future-tense ask (`will`, `once`, `when the helper`, `after the helper`, `soon`) is progress while background continues.
- Errors, explicit stop requests and native approvals retain their existing handling.
- Do not manufacture a new active turn from old, user-only archive history. Runtime liveness remains authoritative when no background work is present.
- Keep helper recovery admission separate from list attention: owner-held receipts may still represent background results, but showing a badge does not authorize a continuation.

The full and slim list projections both carry the background hint. Chats reuses its existing chip geometry with Wizard skin tokens; this hint does not add a notification path. Existing client reply notifications remain client-owned.

## Regression proof

`tests/open-ask.node.mjs` names the QR/button failure and all ten Ready/Working examples, exercises the real main HTTP list with a running helper, and checks main, host-profile, container and restricted HTTP with a concurrent heavy job. It also checks progress persistence, prompt delivery text, timestamp formats and archive stability. `tests/heavy-status.test.ts` retains all-runtime pending-heavy coverage. Run `npm test` for the full server suite.
