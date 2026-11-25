# App wake events (wizard-os issue 634)

Contract: wizard-os `spec/APP_WAKE.md` (`wizard.app-wake/1`). On for everyone: the owner switch `wizard/app-wake` was
approved at show-and-tell and removed. Only a box's `WIZARD_APP_WAKE=0` turns it off: `/wizard/v1/agent-events` then
answers 404 and nothing runs.

The box is the agent's event inbox. An installed app calls the Service with its own app token
(`<wizard-os home>/app-tokens/<app id>`, the file `appForToken` checks, handed to the app by the App Manager, App Manager issue 804):

- `GET /wizard/v1/agent-events` → `{ on: true, contract: 'wizard.app-wake/1', app, agents }`: the agents this app may
  wake now (the main agent plus every standard agent whose `wizard_apps` grant holds the app; `bridge.apps(id)`).
  No agent bridge (no apps.json) means no grant to read, so `agents` is empty.
- `POST /wizard/v1/agent-events` `{ event, agent?, data? }` → `parseWakeEvent` (server/app-wake.mjs) checks the name
  (`<app>.<event>`) and the small flat data, the grant is checked, then `deliverAppWake`:
  - `createWakeLedger().reserve` takes the (app, agent, event) slot before any await: a repeat within `MERGE_MS`
    (60 s) answers `200 merged` and is kept as `again`; one timer wakes the newest merged event when the window ends.
    `HOURLY_CAP` (60) wakes per app per hour, then `429 wake_limit`.
  - `startAppWake` creates a new session (`mintDailyThreadId`, no title: stock Hermes refuses a second session with
    a title another holds, so a fixed title failed every wake after the first), hides it (main through
    `hermesJson` PATCH like the orb dump; routed agents through the proxied PATCH), and admits one run through
    `deliveryCall` with key `wizard-wake-<hash>` and the words of `wakeTurnText` (an app's signal, never the owner's
    words). A failed start frees the slot (`503 wake_not_started`).
- The owner and agents are refused (`403 app_token_required`), the same skin-origin rule as the inbox doors applies,
  and with the browser boundary on the route is a machine request only for a real app token.

Tests: `tests/app-wake.test.ts` (event check, ledger, on by default, `WIZARD_APP_WAKE=0`, no grants) and the parity check `app-wake-events`
(probe, refusals, the wake turn in a hidden thread, merge and follow-up, grants per kind).
