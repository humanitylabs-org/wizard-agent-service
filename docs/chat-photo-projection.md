# Owner chat-photo projection (draft; activation blocked)

This branch contains tested projection/storage and bounded enumeration components.
It is **not a deployed or complete photo backfill**. It must not be activated until
an independently reviewed delivery-evidence adapter and the retry/durability gates
below are implemented. An environment flag alone cannot activate it: service
construction rejects a missing `authorizeEvidence` function before projection
folders are created.

## Storage contract v1

The trusted Agent Service producer writes exactly
`<owner media root>/.wizard/photo-provenance.json`:

```json
{"schema":1,"owner_label":"Owner","agent_labels":{"main":"Assistant"},"files":[{"path":"Photos/Chats/<sha256>.png","sha256":"<sha256>","sources":[{"role":"user","agent_id":"main","sender_label":"Owner","thread_id":"<canonical session>","message_id":"<canonical message>","sent_at":"<ISO-8601>"}]}]}
```

Files are immutable, content-addressed copies under `Photos/Chats`. SHA binds
provenance to bytes; identical bytes keep all distinct thread/message/role sources.
Replay of the same source does not duplicate attribution. Both sender filters must
match an image with both roles. Readers do not receive database, inbox, private
agent or arbitrary host filesystem access. The original messages and files are
never mutated. Unknown existing photos stay unknown. `.wizard` remains hidden
from every normal Files listing; read this one fixed metadata path using no-follow
and bounded validation. Readers must verify SHA/path and handle unavailable or
invalid metadata safely. Labels are configurable display metadata, not identity.

Writer limits: raster images only; 20 MiB per image, 900 MiB aggregate projection,
16 MiB metadata. The total storage cap is a stop condition, not permission to spill
onto another host or import other owner files. A deployment exceeding its host
storage budget requires its existing approved storage route, not a whole-library
migration. No filesystem sweep is performed.

## Enumeration and service integration

`read-chat-photos.py` opens the default history database read-only. Integer message
primary-key pages cover all retained rows through a fixed high-water mark, without
a recent-history window or giant text search. It fetches content only for candidate
human messages. Archived chats remain candidates; hidden/internal/delegated/private
profiles and unsupported sources are excluded. Owner Telegram DM metadata is
checked; ambiguous legacy Telegram sessions are excluded rather than guessed.
Wizard IDs and visible webui source are **candidate selection, not owner proof**.
No sealed database is opened.

Only recognized stored attachment envelopes, inbound image markers and assistant
rendered media syntax produce candidates; prose paths and fenced examples do not.
Candidates are **not yet authorized delivery records**. A canonical attachment
identity must be bound to owner, main agent, message and verified delivery before
publication. Telegram assistant MEDIA text without a send receipt is intent, not
proof of external delivery. An old path, upload completion or magic bytes alone is
never enough.

The candidate service integration kicks reconciliation on accepted queued runs,
completed queued runs and successful main-agent history responses. An explicitly
service-owned bounded timer covers other supported gateways and crash windows;
there is no Hermes cron. Lifecycle construction is disabled by default and stops
with the service. No private-agent route was modified. Config names:
`WIZARD_CHAT_PHOTOS_ENABLED`, `WIZARD_CHAT_PHOTOS_STATE_PATH`,
`WIZARD_CHAT_PHOTOS_OWNER_ID`, `WIZARD_CHAT_PHOTOS_OWNER_LABEL`,
`WIZARD_CHAT_PHOTOS_AGENT_LABEL`, `WIZARD_CHAT_PHOTOS_REPLAY_ROOTS`.
Do not set the flag on this draft: the production evidence adapter is not present.

## Activation gates from independent review

1. Implement authenticated owner/main-agent/delivery binding for each gateway.
   Visible-source and filename heuristics cannot replace this. Legacy replay must
   use the canonical replay allowlist/attachment resolver, not broaden filesystem
   roots. Neither root inbox enumeration nor upload-only indexing is allowed.
2. Retained Telegram assistant messages lack per-image send receipts in the
   inspected history. Do not publish those as delivered. The inspected delivery
   obligation table has no media-bearing receipts. Resolve trustworthy evidence
   if retained elsewhere; otherwise report them unavailable/ambiguous explicitly.
3. Implement an OS-released lock or rigorously checked lease, durable bounded retry
   queue with backoff and stable reason codes, directory fsync, and crash/concurrency
   tests. Current exclusive-file lock and advancing failed-candidate cursor are not
   sufficient for production reliability.
4. Bound/aggregate failure detail rather than an unbounded array. Validate every
   existing source object. Bind private state to immutable owner identity.
5. Complete canonical remote/inline replay support; current resolver deliberately
   rejects those instead of fetching through a new provider or custom URL client.
6. Add live accepted-send/delivered-image integration tests, a disabled-state
   no-effects test, then a fresh independent privacy review of the exact revision.
7. Reinspect the active release and merge concurrent changes. Use an idle-safe
   service release window; never blindly restart an active owner run.

Fixtures exercise storage/dedupe/source roles, corrupt metadata, symlinks, byte
mismatch, private denial, limits and scanner grammar/eligibility. They are not
actual-history delivery proof. Build/tests run on the designated development host.
Run `node --test tests/chat-photo-projection.node.mjs` and
`python3 tests/test_chat_photo_reader.py`, followed by the service test suite.
