// Graceful restart gate (issue 480, off unless WIZARD_GRACEFUL_RESTART=1).
//
// Whoever restarts the Agent Service (an update, a settings change, the Channels toggle) first asks it to get
// ready: POST /wizard/v1/restart. From then on new sends are still accepted and saved in the durable run queue,
// but none is launched (waiting reason `restart_pending`), so nothing a person sends during the wait is lost or
// shown as "Reply not sent". Turns already running keep going. The restarter polls GET /wizard/v1/restart until
// `phase` is `ready` (nothing running), restarts, and the new process launches the held sends on its first tick.
// Past the wait limit the phase is `overdue`: the restarter tells the owner and either waits longer (POST again)
// or restarts now. DELETE lifts the hold (restart called off). The owner's "restart now" from the shell is a POST with
// `now: true`: the hold then reports `restart_now: true` and the restarter restarts without waiting for `ready`.
//
// The hold lives only in this process and is leased: each POST or GET renews it, and a restarter that stops
// asking for `leaseMs` loses it, so a crashed restarter can never leave sends parked.

const PHASES = Object.freeze({ idle: 'idle', waiting: 'waiting', ready: 'ready', overdue: 'overdue' })
const REASON = /^[a-z0-9][a-z0-9_.:-]{0,63}$/u

export const RESTART_PENDING = 'restart_pending'

// Who may reach the route from a browser. Holding every chat's sends is the owner's call, so a page of another app
// on this box (a sibling localhost port or *.ts.net host) must not start, renew or read the hold. A POST must be
// JSON: a page cannot send that without a CORS preflight this service never grants, unlike an empty or text/plain
// body. Same-site and cross-site fetches, and an Origin that is not this host, are refused on every method, so a
// no-cors GET cannot renew the lease either. Server callers (the App Manager) send none of these headers.
// Returns 0 (allowed), 403 (wrong origin) or 415 (POST without JSON).
export function restartRequestRefusal(request, { publicHost } = {}) {
  const headers = request.headers ?? {}
  const site = headers['sec-fetch-site']
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return 403
  if (headers.origin !== undefined) {
    let originHost = ''
    try { originHost = new URL(headers.origin).host } catch { return 403 }
    const host = publicHost ?? (headers['x-forwarded-host'] || headers.host)
    if (!originHost || originHost !== host) return 403
  }
  if (request.method === 'POST' && !/^application\/json(?:;|$)/iu.test(String(headers['content-type'] ?? '').trim())) return 415
  return 0
}

export function createRestartGate({
  activeTurns = () => [],
  heldSends = () => 0,
  now = () => Date.now(),
  defaultWaitMs = 10 * 60_000,
  maxWaitMs = 60 * 60_000,
  leaseMs = 2 * 60_000,
  log = (line) => console.log(line),
} = {}) {
  let hold = null

  const expire = () => {
    if (hold && now() > hold.leaseUntil) {
      log(`[restart-gate] hold for ${hold.reason} lapsed: no restart came within ${Math.round(leaseMs / 1000)} s of the last check; sends launch again`)
      hold = null
    }
    return hold
  }

  const turns = () => {
    let list
    try { list = activeTurns() } catch { list = null }
    // Unreadable means unknown, never "nothing is running".
    return Array.isArray(list) ? list.filter(Boolean) : null
  }

  const report = ({ sessions = false } = {}) => {
    const current = expire()
    if (!current) return { phase: PHASES.idle, holding: false }
    const list = turns()
    const at = now()
    const active = list === null ? null : list.length
    let held = 0
    try { held = Number(heldSends()) || 0 } catch { held = 0 }
    const oldest = list?.length ? Math.max(0, ...list.map(turn => at - Number(turn.since || at))) : 0
    const phase = active === 0 ? PHASES.ready : at > current.waitUntil ? PHASES.overdue : PHASES.waiting
    return {
      phase,
      holding: true,
      reason: current.reason,
      requested_at: new Date(current.requestedAt).toISOString(),
      wait_until: new Date(current.waitUntil).toISOString(),
      active,
      active_unknown: active === null,
      oldest_active_s: Math.round(oldest / 1000),
      held,
      ...(current.now ? { restart_now: true } : {}),
      ...(sessions && list ? { turns: list.map(turn => ({ session_id: String(turn.sessionId || ''), agent_id: String(turn.agentId || 'hermes'),
        running_s: Math.max(0, Math.round((at - Number(turn.since || at)) / 1000)) })) } : {}),
    }
  }

  return {
    PHASES,
    holding() { return Boolean(expire()) },
    // Health/lists: phase and counts only, never thread ids.
    summary() { return report() },
    status() {
      if (expire()) hold.leaseUntil = now() + leaseMs
      return report({ sessions: true })
    },
    request(input = {}) {
      const reason = typeof input.reason === 'string' && REASON.test(input.reason) ? input.reason : 'restart'
      const raw = input.wait_s ?? input.waitS
      if (raw !== undefined && !(Number.isFinite(Number(raw)) && Number(raw) >= 0)) throw Object.assign(new Error('wait_s must be a number of seconds'), { status: 400, code: 'invalid_wait' })
      if (input.now !== undefined && typeof input.now !== 'boolean') throw Object.assign(new Error('now must be true or false'), { status: 400, code: 'invalid_now' })
      const at = now()
      const current = expire()
      // "Restart now" (the owner's choice when overdue) only marks a hold that exists: it never starts one, and it keeps
      // the limit, so the restarter alone decides when to restart. A later "wait longer" clears it.
      if (input.now === true) {
        if (!current) throw Object.assign(new Error('no restart is waiting'), { status: 409, code: 'no_restart_waiting' })
        current.now = true
        current.leaseUntil = at + leaseMs
        log(`[restart-gate] ${current.reason}: the owner chose to restart now`)
        return report({ sessions: true })
      }
      const waitMs = raw === undefined ? defaultWaitMs : Math.min(maxWaitMs, Number(raw) * 1000)
      // A second request (the owner chose to wait longer) keeps the first request time and moves the limit.
      hold = { reason: current ? current.reason : reason, requestedAt: current ? current.requestedAt : at,
        waitUntil: at + waitMs, leaseUntil: at + leaseMs }
      if (!current) log(`[restart-gate] ${hold.reason}: holding new sends until running turns finish (limit ${Math.round(waitMs / 1000)} s)`)
      return report({ sessions: true })
    },
    release() {
      const had = Boolean(expire())
      if (had) log(`[restart-gate] hold for ${hold.reason} lifted; sends launch again`)
      hold = null
      return { ...report(), released: had }
    },
  }
}
