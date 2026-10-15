import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Unlike the UX queue projection this counts ALL leases, including cron and delegated workers.
export function localRuntimeActivity(path, now = Date.now()) {
  if (!path || !existsSync(path)) throw new Error('activity_unknown')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const leases = db.prepare('SELECT COUNT(*) AS n FROM session_turn_leases WHERE expires_at > ?').get(now / 1000).n
    const recent = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE COALESCE(last_activity_description,'') <> '' AND COALESCE(last_activity_at,0) >= ?").get(now / 1000 - 150).n
    return { active: Number(leases) + Number(recent), known: true }
  } finally { db.close() }
}

export function createMaintenanceLease({ path, activity, barrier = null }) {
  let held = null, checking = false, inFlight = 0
  if (path && existsSync(path)) {
    try { held = JSON.parse(readFileSync(path, 'utf8')) } catch { held = { token: 'corrupt' } }
  }
  const blocked = () => Boolean(held || checking)
  const denied = message => Object.assign(new Error(message), { status: 409 })
  return {
    blocked,
    enter() {
      if (blocked()) throw denied('maintenance_active')
      inFlight++
      let released = false
      return () => { if (!released) { released = true; inFlight-- } }
    },
    async acquire(token) {
      if (!/^[a-f0-9-]{36}$/i.test(token)) throw denied('invalid_maintenance_token')
      if (held?.token === token) return held
      if (blocked() || inFlight) throw denied('admission_in_flight')
      checking = true // close admission synchronously, BEFORE the first awaited probe
      let releaseBarrier = null
      try {
        // A Service-only gate cannot stop cron/TUI turns inside stock Hermes. Never claim
        // all-local maintenance without a runtime-side barrier covering those entrypoints.
        if (!barrier) throw denied('runtime_maintenance_barrier_unavailable')
        releaseBarrier = await barrier.acquire(token)
        const agents = await activity()
        if (!Array.isArray(agents) || !agents.length || agents.some(a => a.known !== true || a.active !== 0)) throw denied('agent_busy_or_unknown')
        held = { token, agents: agents.map(a => a.id), acquired: Date.now() }
        if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path + '.new', JSON.stringify(held), { mode: 0o600 }); renameSync(path + '.new', path) }
        return held
      } catch (e) {
        if (releaseBarrier) await releaseBarrier()
        throw e
      } finally { checking = false }
    },
    async release(token) {
      if (!held) return
      if (held.token !== token) throw denied('maintenance_token_mismatch')
      await barrier?.release(token)
      if (path && existsSync(path)) unlinkSync(path)
      held = null
    },
  }
}
