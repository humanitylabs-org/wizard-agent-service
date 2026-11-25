# Capture inbox

Issue humanitylabs-org/wizard-os#696 (Files drop folder, then Photos), contract `spec/CAPTURE_INBOXES.md` in wizard-os. Owner switch `wizard/capture-inbox` in the
synced Look file, off by default; `WIZARD_CAPTURE_INBOX=1` / `0` forces it on or off. With the switch off nothing is
scanned, moved or written, the agent has no `wizard_capture` tool and the routes below answer 404.

The owner drops things in `Inbox/` of his Files (Files uploads, the phone's share menu, a synced laptop folder). The
Service watches that folder itself, because the Files app mounts the owner's files read-only and the Service already
owns the writes into `Inbox/<date>/`. Code: `server/capture-inbox.mjs`, wired in `server/service.mjs`.

## How a batch moves

- **Watch:** every 30 s while the switch is on, the Service lists `Inbox/` (regular visible files, no symlinks, six
  folders deep). The first look after the switch goes on is a **baseline**: what is already there is never touched.
  Chat attachments (the media-files index) belong to their chat and are never batched.
- **Quiet period:** new files wait until nothing new arrived and nothing grew for `WIZARD_CAPTURE_QUIET_MS`
  (default 2 minutes), so a batch of photos or a synced folder is handled as one. At most 50 items per batch; the rest
  form the next batch at once.
- **One record, one worker:** a batch is one agent-inbox record (`source: capture:files`, `privacy_class: private`,
  `capture: { batch, source, count }`, `worker: true`) and one hidden main-agent worker turn, started exactly like the
  orb dump (same run admission, key `wizard-inbox-<record id>`). A worker that could not start is tried again every
  5 minutes. The turn lists every item where the agent sees it (`/media/Inbox/...`) and the owner's rules.
- **Rules:** one plain Markdown file in Files, `Capture rules.md`, written with the default set the first time a batch
  needs it. The owner (or the agent, when asked) changes it in plain words; the agent reads it for every batch.
- **Filing:** the agent uses only the `wizard_capture` tool (below). Each step is one log line in the batch (what the
  item was judged to be, the rule, where it went).
- **Outcome:** `wizard_capture action done` gives the batch's one-line outcome. It becomes the record's title (what the
  sweep card shows for a Done item) and its last update, also after the worker's status line.
- **Questions:** an item the agent is unsure about stays in Inbox (`keep`), and the worker ends with a `needs_you`
  status: one question in the sweep, as for every other background task.
- **Undo:** `wizard_capture action undo` (the owner says "undo that") or `POST /wizard/v1/capture/<batch>/undo` puts
  the whole batch back, newest step first: every filed item to where it arrived, every note without the text the batch
  added. A file is moved back only when its original place is free and it is still where it was filed; anything else is
  reported, never overwritten. Put-back items are left alone by the watcher. The record's last update says "Undone".

State: `capture-inbox.json` next to the agent inbox store (the option `captureInboxStatePath` overrides it in tests).

## The `wizard_capture` tool

Main agent only, only while the switch is on. One tool, `action`:

| action | does |
|---|---|
| `list` | a batch (or the newest batches): every item, its state (waiting, filed, kept) and where it is now |
| `listen` | transcribe an audio or video item of a batch with the box's Voice Service (a voice note = the owner's instructions for that batch) |
| `file` | move one item into a folder of the owner's Files (`folder`, optional `name`, `judged_as`, `rule`); never into Inbox, never over another file (`name (2).ext`) |
| `copy` | add a copy of a file in the owner's Files (`from`, e.g. the `files_path` Photos gives) to a folder; the original stays where it is |
| `keep` | leave an item where it is, with `reason` |
| `note` | append `text` to a `.md` note in Files (`path`), e.g. book-page highlights under the book's title |
| `done` | the batch's one-line `outcome` |
| `undo` | put a whole batch back (newest batch when none is named) |
| `rules` | read the owner's rules, or replace them with `text` |

## App inboxes (Photos)

An app whose items stay in the app (Photos: the camera-roll backup in Immich) is an inbox too, with the same switch:

- **Probe:** `GET /wizard/v1/capture/events` with the app's own app token (`<wizard-os home>/app-tokens/<app id>`,
  handed over by the App Manager as `<NAME>_AGENT_INBOX_TOKEN`). `404` = the switch is off: the app does nothing.
  `200 {on, contract: "wizard.capture-inbox/1", app, batches}` lists the app's own batches (`batch`, `app_batch`,
  `state`, `undone_at`), so the app reverts its own part of an undone batch.
- **Event:** `POST /wizard/v1/capture/events` `{"event": "items_arrived", "data": {"source": "<app id>", "batch":
  "<app's batch id>", "count": N}}` (no content; the app does its own baseline and quiet period). `202` made the batch,
  its record (`source: capture:<app id>`, private) and the hidden worker turn; the same app batch again answers `200`
  with the same batch, never a second worker. The turn tells the agent to read the items with the app's tools
  (Photos: `photos_capture_batch`, `photos_capture_file`).
- **Filing:** the items never leave the app. The agent adds copies to Files with `wizard_capture action copy` and notes
  with `action note` (item = the app's id), both logged here; tags, albums and processed marks are logged by the app.
- **Undo:** the same `undo` takes the copies and notes away (a copy only while it is unchanged) and marks the batch
  undone; the app reads that from its probe and takes away its own tags, albums and processed marks.

## Routes (owner only)

- `GET /wizard/v1/capture` -> `{ on, active, pending, rules, batches }` (newest first, with each batch's items and log)
- `POST /wizard/v1/capture/<batch>/undo` -> `{ batch, restored, problems, items_back_in_inbox, of }`
