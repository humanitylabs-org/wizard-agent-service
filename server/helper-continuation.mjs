// Service-owned continuation identity. No browser field or header can create this authority.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { ownerGate, ownerMovedOn, receiptConsumed, completionDelegationId } from './delegation-receipts.mjs'
import { parseStatus } from './thread-status.mjs'

export const INTERNAL_HELPER_MESSAGE = /^\s*\[(?:ASYNC DELEGATION BATCH COMPLETE|Wizard follow-through|CONTEXT COMPACTION|CONTEXT SUMMARY|PRIOR CONTEXT|IMPORTANT:|System:|Your active task list|Your previous agent loop)/u
export const isHumanRequest = row => row.role === 'user' && Boolean(String(row.content || '').trim())
  && !INTERNAL_HELPER_MESSAGE.test(row.content || '')
  && !['system','async_delegation_complete','internal_notification','hidden','commentary'].includes(row.display_kind)

// IDs, not timestamps alone: a newly inserted backdated/same-timestamp request also invalidates work.
export function requestWatermark(db, sessionId) {
  const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map(r => r.name))
  const rows = db.prepare(`SELECT id,role,content,timestamp ${cols.has('display_kind') ? ',display_kind' : ''}
    FROM messages WHERE session_id=? AND role='user' ${cols.has('active') ? 'AND COALESCE(active,1)=1' : ''}
    ORDER BY id DESC LIMIT 513`).all(sessionId)
  const row = rows.find(isHumanRequest)
  if (!row && rows.length > 512) return null // incomplete history is not authority to resume
  return row ? { id: Number(row.id), at: Number(row.timestamp), fingerprint: createHash('sha256').update(row.content).digest('hex') } : { id: 0, at: 0, fingerprint: '' }
}
export function captureContinuation(path, pending) {
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const watermark = requestWatermark(db, pending.sessionId)
    if (!watermark) return null
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='async_delegations'").get()
    const row = pending.delegationId && exists ? db.prepare('SELECT completed_at FROM async_delegations WHERE delegation_id=?').get(pending.delegationId) : null
    return { sessionId: pending.sessionId, delegationId: pending.delegationId || '', messageId: pending.delegationId ? 0 : pending.messageId || 0,
      completedAt: row ? Number(row.completed_at) : pending.at, request: watermark }
  } catch { return null } finally { db?.close() }
}
export function helperAnswerAfter(db, sessionId, completedAt, delegationId) {
  const rows = db.prepare(`SELECT role,content,timestamp,display_kind FROM messages WHERE session_id=?
    AND timestamp>=? AND COALESCE(active,1)=1 ORDER BY timestamp DESC,id DESC LIMIT 513`).all(sessionId, completedAt)
  if (rows.length > 512) return null // unknown, not invented evidence of an answered completion
  const completion = rows.find(r => r.role === 'user' && completionDelegationId(r.content) === delegationId)
  return Boolean(completion && rows.some(r => r.role === 'assistant' && Number(r.timestamp) > Number(completion.timestamp)
    && !['commentary','hidden','internal_notification','system'].includes(r.display_kind)
    && /\[\/WIZARD_STATUS_V1\]\s*$/u.test(r.content || '')
    && ['done','needs_you','check'].includes(parseStatus(r.content)?.state)))
}
export function continuationCurrent(path, token, now = Date.now(), { allowActive = false } = {}) {
  if (!token?.request || !token.sessionId) return false
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const current = requestWatermark(db, token.sessionId)
    if (!current || JSON.stringify(current) !== JSON.stringify(token.request) || ownerGate(db, token.sessionId)) return false
    if (!allowActive && db.prepare('SELECT 1 FROM session_turn_leases WHERE conversation_id=? AND expires_at>? LIMIT 1').get(token.sessionId, now/1000)) return false
    let at = Number(token.completedAt)
    if (token.delegationId) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='async_delegations'").get()
      if (exists) {
        const row = db.prepare('SELECT * FROM async_delegations WHERE delegation_id=?').get(token.delegationId)
        if (!row || !['completed','failed','interrupted'].includes(row.state)) return false
        const origin = row.origin_session_id || row.parent_session_id || row.origin_ui_session_id || ''
        if (origin !== token.sessionId) return false
        at = Number(row.completed_at)
        if (at !== Number(token.completedAt)) return false
      }
      if (receiptConsumed(db, token.sessionId, token.delegationId, at)) return false
      const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map(r => r.name))
      if (cols.has('display_kind') && helperAnswerAfter(db, token.sessionId, at, token.delegationId) !== false) return false
    } else {
      const message = db.prepare('SELECT role,content,timestamp FROM messages WHERE session_id=? AND id=?').get(token.sessionId, token.messageId)
      if (!message || message.role !== 'user' || !INTERNAL_HELPER_MESSAGE.test(message.content)) return false
      at = Number(message.timestamp)
    }
    return Number.isFinite(at) && at <= now/1000 && now/1000-at <= 2*3600 && !ownerMovedOn(db, token.sessionId, at)
  } catch { return false } finally { db?.close() }
}

export function requireCurrentContinuation(path, token, now) {
  if (!continuationCurrent(path, token, now, { allowActive: true })) throw Object.assign(new Error('Helper request is no longer current'), { status: 410 })
  if (!continuationCurrent(path, token, now)) throw Object.assign(new Error('The owner still holds this turn'), { status: 503 })
}

// Browser mutation boundary; Host is checked directly, never attacker-supplied forwarded headers.
// Missing Origin is allowed only for non-browser clients with no fetch metadata (or same-origin).
export function helperContinueRequestAllowed(request, { authenticated = false, trustedOrigins = [] } = {}) {
  if (!/^application\/json(?:\s*;[^\r\n]*)?$/i.test(request.headers['content-type'] || '')) return 415
  const site = request.headers['sec-fetch-site'], origin = request.headers.origin, host = request.headers.host
  if (site !== undefined && site !== 'same-origin') return 403
  if (typeof host !== 'string' || !host || /[\s,\/@\\]/u.test(host)) return 403
  const localPort = request.socket?.localPort
  const loopbackHosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`]
  const configured = trustedOrigins.filter(value => {
    try { const parsed=new URL(value);return parsed.origin===value && ['http:','https:'].includes(parsed.protocol) } catch { return false }
  })
  // An unauthenticated local service must not trust attacker-controlled Host=Origin equality
  // (DNS rebinding). Public no-Access installations explicitly configure their browser origins.
  if (!authenticated && !loopbackHosts.includes(host) && !configured.some(value => new URL(value).host === host)) return 403
  if (origin !== undefined) {
    if (typeof origin !== 'string' || origin === 'null') return 403
    try {
      const url = new URL(origin)
      if (!['http:','https:'].includes(url.protocol) || url.origin !== origin || url.host !== host || url.username || url.password) return 403
      if (configured.length && !configured.includes(origin)) return 403
      if (!authenticated && !configured.includes(origin) && url.protocol !== (request.socket?.encrypted ? 'https:' : 'http:')) return 403
    } catch { return 403 }
  } else if (site !== undefined) return 403
  return 0
}
