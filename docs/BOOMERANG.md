# Boomerang scheduled defer

Boomerang persists reminders in Agent Service and resurfaces a thread or exact message without starting an agent run.

## HTTP API

Browser writes use the normal Wizard access and same-origin checks.

- `GET /wizard/v1/boomerangs[?session_id=<id>]`
- `POST /wizard/v1/boomerangs` — create idempotently
- `PATCH /wizard/v1/boomerangs/<id>` — reschedule
- `DELETE /wizard/v1/boomerangs/<id>` — cancel
- `POST /wizard/v1/boomerangs/<id>/acknowledge` — clear a due reminder after its context opens

Create payload:

```json
{
  "session_id": "wizard_...",
  "runtime": "direct",
  "agent_id": "hermes",
  "target_kind": "message",
  "anchor_at": 1792571400000,
  "context": "Exact source prompt",
  "note": "Follow up",
  "due_at": "2026-10-22T02:00:00.000Z",
  "timezone": "Asia/Bangkok",
  "client_request_id": "stable-retry-key"
}
```

`due_at` is stored as UTC. `timezone` is retained for display. A repeated `(account scope, client_request_id)` returns the original reminder.

## Agent tool

The box-only Wizard MCP gateway exposes `boomerang_set` (Hermes name `mcp__wizard__boomerang_set`) when Boomerang storage is configured. It requires `session_id`, explicit ISO `due_at`, and an IANA `timezone`; optional fields select a message anchor, context, note, and retry key. The tool only creates the reminder.

## Delivery

The scheduler atomically marks overdue reminders due and keeps a durable notification outbox. Failed ntfy deliveries retry with bounded backoff across service restarts; successful deliveries are not sent again by later scans. When both notification and shell origins are configured it publishes ntfy's root JSON API with an explicit topic and an absolute private-shell click URL. The click URL contains only the canonical Wizard session and reminder IDs; it never includes or submits prompt text. As with any HTTP outbox, a process crash after ntfy accepts a request but before the local commit can produce a duplicate rather than lose the reminder.

## Configuration

- `WIZARD_BOOMERANG_STATE_PATH` (default: `$HERMES_HOME/state/wizard-mobile/boomerang.sqlite3`)
- `WIZARD_NOTIFICATIONS_ORIGIN` (Compose: `http://notifications-engine:8080`)
- `WIZARD_NOTIFICATIONS_TOPIC` (default: `wizard`)
- `WIZARD_SHELL_ORIGIN` (absolute private owner URL, for example `https://wizard.example.invalid`)

The state directory must be on the existing persistent Hermes/Wizard volume.

## Release order

1. Build and roll out Agent Service with the three variables above.
2. Verify `GET /wizard/v1/boomerangs` and `mcp__wizard__boomerang_set` from the box-only gateway.
3. Build Wizard UX from its Boomerang commit and stage it against that Agent Service.
4. Exercise create, reschedule, cancel, restart recovery, due notification, notification click, and acknowledgement.
5. Promote UX only after backend health and API checks pass. Roll back UX first, then Agent Service; the SQLite file is forward-safe and may remain.
