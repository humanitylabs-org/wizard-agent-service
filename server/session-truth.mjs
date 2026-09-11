import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const USER_EVENT_KINDS = new Set(['async_delegation_complete', 'internal_notification', 'system'])
const INTERNAL_ASSISTANT_KINDS = new Set([...USER_EVENT_KINDS, 'commentary', 'hidden'])
const INTERNAL_USER_PREFIXES = [
  '[IMPORTANT: Background process ',
  '[ASYNC DELEGATION BATCH COMPLETE',
  '[CONTEXT COMPACTION — REFERENCE ONLY]',
  '[CONTEXT SUMMARY]:',
  '[PRIOR CONTEXT — for reference only; not a new message]',
  '[Your active task list was preserved across context compression]',
  '[Your previous agent loop was paused',
  '[James requested recovery of this interrupted Helm card.]',
  '[STILL IN PROGRESS',
  'Workline browser QA found a concrete regression in ',
]

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
  if (!text || USER_EVENT_KINDS.has(kind) || kind.startsWith('process_wakeup')) return false
  return !INTERNAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function visibleAssistantReply(content, displayKind, finishReason) {
  const text = typeof content === 'string' ? content.trim() : ''
  const kind = String(displayKind || '')
  const completion = String(finishReason || '')
  const completed = kind === 'final' || Boolean(completion && !['tool_calls', 'function_call', 'cancelled', 'interrupted', 'error'].includes(completion))
  if (!text || !completed || INTERNAL_ASSISTANT_KINDS.has(kind) || kind.startsWith('process_wakeup')) return false
  return !INTERNAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix))
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
    const messageRows = db.prepare(`
      SELECT session_id, role, finish_reason, timestamp, content, display_kind
      FROM messages
      WHERE session_id IN (${placeholders})
        AND role IN ('user', 'assistant')
        AND active = 1
        AND trim(COALESCE(content, '')) <> ''
      ORDER BY timestamp DESC
    `).all(...ids)
    for (const row of messageRows) {
      const id = String(row.session_id || '')
      const current = truth.get(id)
      if (!current) continue
      const timestamp = Number(row.timestamp) || 0
      const visibleUser = row.role === 'user' && visibleUserRequest(row.content, row.display_kind)
      const visibleAssistant = row.role === 'assistant' && visibleAssistantReply(row.content, row.display_kind, row.finish_reason)
      if (!current.activityAt && (visibleUser || visibleAssistant)) current.activityAt = timestamp
      if (!current.lastUserAt && visibleUser) {
        current.lastUserAt = timestamp
        current.requestPreview = row.content.trim()
      }
      if (!current.lastAssistantAt && visibleAssistant) current.lastAssistantAt = timestamp
    }
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

export function readWizardAssistantRunReferences(path, sessionIds, nowSeconds = Date.now() / 1000) {
  const ids = boundedIds(sessionIds)
  const latestBySession = new Map()
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
      const runId = String(row.run_id || '')
      if (!sessionId || latestBySession.has(sessionId)) continue
      if (/^[A-Za-z0-9._:-]+$/.test(runId)) {
        latestBySession.set(sessionId, { sessionId, runId })
        continue
      }
      const createdAt = Number(row.created_at) || 0
      if (!runId && createdAt > 0 && createdAt + PENDING_ASSISTANT_ADMISSION_SECONDS >= nowSeconds) {
        latestBySession.set(sessionId, { sessionId, runId: '', status: 'running' })
      }
    }
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
  return [...latestBySession.values()]
}
