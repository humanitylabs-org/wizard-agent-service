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

- `GET /wizard/v1/agent-inbox?state=new,running&kind=&agent=&limit=` -> `{ records, check, stay }`; `stay` lists the main agent's Daily and Alerts
  threads (newest 500), which Send to inbox refuses, so the shell leaves the action off them
- `POST /wizard/v1/agent-inbox` `{ thread_id, title, ask, agent?, source?, origin_item_id?, kind?, link?,
  severity?, privacy_class?, dedupe_hash?, recommendation?, options?, default_option?, deadline?, confirm? }`
  -> 201 `{ record, created: true }` or 200 with the existing record
- `GET /wizard/v1/agent-inbox/<id>` -> `{ record }`
- `PATCH /wizard/v1/agent-inbox/<id>` `{ action: answer|snooze|archive|surface, option? }` -> `{ record }`

Records default to `privacy_class: private`; `textForModel(record, { privateModel })` returns nothing of a private
record for a non-private model, for the later steps that may ask a model to fill a missing title.

## Hidden worker threads (wizard-ux issue 1569)

A worker thread the Service starts for a capture (the orb dump, `worker: true` on its record) is hidden in Hermes, so it
stays out of the chat list, Activity, Channels, unread counts and badges. Reading it by id still works, so every link
(sweep card, Running view, Ready, notification) opens it; reading it never unhides it. `AgentInboxStore.mayHide` is the
one rule for any later hide: only a Service-started worker thread (or one the owner sent there, below), never one the
owner started. When the owner sends a turn in a hidden worker thread, the Service shows it again (Hermes `hidden: false`)
and stamps `owner_turn_at` on its records, so it is never hidden after that. The shell's Running view reads
`GET /wizard/v1/agent-inbox?state=running,stale`.

## Open and Send to inbox (wizard-ux issue 1570)

One tap fixes a wrong routing either way. Main agent only (its threads are the only hidden ones); a routed agent's
thread answers 409 `main_only`.

- `POST /wizard/v1/agent-inbox/open` `{ thread_id, utterance? }` -> `{ record, hidden: false, example }`: Hermes
  `hidden: false`, then `owner_turn_at` on the thread's records, so nothing hides it again until the owner sends it back.
- `POST /wizard/v1/agent-inbox/send` `{ thread_id, title?, utterance? }` -> `{ record, hidden: true, example }`: refused
  with 409 `pinned` for a thread the owner pinned (ui-preferences `pinnedChats`, or Hermes `pinned`), and with 409
  `daily_thread` / `alerts_thread` for a Daily day thread or a thread filed in a Daily or Alerts channel (read from
  channels.sqlite, Channels switch on or off). Hermes `hidden: true`, then the thread's record (or a new one, source
  `chats:send`) becomes a worker record with `owner_turn_at` cleared: `running` while a turn is still on its way (its
  status line updates it as usual), otherwise a result waiting for the next sweep. Sending is the owner's own choice, so
  it is the one way a thread he started becomes a worker thread.

Each tap stores one example `{ at, utterance, chosen, wanted, privacy_class }` (the words said, else the record's ask;
newest first, 50 kept). The orb router (`/wizard/v1/route` with the dump route) puts the latest 8 into its prompt as
few-shot lines, only when the router is private (`privateRouter`, by endpoint host). No retraining.

## Signal sweep card (issue 550)

Step 3 of the series, same switch. One capped card, built only from inbox records (code: `server/agent-sweep.mjs`).

- **When:** the owner says or types "signal sweep" (on its own) to the main agent, a schedule the owner made with
  thread `daily` and the prompt `signal sweep` fires (none exist by default), or `POST /wizard/v1/agent-inbox/sweep`.
  The typed or scheduled turn still runs; its run note says the card is posted (a scheduled one answers `[SILENT]`).
- **Where:** today's Daily thread of the main agent (Channels switch on, Daily channel open; otherwise the sweep
  answers 409 `daily_unavailable`). The card is not a Hermes message: the Service keeps the newest card and adds it as
  the last row of that thread's newest `view=wizard` history page (`display_kind: agent_sweep`, the card in
  `agent_sweep`, a plain-markdown copy in `content` for a shell that does not draw the buttons).
- **Caps, in code:** Waiting on you max 7 (needs_you records `new` or `surfaced`; urgent first, then deadline, then
  oldest), each with title, ask, recommendation and one button per answer token; beyond 7 "and N more" with a link.
  Done max 10 (newest first), beyond 10 "more". Running (with stale), Later and FYI, and parked are counts with links.
  No free-text summary field anywhere.
- **What a sweep changes:** each shown Waiting item is `surfaced` (one more sweep; `seen` on the card is the age
  badge); an item already shown on 3 sweeps unanswered parks instead. Shown Done and counted FYI records archive.
- **Answers:** `PATCH /wizard/v1/agent-inbox/<id> { action: 'answer', option }` first posts that token's full resume
  message into the record's own thread as its next turn (run admission, idempotency key
  `wizard-inbox-answer-<id>-<token>-<sweep count>`), then marks it `answered`; it archives at the worker's next status
  line (a new needs_you instead starts it over). The token `later` snoozes it to the next sweep, posting nothing.
- **Yes to all:** `POST /wizard/v1/agent-inbox/<card id>/yes-to-all` answers each Waiting item on that card with its
  `default_option`, never an item hidden by the cap, never a `confirm` item (the card shows those as "Open to
  confirm"), never one answered since.
- `GET /wizard/v1/agent-inbox/sweep` -> `{ card }`: the newest card with each item's current `state` / `answer` and
  `yes_to_all: { count, skipped }`.
- Links: threads use the shell's `/wizard-os-home/?session=<id>` deep link; the list views are
  `/wizard-os-home/?inbox=waiting|done|running|later|parked` (the Running view, wizard-ux issue 1569, and the inbox
  views after it).

## App doors (issue 569)

Messenger's Agent chat (and any other app) is a second door to this one inbox: there is one store and one card
builder, never a second list. An app proves itself with its own app token, the file
`<wizard-os home>/app-tokens/<app id>` that the app delivery route already checks, sent as
`Authorization: Bearer <token>`. That credential is never the owner, and it opens only these routes for that app:

- `GET /wizard/v1/agent-inbox/doors`: the door probe, `{ on: true, sweep_caps: { waiting, done }, door, pings }`. With
  the switch off it answers 404, which tells the app to keep its own behaviour (every route below is 404 then too).
- `POST /wizard/v1/agent-inbox` with `{ source: { app, item_id }, text, title? }`: a note. One record (`source`
  `app:<app>/<item_id>`, state running) and a hidden main-agent worker, started exactly like the orb dump. A resend of
  the same item id returns the same record; a note whose worker could not start waits as needs_you and starts again.
- `POST /wizard/v1/agent-inbox/sweep { door: '<app>' }` and `GET .../sweep`: the card as JSON, with each item's current
  state. No Daily thread is needed, so an app door never gets 409 `daily_unavailable`.
- `PATCH /wizard/v1/agent-inbox/<id>` `{ action: 'answer', option }` (a token or `later`) and
  `POST .../<card id>/yes-to-all`: only for Waiting items on a card that door drew, and never for a record another app
  sent. Yes to all never covers `confirm` items.
- `POST /wizard/v1/agent-inbox/events`: only with `source.app` set to the app itself.
- `POST /wizard/v1/agent-inbox/doors { pings: true }` and `GET .../pings`: urgent alerts the rules already delivered
  to Alerts (decided once, issue 552), starting from when the door asked. A read consumes nothing: the door stores each
  ping, then sends `POST .../pings { ack: [ids] }` (at most 500), and only then is that alert never handed to it again.
  A lost answer or a crash between the read and the store hands the same ping out on the next read (issue 325).

Every other inbox route answers 403 `owner_only` to an app token; `source.app` naming another app answers 403
`wrong_app`.

**One sweep event.** A sweep asked at any door (Daily, an app, a typed or scheduled sweep) within an hour of the
newest card, from a door that has not drawn that card yet, draws the same card. So a sweep in Daily and then in
Messenger shows the same items and counts, and surfacing, the age badge (`seen`), parking after 3 sweeps and the
archiving of shown Done/FYI records happen once per event, not once per door. The same door asking again, or any door
after the hour, is a new sweep. When the Daily draws a card an app made, the card gets today's Daily thread and shows
there as its last row.

Handing the token to the app (an env var or file in its container) is the App Manager's part.
