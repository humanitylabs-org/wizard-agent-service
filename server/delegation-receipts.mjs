// Execution, delivery and current owner attention are separate facts. All recovery paths
// use the delegation identity and the same durable consumption/gate checks.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { preparedRead } from './read-only-sqlite.mjs'
import { parseStatus } from './thread-status.mjs'
export const RECEIPT_PREFIX = '[Wizard follow-through] Recovered helper receipt '
export const FOLLOWUP_FAILURE_GUIDANCE = "Count each failed run toward this thread's five-failed-run limit, including failures in your own tests/harness. "
  + 'If product behaviour already passed, ship it and report rather than repairing test scaffolding. '
  + 'After five failed runs, stop and report what works and the blocker.'
export const receiptKey = id => `wizard-helper-receipt-${id}`
export const completionDelegationId = text => typeof text === 'string' ? text.match(/^\[ASYNC DELEGATION BATCH COMPLETE\s*[—-]\s*(deleg_[A-Za-z0-9_-]+)\]/u)?.[1] : undefined
export const internalHelperMessage = text => /^\s*\[(?:ASYNC DELEGATION BATCH COMPLETE|Wizard follow-through|CONTEXT COMPACTION|CONTEXT SUMMARY|PRIOR CONTEXT|IMPORTANT:|System:|Your active task list|Your previous agent loop|Agent-to-agent|supervisor (?:update|build|review|question|closed)|Wizard schedule|Wizard heavy-work (?:completion|notice)|Owner requested recovery|James requested recovery|STILL IN PROGRESS)/u.test(text)
// Machinery row kinds. Hermes 0.22.7 also persists every canonical /v1/runs admission, the owner's own
// messages included, as internal_notification stamped with the admission's submission_id; a gateway
// self-injected wake carries none. A submitted turn is judged by its text, as before that release.
// Otherwise every owner reply vanishes, an older needs_you looks current, and finished helpers never wake.
export const MACHINERY_USER_KINDS = new Set(['system','async_delegation_complete','internal_notification','hidden','commentary'])
export function submittedTurn(row) {
  if (row?.display_kind !== 'internal_notification' || !row.display_metadata) return false
  try {
    const meta = typeof row.display_metadata === 'string' ? JSON.parse(row.display_metadata) : row.display_metadata
    return typeof meta?.submission_id === 'string' && meta.submission_id.length > 0
  } catch { return false }
}
export const machineryKind = row => MACHINERY_USER_KINDS.has(row?.display_kind) && !submittedTurn(row)
// SELECT fragment: display_kind plus the metadata that tells a submitted turn from a gateway wake.
export const displayColumns = columns => !columns.has('display_kind') ? ''
  : columns.has('display_metadata') ? ',display_kind,display_metadata' : ',display_kind'
export const isHumanRequest = row => row.role === 'user' && Boolean(String(row.content || '').trim())
  && !internalHelperMessage(row.content || '')
  && !machineryKind(row)
  && !String(row.display_kind || '').startsWith('process_wakeup')
  && !/^(?:Your previous turn indicated a tool call|You just executed tool calls but returned an empty response|Workline browser QA found a concrete regression)/u.test(String(row.content || '').trim())
// Inactive compaction history is retained; rewound/deleted turns are not.
// Older schemas without compacted must never grant inactive rows authority.
export const retainedMessagesWhere = columns => !columns.has('active') ? '1'
  : `(COALESCE(active,1)=1${columns.has('compacted') ? ' OR (active=0 AND compacted=1)' : ''})`
const internal = internalHelperMessage

export function currentOwnerResult(db, sessionId) {
  const columns = new Set(preparedRead(db, 'PRAGMA table_info(messages)').all().map(r=>r.name))
  // Compaction changes model context, not the owner's request/answer boundary.
  // Only compacted inactive rows remain authoritative for gates and supersession.
  const kind = displayColumns(columns)
  const rows = preparedRead(db, `SELECT role, content, timestamp ${kind} FROM messages WHERE session_id=?
    AND ${retainedMessagesWhere(columns)} AND role IN ('user','assistant') AND trim(COALESCE(content,''))<>'' ORDER BY timestamp DESC,id DESC LIMIT 513`).iterate(sessionId)
  let assistant, userAt=0, inspected=0
  for (const row of rows) {
    inspected++
    if (internal(row.content) || machineryKind(row)) continue
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
  const rows = preparedRead(db, `SELECT role,content FROM messages WHERE session_id=? AND timestamp>=?
    AND role IN ('user','tool') AND instr(COALESCE(content,''),?)>0
    ORDER BY timestamp DESC,id DESC LIMIT 513`).all(sessionId,after,id)
  // Incomplete evidence blocks automatic redelivery, never proves integration.
  return rows.length > 512 || rows.some(row => isReceiptDelivery(row,id))
}
// One SQL call for a bounded batch, with the exact per-receipt 513-row fence.
// The correlated seek uses the existing session index, never a global body scan.
export function receiptsConsumed(db, receipts) {
  if (!receipts.length) return []
  const input = receipts.map(row => [row.sessionId, row.id, Number.isFinite(Number(row.completedAt)) ? Number(row.completedAt) : 0])
  const rows = preparedRead(db, `SELECT r.key, (SELECT json_group_array(json_object('role',role,'content',content)) FROM (
    SELECT role,content FROM messages WHERE session_id=json_extract(r.value,'$[0]') AND timestamp>=json_extract(r.value,'$[2]')
      AND role IN ('user','tool') AND instr(COALESCE(content,''),json_extract(r.value,'$[1]'))>0
      ORDER BY timestamp DESC,id DESC LIMIT 513
    )) AS evidence FROM json_each(?) r`).all(JSON.stringify(input))
  return rows.map(row => {
    const evidence = JSON.parse(row.evidence)
    return evidence.length > 512 || evidence.some(message => isReceiptDelivery(message, receipts[Number(row.key)].id))
  })
}
export function continuationAllowed(path, sessionId, id, now=Date.now()) {
  if(!path || !existsSync(path)) return false
  let db
  try {
    db=new DatabaseSync(path,{readOnly:true})
    if (ownerGate(db,sessionId) || id && receiptConsumed(db,sessionId,id)) return false
    if(preparedRead(db, 'SELECT 1 FROM session_turn_leases WHERE conversation_id=? AND expires_at>? LIMIT 1').get(sessionId,now/1000)) return false
    return true
  } catch { return false } finally { db?.close() }
}
// The owner has taken the thread forward since the helper finished: the result is stale for this
// thread, and resuming it would override what the owner asked for next. It stays queryable in Hermes.
export function ownerMovedOn(db, sessionId, completedAt) {
  const columns = new Set(preparedRead(db, 'PRAGMA table_info(messages)').all().map(r=>r.name))
  const rows = preparedRead(db, `SELECT content ${displayColumns(columns)} FROM messages WHERE session_id=? AND role='user' AND timestamp>?
    AND ${retainedMessagesWhere(columns)} AND trim(COALESCE(content,''))<>'' ORDER BY timestamp DESC,id DESC LIMIT 513`).all(sessionId, Number(completedAt) || 0)
  return rows.length>512 || rows.some(row => isHumanRequest({ ...row, role: 'user' }))
}
// Automatic resumption is for the turn that was waiting on the helper; after two hours it is stale.
export function readUndeliveredHelperReceipts(path, {now=Date.now(),maxAgeSeconds=2*3600,includeDelivered=false,delegationId,db: suppliedDb,sessionIds}={}) {
  if(!path || !existsSync(path)) return []
  let db
  try {
    db=suppliedDb ?? new DatabaseSync(path,{readOnly:true})
    const columns=new Set(preparedRead(db, 'PRAGMA table_info(async_delegations)').all().map(r=>r.name))
    if(!['delegation_id','state','delivery_state','result_json','completed_at'].every(k=>columns.has(k))) return []
    const origins=['origin_session_id','parent_session_id','origin_ui_session_id'].filter(k=>columns.has(k))
    if(!origins.length) return []
    const origin=origins.length===1 ? origins[0] : `COALESCE(${origins.map(k=>`NULLIF(${k},'')`).join(',')})`
    const rows=preparedRead(db, `SELECT delegation_id,${origin} AS session_id,completed_at,result_json FROM async_delegations
      WHERE state IN ('completed','failed','interrupted') ${includeDelivered?'':"AND delivery_state IN ('pending','dropped')"}
      AND ${delegationId?'delegation_id=?':'completed_at>=?'} ${sessionIds ? `AND ${origin} IN (SELECT value FROM json_each(?))` : ''} ORDER BY completed_at`)
      .all(delegationId ?? now/1000-maxAgeSeconds, ...(sessionIds ? [JSON.stringify(sessionIds)] : []))
    const valid = rows.filter(row => /^(wizard_|wizard-assistant-)[A-Za-z0-9._:-]+$/.test(String(row.session_id||'')) && /^[A-Za-z0-9_-]+$/.test(String(row.delegation_id||'')))
    const consumed = receiptsConsumed(db, valid.map(row => ({ sessionId: String(row.session_id), id: String(row.delegation_id), completedAt: row.completed_at })))
    const receipts=[]
    for(const [index, row] of valid.entries()) {
      const sessionId=String(row.session_id||''),id=String(row.delegation_id||'')
      if(!/^(wizard_|wizard-assistant-)[A-Za-z0-9._:-]+$/.test(sessionId)||!/^[A-Za-z0-9_-]+$/.test(id)) continue
      if(consumed[index]||ownerGate(db,sessionId)) continue
      if(ownerMovedOn(db,sessionId,row.completed_at) || Number(row.completed_at)<now/1000-maxAgeSeconds) continue
      let results;try{results=JSON.parse(row.result_json)?.results}catch{continue}
      if(!Array.isArray(results)) continue
      const text=results.filter(r=>typeof r?.summary==='string'&&r.summary.trim()).map(r=>`Helper ${Number(r.task_index)+1} (${String(r.status||'unknown')}):\n${r.summary.trim()}`).join('\n\n')
      if(!text||text.length>60000) continue
      receipts.push({agent_id:'hermes',session_id:sessionId,sessionId,delegationId:id,at:Number(row.completed_at),key:receiptKey(id),statuses:results.map(r=>String(r?.status||'')),
        input:RECEIPT_PREFIX+id+'\nThese are saved helper findings, not verified completion. Check the receipt; do not blindly duplicate work. '+FOLLOWUP_FAILURE_GUIDANCE+' Preserve the latest user instructions, original release authority and explicit owner approval gates; new scope still needs authorization.\n\n'+text})
    }
    return receipts
  } catch{return []}finally{if (!suppliedDb) db?.close()}
}
// The running background delegation that launched this canonical Hermes child, from Hermes'
// own records only: the child row names its parent and delegate marker, and its kickoff
// message is one of that delegation's goals. Hermes stores no child id on the delegation,
// so overlapping candidates that cannot be told apart fail closed rather than guess.
// Same 6 h horizon as the helpers-running projection: a lost helper keeps no authority.
export function outstandingBackgroundDelegation(db, childSessionId, now=Date.now()) {
  const sessionColumns=new Set(preparedRead(db, 'PRAGMA table_info(sessions)').all().map(r=>r.name))
  if(!['parent_session_id','source','started_at','ended_at','model_config'].every(k=>sessionColumns.has(k))) return null
  const exists=preparedRead(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='async_delegations'").get()
  if(!exists) return null
  const columns=new Set(preparedRead(db, 'PRAGMA table_info(async_delegations)').all().map(r=>r.name))
  const origins=['origin_session_id','parent_session_id','origin_ui_session_id'].filter(k=>columns.has(k))
  if(!origins.length || !['delegation_id','state','dispatched_at','completed_at','task_json'].every(k=>columns.has(k))) return null
  const child=preparedRead(db, 'SELECT parent_session_id,source,started_at,ended_at,model_config FROM sessions WHERE id=?').get(childSessionId)
  const parent=String(child?.parent_session_id||'')
  if(!parent || child.source!=='subagent' || child.ended_at!=null || !Number.isFinite(Number(child.started_at))) return null
  let config; try { config=JSON.parse(child.model_config||'{}') } catch { return null }
  if(config?._delegate_from!==parent) return null
  // Compaction may deactivate the kickoff row, never renumber it: the first id is the kickoff.
  const kickoff=String(preparedRead(db, "SELECT content FROM messages WHERE session_id=? AND role='user' ORDER BY id LIMIT 1").get(childSessionId)?.content||'')
  if(!kickoff.trim()) return null
  const origin=`COALESCE(${origins.map(k=>`NULLIF(${k},'')`).join(',')},'')`
  const rows=preparedRead(db, `SELECT delegation_id,task_json FROM async_delegations WHERE ${origin}=?
    AND state IN ('running','stalling','finalizing') AND completed_at IS NULL AND dispatched_at>? AND dispatched_at<=?
    ORDER BY dispatched_at DESC LIMIT 33`).all(parent, now/1000-6*3600, Number(child.started_at)+30)
  const matches=rows.filter(row => {
    let goals; try { goals=JSON.parse(row.task_json||'{}')?.goals } catch { return false }
    // Attachments are appended after the goal text in the kickoff message.
    return Array.isArray(goals) && goals.some(goal => typeof goal==='string' && goal.trim() && kickoff.startsWith(goal))
  })
  return rows.length<33 && matches.length===1 && matches[0].delegation_id
    ? { delegationId: String(matches[0].delegation_id), sessionId: parent } : null
}
export function findIdleUndeliveredHelperReceipts(path,options={}) {
  return readUndeliveredHelperReceipts(path,options).filter(r=>continuationAllowed(path,r.sessionId,r.delegationId,options.now??Date.now()))
}
