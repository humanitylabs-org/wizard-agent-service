# Box-wide shell preferences

The Agent Service owns `GET /wizard/v1/ui-preferences` and `PUT /wizard/v1/ui-preferences`.
Both require the same verified owner access as bootstrap. Agent/MCP tokens alone do not
bypass that check. The API serves no secrets and sends `Cache-Control: no-store`.

The response is a flat JSON object:

```json
{"archiveAfterDays":7,"compact":false,"readyOrder":"newest","subjectOrder":[],"pinnedChats":[],"spaces":[]}
```

PUT accepts a **partial** object and merges only the specified fields. Unknown fields,
arrays at the root, wrong types and invalid values are rejected (400). Send
`Content-Type: application/json`; cross-site browser writes are rejected.

- `archiveAfterDays`: 0 (Never), 1, 3, 7, 14 or 30. Default: 7.
- `compact`: boolean. Default: false.
- `readyOrder`: `newest`, `oldest`, `priority` or `subject`. Default: `newest`.
- `subjectOrder`: at most 60 unique strings, each at most 120 characters without control
  characters. Default: empty (natural order).

- `pinnedChats`: at most 300 unique canonical thread ids (`[A-Za-z0-9._:-]{1,180}`). Default: empty.
- `spaces`: at most 50 owner-created `{id,name,threads,createdAt}` records, unique by id.
  `id`: `[a-z0-9-]{1,48}`; `name`: 1–60 characters, nonblank and without controls;
  `threads`: at most 500 unique canonical thread ids (same regex as pins); `createdAt`: ISO timestamp.
  Default: empty. Extra record fields are rejected. Deleted/unknown member ids are harmless in Chats.
  Whole-array replacement: serialize edits to Spaces; there is no same-array compare-and-swap.
  Wizard UX ships `skills/wizard-spaces` with an owner HTTP read/merge/write/readback helper and
  the requested-collection/back-fill skill; this is not an MCP-token authorization bypass.

The service saves `ui-preferences.json` under its Wizard OS home, using a restricted
mode and atomic rename. It never rewrites operator-owned `settings.json`, app config,
Hermes configuration or user data. Writes within one service process merge
synchronously so simultaneous partial updates do not lose other fields.

PUT is strict; reads are lenient. The stored file may come from a newer or older
service or shell (rollback, two shells on one box), so GET never fails on its content:

- Unknown stored keys are left out of the response. A PUT from this version keeps them
  on disk, so rolling forward again does not lose them.
- A known key with an invalid stored value falls back to its default; other keys are
  unaffected.
- A file that is unparseable, not a JSON object, or over 5 MiB is served as defaults
  and left untouched on disk until the next valid PUT replaces it.

GET and PUT responses only ever contain the validated known keys. 503 means the file could
not be written (for example, a read-only volume), not that the stored content is bad.

Front ends may use browser storage as an offline cache, but this endpoint is the
cross-device source of truth. Poll or refresh on focus; do not overwrite a user's
newer local change with an older in-flight GET. An older Agent Service without the
endpoint leaves the device cache intact and should visibly report local-only saves.

No box-specific proxy, shim route, host path, or production deployment is required by
this contract. This is a proposed API until the companion Agent Service PR is merged
and installed. The UX consumer must not claim cross-device persistence on an older
service. Existing private shim values are not automatically imported: importing them
would be an explicit owner-approved data migration, not part of a source PR.
