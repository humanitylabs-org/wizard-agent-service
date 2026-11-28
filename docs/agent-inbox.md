# Agent inbox

Step 1 of the agent inbox series (issue 549). On for everyone since wizard-ux issue 1778 (James's yes at
show-and-tell; the owner switch `wizard/agent-inbox` is gone and an old value for it in the Look file is ignored).
Only a box's `WIZARD_AGENT_INBOX=0` turns it off; then nothing is written and every route below answers 404.

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
- **Stalled = failed (issue 607):** a `running` record with no update for 6 hours, or past its `deadline`, fails on
  the next read and in the nightly check: `state` `new`, `kind` `needs_you`, `failed: true`, `last_update`
  "Stalled: ...". It waits on the owner in Inbox. A later status line from its worker still applies (and clears
  `failed`). Records stored as `stale` before this stay readable.
- **Confirm:** a status line with `confirm: true` (the worker would send, book, buy, publish or delete) is never done:
  the record waits as `needs_you`. The background run note tells the worker to stop there.
- **Nightly check** (scheduler tick, once a day): marks stale records and counts finished worker runs (queue runs
  whose idempotency key starts with `wizard-inbox-`, finished in the last 7 days) that have no record. The target is
  zero; a non-zero count is logged (`[agent-inbox] nightly check: ...`) and returned as `check` by the list route.

## Result reader (issue 630, on for everyone with the agent inbox)

After a long run the worker often forgets its reply rules, so its status line goes missing, runs long or names the
wrong state. A fixed reader decides how each finished run on a linked record is filed (its switch
`wizard/result-reader` was removed at show-and-tell; an old Look file entry is ignored). Code: `server/result-reader.mjs`.

- **Model:** only the box's private fast router (`privateRouter`: Tinfoil by host, an on-box `*-tinfoil` proxy or
  loopback), temperature 0, a fixed prompt, no memory, no tools. No private router set: never called, logged once,
  every run filed exactly as before. It covers every agent (main, standard, private) because the model is private.
- **Reads (bounded):** agent and its kind, duration, ok / failed / killed, error text, owed background work, the
  status line as a hint, the last 4,000 characters of the final reply, and the owner's latest 8 corrections (Not
  urgent / Should have alerted, Open / Send to inbox).
- **Writes (strict JSON):** `kind` needs_you | result | fyi, `urgent`, `failed`, `ask` (capped at 140), `options` only
  on needs_you. It goes through the same mapping as a status line, so owed work, a `confirm` line and an answered
  record behave as before; `failed` marks a result failed; `urgent` raises the severity to `high`, and the alert gate
  (its rules, examples and 3-a-day cap) decides the alert.
- **On the record:** `classified_by` (`reader`; `status_line` or `fallback` when the read failed), `status_line` (the
  hint), `reader` (its decision or its error), `reader_disagreed`. GET `/wizard/v1/agent-inbox` carries `reader`
  counts (calls, reader, status_line, fallback, disagreements), and a Sent row whose record the
  reader filed shows `filed_by`.
- **Failures:** invalid JSON, an HTTP error or a 20 s timeout file the run as today, logged. One read per finished run
  however often it is polled; a Service restart mid-read reads it again on the next poll.

## Smart inbox (issue 667, switch `wizard/smart-inbox`, off by default)

The same owner switch as the shell's Smart inbox rule (wizard-ux issue 1883), read from the Look file; env
`WIZARD_SMART_INBOX` `1` forces it on, `0` off. With it on:

- The status contract injected into every agent's runs (main, routed, heavy relay; Wizard and Own reply styles)
  says `needs_you` is a blocker only (a decision, approval, unclear instruction or missing input; if the agent can
  file, build or finish, it does), and `check` is the confirm kind (try it, QA it, confirm it) that waits for catch
  me up. No agent persona changes.
- When a main-agent run ends: `check` writes one record (kind `confirm`, `filed: smart_inbox`, the ask) and the run
  is quiet. A run with no owner Sent row (a watch, a schedule, a helper result) files `done` as `result`, a final
  `fyi` as `fyi`, `check` as `confirm`, and is quiet; a `[SILENT]` answer is only quiet. The owner's first message or
  reply is quiet when his words asked for no answer and the run ended done, fyi or check. `needs_you` and failed runs
  are never quiet or filed. A newer filed record on a thread archives its older open one; a filed record is never the
  thread's worker record (`linked` skips it), and a worker thread keeps reporting into its own record.
- "Let me know when", "tell me when", "ping me once" in the owner's message set `notify_when_done` on its Sent row;
  that thread's next finished result (done or check) is not quiet and not filed, once (`notified_run`).
- The list row's `wizard_quiet_reply` (`quietReply` in `view=list`) reads these quiet runs; a `check` Sent row reads
  `done`. The signal sweep counts `confirm` records under Later.

Switch off: the contract, Sent rows, records and quiet marks are exactly as before.

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
  WIZARD_AGENT_INBOX=0 it answers 404, which tells the app to keep its own behaviour (every route below is 404 then too).
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
  to Alerts (decided once, issue 552), starting from when the door asked. A door should read with `GET .../pings?keep=1`:
  that read consumes nothing, the door stores each ping, then sends `POST .../pings { ack: [ids] }` (at most 500), and
  only then is that alert never handed to it again, so a lost answer or a crash between the read and the store hands the
  same ping out on the next read (issue 325). A plain `GET .../pings` still hands each ping out once, at the read.

Every other inbox route answers 403 `owner_only` to an app token; `source.app` naming another app answers 403
`wrong_app`.

**One sweep event.** A sweep asked at any door (Daily, an app, a typed or scheduled sweep) within an hour of the
newest card, from a door that has not drawn that card yet, draws the same card. So a sweep in Daily and then in
Messenger shows the same items and counts, and surfacing, the age badge (`seen`), parking after 3 sweeps and the
archiving of shown Done/FYI records happen once per event, not once per door. The same door asking again, or any door
after the hour, is a new sweep. When the Daily draws a card an app made, the card gets today's Daily thread and shows
there as its last row.

Handing the token to the app (an env var or file in its container) is the App Manager's part.

## Sent log (issue 607)

Every capture the owner sends to `POST /wizard/v1/route` (orb take, side button, new chat) gets one row in
`sent-log.json` beside the inbox store, written **before** the router runs, so a router that throws, hangs or is
missing still leaves a row. The shell may send `source` (`orb` | `side` | `new_chat`), `idempotency_key` (one row per
take; without one, the same words from the same source within 60 s are the same row) and the `thread_id` it will use.
The answer keeps its old status codes and adds `sent_id`.

Routing order, whole phrases only (never words inside a task: "draft a reply to Sam" is a task):

1. no-reply phrases at the start or the end ("note", "note to self", "no reply", "just do it") -> background
   (`dump`), without asking the model, also when no router is configured;
2. wants-reply phrases ("reply", "tell me", "answer me", "let's talk", "walk me through", "explain to me"), a greeting
   -> visible thread;
3. an exact earlier correction of the same words (Open / Send to inbox, or `/correct`) -> the route the owner wanted;
4. the plain task lead / short question heuristics, then the model. The model may answer `unsure`.

"urgent" / "priority" at the start or the end set `urgent` (the record sorts first in Inbox); `#x` / "hashtag x" are
`tags`. Router missing, failing, slower than 5 s for a dump, `unsure` or no usable answer -> route `agent`,
`decided_by: fallback`, which the shell opens as a visible thread.

A new main-agent thread's first owner turn links to the orb row with the same words (within 10 min), else it is a
`typed` row (route `agent`, always a visible thread) that is classified in the background into `would_route`. The
model is asked only when the fast router is private (the owner's typed words never reach any other model).

Routes (owner only; WIZARD_AGENT_INBOX=0 -> 404):

- `GET /wizard/v1/sent?limit=50&before=<row id>` -> `{ rows, next, check }`, newest first. A row: `id`,
  `idempotency_key`, `at`, `source` (orb | side | new_chat | typed), `text`, `route` (dump | agent | command |
  reminder), `decided_by` (owner_words | model | correction | fallback), `rules_matched[]`, `model`, `confidence?`,
  `would_route?` (typed only, with `would_decided_by`, `would_rules`), `tags[]`, `urgent`, `correction_id`,
  `thread_id`, `record_id`, and `state` read live: from the inbox record (running, needs_you, failed, done) or from the
  thread's queue rows (running, done, failed).
- `GET /wizard/v1/sent/<id>` -> `{ row }`.
- `POST /wizard/v1/sent/<id>/correct {should_reply: true|false}`: "Should have replied" on a background row is Open,
  "Didn't need a reply" on a visible row is Send to inbox (same refusals: pinned, Daily, Alerts, main only). Each is
  one route example; its id is the row's `correction_id`. Already right -> `{ changed: false }`.

The nightly check flags rows still without a final state (done, needs_you, failed) 6 h after they were sent
(`flag: no_final_state`, `check.unfinished`).

### Replies inside a thread (wizard-ux issue 1808)

Every later owner turn in an existing main-agent thread (a typed or voice message, or a steer while a turn runs) is a
`reply` row: route `thread`, `decided_by: owner_words`, the thread id and the turn's run, written before the turn is
admitted. `wants_reply` comes from the same reply rules (a wants-reply phrase, a greeting, a short question) or any
`?`; a voice note with no words yet wants a reply. When the turn's run ends, the row keeps the agent's final status
(`outcome`: done | fyi | needs_you | check | none, or failed) and its one-line `answer` (the status ask). `quiet` is
true only when `wants_reply` is false and the outcome is done or fyi; `state` is then done. `/correct` on a reply row
changes nothing.

The chat list row of a thread whose newest run is a quiet reply carries `wizard_quiet_reply: true` (`quietReply` in
`view=list`), never while a turn runs or while the row shows needs_you / check. The shell keeps such a thread out of
Inbox / Ready (wizard/chats-inbox). A question, needs_you, check or a failed run goes to Inbox as before. Switch off:
no reply rows and no flag.

### Typed messages can go quiet too (issue 669, Smart inbox switch `wizard/smart-inbox`)

A typed first message's row keeps its first run's `outcome` too, and the Sent log judges its shadow guess
(`server/typed-routing.mjs`) against what the owner did:

- guess: `background` when `would_route` is dump or reminder (or the message already ran in the background), else
  `visible`. A reply phrase, a `?` or "let me know when" is always visible, whatever the router said.
- what he wanted: his `/correct` first (Should have replied = visible, Didn't need a reply = background); a blocker
  (needs_you) or a failure reached Inbox either way (`neutral`, not counted); a reply row he typed in that thread after
  it = visible; a finished answer he left alone for 24 h = background; otherwise `pending`. Opening the thread is not
  counted (every typed thread is open at send today).
- the gate counts the background guesses only (the ones that would change what he sees): at least 50 of the newest 200
  judged and 90% of them right. A typed message that ran in the background counts too, so a guess that gets worse
  closes the gate again.

`GET /wizard/v1/sent` adds `typed_routing` (`on` = switch on and gate met, `switch`, `graduated`, `typed`, `pending`,
`neutral`, `all` / `background` / `visible` `{judged, matched, rate}`, `gate {min, rate, window, settle_hours}`) and,
on each typed row, `typed_guess` and `typed_verdict` (match | miss | neutral | pending). `GET /wizard/v1/sent/typed`
answers `{ typed_routing }` alone. This is read-only and served with the switch off too (nothing acts on it).

With the switch on and the gate met, the shell asks before it opens a typed new main-agent chat:
`POST /wizard/v1/route {text, source: "typed", accept_dump: true, idempotency_key?}` (owner same-origin JSON). The
box decides with the same guess as the shadow one (his words, an exact earlier correction, a private router only,
5 s). A task answers `cmd.route: dump` with `record_id` / `thread_id` after starting the orb's hidden worker (record
`source: typed:dump`; the worker's run note says the owner typed it and is not watching); the Sent row is `source:
typed`, `route: dump` (or reminder), with `would_route`. It waits in Sent › Working and comes back to Inbox only for a
blocker or a failure, as an orb dump does. "Should have replied" on it opens the thread, teaches the router (one route
example) and counts as a miss. Anything else answers `200 {cmd: {route: agent, summary}, typed: {background: false,
why}}` at once with no Sent row (`why`: switch_off | not_proven | question | notify_when_done | wants_reply:… |
greeting | unclear | not_a_task | private_routing | not_allowed), and the shell opens the visible thread as today.

### Private mode edges (issue 631, on for everyone)

On for everyone (the `wizard/private-routing` switch of issues 629 and 631 was approved and removed): nothing from a
private agent's work leaks through the box's edges (`server/private-edges.mjs`):

- **Pushes.** Every note the Service hands the notifications slot for a private agent (agent alerts, the day's
  collapsed alert, scheduled `deliver: notification` runs, phone chat-reply notes) goes out as
  `title: "Wizard: 1 new item"`, the fixed body `Open Wizard to read it.` (the Notifications `notify` tool refuses an
  empty message) and the shell's own https link (alerts: its `?inbox=alerts` view; a thread deep link is kept). An app
  door's ping for a private agent's alert has the same title, `ask: ""` and `content_free: true`. The words stay in the
  inbox record and show only inside Wizard. Standard agents' notes are unchanged. Nothing in the phone app changes: the
  words never leave the Service.
- **Daily follows the default agent.** With a private default agent a Daily channel is seeded once for it (an archive
  or delete sticks); the sweep card goes into that Daily's today thread; "signal sweep" typed in its threads posts the
  card and gives the turn the same run note as on main; a scheduled sweep job (prompt `signal sweep`) runs on the
  private agent in its Daily for each occurrence (the job keeps its own agent, so a standard default agent puts it back). Its Daily
  archived means no card (409 `daily_unavailable`), never the standard agent's Daily instead.
- **Open / Send to inbox** move the private default agent's threads too, through its own Hermes (a request that names
  no agent uses the thread's pin). `GET /wizard/v1/agent-inbox` adds `private_default: <agent id>` and lists its Daily
  days in `stay`. The owner's next turn in a thread he sent to the inbox lists it again.
- **Imported History.** With the read grant (`read_standard_chats`, DECISIONS 81) the private agent's `standard_chats`
  MCP server also lists `standard_history_search`: the standard agent's fact store (`memory_store.db` beside its
  state.db; imported History facts first) and Markdown under `Files/Imported` (the Importer's History chats, memories
  and skills), read-only, credential-redacted, rate-limited like the other three tools. No private store is opened.

No private agent (pushes), or no private default agent (the Daily and Open / Send parts): every route, push and tool
list is as on a box without private mode.
