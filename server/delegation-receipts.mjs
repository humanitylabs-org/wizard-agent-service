// Read-only recovery of stock Hermes helper receipts which never reached their parent.
// A helper's execution state and its delivery state are separate facts.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { parseStatus } from './thread-status.mjs'

export const RECEIPT_PREFIX = '[Wizard follow-through] Recovered helper receipt '
export const receiptKey = (id) => `wizard-helper-receipt-${id}`
export function readUndeliveredHelperReceipts(path, { now = Date.now(), maxAgeSeconds = 6 * 3600 } = {}) {
  if (!path || !existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(async_delegations)').all().map(r => r.name))
    if (!['delegation_id', 'state', 'delivery_state', 'result_json', 'completed_at'].every(k => columns.has(k))) return []
    const origins = ['origin_session_id', 'parent_session_id', 'origin_ui_session_id'].filter(k => columns.has(k))
    if (!origins.length) return []
    const origin = `COALESCE(${origins.map(k => `NULLIF(${k}, '')`).join(', ')})`
    const rows = db.prepare(`SELECT delegation_id, ${origin} AS session_id, completed_at, result_json
      FROM async_delegations WHERE state IN ('completed', 'failed', 'interrupted')
      AND delivery_state IN ('pending', 'dropped') AND completed_at >= ? ORDER BY completed_at`).all(now / 1000 - maxAgeSeconds)
    const receipts = []
    for (const row of rows) {
      const sessionId = String(row.session_id || '')
      const id = String(row.delegation_id || '')
      if (!/^(wizard_|wizard-assistant-)[A-Za-z0-9._:-]+$/.test(sessionId) || !/^[A-Za-z0-9_-]+$/.test(id)) continue
      // A successful recovery admission is durable in the canonical conversation. Never replay
      // an old snapshot after restart, even if Hermes still calls its delivery pending/dropped.
      const marker = RECEIPT_PREFIX + id + '\n'
      if (db.prepare(`SELECT 1 FROM messages WHERE session_id = ? AND role = 'user'
        AND instr(COALESCE(content, ''), ?) > 0 LIMIT 1`).get(sessionId, marker)) continue
      // Do not revive completed work or override a real owner decision written after the receipt.
      const latest = db.prepare(`SELECT content, timestamp FROM messages WHERE session_id = ?
        AND role = 'assistant' AND COALESCE(active, 1) = 1 AND trim(COALESCE(content, '')) <> ''
        AND COALESCE(tool_calls, '') IN ('', '[]') ORDER BY timestamp DESC, id DESC LIMIT 1`).get(sessionId)
      if (Number(latest?.timestamp) >= Number(row.completed_at) && ['done', 'needs_you', 'check'].includes(parseStatus(latest?.content)?.state)) continue
      let results
      try { results = JSON.parse(row.result_json)?.results } catch { continue }
      if (!Array.isArray(results)) continue
      // Recover genuine summaries only; no tool traces, credentials, fabricated results or claims.
      const text = results.filter(r => typeof r?.summary === 'string' && r.summary.trim())
        .map(r => `Helper ${Number(r.task_index) + 1} (${String(r.status || 'unknown')}):\n${r.summary.trim()}`).join('\n\n')
      if (!text || text.length > 60000) continue
      receipts.push({ sessionId, delegationId: id, at: Number(row.completed_at), key: receiptKey(id),
        input: marker + 'The original delivery failed. These are saved helper findings, not verified completion. Continue the original request through its remaining acceptance checks. Preserve the latest user instructions and original release authority. Keep internal progress in Working; return a final answer only when there is a verified result or one specific owner-only gate.\n\n' + text })
    }
    return receipts
  } catch { return [] } finally { db.close() }
}

export function findIdleUndeliveredHelperReceipts(path, options = {}) {
  const rows = readUndeliveredHelperReceipts(path, options)
  if (!rows.length) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const nowSeconds = Number(options.now ?? Date.now()) / 1000
    let leased
    try { leased = new Set(db.prepare('SELECT conversation_id FROM session_turn_leases WHERE expires_at > ?').all(nowSeconds).map(r => r.conversation_id)) }
    catch { return [] } // Fail closed: no parent concurrency proof, no automatic recovery.
    return rows.filter(r => !leased.has(r.sessionId))
  } finally { db.close() }
}
