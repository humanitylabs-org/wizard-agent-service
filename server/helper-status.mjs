// Read-only helper visibility. Counts assigned tasks still awaited, not guessed live processes.
import { DatabaseSync } from 'node:sqlite'
import { ownerGate, ownerMovedOn, receiptConsumed } from './delegation-receipts.mjs'
import { helperAnswerAfter } from './helper-continuation.mjs'
import { helperDelegationQuery, assignedHelperCount, HELPER_SOURCE_LIMIT } from './helper-source.mjs'
import { readNonHoldingFollowUps } from './owned-open-work-follow-through.mjs'
const RUNNING = new Set(['running','stalling','finalizing'])
const TERMINAL = new Set(['completed','failed','interrupted'])
export function readHelperStatuses(path, ids, { now = Date.now(), stallSeconds = 120, activeSessionIds = new Set(), nonHoldingFor = id => readNonHoldingFollowUps(path, id) } = {}) {
  if (!path || !ids?.length) return new Map()
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true }); const result = new Map(); const sec = now / 1000
    const uniqueIds = [...new Set(ids)].slice(0,200)
    const query = helperDelegationQuery(db, uniqueIds, sec)
    if (!query) return result
    const all = db.prepare(query.sql).all(...query.params)
    if (all.length > HELPER_SOURCE_LIMIT) {
      // Do not invent zero/exact counts from truncated evidence. Suppress this unavailable
      // projection just as with an unreadable DB; never authorize continuation from it.
      return result
    }
    const grouped = new Map()
    for (const row of all) { const rows=grouped.get(row.session_id) ?? [];rows.push(row);grouped.set(row.session_id,rows) }
    for (const [sid, sourceRows] of grouped) {
      const followUps = nonHoldingFor(sid)
      const rows = sourceRows.filter(row => !followUps.has(row.delegation_id))
      if (!rows.length) continue
      const gate = ownerGate(db,sid)
      const active = activeSessionIds.has(sid) || Boolean(db.prepare('SELECT 1 FROM session_turn_leases WHERE conversation_id=? AND expires_at>? LIMIT 1').get(sid,sec))
      // A steer *before* completion belongs to this request. Only an owner turn after the
      // completion supersedes its findings. Dispatch time is not a user-request boundary.
      const completed = rows.filter(r=>TERMINAL.has(r.state) && !ownerMovedOn(db,sid,r.completed_at))
      const running = rows.filter(r=>RUNNING.has(r.state))
      const answers = new Map(completed.map(r=>[r.delegation_id,helperAnswerAfter(db,sid,r.completed_at,r.delegation_id)]))
      const uncertainAnswers = [...answers.values()].some(value=>value===null)
      const unresolved = completed.filter(r=> answers.get(r.delegation_id)!==true)
      if (!running.length && !unresolved.length) continue
      const since = running.length ? Math.min(...running.map(r=>Number(r.dispatched_at))) : Math.max(...unresolved.map(r=>Number(r.completed_at)))
      const stale = running.some(r=>sec-Number(r.dispatched_at)>6*3600)
      const expired = !running.length && sec-since>2*3600
      const phase = gate==='unknown' ? 'uncertain' : gate ? 'held' : uncertainAnswers || stale || expired ? 'uncertain' : running.length ? 'running' : active ? 'integrating' : sec-since>=stallSeconds ? 'stalled' : 'waiting'
      result.set(sid,{ phase, pending: running.reduce((n,r)=>n+assignedHelperCount(r),0), returned: completed.reduce((n,r)=>n+assignedHelperCount(r),0), since, checkedAt: sec,
        resumeEligible: phase==='stalled' && !active && unresolved.some(r=>sec-Number(r.completed_at)<=2*3600 && !receiptConsumed(db,sid,r.delegation_id,r.completed_at)),
        failed: completed.some(r=>r.state!=='completed') })
    }
    return result
  } catch { return new Map() } finally { db?.close() }
}
