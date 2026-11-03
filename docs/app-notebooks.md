# Per-app, read-only agent notebooks

This is a generic Agent Service capability, not a Notes integration. Apps keep source selection, rendering, copying and search presentation in their own releases.

## Two independent decisions

1. The App Manager's normal app → `wizard-agent-service` connection supplies `X-Wizard-Grant`. The Service hashes it against the provider-side `incoming` rows in `WIZARD_GRANTS_FILE` (or `~/.wizard-os/grants/agent-service.json` alongside). No new token store. Missing, malformed, ambiguous or revoked identity fails closed, including `enforce: false`.
2. The owner approves each notebook using the existing owner-authenticated grant API:

   `POST /wizard/v1/agent-grants` with `{"kind":"app-notebook","reader":"app:<installed-app-id>","source":"<agent-id>","scope":"read"}`.

   `GET /wizard/v1/agent-grants?reader=app:<id>` lists that app's grants; `DELETE /wizard/v1/agent-grants/<grant-id>` revokes one immediately. These resource grants reuse the existing atomic `.agent-grants.json` store. An ordinary app connection is not agent authority. Agent → agent grants and per-agent app tick lists remain separate and unchanged.

An installed app with only a connection sees no sources. A notebook grant without a valid app key also gives no access. Only an authenticated owner can create/delete app-notebook grants; an app key cannot call owner grant management.

## Generic resource API (box-local)

- `GET /wizard/v1/agent-notebooks` → `{sources:[{id,label,privacy,appearance?}]}`
- `GET /wizard/v1/agent-notebooks/<id>` → `{source,entries,truncated}`
- `GET /wizard/v1/agent-notebooks/<id>/read?path=...` → `{source,path,text}`
- `GET /wizard/v1/agent-notebooks/<id>/search?q=...` → `{source,notes,truncated}`

Every operation is read-only and no-store. The shared `stateList`/`stateText` path, extension, link and size gates still apply. Client identity comes only from the matching grant hash, never a supplied app/agent name, owner cookie or URL parameter. The public phone listener does not accept app credentials. Apps call this from their backend, never expose the key to browser JavaScript.

## Privacy / approval boundary

The safe source default is the 1eaaa4f rule: standard, visible, non-recovery agents with an explicit `notes_dir`. Eligibility is checked on every read, before any state-home resolution. No default `wiki` folder. Stored or forged grants cannot open a private/hidden/recovery agent. No private exception is implemented: the approved AGENT_STATE #59 contract seals private agents against apps. Any future owner-authorized exception needs a separately reviewed privacy/spec change, never an ordinary connection grant.

This proposal adds the narrow `app-notebook` resource grant kind to the existing Service grant API. It needs contract review against `spec/PERMISSIONS.md` / `spec/AGENT_STATE.md`; it does not claim that ordinary app grants already authorize agent data or that App Manager already displays this new kind. A future Connections screen should call this same grant API, not invent another store.

## Migration

The old unscoped `/wizard/v1/agent-notes...` owner-browser route returns `410 app_notebook_grant_required`; it no longer reads any notebook. There is deliberately no compatibility flag that preserves the private-data leak. Update notebook-consuming apps before switching a box to this version. The Notes app must use a backend proxy with its normal outgoing app key and an explicit resource grant; until that proxy has owner-authentication parity, leave notebook discovery disabled instead of forwarding a privileged credential through an unauthenticated app route. The owner's own vault is unaffected.

Synthetic coverage: `tests/agent-notebooks.test.ts` (real HTTP route, per-app identity, source grants/CRUD, private/hidden/recovery exclusion, revocation, malformed/symlink grant files, path gates and write refusals). No live notebooks are read by these tests.
