# Proposed per-thread answer route: Opus direct

The owner can select `hermes` (default) or `opus-direct` with
`GET|PUT /wizard/v1/threads/{sessionId}/route`. PUT accepts `{ "route": "opus-direct" }`.
An optional `agent_id` (or `agent`) query identifies a qualified thread when session IDs collide.
Unknown threads return 404; ambiguous unqualified threads return 409. Agent credentials cannot
use the owner control. Private, confidential, restricted and recovery agents return
409 `thread_route.private_agent`, including when a previously standard agent has been sealed.
Operator/confidential session namespaces are refused too.

Selection is independent of connection readiness: an unavailable selection remains selected;
the response has `available: false`, `reason` and `fix_url`. It never silently selects Hermes.
Changing a route during an active direct turn returns 409 `session_busy`.

## Runtime and state

The shell already sends `web/outbox.js` -> `POST /wizard/hermes/v1/runs` and reads
`GET /wizard/hermes/v1/runs/{run_id}` and `.../{run_id}/events` (`web/live.js`).
The service intercepts direct admissions before either Hermes executor or its queue/lock bridge.
It uses Connection Router `POST /v1/models/opus-direct/run`, with `X-Wizard-Grant`, and translates
router `delta`/`text`, `done`, and `error` SSE into the existing `message.delta`, `run.completed`
and `run.failed` events. Terminal completion includes `route: {kind, provider, model}`.
Only the router's effective done-event provenance is recorded; an incomplete/malformed stream
or missing/wrong-model provenance fails, with no inference retry or Hermes fallback.

`thread-routes.json` is an atomic, thread-reference-keyed service store. `direct-turns.sqlite3`
uses `node:sqlite` in the service state directory beside the run queue. It persists user/assistant
messages, idempotent admissions, final provenance (`provider`, `model`, `chosen`, `usage`), and
run status. A running turn interrupted by service restart is marked failed, never resent.
No Hermes database or Claude credential is written or read for this implementation.
Existing Hermes history is read through its HTTP API (the service's existing read-only history
projection); system/tool/hidden rows are excluded from direct inference. Only bounded text is
sent (64,000 characters of context; at most 32,000 characters of new input). No tools, persona,
memory or shell screen instructions are included. Direct mode is text-only: attachments are
refused and must be sent through Hermes after an explicit route change.

Assistant provenance and `direct:` message IDs are merged chronologically into thread history
and detail; list/detail advertise optional `answer_route: "opus-direct"` (absent means Hermes).
Direct errors and run status use the existing list/run error surfaces. History pagination is
applied to the combined timeline. On return to Hermes the server appends a bounded
`[Wizard direct-answer context]` transcript note via its existing run-context instructions,
covering direct turns newer than the latest Hermes assistant turn. Hermes stays stock.
Direct runs cannot currently be steered or stopped through Hermes controls: those return 409,
never call Hermes. The service still enforces an overall direct inference timeout.

## App Manager grant delivery (verified source, not a live-install proof)

App Manager `origin/main`, `packages/backend/src/modules/docker/wizard-app-grants.ts`:

- `requires.models` automatically requests `slot:connection-router` through the connection policy
  (`wam/network.py` describes this grant).
- `mountAppGrants()` mounts `${APP_DATA_DIR}/wizard:/wizard:ro` and sets
  `WIZARD_GRANTS_FILE=/wizard/grants.json`.
- The consumer file's `outgoing["slot:connection-router"]` is the plaintext outgoing token;
  the provider gets only its incoming hash. `provider_endpoints` supplies the routable internal
  endpoint when the public registry address is unsuitable.
- Discovery still requires the `connection-router` slot in `apps.json` and its selected app.
  Endpoint resolution accepts registry API/internal, view/upstream and MCP addresses, stripping
  their paths, with App Manager's `provider_endpoints` override. Requests do not follow redirects.

Alongside installs receive no automatic app grant. An explicitly provisioned
`WIZARD_ROUTER_GRANT` or `WIZARD_ROUTER_GRANT_FILE` can supply it without reading provider logins.
This is not an invitation to extract or mint a live owner grant. A fresh App Manager installation
or separately approved staging grant is still needed for real Opus acceptance.

## Synthetic fixture and tests

```sh
npm ci
npm test
node --test tests/locked-run-bridge.test.mjs
WIZARD_FIXTURE_OPUS_DIRECT=1 npm run fixture
```

The last command starts a fake Hermes, a local fake SSE Connection Router and the service on a
random loopback port, and prints its URL. Set `WIZARD_FIXTURE_PORT` to choose an unused test port.
Set `WIZARD_UX_DIR` to a Wizard UX checkout's `web` directory for combined shell testing. Existing
synthetic sessions include `chat-recent` and `chat-long`. Select direct on either via the route
PUT, then use the unchanged send/stream path. The synthetic reply is clearly labelled
`Synthetic Opus direct reply.`; it does not consume a subscription or require credentials.
Ctrl-C stops the fixture and removes its scratch state.

The executable parity entry `opus-direct-answer-route` covers main/host-profile/container sends,
restart, history, switch-back context, unchanged ordinary threads and router failure. Restricted
kinds execute a 409 refusal policy test instead. Additional grant/policy tests are in
`tests/opus-direct.node.mjs`. These are fixture boundaries, not real VM/container/browser or
paid-model acceptance.
