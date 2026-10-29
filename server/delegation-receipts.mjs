// Execution, delivery and current owner attention are separate facts. All recovery paths
// use the delegation identity and the same durable consumption/gate checks.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { parseStatus } from './thread-status.mjs'
export const RECEIPT_PREFIX = '[Wizard follow-through] Recovered helper receipt '
export const receiptKey = id => `wizard-helper-receipt-${id}`
export const completionDelegationId = text => typeof text === 'string' ? text.match(/^\[ASYNC DELEGATION BATCH COMPLETE\s*[—-]\s*(deleg_[A-Za-z0-9_-]+)\]/u)?.[1] : undefined
export const internalHelperMessage = text => /^\s*\[(?:ASYNC DELEGATION BATCH COMPLETE|Wizard follow-through|CONTEXT COMPACTION|CONTEXT SUMMARY|PRIOR CONTEXT|IMPORTANT:|System:|Your active task list|Your previous agent loop|Agent-to-agent|supervisor (?:update|build|review|question|closed)|Wizard schedule|Wizard heavy-work (?:completion|notice)|Owner requested recovery|James requested recovery|STILL IN PROGRESS)/u.test(text)
export const isHumanRequest = row => row.role === 'user' && Boolean(String(row.content || '').trim())
  && !internalHelperMessage(row.content || '')
  && !['system','async_delegation_complete','internal_notification','hidden','commentary'].includes(row.display_kind)
  && !String(row.display_kind || '').startsWith('process_wakeup')
  && !/^(?:Your previous turn indicated a tool call|You just executed tool calls but returned an empty response|Workline browser QA found a concrete regression)/u.test(String(row.content || '').trim())
// Inactive compaction history is retained; rewound/deleted turns are not.
// Older schemas without compacted must never grant inactive rows authority.
export const retainedMessagesWhere = columns => !columns.has('active') ? '1'
  : `(COALESCE(active,1)=1${columns.has('compacted') ? ' OR (active=0 AND compacted=1)' : ''})`
const internal = internalHelperMessage

export function currentOwnerResult(db, sessionId) {
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(r=>r.name))
  // Compaction changes model context, not the owner's request/answer boundary.
  // Only compacted inactive rows remain authoritative for gates and supersession.
  const kind = columns.has('display_kind') ? ', display_kind' : ''
  const rows = db.prepare(`SELECT role, content, timestamp ${kind} FROM messages WHERE session_id=?
    AND ${retainedMessagesWhere(columns)} AND role IN ('user','assistant') AND trim(COALESCE(content,''))<>'' ORDER BY timestamp DESC,id DESC LIMIT 513`).iterate(sessionId)
  let assistant, userAt=0, inspected=0
  for (const row of rows) {
    inspected++
    if (internal(row.content) || ['async_delegation_complete','internal_notification','system','commentary','hidden'].includes(row.display_kind)) continue
    if (row.role==='user' && isHumanRequest(row) && !userAt) userAt=Number(row.timestamp)
    if (row.role==='assistant' && !assistant && /\[\/WIZARD_STATUS_V1\]\s*$/u.test(row.content || '')
      && ['done','needs_you','check'].includes(parseStatus(row.content)?.state)) assistant=row
    if (userAt) break // older outcomes cannot gate the latest genuine request
  }
  if (inspected>512 && (!assistant || !userAt)) return 'unknown'
  const state=parseStatus(assistant?.content)?.state
  return Number(assistant?.timestamp)>=userAt && ['done','needs_you','check'].includes(state) ? state : null
}
// Only a gate that waits on the owner holds back a continuation. A 'done' written while a helper was
// still running never saw that helper's findings (a reviewer's must-fix is exactly that case), so the
// findings still go back to the agent. Held results become eligible again after the owner's next turn.
export const OWNER_GATES = new Set(['needs_you', 'check'])
export function ownerGate(db, sessionId) {
  const state = currentOwnerResult(db, sessionId)
  return state==='unknown' || OWNER_GATES.has(state) ? state : null
}
// Delivery is not an integrated outcome. A checkpoint, a tool argument, or a
// delegation status lookup cannot prove that the model received the findings.
export function isReceiptDelivery(row, id) {
  if (row.role === 'user') return String(row.content || '').startsWith(RECEIPT_PREFIX + id + '\n')
  if (row.role !== 'tool') return false
  try {
    const result = JSON.parse(row.content)
    return result?.delegation_id === id && ['completed','failed','interrupted'].includes(result.status)
      && Array.isArray(result.results) && result.results.some(r => typeof r?.summary === 'string' && r.summary.trim())
  } catch { return false }
}
export function receiptConsumed(db, sessionId, id, completedAt) {
  const after = Number.isFinite(Number(completedAt)) ? Number(completedAt) : 0
  const rows = db.prepare(`SELECT role,content FROM messages WHERE session_id=? AND timestamp>=?
    AND role IN ('user','tool') AND instr(COALESCE(content,''),?)>0
    ORDER BY timestamp DESC,id DESC LIMIT 513`).all(sessionId,after,id)
  // Incomplete evidence blocks automatic redelivery, never proves integration.
  return rows.length > 512 || rows.some(row => isReceiptDelivery(row,id))
}
export function continuationAllowed(path, sessionId, id, now=Date.now()) {
  if(!path || !existsSync(path)) return false
  let db
  try {
    db=new DatabaseSync(path,{readOnly:true})
    if (ownerGate(db,sessionId) || id && receiptConsumed(db,sessionId,id)) return false
    if(db.prepare('SELECT 1 FROM session_turn_leases WHERE conversation_id=? AND expires_at>? LIMIT 1').get(sessionId,now/1000)) return false
    return true
  } catch { return false } finally { db?.close() }
}
// The owner has taken the thread forward since the helper finished: the result is stale for this
// thread, and resuming it would override what the owner asked for next. It stays queryable in Hermes.
export function ownerMovedOn(db, sessionId, completedAt) {
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(r=>r.name))
  const rows = db.prepare(`SELECT content ${columns.has('display_kind')?',display_kind':''} FROM messages WHERE session_id=? AND role='user' AND timestamp>?
    AND ${retainedMessagesWhere(columns)} AND trim(COALESCE(content,''))<>'' ORDER BY timestamp DESC,id DESC LIMIT 513`).all(sessionId, Number(completedAt) || 0)
  return rows.length>512 || rows.some(row => isHumanRequest({ ...row, role: 'user' }))
}
// Automatic resumption is for the turn that was waiting on the helper; after two hours it is stale.
export function readUndeliveredHelperReceipts(path, {now=Date.now(),maxAgeSeconds=2*3600,includeDelivered=false,delegationId}={}) {
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
      if(receiptConsumed(db,sessionId,id,row.completed_at)||ownerGate(db,sessionId)) continue
      if(ownerMovedOn(db,sessionId,row.completed_at) || Number(row.completed_at)<now/1000-maxAgeSeconds) continue
      let results;try{results=JSON.parse(row.result_json)?.results}catch{continue}
      if(!Array.isArray(results)) continue
      const text=results.filter(r=>typeof r?.summary==='string'&&r.summary.trim()).map(r=>`Helper ${Number(r.task_index)+1} (${String(r.status||'unknown')}):\n${r.summary.trim()}`).join('\n\n')
      if(!text||text.length>60000) continue
      receipts.push({agent_id:'hermes',session_id:sessionId,sessionId,delegationId:id,at:Number(row.completed_at),key:receiptKey(id),
        input:RECEIPT_PREFIX+id+'\nThese are saved helper findings, not verified completion. Continue the original request through its remaining acceptance checks. Preserve the latest user instructions and original release authority. Keep internal progress in Working; return a final answer only when there is a verified result or one specific owner-only gate.\n\n'+text})
    }
    return receipts
  } catch{return []}finally{db?.close()}
}
export function findIdleUndeliveredHelperReceipts(path,options={}) {
  return readUndeliveredHelperReceipts(path,options).filter(r=>continuationAllowed(path,r.sessionId,r.delegationId,options.now??Date.now()))
}
