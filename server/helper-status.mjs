// Read-only helper visibility. Counts assigned tasks still awaited, not guessed live processes.
import { DatabaseSync } from 'node:sqlite'
import { currentOwnerResult, ownerGate, ownerMovedOn, receiptConsumed, completionDelegationId } from './delegation-receipts.mjs'
const INTERNAL = /^\s*\[(?:ASYNC DELEGATION BATCH COMPLETE|Wizard follow-through|CONTEXT COMPACTION|CONTEXT SUMMARY|PRIOR CONTEXT|IMPORTANT:|System:|Your active task list|Your previous agent loop)/u
const RUNNING = new Set(['running','stalling','finalizing'])
const TERMINAL = new Set(['completed','failed','interrupted'])
export function readHelperStatuses(path, ids, { now = Date.now(), stallSeconds = 120, activeSessionIds = new Set() } = {}) {
  if (!path || !ids?.length) return new Map()
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true }); const result = new Map(); const sec = now / 1000
    const cols = new Set(db.prepare('PRAGMA table_info(async_delegations)').all().map(r=>r.name))
    const origins = ['origin_session_id','parent_session_id','origin_ui_session_id'].filter(k=>cols.has(k))
    if (!origins.length) return result
    const origin = `COALESCE(${origins.map(k=>`NULLIF(${k},'')`).join(',')},'')`
    for (const sid of [...new Set(ids)]) {
      if (!db.prepare(`SELECT 1 FROM async_delegations WHERE ${origin}=? LIMIT 1`).get(sid)) continue
      const messages = db.prepare(`SELECT role,content,timestamp,display_kind FROM messages WHERE session_id=? AND COALESCE(active,1)=1 ORDER BY timestamp DESC,id DESC`).all(sid)
      const human = messages.find(r=>r.role==='user' && !INTERNAL.test(r.content||'') && !['system','async_delegation_complete','internal_notification','hidden'].includes(r.display_kind))
      const boundary = Number(human?.timestamp) || 0
      const rows = db.prepare(`SELECT * FROM async_delegations WHERE ${origin}=? AND (state IN ('running','stalling','finalizing') OR dispatched_at>=?) ORDER BY dispatched_at`).all(sid,boundary)
      if (!rows.length) continue
      const gate = ownerGate(db,sid)
      const active = activeSessionIds.has(sid) || Boolean(db.prepare('SELECT 1 FROM session_turn_leases WHERE conversation_id=? AND expires_at>? LIMIT 1').get(sid,sec))
      const completed = rows.filter(r=>TERMINAL.has(r.state))
      const running = rows.filter(r=>RUNNING.has(r.state))
      const unresolved = completed.filter(r=> {
        if (ownerMovedOn(db,sid,r.completed_at)) return false
        const completion = messages.find(m=>m.role==='user' && completionDelegationId(m.content)===r.delegation_id)
        const answered = completion && messages.some(m=>m.role==='assistant' && Number(m.timestamp)>Number(completion.timestamp) && /\[WIZARD_STATUS_V1\]/.test(m.content||''))
        return !answered && !(['done','needs_you','check'].includes(currentOwnerResult(db,sid)) && receiptConsumed(db,sid,r.delegation_id,r.completed_at))
      })
      if (!running.length && !unresolved.length) continue
      const count = r=> { try { const t=JSON.parse(r.task_json||'{}'); return Math.max(1,Array.isArray(t.goals)?t.goals.length:1) } catch { return 1 } }
      const since = running.length ? Math.min(...running.map(r=>Number(r.dispatched_at))) : Math.max(...unresolved.map(r=>Number(r.completed_at)))
      const stale = running.some(r=>sec-Number(r.dispatched_at)>6*3600)
      const expired = !running.length && sec-since>2*3600
      const phase = gate ? 'held' : stale || expired ? 'uncertain' : running.length ? 'running' : active ? 'integrating' : sec-since>=stallSeconds ? 'stalled' : 'waiting'
      result.set(sid,{ phase, pending: running.reduce((n,r)=>n+count(r),0), returned: completed.reduce((n,r)=>n+count(r),0), since, checkedAt: sec,
        resumeEligible: phase==='stalled' && !active && unresolved.some(r=>sec-Number(r.completed_at)<=2*3600 && !receiptConsumed(db,sid,r.delegation_id,r.completed_at)),
        failed: completed.some(r=>r.state!=='completed') })
    }
    return result
  } catch { return new Map() } finally { db?.close() }
}
