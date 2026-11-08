// A turn can end by handing its work to a detached background job: a deploy launched through
// wizard_restart_report.py outlives the turn, restarts services, and posts its own result into the
// thread. Until it reports, the thread is waiting on that job, not stuck and not Ready.
//
// The job's own state file (~/.hermes/state/wizard-restart-report/<id>.json) is the durable receipt.
// This reads it read-only and projects each live one as a heavy-ledger row, so the existing heavy
// wait (heavy-wait.mjs, the status guard, the Working/Ready projection) treats it exactly like a
// queued heavy job. No new status signal: a finished job ("reported"/"post_failed") drops out and
// the thread settles on the message the job posted.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HEAVY_WAIT_CAP_SECONDS } from './heavy-wait.mjs'

export const DETACHED_ACTIVE = new Set(['launching', 'running'])
const GRACE_SECONDS = 600
const TTL_MS = 2000

/** Pure: one job file's parsed JSON -> a heavy-ledger row, or null when it no longer owes a result. */
export function detachedJobRow(job, nowMs = Date.now()) {
  if (!job || !DETACHED_ACTIVE.has(job.status)) return null
  const sessionId = String(job.requested_by_session || job.thread || '')
  const created = Date.parse(job.created_at)
  if (!sessionId || !Number.isFinite(created) || created > nowMs + 60_000) return null
  // A vanished owner (host reboot mid-run) must not pin the thread forever: the job's own timeout
  // plus its verify window plus a grace bounds the wait, never longer than the heavy-wait cap.
  const budget = Math.min(HEAVY_WAIT_CAP_SECONDS, (Number(job.timeout) || 0) + (Number(job.verify_s) || 0) + GRACE_SECONDS)
  if (nowMs - created > budget * 1000) return null
  return { job_id: `deploy:${job.id}`, id: `deploy:${job.id}`, sessionId, agent_id: 'hermes', state: 'running', resume: '',
    cancel_requested: false, continuation_invalidated: false, created_at: created, kind: 'detached-deploy', what: String(job.what || '').slice(0, 160) }
}

/** Reader with a short memo; the returned array keeps its identity while nothing changed, so
 * per-snapshot indexes (heavyJobsForSession) are built once, not per listed row. The parsed receipts
 * are kept, and every refresh re-ages them, so an unreadable or deleted directory can never keep a
 * thread waiting past the job's own bound. */
export function createDetachedJobReader(dir, { ttlMs = TTL_MS } = {}) {
  let at = 0, last = [], sig = '[]', jobs = []
  const publish = (nowMs) => {
    const next = jobs.map(job => detachedJobRow(job, nowMs)).filter(Boolean)
    const nextSig = JSON.stringify(next)
    if (nextSig !== sig) { sig = nextSig; last = next }
    return last
  }
  const rows = (nowMs = Date.now()) => {
    if (!dir) return last
    if (nowMs - at < ttlMs) return last
    at = nowMs
    try {
      const found = []
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const file = join(dir, name)
        try {
          // Only recent files can still be live; skip the archive without parsing it.
          if (nowMs - statSync(file).mtimeMs > HEAVY_WAIT_CAP_SECONDS * 1000) continue
          const job = JSON.parse(readFileSync(file, 'utf8'))
          if (detachedJobRow(job, nowMs)) found.push(job)
        } catch { /* one unreadable receipt must not hide the rest */ }
      }
      jobs = found
    } catch (error) {
      // A missing directory means no deploy was ever started; any other failure keeps the last known
      // receipts, aged below, rather than guessing.
      if (error?.code === 'ENOENT') jobs = []
    }
    return publish(nowMs)
  }
  return { rows }
}

/** The same rows addressed to one agent: a receipt names only its thread, and thread ids are unique. */
export const detachedRowsFor = (rows, agentId) => rows.length ? rows.map(row => ({ ...row, agent_id: agentId })) : rows

/** Heavy ledger + detached jobs as one snapshot; identity-stable while neither side changed. */
export function combineLedgers(heavyRows, detachedRows) {
  const base = heavyRows ?? []
  if (!detachedRows?.length) return base
  return [...base, ...detachedRows]
}
export function createLedger(heavyRowsFn, detachedRowsFn) {
  let lastA, lastB, lastOut = []
  return () => {
    const a = heavyRowsFn?.(), b = detachedRowsFn?.()
    if (a === lastA && b === lastB) return lastOut
    lastA = a; lastB = b; lastOut = combineLedgers(a, b)
    return lastOut
  }
}
