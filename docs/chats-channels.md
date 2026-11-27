# Chats channels: the Agent Service channel store (phase 2 of 3)

On for everyone (wizard-ux issue 1258). A box can still turn a part off with its env setting `0`
(`WIZARD_CHANNEL_STORE=0` and the others below); with the store off, nothing here exists: the routes answer 404, no
`channels.sqlite` is created, and `spaces` stays in `ui-preferences.json` exactly as before. Issue:
humanitylabs-org/wizard-agent-service#440 (phase 1, the shell view: humanitylabs-org/wizard-ux#1254; phase 3, agent
filing: issue 441).

## No switch (wizard-ux issues 1358 and 1258)

Every Channels part here (the store, channel posts, agent filing, read marks, Daily) used to follow the owner's
`wizard/chat-channels` switch in the Look file. Since wizard-ux issue 1258 that switch is gone and every part is on;
an old value for it in `Pages/wizard-look/look.json` is ignored. The `WIZARD_CHANNEL_*` env settings below still win
when a box sets them: `0` forces that part off.

## Store

`~/.wizard-os/channels.sqlite` (next to `ui-preferences.json`, mode 0600), owned by the Agent Service.

- `channels(id, agent, name, ord, created_at, archived, pinned, kind)`. `archived` is the ISO time it was
  archived (or null), `pinned` is the pin rank (or null), `kind` is `alerts` for the seeded Alerts channel.
- `membership(agent, session_id, channel_id, filed_at, filed_by)` with `PRIMARY KEY(agent, session_id)`:
  a thread is in at most one channel of its agent. The key includes the agent because routed agents'
  thread ids are only unique within that agent. `filed_by` is `owner`, `agent` or `migration`.
- `meta`: the migration marker, the Alerts marker and the shared sort (`az` or `za`).

Limits: 200 channels per agent; memberships are not capped (the old file held about 790).

## First boot

1. Copy `spaces` from `ui-preferences.json` once (ids, names, agents, order and creation times kept). A
   legacy thread listed in two Spaces of one agent stays in the first. Marked done in `meta`, so it never
   runs twice and later file edits are not copied again.
2. Seed one **Alerts** channel for the main agent, pinned at the top. It is renamable and archivable like any
   other channel and never re-created once seeded (an owner's archive or delete sticks).
3. Drop main-agent memberships whose thread is no longer in Hermes' `state.db` (kept when it can't be read).
   Deleting a thread through the Service (main or routed) also removes its membership.

`ui-preferences.json` is never rewritten, so a box that sets `WIZARD_CHANNEL_STORE=0` shows the Spaces as they were before.

To check the migration against a real file, run it on a **copy** (it prints counts only):

    node scripts/channels-migrate-check.mjs /path/to/copy-of-ui-preferences.json

## API

Same owner surface as ui-preferences: verified access, no cross-site writes, JSON bodies, unknown keys 400.

- `GET /wizard/v1/channels[?agent=<id>]` → `{schema:'wizard.channels/1', sort, migratedAt, channels:[{id, agent,
  name, order, createdAt, archived, archivedAt?, pinned, pinOrder?, kind?, count}]}`
- `POST /wizard/v1/channels {name, agent?}` → 201 with the channel.
- `PATCH /wizard/v1/channels` with exactly one of:
  - `{id, name?, archived?, pinned?}`: rename, archive or restore, pin (appends to the pin order) or unpin;
  - `{order:[ids]}`: these channels first, in this order (one agent);
  - `{pinOrder:[ids]}`: these pins first, in this order;
  - `{sort:'az'|'za'}`: the shared channel sort.
- `PUT /wizard/v1/channels/membership {sessionId, channelId|null, agent?}`: the atomic move. Into a channel
  drops the thread from that agent's other channel; `null` unfiles. A named `agent` that isn't the channel's is 409.
- `GET /wizard/v1/channels/membership?sessionId=<id>[&agent=<id>]` or `?channel=<id>`.

Issue 447 (shared sort, pins and archive) is covered by `sort`, `pinned`/`pinOrder` and `archived` here.

## Older shells

`GET /wizard/v1/ui-preferences` serves `spaces` as a projection of the store: open channels only, at most 50,
each with its newest-filed 500 threads. A PUT's `spaces` is ignored (other keys are saved), so a stale full
snapshot can't erase memberships. PATCH item operations on `spaces` (the phase 1 shell's `LIVE.prefOps`) are
applied to the store. The Spaces tools (`spaces_*`) and the status line's `space` field use the store too.

## Chats list

See `docs/chats-list-protocol.md`: rows gain `channel` and `firstRequest`, and `view=list&channel=<id>` is the
channel feed. With channel posts (issue 446, on; `WIZARD_CHANNEL_FIRST_POSTS=0` turns them off) every row of an owner-started thread
also carries the post itself: `firstRequest` from the whole first owner message and `firstAttachments`, its photos.

## Agent filing and Alerts (phase 3)

On for everyone wherever the channel store is (the switch was removed after show-and-tell; with
`WIZARD_CHANNEL_STORE=0` none of this exists). Issue:
humanitylabs-org/wizard-agent-service#441.

- **Status line `channel`.** `WIZARD_STATUS_V1` takes an optional `channel`: one exact channel id from the agent's
  catalogue. `space` is still read as an alias for one release (`channel` wins when both are given).
- **Run note.** Every run gets the channel rules and the agent's open channels (id and name). Alerts is never offered,
  and neither is another agent's channel. In channels mode `title` is the post's short name (what this chat is
  about), not the project label.
- **Refusals.** The service files only a chat that is in none of the agent's channels (`filed_by=agent`) and never
  moves one the owner filed. A status naming Alerts, an archived, missing or other agent's channel files nothing, and
  so does any status inside a chat the scheduler opened.
- **Chats the scheduler opens** (a reminder, report or message with no thread of its own, `wizard_start_thread`, a new
  Supervisor chat): the occurrence that first opens the chat files it into the job's `channel` when that is an open
  channel of the job's agent, otherwise into the main agent's Alerts channel. A routed agent's job with no channel stays
  unfiled. A job that posts into an existing thread never files or moves it, and later occurrences never re-file the
  chat, so an owner's move or unfile stands. A notification-delivery job's hidden thread is not filed.
- **Per-job channel.** `POST/PATCH /wizard/v1/schedules` accept `channel` (a channel id or `null`) while the channel
  store is on; with the store off (`WIZARD_CHANNEL_STORE=0`) the field is an unknown-field 400.

- **Agent posts.** With channel posts on as well, a thread whose first message is the agent's (an
  alert) carries no `firstRequest` even after the owner replies, so the shell keeps showing the agent's post.

Not changed here: a recurring job keeps its one chat (each run is a reply in it), as before.

## Read position (issue 471)

On, with the channel store; `WIZARD_CHANNEL_READ_SYNC=0` (option `channelReadSync`) turns it off, and the route is then a 404 and the shell keeps its read position on
each device only (wizard-ux issue 1316). Issue: humanitylabs-org/wizard-agent-service#471.

- **What it holds.** One read watermark per shell key, in `channels.sqlite` table `read_marks`: the newest activity
  time (ms since the epoch) the owner has scrolled past in that feed. Keys are the shell's own: `general` (All
  General), `general|<agent>` (General focused on one agent) and `<agent>|<channel id>` (`hermes` = main).
- **`GET /wizard/v1/channels/read`** returns `{ schema: 'wizard.channel-reads/1', at: { <key>: <ms> } }`, the
  newest 1000 marks.
- **`PUT /wizard/v1/channels/read`** with `{ at: { <key>: <ms> } }` (1 to 300 keys) moves each mark forward only: an
  older or equal mark is ignored, so a device that read less never un-reads a channel. A mark later than the box's
  clock plus one minute is kept as that, so a device clock running ahead cannot mark future posts read. It answers
  with the same shape as GET. Beyond 1000 marks the oldest are dropped. An invalid key or value, or any other body
  field, is a 400.
- Same owner surface, access check, cross-site rule and `no-store` as the other channel routes. The shell writes at
  most once per two seconds and reads it with the channel list (every 30 seconds and when a window comes back).

## Daily channel (issue 527)

On, like the parts above; `WIZARD_CHANNEL_DAILY=0` turns it off (option `channelDaily`). Off: the routes below answer 404, nothing is seeded and `thread: 'daily'` is just a
thread id, as before. Issue: humanitylabs-org/wizard-agent-service#527 (shell half: humanitylabs-org/wizard-ux#1469).

One pinned channel per agent that holds **one real thread per day**, so the shell can show it as one continuous chat
while each day stays its own Hermes session (a never-ending session re-sends its whole history every turn and gets
compressed). No Hermes change.

- **`kind: 'daily'`.** One Daily channel is seeded for the main agent once, pinned at rank 0 above Alerts. It can be
  renamed or archived like Alerts and is never re-created after the owner archives or deletes it (meta
  `daily_seeded`). Channel rows of this kind carry `dayStartsAt: "05:00"`. `PATCH /wizard/v1/channels {id,
  kind:'daily'|null}` turns a channel into its agent's daily channel (an earlier one becomes a plain channel, its day
  threads kept) or back; Alerts can't be turned into Daily (409 `alerts_channel`).
- **Day boundary.** 05:00 in the owner's time zone (Settings clock, as the scheduler uses): a post at 04:59 belongs to
  yesterday's thread, one at 05:00 starts today's.
- **`GET /wizard/v1/channels/<id>/today`** → `{channel, agent, day, sessionId|null}`; null until something is posted
  after today's boundary.
- **`POST /wizard/v1/channels/<id>/today`** (JSON, empty body) creates today's thread lazily and answers `{channel,
  agent, day, sessionId, created}` (201 when this call created it, else 200). Racing first posts get the same thread
  (`daily_days` row per channel and day, one transaction). The thread is a real session of the channel's agent, titled
  `<channel name> · <Sun 15 Nov>`, filed into Daily (`filed_by=agent`). The shell calls it before its first send of
  the day and then sends into `sessionId` as usual. An archived Daily is 409.
- **`GET /wizard/v1/channels/<id>/days[?cursor=<YYYY-MM-DD>&limit=<1-60>]`** → `{channel, agent, dayStartsAt, today,
  days: [{day, sessionId, title, opener, count, lastAt}], next}`, newest first (14 per page). `next` is the cursor of
  the next page (older days) or null. `opener` is the day's first shown message (normally the day's Signal post; the
  scheduler's own brief is skipped) cut to 200 characters; `count` is the thread's message count.
- **Scheduler.** `POST/PATCH /wizard/v1/schedules` accept `thread: 'daily'`: each run posts into today's Daily thread
  of the job's agent (creating it if needed), so a morning brief becomes the day's first message. A reminder
  (`kind: remind`) with no origin thread, and a job whose own chat would be filed into the daily channel (`channel:
  <daily id>`), go to today's Daily thread instead of Alerts. With no open daily channel a `thread: 'daily'` job gets
  its own chat, as a job with no thread does. A watcher or a return can't name `daily`.
- **Carry-over run note.** A run in a Daily thread is told the day, the previous day's thread id and that thread's
  still-open tracker items (`needs_you` or `running`), so the agent continues yesterday's plan and can look it up.

Store: table `daily_days(channel_id, day, agent, session_id, created_at)` in `channels.sqlite`; deleting a day thread
through the Service drops its row, deleting the channel drops all of them.

## Tags (issue 608)

Channels become tags: a chat can carry several of its agent's channels. On for everyone wherever the channel store is
(James's yes, 27 Nov 2026; the switch `wizard/chat-tags`, its env `WIZARD_CHANNEL_TAGS` and option `channelTags` are
gone). Without a channel store `/wizard/v1/channels/tags` is a 404, like every channel route.

- **Store.** Table `tags(agent, session_id, channel_id, tagged_at, tagged_by)` plus `tag_removed(agent, session_id,
  channel_id, at)` in `channels.sqlite`. The first time the store is used, every membership is copied in once (meta
  `tags_migrated`): each chat's channel becomes its first tag. `membership` keeps the **primary tag** (the first one,
  then the oldest left), so Daily day threads, agent filing and older shells (which read one channel per chat) keep
  working. Once migrated, every one-channel write (move, agent filing, a
  Daily claim, a Spaces migration, unfile, delete) mirrors into `tags`.
- **API.** `GET /wizard/v1/channels/tags?sessionId=&agent=` → `{sessionId, agent, channel, tags}` (primary first);
  `?channel=<id>` → `{channel, members}`. `PUT {sessionId, agent?, add: <channel id>}` or `{…, remove: <channel id>}`
  (exactly one; only the chat's own agent's channels, else 409). Removing the primary promotes the oldest other tag;
  removing the last leaves the chat in General. An owner's removal is remembered. `GET /wizard/v1/channels` says
  `tags: true` and counts tagged chats.
- **Chats list and feeds.** `view=list` rows carry `tags` (primary = `channel` first) on every agent kind; a tag's
  feed (`view=list&channel=<id>`) lists every chat carrying it.
- **Agent filing.** The status line's `channel` adds a tag (the run note says so), never one the owner removed from
  that chat, never on a chat the owner took out of every channel, never an archived channel.
- **Said tags.** Tags in a capture (`#philosopher`, "hashtag philosopher", on its Sent row) go on the thread the take
  ran in, for tags that already exist (same letters and digits as the channel name, so "🧠 Philosopher" is
  `#philosopher`). A word that names no tag makes none.

## Automatic tags (issue 702)

Off by default: the owner's `wizard/auto-tags` switch in the Look file (option `autoTags`, env `WIZARD_AUTO_TAGS`: `1`
on, `0` off, unset follows the switch). Needs the channel store. Off, nothing below runs: no covers route, no tag note,
the status-line `channel` works exactly as in phase 3 and Tags. Code: `server/auto-tags.mjs`.

- **Covers.** Each channel has a list of plain words or phrases (`clips`, `Clips Pipeline`, `fact check`) and kind
  entries (`kind: question | lookup | evaluation | digest | report | reminder | todo`) in `channels.sqlite`
  `channel_covers`. The first time auto tags see a channel it is seeded once: its name's own words and its learned
  subjects, or, for a channel named Reports, the kinds question/lookup/evaluation/digest/report, and for Reminders
  reminder/todo. `GET /wizard/v1/channels/covers?id=` -> `{id, covers, learned, not}`; `PUT {id, add: phrase}` or
  `{id, remove: phrase}` changes one entry (what the shell sends, so two devices never erase each other's edit);
  `PUT {id, covers: [...]}` replaces the owner's list (at most 40 entries of 60 characters; what was learned stays). The channel list says
  `autoTags: true`, so the shell offers What goes here… on a channel's sheet.
- **Tagging.** On every status line and list row the chat's title, subject, app id and first owner message are matched
  against every channel of its agent (never Alerts or Daily): a listed phrase anywhere, the chat's kind, a learned
  subject, a learned title or a parent chat's tags decide; the status line's `channel` and new `channels: [...]` are
  hints, taken when the old subject rule (issue 520) agrees. Chat kind comes from the first owner message and the
  source (a scheduled or cron chat is a digest, "remind me" a reminder); a build, bug, app-work or draft chat is never
  a Reports kind. Only a chat whose evidence is weak (a learned phrase inside a longer title) goes to the owner's
  PRIVATE fast router (the Alert rules rule), at most 30 calls an hour, and only an answer at least 0.85 sure is taken.
  A decision is memoised per chat and covers version, and tag writes found during a list build go in one transaction
  on the next turn, so a list rebuild costs what it did (issue 584).
- **No silent refusals.** Every refusal or skip is a `[auto-tags]` log line with its reason, and the agent's next run
  note in that chat says it once ("Reports refused: subject Content").
- **The owner decides.** A removed tag is never put back (`tag_removed`). The owner's tag add teaches the channel the
  chat's subject and title; a removal teaches the opposite (a negative entry): a chat like that one is no longer tagged
  there unless the owner's own list names it in the title.
- **Agent route.** `PATCH /wizard/hermes/api/sessions/<id>` (and a routed agent's own path) with `{"tags": [ids or
  names]}` adds those tags: 200 with `{tags, added, refused}`, 409 when every one was refused (a removed tag says
  `the owner removed this tag`). Other fields in the same PATCH still go to Hermes.
- **Passes.** Every 10 minutes the Service checks whether today's pass ran: the first time it is on, a one-time
  backfill over the main agent's chats of the last 30 days; after that, once a day, the chats of the last 7 days that
  carry no tag. Chats still untagged are listed once in the main agent's next run note for its sweep.
  `GET /wizard/v1/channels/auto-tags` shows the passes and that list; `POST` runs the pass now.
