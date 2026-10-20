# Raw ChatGPT inference (plugin 0.4.0)

Implements `wizard-os/spec/CONNECTION_ROUTER.md`, open question 1: the ChatGPT
connection app can forward its future `POST /api/infer` to the Hermes-owned login.
This change supplies the plugin side only, not the connection app/router forwarding.
It extends Oscar's read-only usage route; that route remains read-only.

## HTTP contract

All paths below are relative to `/api/plugins/wizard-os`:

- `GET /models/chatgpt`: `{"models":[{"id","label","tier","abilities"},...]}`.
  This is an operator-configured allowlist, **not a live entitlement probe**. Defaults
  are `gpt-6-luna` / fast, `gpt-6.1-sol` / standard, `gpt-6-astra` / frontier.
  Abilities are `text` and `streaming`, never `web_search` or tools. An unavailable
  upstream model fails closed; there is no model/provider/account fallback.
- `POST /infer/chatgpt`: JSON `{model, system?, messages, max_tokens?, stream?}`.
  `messages` is a nonempty list of exact `{role: "user"|"assistant", content: string}`
  objects. `system` defaults to the empty string, **not** a Hermes/default persona.
  `stream` defaults to false. Unknown keys, duplicate JSON keys, tools, tool choice,
  tool history, system-role messages, profile overrides, URLs, keys and arbitrary
  headers in the body are rejected. Requests cannot manage authentication.
- Non-streaming success: `{"ok":true,"model":"<reported upstream model>",
  "content":"...","usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}`.
  Those counts in this example are illustrative. Runtime counts/model come only
  from a completed upstream response; neither is synthesized from the request.
- Streaming: `text/event-stream`, `event: delta` with `{"text":"..."}`, then exactly
  one successful `event: done` with `{ok,model,usage}` (no repeated full content).
  Failure before the first output is an HTTP error; after headers it is `event: error`
  with `{"ok":false,"error":{"code":"..."}}`. EOF/disconnect without `done` is failure.
  **Consumers must discard provisional text on error or missing done.** A stalled
  downstream is closed at the deadline; it may not receive a final error event.
- Errors use only `signed_out`, `expired`, `limit`, `unreachable`, `provider_error`.
  No upstream messages, raw bodies, exception strings, credentials or request data
  appear in errors. Bad schemas/models -> 400; forbidden ingress -> 403; oversized
  body -> 413; unsupported encoding/type -> 415; exhausted concurrency/quota -> 429;
  missing/expired credential -> 401; network timeout -> 503; upstream failure -> 502.
  Schema rejection uses `provider_error`; size/output budget rejection uses `limit`.

## Operator configuration and limits

`../chatgpt.json` is shipped plugin configuration, read on each request. Nothing in
an app request selects its path. `models` controls both discovery and the allowlist.
A bad/missing configuration fails closed rather than reverting to hidden defaults.

`credential_id: null` permits only a single pool row. Multiple credentials require
an operator-pinned pool row ID (non-secret), never an availability-based picker.
A missing pinned row fails signed-out; a failed refresh never selects another row.
Only OAuth credentials routed to the canonical ChatGPT Codex URL are accepted.
The SDK cannot inherit a relay URL, HTTP proxy, organization or project from env;
redirects and automatic SDK retries are disabled.

Defaults: 256 KiB incoming body (including chunked input), 128 messages, 10 seconds
for body receipt, 120 seconds for credential resolution + generation + delivery,
2 active requests per plugin process, and a 32768 `max_tokens` ceiling. Cleanup is
shielded and bounded to 2 seconds. There is no waiting concurrency queue. A timed-out
credential refresh thread retains its slot until Hermes's locked transaction exits;
we do not kill a refresh between token rotation and persistence. Multiple dashboard
processes each have their own limit; deployment must not multiply workers to evade it.

**Codex output-limit caveat:** the subscription Responses transport used by Hermes
rejects `max_output_tokens`; the adapter intentionally does not send it. Here
`max_tokens` is a conservative local guard: streamed visible UTF-8 bytes cannot
exceed it (byte-BPE token count cannot exceed those bytes), and final upstream
`output_tokens`, including reasoning, must also fit. Crossing either fails `limit`,
closes the stream, and never returns a truncated success. This can reject text
**earlier** than a tokenizer-exact cap and is **not an upstream spend/quota cap**:
reasoning/generated-but-undelivered tokens may already have been consumed. Do not
present it as a billing guarantee. A tokenizer-specific relaxation needs separate
review and must not silently change this bound.

## Authentication and deployment boundary (no deployment in this change)

The router is mounted by stock Hermes, not exposed as a second standalone service.
It inherits the **same dashboard authentication** as `/ai-usage/chatgpt`:

- `hermes_cli/web_server.py:701-720`: all nonpublic `/api/` routes require the
  dashboard session token in normal loopback mode.
- `hermes_cli/web_server.py:689-698` and `dashboard_auth/middleware.py`: gated mode
  uses the configured verified login/session-cookie provider, including its origin
  enforcement. The plugin does not add a public route or a bearer-token opt-in.
- `hermes_cli/web_server_dashboard.py:806-817,1032-1036`: mount includes the
  request's profile/secret-scope dependency. `asyncio.to_thread` copies that context;
  this route rejects all query parameters, including the `?profile=` selector.

Both new routes independently reject the **presence** (even empty) of
`tailscale-user-login`, `x-forwarded-for`, `forwarded`, `x-real-ip`, and every `cf-*`
header, and reject any Origin other than the exact HTTP(S) same-origin value.
Backend connection-app requests should omit Origin. The dashboard's own Host and
auth gates still apply; these checks do not replace them.

Use the trusted connection-app/backend boundary; **never distribute the full
owner dashboard/session key to arbitrary Wizard apps**. This PR does not invent a
new app principal or grant mechanism. Connection-app forwarding/scoped service
auth is a separate integration acceptance gate before exposure to apps. The unit
harness intentionally mounts only the router; it does not claim a live dashboard
authentication test.

Hermes's default `plugins.isolation: in_process` is required. Optional `host` mode
buffers entire requests/responses (`web_server_dashboard.py:820-840`) and cannot
preserve SSE/disconnect/ingress-limit semantics. Inference refuses that mode with
503 before resolving credentials; discovery remains read-only. No config, running
plugin, dashboard, gateway or Hermes core was changed by this source-only work.

## Privacy/observability audit

The route imports no AIAgent, SessionDB or memory/persona/skill loader, and calls
no agent API. It only supplies explicit request text to the stateless Responses
converter, pins the provider/transport, and sends `store:false` and `stream:true`.
No tools, conversation IDs, previous response IDs, prompt cache keys, workspace
instructions or inherited runtime session cache scope are included.

It deliberately does **not** construct `_CodexCompletionsAdapter` or an auxiliary
client: that path binds the current runtime's cache scope. Instead it reuses its
stateless converter and the same direct OpenAI Responses streaming transport.
The converter module transitively imports the **constant** `DEFAULT_AGENT_IDENTITY`
from `agent.prompt_builder`; this text-only call never calls prompt assembly or
uses that constant. Re-audit this import boundary when updating Hermes.

No route logger, transcript, result cache, metrics payload or persistence is added.
The sole pre-existing usage cache remains unrelated to inference. Context-local
filters suppress `openai._base_client` DEBUG request/error-body logging and pool/
Codex diagnostic logging during this request, without disabling unrelated requests'
logs. The dedicated plain SDK/httpx client has no Hermes Relay/observability wrapper.
Hermes's normal credential pool may persist auth refresh/health metadata; that is
credential maintenance, not a transcript. Provider retention beyond `store:false`,
external APM monkeypatching and operator-configured HTTP body logging cannot be
promised away by a plugin; do not enable body logging on this route.

## Compatibility seams to re-audit on a Hermes update

Line references are to the source audited for this PR, not a stability promise:

| Internal seam | Source | Why it matters |
|---|---|---|
| `load_pool("openai-codex")` | `agent/credential_pool.py:3066-3140` | Profile-aware pool authority/seeding; no separate token-file reader |
| `entries()` and runtime credential fields | `agent/credential_pool.py:1096-1098,290-318` | Explicit identity choice, OAuth-only key and route |
| `_entry_needs_refresh` | `agent/credential_pool.py:1985-1998` | Proactive expiry detection |
| `_refresh_entry(..., force=False)` | `agent/credential_pool.py:1531-1573` | Shared cross-process auth-store lock, re-read and rotated-token writeback |
| `_exhausted_until` / `model_cooldown_until` | `agent/credential_pool.py:469` / `agent/credential_pool_model_cooldowns.py:22` | Refuse quota/model cooldown without probing or rotation |
| `_codex_pool_route_base_url` | `hermes_cli/auth_codex.py:74-92` | Refuse environment/config/pool relay routing before sending credentials |
| `_chat_messages_to_responses_input` | `agent/codex_responses_adapter.py:552-728` | Typed `input_text`/`output_text`; explicit codex issuer, no replay/compaction |
| Responses request pattern (reference only) | `agent/auxiliary_client.py:1386-1588` | Store false, streaming endpoint; bypass cache-scope binding at 1522-1547 |
| Dashboard mount/auth/host bridge | Sources above | Authentication, profile scope, real streaming vs buffering |
| SDK private logger name | `openai._base_client` | Debug-body privacy; covered with the actual SDK and a mock HTTP transport |

## Offline verification

From this directory, with Python 3.11+ and the existing FastAPI/httpx/openai runtime dependencies:

```sh
python3 -I test_plugin_api.py -v
```

Tests fake every credential resolver/pool/Responses converter/upstream stream; a
real AsyncOpenAI client is exercised only against `httpx.MockTransport`. Socket and
sensitive-file tripwires, import/instantiation traps for AIAgent/SessionDB, exact
wire-payload assertions, limits, timeout/cancellation/slot cleanup, pin/refresh
failure behavior, malformed upstream output and DEBUG-log redaction are covered.
No real token was read, copied or refreshed; no live inference was made. A real
model-availability/login/stream smoke test remains separately approval-gated.
