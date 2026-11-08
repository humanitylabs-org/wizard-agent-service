# AI Look up (`POST /wizard/v1/lookup/stream`)

Stateless, fast-model explanation of a selected word or phrase inside one chat message. Powers **Look up** in the
Chats text-selection menu (wizard-ux `web/core/lookup-pop.js`). Same contract as Wisdom's `/api/lookup/stream`.

Request (owner session, same-origin JSON): `{text, before?, after?, frame?, agent?, session?}`
- `text` ≤128 chars / 8 words; `before`/`after` ≤1600 accepted, the nearest 800 characters each side are used;
  `frame` ≤80 chars one-line thread label; `agent`/`session` let the server refuse private sources.
- Bad input: plain `400 {error:'invalid_request'}`; non-JSON `415`; >16 KB `413`; private agent / incognito /
  hidden session `403 private_thread`; unconfigured or busy (3 slots) `503 lookup_unavailable`.

Response: `application/x-ndjson`, `{type:'delta',text}`… then exactly one `{type:'done',text,model}` or
`{type:'error',status,error}`. Deltas are provisional; `done.text` is validated (3-70 words, ≤700 chars, one
paragraph, no markdown/links/lists, not just the term) and `done.model` is exactly `claude-haiku-4-5`.

Backend: the first-party Claude fast route that Wisdom's independent broker already runs (`POST <broker>/lookup`):
exactly `claude-haiku-4-5`, thinking off, no tools/web/MCP/settings, one explicit passage, no history, memory or
profile. Operator config (this process only, never sent to browsers): `WIZARD_LOOKUP_URL`, `WIZARD_LOOKUP_TOKEN`.
No alternate-model fallback; nothing is persisted or logged. A closed client cancels the broker run.
Private (Tinfoil) agents and incognito threads are never sent to a cloud model.

Tests: `node --test tests/lookup.node.mjs`.
