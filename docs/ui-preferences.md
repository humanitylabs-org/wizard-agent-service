# Box-wide shell preferences

The Agent Service owns `GET /wizard/v1/ui-preferences` and `PUT /wizard/v1/ui-preferences`.
Both require the same verified owner access as bootstrap. Agent/MCP tokens alone do not
bypass that check. The API serves no secrets and sends `Cache-Control: no-store`.

The response is a flat JSON object:

```json
{"archiveAfterDays":7,"compact":false,"readyOrder":"newest","subjectOrder":[]}
```

PUT accepts a **partial** object and merges only the specified fields. Unknown fields,
arrays at the root, wrong types and invalid values are rejected (400). Send
`Content-Type: application/json`; cross-site browser writes are rejected.

- `archiveAfterDays`: 0 (Never), 1, 3, 7, 14 or 30. Default: 7.
- `compact`: boolean. Default: false.
- `readyOrder`: `newest`, `oldest`, `priority` or `subject`. Default: `newest`.
- `subjectOrder`: at most 60 unique strings, each at most 120 characters without control
  characters. Default: empty (natural order).

The service saves `ui-preferences.json` under its Wizard OS home, using a restricted
mode and atomic rename. It never rewrites operator-owned `settings.json`, app config,
Hermes configuration or user data. Writes within one service process merge
synchronously so simultaneous partial updates do not lose other fields. Corrupt
stored preferences fail closed with 503 instead of resetting the owner's choices.

Front ends may use browser storage as an offline cache, but this endpoint is the
cross-device source of truth. Poll or refresh on focus; do not overwrite a user's
newer local change with an older in-flight GET. An older Agent Service without the
endpoint leaves the device cache intact and should visibly report local-only saves.

No box-specific proxy, shim route, host path, or production deployment is required by
this contract. This is a proposed API until the companion Agent Service PR is merged
and installed. The UX consumer must not claim cross-device persistence on an older
service. Existing private shim values are not automatically imported: importing them
would be an explicit owner-approved data migration, not part of a source PR.
