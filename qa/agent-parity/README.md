# Agent chat parity fixtures

`npm run test:agent-parity` runs the disposable HTTP matrix and policy-validation tests.
`features.json` is the inventory; every server feature requires an executable `fixture`
registered in `checks.mjs`. Missing coverage is a failure. Runtime/browser gaps remain
visible and must not be described as live acceptance.

## Executable policy exemptions

An exemption is narrowly declared per feature and kind:

```json
{"kind":"container","policy":"owner-scoped-hermes-only","assertion":"owned-open-work"}
```

The named policy must declare its allowed `kinds` and an explicit `rule`. The
`assertion` must equal that feature's executable fixture. The runner always executes
the fixture for that kind; only a passing assertion becomes `policy-exempt`. Failed
assertions stay failures. Unknown policies, blanket kinds, missing fixtures and
duplicate kinds are rejected. Other features are never exempted implicitly.

The owned-open-work exception records James's 27 Oct 2026 "Archimedes only" scope.
Its HTTP assertions prove routed kinds receive no new instructions, keep done status,
and receive no automatic correction. Main service continuation and restart behavior
are additionally exercised by `tests/owned-open-work.test.ts`.
