// Graceful restart gate (issue 480, off unless WIZARD_GRACEFUL_RESTART=1).
//
// Whoever restarts the Agent Service (an update, a settings change, the Channels toggle) first asks it to get
// ready: POST /wizard/v1/restart. From then on new sends are still accepted and saved in the durable run queue,
// but none is launched (waiting reason `restart_pending`), so nothing a person sends during the wait is lost or
// shown as "Reply not sent". Turns already running keep going. The restarter polls GET /wizard/v1/restart until
// `phase` is `ready` (nothing running), restarts, and the new process launches the held sends on its first tick.
// Past the wait limit the phase is `overdue`: the restarter tells the owner and either waits longer (POST again)
// or restarts now. DELETE lifts the hold (restart called off).
//
// The hold lives only in this process and is leased: each POST or GET renews it, and a restarter that stops
// asking for `leaseMs` loses it, so a crashed restarter can never leave sends parked.

const PHASES = Object.freeze({ idle: 'idle', waiting: 'waiting', ready: 'ready', overdue: 'overdue' })
const REASON = /^[a-z0-9][a-z0-9_.:-]{0,63}$/u

export const RESTART_PENDING = 'restart_pending'

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
      const waitMs = raw === undefined ? defaultWaitMs : Math.min(maxWaitMs, Number(raw) * 1000)
      const at = now()
      const current = expire()
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
