# Graceful restart (issue 480)

Switch: `WIZARD_GRACEFUL_RESTART=1` (Agent Service env, option `gracefulRestart`). Off by default. With it off,
`/wizard/v1/restart` is a 404, `/wizard/health` has no `restart` field and the run queues launch as before.

Optional: `WIZARD_GRACEFUL_RESTART_WAIT_S` sets the default wait limit (600 s).

## Why

A restart the product starts (an update, a settings change, the Channels toggle) used to stop the service straight
away: the service's own shutdown waits only 30 s, a longer agent turn was cut, and a message sent during the restart
could fail with "Reply not sent". James's box avoided this with a local drain script; other boxes had nothing.

## Protocol (for the restarter: the App Manager, or an operator script)

All routes are owner-only (the box owner or the App Manager on the box's loopback); apps and agents get 403.

1. `POST /wizard/v1/restart` with `{"reason": "update", "wait_s": 600}` (both optional). From now on new sends are
   accepted and saved in the durable run queue but not launched (queue reason `restart_pending`). Turns already
   running keep going. The answer is the status below.
2. Poll `GET /wizard/v1/restart` (every few seconds). It answers
   `{ phase, holding, reason, requested_at, wait_until, active, active_unknown, oldest_active_s, held, turns: [{session_id, agent_id, running_s}] }`.
   - `waiting`: turns are still running, within the limit.
   - `ready`: nothing runs. Restart now.
   - `overdue`: turns still run past `wait_until`. Tell the owner and let them choose: wait longer
     (`POST` again with a new `wait_s`; the first request time stays) or restart now.
   - `active_unknown: true` means a queue could not be read; it is never treated as ready.
3. Restart the service. The new process starts without a hold and launches every held send on its first queue
   tick, in order, exactly once (same durable rows, same idempotency keys).
4. To call the restart off, `DELETE /wizard/v1/restart`: held sends launch at once.

The hold is leased: every `POST` and `GET` renews it for 2 minutes. A restarter that stops asking (crashed, killed)
loses the hold and sends launch again, so a hold can never park messages for good.

While a hold is on, `GET /wizard/health` carries `restart: { phase, holding, reason, requested_at, wait_until,
active, held, ... }` (counts only, no thread ids) so the shell can show "Restarting when chats finish" instead of
errors.

## Scope of this slice and what is left

This is the Agent Service half. Still to build (filed as their own issues, `Refs` issue 480):

- App Manager: route every product restart of the Agent Service through this gate (hold, wait, ask the owner when
  overdue, restart, health check, roll back to the previous release when the health check fails).
- Shell: the quiet "Restarting when chats finish" state from `health.restart`, the owner's wait / restart now
  choice, and resending a message whose request hit the few seconds the service is down.
