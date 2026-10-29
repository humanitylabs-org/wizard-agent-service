# Box-wide shell preferences

The Agent Service owns `GET /wizard/v1/ui-preferences` and `PUT /wizard/v1/ui-preferences`.
Both require the same verified owner access as bootstrap. Agent/MCP tokens alone do not
bypass that check. The API serves no secrets and sends `Cache-Control: no-store`.

The response is a flat JSON object:

```json
{"archiveAfterDays":7,"compact":false,"chatLayout":"day","readyOrder":"newest","subjectOrder":[],"pinnedChats":[],"spaces":[]}
```

PUT accepts a **partial** object and merges only the specified fields. Unknown fields,
arrays at the root, wrong types and invalid values are rejected (400). Send
`Content-Type: application/json`; cross-site browser writes are rejected.

- `archiveAfterDays`: 0 (Never), 1, 3, 7, 14 or 30. Default: 7.
- `compact`: boolean. Default: false.
- `chatLayout`: `day` (Ready, Yesterday, Past week) or `status` (Working, Ready, Archive). Default: `day`.
- `readyOrder`: `newest`, `oldest`, `priority` or `subject`. Default: `newest`.
- `subjectOrder`: at most 60 unique strings, each at most 120 characters without control
  characters. Default: empty (natural order).

- `pinnedChats`: at most 300 unique canonical thread ids (`[A-Za-z0-9._:-]{1,180}`). Default: empty.
- `spaces`: at most 50 owner-created `{id,name,threads,createdAt}` records, unique by id.
  `id`: `[a-z0-9-]{1,48}`; `name`: 1–60 characters, nonblank and without controls;
  `threads`: at most 500 unique canonical thread ids (same regex as pins); `createdAt`: ISO timestamp.
  Default: empty. Extra record fields are rejected. Deleted/unknown member ids are harmless in Chats.
  PUT replaces the whole array; shells and tools edit Spaces with PATCH operations (below).
  Wizard UX ships `skills/wizard-spaces` with an owner HTTP read/merge/write/readback helper and
  the requested-collection/back-fill skill; this is not an MCP-token authorization bypass.

## Item operations (PATCH)

`PUT` replaces a whole list, so a device that has not pulled yet would erase another device's or an
agent's change (last writer wins per key). `PATCH /wizard/v1/ui-preferences` with `{"ops":[…]}` (1–100
operations) changes single items instead. The service applies them to the stored lists inside the same
synchronous read/merge/atomic rename as PUT and answers with the full preferences, like PUT:

- `{"op":"add"|"remove","key":"pinnedChats"|"subjectOrder","item":"<string>"}`: add appends when absent.
- `{"op":"front","key":"subjectOrder","items":[…]}`: these first, in this order; every other stored
  subject keeps its relative order after them (at most 60 kept).
- `{"op":"add","key":"spaces","item":{id,name,threads,createdAt,agent?}}`: no-op when that id exists.
- `{"op":"remove","key":"spaces","item":"<space id>"}`.
- `{"op":"add"|"remove","key":"spaces/<id>/threads","item":"<thread id>"}` and
  `{"op":"set","key":"spaces/<id>/name","item":"<name>"}`: no-op when the Space no longer exists.

Every operation is idempotent, so a client may resend a batch whose response it never saw. Malformed
operations, or a result that breaks a key's limits, are a 400 and write nothing. Access, JSON and
same-site rules are those of PUT. Older services answer PATCH with 405; clients then fall back to
reading fresh, replaying their operations, PUT, and reading back.

## Launcher preferences and atomic migration

`launcher` is optional (absent remains absent in GET, preserving the old response defaults).
PUT replaces the launcher object, just as it replaces a spaces array. It accepts only:

- `nativeLinks`: up to 50 unique `{id,name,icon,href,colors?,phoneOnly?,desc?}` records.
  App ids match `[a-z0-9][a-z0-9-]{0,63}`; names 1–80 chars, icons 1–160,
  descriptions 1–240, hrefs 1–2048, all nonblank without control characters.
  Hrefs accept HTTP(S), `tel:`, `sms:` and Android `intent:…#Intent;…;end` only.
  Colors are one or two hex colors; phoneOnly is boolean. Unknown record fields fail.
- `recents`, `desktopQuick`, `autoOpen`, `hostedThreadApps`: up to 100 unique app ids each.
  These are owner choices, not claims of installed apps; shells intersect with the current registry.
- `displayNames`: up to 100 app-id → nonblank, control-free names (80 chars max).

`migrations` is an optional map of up to 100 marker → UTC ISO timestamp entries.
Markers match `[a-z0-9][a-z0-9._-]{0,79}`; timestamps must name real calendar dates.
The existing 5 MiB request/file limit still applies; no app data or settings schema is changed.

`POST /wizard/v1/ui-preferences/seed` accepts exactly `{marker,launcher}`. It explicitly
requires an owner principal (including the configured gateway owner proof); access verification,
JSON Content-Type, cross-site refusal and byte bounds apply as on PUT. Existing GET/PUT
access behavior is unchanged. A missing marker
fills **only absent launcher keys**, preserving existing owner choices (including empty
arrays), existing fields and unknown future stored fields. The server timestamps the
marker and commits both marker and data with one restricted-mode atomic rename.
Response: `{seeded:true,preferences:{…}}`. If the marker exists, it returns
`{seeded:false,preferences:{…}}` without touching the file or its mtime. Invalid payloads
are 400 even on this no-op path. Corrupt existing launcher/migration/file data returns
503 without replacing it; a missing file can be seeded. A full marker map returns 400.

The read/check/merge/write is synchronous, with no await, under the **same process-local
critical section as PUT**. Concurrent HTTP seeds cannot both win or lose a partial PUT.
This is not a cross-process filesystem lock: run one Agent Service writer per owner store,
as before. Shells must not write a migration-complete marker in browser storage. Old
services may lack this route; clients keep compatibility defaults without making a PUT.

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
