// Execution, delivery and current owner attention are separate facts. All recovery paths
// use the delegation identity and the same durable consumption/gate checks.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { parseStatus } from './thread-status.mjs'
export const RECEIPT_PREFIX = '[Wizard follow-through] Recovered helper receipt '
export const receiptKey = id => `wizard-helper-receipt-${id}`
export const completionDelegationId = text => typeof text === 'string' ? text.match(/^\[ASYNC DELEGATION BATCH COMPLETE\s*[—-]\s*(deleg_[A-Za-z0-9_-]+)\]/u)?.[1] : undefined
const internal = text => /^\s*\[(?:ASYNC DELEGATION BATCH COMPLETE|Wizard follow-through|CONTEXT COMPACTION|CONTEXT SUMMARY|PRIOR CONTEXT|IMPORTANT:|System:|Your active task list|Your previous agent loop)/u.test(text)

export function currentOwnerResult(db, sessionId) {
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(r=>r.name))
  const active = columns.has('active') ? 'AND COALESCE(active, 1) = 1' : ''
  const kind = columns.has('display_kind') ? ', display_kind' : ''
  const rows = db.prepare(`SELECT role, content, timestamp ${kind} FROM messages WHERE session_id=?
    AND role IN ('user','assistant') ${active} AND trim(COALESCE(content,''))<>'' ORDER BY timestamp DESC,id DESC`).iterate(sessionId)
  let assistant, userAt=0
  for (const row of rows) {
    if (internal(row.content) || ['async_delegation_complete','internal_notification','system','commentary','hidden'].includes(row.display_kind)) continue
    if (row.role==='user' && !userAt) userAt=Number(row.timestamp)
    if (row.role==='assistant' && !assistant) assistant=row
    if (assistant && userAt) break
  }
  const state=parseStatus(assistant?.content)?.state
  return Number(assistant?.timestamp)>=userAt && ['done','needs_you','check'].includes(state) ? state : null
}
export function receiptConsumed(db, sessionId, id) {
  return Boolean(db.prepare(`SELECT 1 FROM messages WHERE session_id=? AND role='user'
    AND instr(COALESCE(content,''),?)>0 LIMIT 1`).get(sessionId, RECEIPT_PREFIX+id+'\n'))
}
export function continuationAllowed(path, sessionId, id, now=Date.now()) {
  if(!path || !existsSync(path)) return false
  let db
  try {
    db=new DatabaseSync(path,{readOnly:true})
    if (currentOwnerResult(db,sessionId) || id && receiptConsumed(db,sessionId,id)) return false
    if(db.prepare('SELECT 1 FROM session_turn_leases WHERE conversation_id=? AND expires_at>? LIMIT 1').get(sessionId,now/1000)) return false
    return true
  } catch { return false } finally { db?.close() }
}
export function readUndeliveredHelperReceipts(path, {now=Date.now(),maxAgeSeconds=6*3600,includeDelivered=false,delegationId}={}) {
  if(!path || !existsSync(path)) return []
  let db
  try {
    db=new DatabaseSync(path,{readOnly:true})
    const columns=new Set(db.prepare('PRAGMA table_info(async_delegations)').all().map(r=>r.name))
    if(!['delegation_id','state','delivery_state','result_json','completed_at'].every(k=>columns.has(k))) return []
    const origins=['origin_session_id','parent_session_id','origin_ui_session_id'].filter(k=>columns.has(k))
    if(!origins.length) return []
    const origin=origins.length===1 ? origins[0] : `COALESCE(${origins.map(k=>`NULLIF(${k},'')`).join(',')})`
    const rows=db.prepare(`SELECT delegation_id,${origin} AS session_id,completed_at,result_json FROM async_delegations
      WHERE state IN ('completed','failed','interrupted') ${includeDelivered?'':"AND delivery_state IN ('pending','dropped')"}
      AND ${delegationId?'delegation_id=?':'completed_at>=?'} ORDER BY completed_at`).all(delegationId ?? now/1000-maxAgeSeconds)
    const receipts=[]
    for(const row of rows) {
      const sessionId=String(row.session_id||''),id=String(row.delegation_id||'')
      if(!/^(wizard_|wizard-assistant-)[A-Za-z0-9._:-]+$/.test(sessionId)||!/^[A-Za-z0-9_-]+$/.test(id)) continue
      if(receiptConsumed(db,sessionId,id)||currentOwnerResult(db,sessionId)) continue
      let results;try{results=JSON.parse(row.result_json)?.results}catch{continue}
      if(!Array.isArray(results)) continue
      const text=results.filter(r=>typeof r?.summary==='string'&&r.summary.trim()).map(r=>`Helper ${Number(r.task_index)+1} (${String(r.status||'unknown')}):\n${r.summary.trim()}`).join('\n\n')
      if(!text||text.length>60000) continue
      receipts.push({sessionId,delegationId:id,at:Number(row.completed_at),key:receiptKey(id),
        input:RECEIPT_PREFIX+id+'\nThese are saved helper findings, not verified completion. Continue the original request through its remaining acceptance checks. Preserve the latest user instructions and original release authority. Keep internal progress in Working; return a final answer only when there is a verified result or one specific owner-only gate.\n\n'+text})
    }
    return receipts
  } catch{return []}finally{db?.close()}
}
export function findIdleUndeliveredHelperReceipts(path,options={}) {
  return readUndeliveredHelperReceipts(path,options).filter(r=>continuationAllowed(path,r.sessionId,r.delegationId,options.now??Date.now()))
}
