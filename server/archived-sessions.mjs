// Archived threads straight from a Hermes state.db (read-only). Stock Hermes' /api/sessions never lists
// archived rows, so the main list and every agent's list add them from the runtime's own database.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export function readArchivedSessions(sessionDbPath, { all = false } = {}) {
  if (!sessionDbPath || !existsSync(sessionDbPath)) return []
  const database = new DatabaseSync(sessionDbPath, { readOnly: true })
  try {
    return database.prepare(`
      SELECT id, source, model, title, started_at, ended_at, end_reason,
             message_count, parent_session_id, last_activity_at AS last_active,
             pinned, archived, hidden
        FROM sessions
       WHERE archived = 1
         AND hidden = 0
         AND parent_session_id IS NULL
         AND message_count > 0
       ORDER BY COALESCE(last_activity_at, started_at) DESC
       ${all ? '' : 'LIMIT 100'}
    `).all().map((session) => ({
      ...session,
      pinned: Boolean(session.pinned),
      archived: Boolean(session.archived),
      hidden: Boolean(session.hidden),
    }))
  } finally {
    database.close()
  }
}
