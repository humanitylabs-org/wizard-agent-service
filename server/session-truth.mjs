import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readUndeliveredHelperReceipts, completionDelegationId, receiptConsumed, ownerGate } from './delegation-receipts.mjs'

const USER_EVENT_KINDS = new Set(['async_delegation_complete', 'internal_notification', 'system'])
const INTERNAL_ASSISTANT_KINDS = new Set([...USER_EVENT_KINDS, 'commentary', 'hidden'])
const INTERNAL_USER_PREFIXES = [
  '[System: Your previous response contained only internal reasoning and never produced a ',
  '[System: Continue now. Execute the required tool calls ',
  '[System: The previous response was cut off by a network error mid-stream.',
  '[System: Your previous response was truncated by the output length limit.',
  'Your previous turn indicated a tool call but none was included.',
  'You just executed tool calls but returned an empty response.',
  '[IMPORTANT: Background process ',
  '[ASYNC DELEGATION BATCH COMPLETE',
  '[Wizard follow-through]',
  '[CONTEXT COMPACTION — REFERENCE ONLY]',
  '[CONTEXT SUMMARY]:',
  '[PRIOR CONTEXT — for reference only; not a new message]',
  '[Your active task list was preserved across context compression]',
  '[Your previous agent loop was paused',
  '[James requested recovery of this interrupted Helm card.]',
  '[STILL IN PROGRESS',
  'Workline browser QA found a concrete regression in ',
]
const EMPTY_TOOL_RESPONSE_NUDGE = 'You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.'

function boundedIds(values, limit = 200) {
  return [...new Set(values.filter((value) => typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value)).slice(0, limit))]
}

function openReadOnly(path) {
  if (!path || !existsSync(path)) return null
  try { return new DatabaseSync(path, { readOnly: true }) }
  catch { return null }
}

function visibleUserRequest(content, displayKind) {
  const text = typeof content === 'string' ? content.trim() : ''
  const kind = String(displayKind || '')
  if (!text || text === EMPTY_TOOL_RESPONSE_NUDGE || USER_EVENT_KINDS.has(kind) || kind.startsWith('process_wakeup')) return false
  return !/^\[IMPORTANT: \d+ background processes completed for this session\./.test(text) && !INTERNAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function visibleAssistantReply(content, displayKind, finishReason) {
  const text = typeof content === 'string' ? content.trim() : ''
  const kind = String(displayKind || '')
  const completion = String(finishReason || '')
  const completed = kind === 'final' || Boolean(completion && !['tool_calls', 'function_call', 'cancelled', 'interrupted', 'error'].includes(completion))
  if (!text || text === '(empty)' || !completed || INTERNAL_ASSISTANT_KINDS.has(kind) || kind.startsWith('process_wakeup')) return false
  return !/^\[IMPORTANT: \d+ background processes completed for this session\./.test(text) && !INTERNAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix))
}

const ROUTE_PART = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}(?:\[[0-9a-z]{1,8}\])?(?![\s\S])/

function lockedRoute(modelConfig) {
  if (typeof modelConfig !== 'string' || !modelConfig) return null
  try {
    const lock = JSON.parse(modelConfig)?.browser_model_lock
    const model = typeof lock?.model === 'string' ? lock.model : ''
    const provider = typeof lock?.provider === 'string' ? lock.provider : ''
    return ROUTE_PART.test(model) && ROUTE_PART.test(provider) ? { model, provider, updatedAt: Number(lock.updated_at) || 0 } : null
  } catch { return null }
}

export function readHermesSessionTruth(path, sessionIds, nowSeconds = Date.now() / 1000) {
  const ids = boundedIds(sessionIds)
  const truth = new Map()
  if (!ids.length) return truth
  const db = openReadOnly(path)
  if (!db) return truth
  try {
    const placeholders = ids.map(() => '?').join(',')
    const sessionRows = db.prepare(`SELECT id, started_at FROM sessions WHERE id IN (${placeholders})`).all(...ids)
    for (const row of sessionRows) truth.set(String(row.id), {
      startedAt: Number.isFinite(Number(row.started_at)) ? Number(row.started_at) : 0,
      lastUserAt: 0,
      lastAssistantAt: 0,
      activityAt: 0,
      requestPreview: '',
      active: false,
    })
    // Hermes' session API omits provider. A thread's exact model lock is the only
    // trustworthy route; billing_provider can name a different account.
    try {
      const routeRows = db.prepare(`SELECT id, model, model_config FROM sessions WHERE id IN (${placeholders})`).all(...ids)
      for (const row of routeRows) {
        const current = truth.get(String(row.id))
        const lock = lockedRoute(row.model_config)
        if (current && lock && lock.model === row.model) {
          current.route = { model: lock.model, provider: lock.provider }
          current.routeUpdatedAt = lock.updatedAt
        }
      }
    } catch { /* older state schemas carry no model lock */ }
    // Seek newest-first within each session's existing indexed range. Loading
    // every historical body for a whole Work page blocks the shared HTTP loop;
    // only the newest visible request and completed reply determine this view.
    const recentMessages = db.prepare(`
      SELECT role, finish_reason, timestamp, content, display_kind
      FROM messages
      WHERE session_id = ?
        AND role IN ('user', 'assistant')
        AND active = 1
        AND trim(COALESCE(content, '')) <> ''
      ORDER BY timestamp DESC
    `)
    for (const [id, current] of truth) {
      for (const row of recentMessages.iterate(id)) {
        const timestamp = Number(row.timestamp) || 0
        const visibleUser = row.role === 'user' && visibleUserRequest(row.content, row.display_kind)
        const visibleAssistant = row.role === 'assistant' && visibleAssistantReply(row.content, row.display_kind, row.finish_reason)
        if (!current.activityAt && (visibleUser || visibleAssistant)) current.activityAt = timestamp
        if (!current.lastUserAt && visibleUser) {
          current.lastUserAt = timestamp
          current.requestPreview = row.content.trim()
        }
        if (!current.lastAssistantAt && visibleAssistant) current.lastAssistantAt = timestamp
        if (current.lastUserAt && current.lastAssistantAt) break
      }
    }
    // Helpers the agent dispatched in the background (stock Hermes delegate_task). While one runs, or its
    // result is saved but the agent has not answered yet, the thread is still working for the owner: the
    // "I've delegated this" reply is progress, not something to act on. Capped at 6 h so a lost helper
    // cannot pin a thread in Working forever.
    try {
      const helperRows = db.prepare(`
        SELECT origin_session_id AS id, COUNT(*) AS n
        FROM async_delegations
        WHERE state IN ('running', 'stalling', 'finalizing') AND dispatched_at > ?
          AND origin_session_id IN (${placeholders})
        GROUP BY origin_session_id
      `).all(nowSeconds - 6 * 3600, ...ids)
      for (const row of helperRows) {
        const current = truth.get(String(row.id || ''))
        if (current && !ownerGate(db, String(row.id))) current.helpersRunning = Number(row.n) || 0
      }
    } catch { /* agents without background delegation */ }
    // Completion can precede the parent's handoff, and failed delivery leaves no message at all.
    // Read delivery receipts independently of the latest transcript row and execution state.
    for (const receipt of readUndeliveredHelperReceipts(path, { now: nowSeconds * 1000 })) {
      const current = truth.get(receipt.sessionId)
      if (current) current.helperResultUnanswered = true
    }
    try {
      const newestRow = db.prepare(`
        SELECT role, content, timestamp FROM messages
        WHERE session_id = ? AND active = 1
        ORDER BY timestamp DESC LIMIT 1
      `)
      for (const [id, current] of truth) {
        const row = newestRow.get(id)
        const delegationId = completionDelegationId(row?.content)
        if (row?.role === 'user' && typeof row.content === 'string' && row.content.startsWith('[ASYNC DELEGATION BATCH COMPLETE')
          && Number(row.timestamp) > nowSeconds - 6 * 3600 && !ownerGate(db, id)
          && !(delegationId && receiptConsumed(db, id, delegationId))) current.helperResultUnanswered = true
      }
    } catch { /* unreadable newest row: no helper wait */ }
    const leaseRows = db.prepare(`
      SELECT conversation_id
      FROM session_turn_leases
      WHERE expires_at > ? AND conversation_id IN (${placeholders})
    `).all(nowSeconds, ...ids)
    for (const row of leaseRows) {
      const current = truth.get(String(row.conversation_id || ''))
      if (current) current.active = true
    }
  } catch {
    return new Map()
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
  return truth
}

export function readHelmActivitySessionIds(path, activityIds) {
  const ids = boundedIds(activityIds)
  const sessions = new Map()
  if (!ids.length) return sessions
  const db = openReadOnly(path)
  if (!db) return sessions
  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`SELECT activity_id, session_id FROM activities WHERE activity_id IN (${placeholders})`).all(...ids)
    for (const row of rows) {
      const sessionId = String(row.session_id || '')
      if (sessionId) sessions.set(String(row.activity_id), sessionId)
    }
  } catch {
    return new Map()
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
  return sessions
}

const PENDING_ASSISTANT_ADMISSION_SECONDS = 120

export function readWizardAssistantRunReferences(path, sessionIds, nowSeconds = Date.now() / 1000, boundWindowSeconds = Number.POSITIVE_INFINITY) {
  const ids = boundedIds(sessionIds)
  const latestBySession = new Map()
  const seenSessions = new Set()
  if (!ids.length) return []
  const db = openReadOnly(path)
  if (!db) return []
  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT session_id, run_id, admission_status, created_at
      FROM assistant_requests
      WHERE session_id IN (${placeholders})
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
    `).all(...ids)
    for (const row of rows) {
      const sessionId = String(row.session_id || '')
      if (!sessionId || seenSessions.has(sessionId)) continue
      seenSessions.add(sessionId)
      const runId = typeof row.run_id === 'string' ? row.run_id : ''
      const createdAt = Number(row.created_at) || 0
      const boundIsRecent = createdAt >= nowSeconds - boundWindowSeconds && createdAt <= nowSeconds + 5
      if (/^[A-Za-z0-9._:-]+$/.test(runId) && boundIsRecent) {
        latestBySession.set(sessionId, { sessionId, runId, createdAt })
        continue
      }
      if (row.run_id === null && row.admission_status === null
        && createdAt >= nowSeconds - PENDING_ASSISTANT_ADMISSION_SECONDS && createdAt <= nowSeconds + 5) {
        latestBySession.set(sessionId, { sessionId, runId: '', status: 'running', createdAt })
      }
    }
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
  return [...latestBySession.values()]
}

export function readWizardAssistantRevision(path) {
  const db = openReadOnly(path)
  if (!db) return ''
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(run_id IS NULL), 0) AS pending,
             COALESCE(MAX(rowid), 0) AS latest_id,
             COALESCE(MAX(updated_at), 0) AS latest_update
      FROM assistant_requests
    `).get()
    return [row.total, row.pending, row.latest_id, row.latest_update].map((value) => Number(value) || 0).join(':')
  } catch {
    return ''
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
}

export function readPendingWizardAssistantAdmissions(path, sessionIds, nowSeconds = Date.now() / 1000) {
  const ids = boundedIds(sessionIds)
  const seenSessions = new Set()
  const pending = []
  if (!ids.length) return []
  const db = openReadOnly(path)
  if (!db) return []
  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT session_id, run_id, admission_status, created_at
      FROM assistant_requests
      WHERE session_id IN (${placeholders})
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
    `).all(...ids)
    for (const row of rows) {
      const sessionId = String(row.session_id || '')
      if (!sessionId || seenSessions.has(sessionId)) continue
      seenSessions.add(sessionId)
      const createdAt = Number(row.created_at) || 0
      if (row.run_id === null && row.admission_status === null
        && createdAt >= nowSeconds - PENDING_ASSISTANT_ADMISSION_SECONDS && createdAt <= nowSeconds + 5) {
        pending.push({ sessionId, runId: '', status: 'running' })
      }
    }
    return pending
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
}
