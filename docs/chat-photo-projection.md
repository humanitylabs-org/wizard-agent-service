# Owner chat-photo projection

Default off. The Agent Service owns accepted-message, completed-run and delivered-history hooks and a bounded in-service crash-repair interval. There is no Hermes cron and no change to original messages or attachment bytes.

## Authority and delivery

Activation requires an explicit single-owner main-runtime binding. The seal includes the configured immutable owner ID, actual history DB, actual session-agent registry directory, upstream origin and hash of the existing runtime credential. A bounded authenticated session request must match an eligible ID in that DB before any projection or cursor write. The seal is immutable in both checkpoint and manifest; changing owner/runtime/registry fails closed rather than relabeling existing photos.

The canonical registry is checked before reading message content: a non-main pin never routes into its store. Session metadata rejects hidden, parented/delegated, non-default profile and synthetic/helper/cron/private provenance. Title checks are additional defense only. Archived human conversations remain eligible. Owner Telegram DM IDs must match. Missing owner fields on older Wizard conversations are covered by the explicit single-owner runtime binding, not fabricated per-row metadata.

Integer-ID pages enumerate eligible retained human history, with no recent cutoff. Candidate syntax is not delivery authority: each candidate is reread, role/timestamp/finality verified, and passed through the same visible-history projection and image resolver used by Wizard. Resolved owner-visible Wizard history is delivery on Wizard, not a claim about an external Telegram send or a phone read receipt. Mere unresolved MEDIA intentions remain unavailable.

Supported resolution: durable Wizard file identities through the shared canonical file resolver, main local image references through the shared history image registrar, canonical Helm attachment IDs and inline image data through the existing magic/size validator. Arbitrary remote URLs are not fetched. A retired Helm server can use an explicitly configured retained attachment root: the old AttachmentStore.resolve contract is fixed ID plus png/jpg/webp suffixes, no directory scan or envelope-supplied path. The same resolver serves GET `/wizard/attachments/:id`.

## Storage and durability

The manifest remains schema 1 at `<owner media root>/.wizard/photo-provenance.json`, adding producer-only `owner_id` and `authority_id`. Existing Files readers use the unchanged `owner_label`, `agent_labels.main`, and `files[{path,sha256,sources}]` contract. Every source has role, main agent, sender label, thread/message identity and ISO timestamp. Content dedupe retains all sources, including both sender roles. Unknown unrelated photos are untouched.

Projection metadata and Chats directories are owner-only; image bytes are owner-readable. Existing broad permissions or unexpected owners fail closed. No recursive permission change to unrelated media is performed. Source/target symlinks and private-store paths are denied. Image and manifest writes fsync bytes, atomic replacement and parent directories. A Python flock helper releases locks on parent pipe EOF, including SIGKILL. Manifest publication precedes cursor commit and is idempotent; resolution totals are recomputed from the manifest's source inventory after replay.

Transient errors remain in a durable bounded queue with capped hourly backoff, including beyond six attempts. Backpressure stops scanning rather than discarding retries. Definitive unavailable reasons have aggregate counts and at most 50 examples. Cursor and retry queue commit together. Corrupt binding/manifest, permissions or storage placement errors stop the batch without advancing the cursor.

Survey aggregate and largest-file bytes before materializing. Set an explicit deployment storage budget; exceeding it is a reported placement gate, never silent truncation. Use the existing approved shared storage framework when required, not symlink bypasses or relocation of the entire owner root. Canonical local images retain the history route's size validation; larger/unresolved candidates are counted unavailable.

## Configuration and operation

Required opt-ins: `WIZARD_CHAT_PHOTOS_ENABLED=1`, `WIZARD_CHAT_PHOTOS_SINGLE_OWNER=1`, `WIZARD_CHAT_PHOTOS_OWNER_ID`, `WIZARD_CHAT_PHOTOS_OWNER_LABEL`, `WIZARD_CHAT_PHOTOS_AGENT_LABEL`, `WIZARD_CHAT_PHOTOS_STATE_PATH`, `WIZARD_CHAT_PHOTOS_MAX_BYTES`. Existing `WIZARD_HERMES_STATE_PATH`, main runtime credentials, agent registry and `WIZARD_USER_FILES_ROOT` supply the actual deployment. Optional `WIZARD_HELM_ATTACHMENTS_ROOT` must be the existing main Helm delivery store.

`scripts/chat-photo-backfill.mjs --survey <saved enumeration dir> <receipt>` revalidates retained candidate evidence without writing owner media. `--backfill` performs bounded resumable reconciliation only with explicit activation. The live producer continues from that same checkpoint. Checkpoint `event_counts` distinguishes startup/repair, accepted user, completed assistant and delivered history triggers. The owner manifest—not attempt counters—is the source of unique file and sender totals.

Run `npm test` on the designated development host. Focused node tests cover both sender dedupe, immutable owner/registry, wrong agent/owner, actual runtime authentication, private/fenced denial, legacy/inline resolution, process-crash lock release, durable retry, publication-before-cursor replay and permissions. Fixtures are separate from actual owner-history/live-release evidence. A fresh independent review of full integration and deployment binding is required before activation. Preserve concurrent main/live changes and use an idle-safe service release; never restart active owner work blindly.
