# Chats channels: the Agent Service channel store (phase 2 of 3)

Switch: `WIZARD_CHANNEL_STORE=1` (Agent Service env, option `channelStore`). Off by default. With it off,
nothing here exists: the routes answer 404, no `channels.sqlite` is created, and `spaces` stays in
`ui-preferences.json` exactly as before. Issue: humanitylabs-org/wizard-agent-service#440 (phase 1, the
shell view: humanitylabs-org/wizard-ux#1254; phase 3, agent filing: issue 441).

## Store

`~/.wizard-os/channels.sqlite` (next to `ui-preferences.json`, mode 0600), owned by the Agent Service.

- `channels(id, agent, name, ord, created_at, archived, pinned, kind)`. `archived` is the ISO time it was
  archived (or null), `pinned` is the pin rank (or null), `kind` is `alerts` for the seeded Alerts channel.
- `membership(agent, session_id, channel_id, filed_at, filed_by)` with `PRIMARY KEY(agent, session_id)`:
  a thread is in at most one channel of its agent. The key includes the agent because routed agents'
  thread ids are only unique within that agent. `filed_by` is `owner`, `agent` or `migration`.
- `meta`: the migration marker, the Alerts marker and the shared sort (`az` or `za`).

Limits: 200 channels per agent; memberships are not capped (the old file held about 790).

## First boot with the switch on

1. Copy `spaces` from `ui-preferences.json` once (ids, names, agents, order and creation times kept). A
   legacy thread listed in two Spaces of one agent stays in the first. Marked done in `meta`, so it never
   runs twice and later file edits are not copied again.
2. Seed one **Alerts** channel for the main agent, pinned at the top. It is renamable and archivable like any
   other channel and never re-created once seeded (an owner's archive or delete sticks).
3. Drop main-agent memberships whose thread is no longer in Hermes' `state.db` (kept when it can't be read).
   Deleting a thread through the Service (main or routed) also removes its membership.

`ui-preferences.json` is never rewritten, so turning the switch off shows the Spaces as they were before.

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
channel feed.
