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

## Browser groups

`browser.mjs` runs the real Service and the unmodified shell in a browser, against synthetic runtimes, one group
at a time (`QA_GROUP`): `static`, `compose`, `working`, `media`, `resume` and `offline`. `resume` (feature
`stream-resume`) cuts every Service connection mid-reply, goes offline, and loses frames past retention, using
the fixture's opt-in numbered event script (`fixtureEventScript`, `s.eventScript(runId).push(...)`). `offline`
(feature `offline-start`) allows service workers and reloads the shell with the browser offline. These two need
no fake media devices, so they also run on Linux with `QA_CHROMIUM` and `QA_PLAYWRIGHT` set. Their evidence is
synthetic-runtime browser evidence, not live provider acceptance.
