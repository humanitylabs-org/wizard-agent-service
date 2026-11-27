// Which chats have a turn running, read from Hermes' state.db. Called from the run queue's tick, the health
// summary and each Chats list rebuild; the Service runs them in the state worker (issue 584), never on the HTTP thread.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const HUMAN_SESSION_SOURCES = new Set(['webui', 'telegram', 'discord', 'slack', 'whatsapp', 'signal', 'wizard-mobile'])
export const EXTERNAL_WIZARD_SESSION_PREFIX = 'wizard-assistant-'
export const OPERATOR_USER_SESSION_PREFIX = 'wizardop_user_'

export function isDirectHumanSessionIdentity(id, source) {
  return HUMAN_SESSION_SOURCES.has(String(source ?? '').toLowerCase())
    || id.startsWith('wizard_')
    || id.startsWith(EXTERNAL_WIZARD_SESSION_PREFIX)
}

// Turns running on other surfaces (Telegram, TUI, cron). Stock Hermes serves no list of live turns
// over HTTP, so this read needs WIZARD_HERMES_STATE_PATH (spec/AGENT_BRIDGE.md, "Agent adapter").
export function readActiveHumanSessionIds(sessionDbPath, currentTime = Date.now()) {
  if (!sessionDbPath || !existsSync(sessionDbPath)) throw new Error('Hermes session state is unavailable')
  const database = new DatabaseSync(sessionDbPath, { readOnly: true })
  try {
    const now = currentTime / 1000
    // Two index-driven branches instead of one scan of every root session (that join took ~12 ms warm and
    // far longer on a busy disk, on every queue tick): live turn leases first, then recently active rows
    // through the COALESCE(last_activity_at, started_at) index. The exact old predicate still decides.
    const rows = database.prepare(`
      SELECT sessions.id, sessions.source
        FROM session_turn_leases
        CROSS JOIN sessions ON sessions.id = session_turn_leases.conversation_id
       WHERE session_turn_leases.expires_at > ?
         AND sessions.hidden = 0
         AND sessions.parent_session_id IS NULL
         AND sessions.message_count > 0
      UNION
      SELECT sessions.id, sessions.source
        FROM sessions
       WHERE COALESCE(sessions.last_activity_at, sessions.started_at) >= ?
         AND sessions.hidden = 0
         AND +sessions.parent_session_id IS NULL
         AND sessions.message_count > 0
         AND COALESCE(sessions.last_activity_description, '') <> ''
         -- A background helper heartbeats its parent's activity while the parent's own
         -- turn is over. That parent is waiting, not working: it must not hold a slot.
         AND COALESCE(sessions.last_activity_description, '') NOT LIKE 'delegate_task:%'
         AND COALESCE(sessions.last_activity_at, 0) >= ?
    `).all(now, now - 150, now - 150)
    return rows
      .filter((row) => {
        const id = String(row.id ?? '')
        return isDirectHumanSessionIdentity(id, row.source) || id.startsWith(OPERATOR_USER_SESSION_PREFIX)
      })
      .map((row) => String(row.id))
  } finally {
    database.close()
  }
}

// True while any turn holds this thread. Throws when the state is unreadable.
export function readSessionLeaseHeld(sessionDbPath, sessionId, currentTime = Date.now()) {
  if (!sessionDbPath) throw new Error('turn leases unavailable')
  const database = new DatabaseSync(sessionDbPath, { readOnly: true })
  try { return Boolean(database.prepare('SELECT 1 FROM session_turn_leases WHERE conversation_id = ? AND expires_at > ? LIMIT 1').get(sessionId, currentTime / 1000)) }
  finally { database.close() }
}
