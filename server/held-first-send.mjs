// A new chat whose first message a graceful restart holds (issue 480, wizard-ux issue 1362).
//
// The owner starts a new chat while the restart waits: the session exists in Hermes with no messages yet, and its
// first message sits in this agent's durable run queue as `queued` / `restart_pending` until the next process sends
// it. Every list reader drops a session with no messages, so the chat vanished from the Chats list on every device
// for the whole wait (up to 10 minutes) and only the sending device showed it, from its outbox, for 2 minutes.
// This keeps such a row listed, on every agent kind, as a saved first send with the owner's own words as its title.
// Only rows the restart hold itself parked qualify, so nothing changes while WIZARD_GRACEFUL_RESTART is off.

import { queuedInputTextOf } from './run-queue.mjs'

const RESTART_PENDING = 'restart_pending'
const HELD = new Set(['queued', 'launching'])

/** The owner's words of a saved request, without Wizard's file block, on one line. */
export function heldWords(body) {
  return String(queuedInputTextOf(body) || '')
    .replace(/\[WIZARD_FILES_V1\][\s\S]*?(\[\/WIZARD_FILES_V1\]|$)/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
}

/** The queue record that holds this session's first message for a restart, or null. */
export function heldFirstSendRecord(queue, sessionId) {
  if (!queue || typeof sessionId !== 'string' || !sessionId) return null
  let record = null
  try { record = queue.latestForSession(sessionId) } catch { return null }
  return record && HELD.has(record.status) && record.waitingReason === RESTART_PENDING ? record : null
}

/**
 * Mark the empty sessions of `rows` whose first message the restart holds, so the list keeps them
 * (`wizard_pending_first_send`) and shows them as saved: status queued with queue_reason restart_pending, the owner's
 * words as preview and, when the session has no title yet, as its title. Rows with messages, rows the hold does not
 * own and every row while no hold parked anything come back unchanged (the same objects). Pure apart from the reads.
 * @param {any[]} rows
 * @param {{ latestForSession(id: string): any } | null | undefined} queue
 */
export function markHeldFirstSends(rows, queue) {
  if (!Array.isArray(rows) || !queue) return rows
  return rows.map((row) => {
    if (!row || typeof row.id !== 'string' || row.hidden === true || row.archived === true || row.parent_session_id) return row
    const count = Number(row.message_count ?? 0)
    if (Number.isFinite(count) && count > 0) return row
    const record = heldFirstSendRecord(queue, row.id)
    if (!record) return row
    const words = heldWords(record.body)
    const say = words || 'Voice message'
    return {
      ...row,
      wizard_pending_first_send: true,
      status: 'queued',
      queue_reason: RESTART_PENDING,
      wizard_run_id: record.publicRunId,
      ...(record.idempotencyKey ? { wizard_last_run_idempotency_key: record.idempotencyKey } : {}),
      ...(record.createdAt ? { wizard_assigned_at: record.createdAt, wizard_last_user_at: record.createdAt } : {}),
      wizard_request_preview: say,
      preview: row.preview || say,
      title: row.title || say.slice(0, 60),
    }
  })
}
