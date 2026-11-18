# Agent inbox

Step 1 of the agent inbox series (issue 549). Owner switch `wizard/agent-inbox` in the synced Look file, off by
default; `WIZARD_AGENT_INBOX=1` / `0` forces it on or off. With the switch off nothing is written and every route
below answers 404.

One short record per background task, in `$HERMES_HOME/state/wizard-mobile/agent-inbox.json` (next to the Thread
tracker ledger, so it is in the agent's private data and the normal backup; `WIZARD_AGENT_INBOX_STATE_PATH`
overrides it). Code: `server/agent-inbox.mjs`.

## How a record moves

- **Capture** (`POST /wizard/v1/agent-inbox`) creates the record in state `running` before the worker starts.
  The same dedupe hash (given, or derived from agent + source + ask) returns the existing record instead.
- **Every finished run** on the record's thread (main queue lookups and run reads, routed agents' queue lookups and
  run reads) updates it from the hidden `WIZARD_STATUS_V1` line. The worker never writes the inbox.
  - `needs_you` / `check` -> `new`, kind `needs_you`
  - `done` -> `new`, kind `result`
  - `fyi` -> `last_update` only while more work is on its way (another queued turn, or owed heavy work); at the
    end of the work -> `new`, kind `fyi`
  - no parseable status line, or a failed/killed run -> `new`, kind `result`,
    `last_update` "Finished without a summary. Open it to read."
  - optional status keys `recommendation`, `options` (token -> full resume message), `default_option`,
    `deadline`, `confirm` are read when present.
- **Stale:** a `running` record with no update for 6 hours becomes `stale` ("No news for 6 h.") on the next read
  and in the nightly check.
- **Nightly check** (scheduler tick, once a day): marks stale records and counts finished worker runs (queue runs
  whose idempotency key starts with `wizard-inbox-`, finished in the last 7 days) that have no record. The target is
  zero; a non-zero count is logged (`[agent-inbox] nightly check: ...`) and returned as `check` by the list route.

## Routes (owner settings gate on every method)

- `GET /wizard/v1/agent-inbox?state=new,running&kind=&agent=&limit=` -> `{ records, check }`
- `POST /wizard/v1/agent-inbox` `{ thread_id, title, ask, agent?, source?, origin_item_id?, kind?, link?,
  severity?, privacy_class?, dedupe_hash?, recommendation?, options?, default_option?, deadline?, confirm? }`
  -> 201 `{ record, created: true }` or 200 with the existing record
- `GET /wizard/v1/agent-inbox/<id>` -> `{ record }`
- `PATCH /wizard/v1/agent-inbox/<id>` `{ action: answer|snooze|archive|surface, option? }` -> `{ record }`

Records default to `privacy_class: private`; `textForModel(record, { privateModel })` returns nothing of a private
record for a non-private model, for the later steps that may ask a model to fill a missing title.
