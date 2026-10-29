// Which threads are waiting on their own queued heavy job (Thales builds, emulator and VM tests).
//
// An agent that submits heavy work ends its turn with a handoff ("queued on Thales, the result comes
// back here"). That reply is progress, not something for the owner to act on, so the thread stays in
// Working until the job's completion turn answers. Mirrors the background-helper wait: an owner gate
// (needs_you/check since the latest genuine request) still wins, and a job older than the cap stops
// pinning the thread so a lost job never hides it forever.
import { DatabaseSync } from 'node:sqlite'
import { ownerGate } from './delegation-receipts.mjs'

export const HEAVY_WAIT_CAP_SECONDS = 12 * 3600
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
export const heavyCompletionDropped = job => terminal.has(job.state) && !job.completion_delivered_at
  && (job.cancel_requested || job.continuation_invalidated || ['superseded', 'suppressed'].includes(job.resume))

// Admission is not delivery: a queued continuation still owes its result. Unlike
// the bounded list liveness hint, the completion guard must not expire by age.
export function heavyResultOwed(job, isDelivered = () => false) {
  if (!terminal.has(job.state)) return true
  if (heavyCompletionDropped(job)) return !job.notice_delivered_at
  return !(job.completion_delivered_at || isDelivered(job))
}

/** Live heavy jobs whose result is still owed to their thread: Map(sessionId -> { pending, since }). */
export function pendingHeavyJobs(jobs, ids, nowMs = Date.now()) {
  const wanted = new Set(ids)
  const out = new Map()
  for (const job of jobs ?? []) {
    const sessionId = job?.sessionId ?? job?.session_id
    if (!wanted.has(sessionId) || (job.agent_id ?? 'hermes') !== 'hermes') continue
    if (job.cancel_requested || job.continuation_invalidated) continue
    const resume = String(job.resume ?? '')
    // A terminal job is owed only until its continuation is admitted (resume names that run) or dropped.
    if (resume) continue
    if (job.state === 'cancelled') continue
    const created = Number(job.created_at) || 0
    if (!created || nowMs - created > HEAVY_WAIT_CAP_SECONDS * 1000) continue
    const current = out.get(sessionId) ?? { pending: 0, since: created / 1000 }
    current.pending += 1
    current.since = Math.min(current.since, created / 1000)
    out.set(sessionId, current)
  }
  return out
}

/** Drops threads whose agent has asked the owner something since the latest genuine request. */
export function withoutOwnerGates(hermesStatePath, waits) {
  if (!hermesStatePath || !waits.size) return waits
  let db
  try {
    db = new DatabaseSync(hermesStatePath, { readOnly: true })
    for (const id of [...waits.keys()]) if (ownerGate(db, id)) waits.delete(id)
    return waits
  } catch { return new Map() } finally { db?.close() }
}
