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
// at most once (delegation identity when available, otherwise session + row id). Portable installs
// inject the HTTP finder; an explicitly configured Hermes state path also enables receipt recovery.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { findIdleUndeliveredHelperReceipts, readUndeliveredHelperReceipts, completionDelegationId, receiptKey, ownerGate, receiptConsumed, continuationAllowed, RECEIPT_PREFIX } from './delegation-receipts.mjs'
import { captureContinuation, continuationCurrent } from './helper-continuation.mjs'

export const FOLLOW_THROUGH_PREFIX = '[ASYNC DELEGATION BATCH COMPLETE'
// Wizard app threads and phone-intake (Wizard Inbox) threads both show in Wizard, so both get the next turn.
export const FOLLOW_THROUGH_SESSION_PREFIXES = ['wizard_', 'wizard-assistant-']
export const FOLLOW_THROUGH_INPUT = '[Wizard follow-through] The delegated results above have arrived. Finish the original request now, in one self-contained reply.'

// Newest active message per eligible thread, when it is a recent completion row. Grouping MAX(id)
// over every message took ~250 ms of the shared loop every 5 s (3 M rows). Instead, walk the
// distinct prefixed session ids with index seeks (a loose index scan) and seek each one's newest
// row through (session_id, id). Same rows, a fraction of the cost; unprefixed threads were always
// filtered out below, so they are never read.
const prefixUpperBound = (prefix) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
function newestFollowThroughRows(database, sessionPrefixes, cutoffSeconds) {
  const prefixes = [...new Set(sessionPrefixes.filter((prefix) => typeof prefix === 'string' && prefix))]
  const distinct = database.prepare(`
    WITH RECURSIVE ids(id) AS (
      SELECT MIN(session_id) FROM messages WHERE session_id >= ? AND session_id < ?
      UNION ALL
      SELECT (SELECT MIN(session_id) FROM messages WHERE session_id > ids.id AND session_id < ?) FROM ids WHERE ids.id IS NOT NULL
    ) SELECT id FROM ids WHERE id IS NOT NULL
  `)
  const newest = database.prepare(`
    SELECT session_id, id AS message_id, role, timestamp AS at, content
      FROM messages
     WHERE session_id = ? AND COALESCE(active, 1) = 1
     ORDER BY id DESC LIMIT 1
  `)
  const sessionIds = new Set()
  for (const prefix of prefixes) {
    const upper = prefixUpperBound(prefix)
    for (const { id } of distinct.all(prefix, upper, upper)) sessionIds.add(String(id))
  }
  const rows = []
  for (const id of sessionIds) {
    const row = newest.get(id)
    if (row?.role === 'user' && Number(row.at) >= cutoffSeconds && typeof row.content === 'string'
      && row.content.slice(0, FOLLOW_THROUGH_PREFIX.length) === FOLLOW_THROUGH_PREFIX) rows.push(row)
  }
  return rows
}

/** Sessions waiting on a follow-through: newest active message is a completion row, no live turn. */
export function findPendingFollowThroughs(sessionDbPath, { now = Date.now(), maxAgeSeconds = 2 * 3600, sessionPrefixes = FOLLOW_THROUGH_SESSION_PREFIXES } = {}) {
  if (!sessionDbPath || !existsSync(sessionDbPath)) return []
  const database = new DatabaseSync(sessionDbPath, { readOnly: true })
  try {
    const nowSeconds = now / 1000
    const rows = newestFollowThroughRows(database, sessionPrefixes, nowSeconds - maxAgeSeconds)
    let leased = new Set()
    try {
      leased = new Set(database.prepare('SELECT conversation_id FROM session_turn_leases WHERE expires_at > ?').all(nowSeconds).map((row) => String(row.conversation_id)))
    } catch { /* older Hermes without leases */ }
    return rows
      .filter(row => sessionPrefixes.some(prefix => String(row.session_id).startsWith(prefix))
        && !leased.has(String(row.session_id)) && !ownerGate(database, String(row.session_id)))
      .map(row => {
        const sessionId = String(row.session_id), delegationId = completionDelegationId(row.content)
        if (delegationId && receiptConsumed(database, sessionId, delegationId)) return null
        const receipt = delegationId ? readUndeliveredHelperReceipts(sessionDbPath, { now, delegationId, includeDelivered: true })
          .find(r => r.sessionId === sessionId) : null
        return { sessionId, messageId: Number(row.message_id), at: Number(row.at),
          ...(delegationId ? { delegationId, key: receiptKey(delegationId), input: receipt?.input
            ?? RECEIPT_PREFIX + delegationId + '\nThe saved helper findings below arrived. Finish the original request under its latest instructions and release authority.\n\n' + row.content } : {}) }
      }).filter(Boolean)
  } finally {
    database.close()
  }
}

/**
 * Start the watcher. `find()` returns the pending threads ({ sessionId, messageId }).
 * `admit(sessionId, input, idempotencyKey)` submits one run through the service's normal admission
 * path. `enabled()` is checked every tick so it turns itself off on agents that join delegated work
 * inside the run.
 */
export function startDelegationFollowThrough({ sessionDbPath = '', find = () => findPendingFollowThroughs(sessionDbPath), admit, enabled, allowSession = () => true, eligible = async () => true, intervalMs = 5000, log = () => {} }) {
  const done = new Set()
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      if (!(await enabled())) return
      const completions = await find()
      const completionSessions = new Set(completions.map(row => row.sessionId))
      const receipts = findIdleUndeliveredHelperReceipts(sessionDbPath).filter(row => !completionSessions.has(row.sessionId))
      const touchedSessions = new Set()
      for (const pending of [...completions, ...receipts].filter(row => allowSession(row.sessionId))) {
        if (!await eligible(pending.sessionId)) continue
        if (touchedSessions.has(pending.sessionId)
          || (sessionDbPath && !continuationAllowed(sessionDbPath, pending.sessionId, pending.delegationId))) continue
        touchedSessions.add(pending.sessionId)
        const key = pending.key ?? `wizard-follow-through-${pending.sessionId}-${pending.messageId}`
        // Portable HTTP installations have no receipt DB. Preserve the exact observed
        // completion identity; the service revalidates it over HTTP at admission/dispatch.
        const token = sessionDbPath ? captureContinuation(sessionDbPath, pending)
          : { kind: 'http-completion', sessionId: pending.sessionId, messageId: pending.messageId, at: pending.at }
        if (sessionDbPath && !continuationCurrent(sessionDbPath, token)) continue
        if (done.has(key)) continue
        done.add(key)
        try {
          await admit(pending.sessionId, pending.input ?? FOLLOW_THROUGH_INPUT, key, token)
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
