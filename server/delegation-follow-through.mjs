// Delegation follow-through for agents that cannot join delegated work inside a run.
//
// Stock Hermes runs delegate_task in the background for a stateful API session: the run ends with
// "the subagent is working", and the subagent's result is saved into the thread as a user-role
// "[ASYNC DELEGATION BATCH COMPLETE …]" row that the agent only reads on the next turn. Hermes
// deliberately never wakes the model by itself for API sessions; the client owns the next turn.
//
// The Agent Service is that client. This watcher finds Wizard threads whose newest message is such a
// completion row, with no turn running, and starts one continuation run so the agent finishes the
// original request without the person having to say anything. Each completion row is followed up
// at most once (idempotency key = session + row id).
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { findIdleUndeliveredHelperReceipts } from './delegation-receipts.mjs'

export const FOLLOW_THROUGH_PREFIX = '[ASYNC DELEGATION BATCH COMPLETE'
// Wizard app threads and phone-intake (Wizard Inbox) threads both show in Wizard, so both get the next turn.
export const FOLLOW_THROUGH_SESSION_PREFIXES = ['wizard_', 'wizard-assistant-']
export const FOLLOW_THROUGH_INPUT = '[Wizard follow-through] The delegated results above have arrived. Finish the original request now, in one self-contained reply.'

/** Sessions waiting on a follow-through: newest active message is a completion row, no live turn. */
export function findPendingFollowThroughs(sessionDbPath, { now = Date.now(), maxAgeSeconds = 2 * 3600, sessionPrefixes = FOLLOW_THROUGH_SESSION_PREFIXES } = {}) {
  if (!sessionDbPath || !existsSync(sessionDbPath)) return []
  const database = new DatabaseSync(sessionDbPath, { readOnly: true })
  try {
    const nowSeconds = now / 1000
    const rows = database.prepare(`
      SELECT m.session_id AS session_id, m.id AS message_id, m.timestamp AS at
        FROM messages m
        JOIN (SELECT session_id, MAX(id) AS id FROM messages WHERE COALESCE(active, 1) = 1 GROUP BY session_id) latest
          ON latest.session_id = m.session_id AND latest.id = m.id
       WHERE m.role = 'user'
         AND m.timestamp >= ?
         AND substr(m.content, 1, ${FOLLOW_THROUGH_PREFIX.length}) = ?
    `).all(nowSeconds - maxAgeSeconds, FOLLOW_THROUGH_PREFIX)
    let leased = new Set()
    try {
      leased = new Set(database.prepare('SELECT conversation_id FROM session_turn_leases WHERE expires_at > ?').all(nowSeconds).map((row) => String(row.conversation_id)))
    } catch { /* older Hermes without leases */ }
    return rows
      .map((row) => ({ sessionId: String(row.session_id), messageId: Number(row.message_id), at: Number(row.at) }))
      .filter((row) => sessionPrefixes.some((prefix) => row.sessionId.startsWith(prefix)) && !leased.has(row.sessionId))
  } finally {
    database.close()
  }
}

/**
 * Start the watcher. `admit(sessionId, input, idempotencyKey)` submits one run through the service's
 * normal admission path. `enabled()` is checked every tick so it turns itself off on agents that
 * join delegated work inside the run.
 */
export function startDelegationFollowThrough({ sessionDbPath, admit, enabled, intervalMs = 5000, log = () => {} }) {
  const done = new Set()
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      if (!(await enabled())) return
      const completions = findPendingFollowThroughs(sessionDbPath)
      const completionSessions = new Set(completions.map(row => row.sessionId))
      const receipts = findIdleUndeliveredHelperReceipts(sessionDbPath).filter(row => !completionSessions.has(row.sessionId))
      for (const pending of [...completions, ...receipts]) {
        const key = pending.key ?? `wizard-follow-through-${pending.sessionId}-${pending.messageId}`
        if (done.has(key)) continue
        done.add(key)
        try {
          await admit(pending.sessionId, pending.input ?? FOLLOW_THROUGH_INPUT, key)
          log(`follow-through started for ${pending.sessionId} (${pending.delegationId ?? `row ${pending.messageId}`})`)
        } catch (error) {
          done.delete(key)
          log(`follow-through failed for ${pending.sessionId}: ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      log(`follow-through scan failed: ${error?.message ?? error}`)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}
