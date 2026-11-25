// Archived threads straight from a Hermes state.db (read-only). Stock Hermes' /api/sessions never lists
// archived rows, so the main list and every agent's list add them from the runtime's own database.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// Parent end reasons that mark a conversation boundary (Hermes' reset reasons plus /branch).
const BOUNDARY_END_REASONS = ['session_reset', 'session_switch', 'idle', 'daily', 'suspended', 'resume_pending_expired', 'branched'].map((reason) => `'${reason}'`).join(', ')

export function readArchivedSessions(sessionDbPath, { all = false, limit = all ? -1 : 100 } = {}) {
  if (!Number.isInteger(limit) || (limit !== -1 && (limit < 1 || limit > 100000)) || (limit === -1 && !all)) throw new Error('invalid_archive_limit')
  if (!sessionDbPath || !existsSync(sessionDbPath)) return []
  const database = new DatabaseSync(sessionDbPath, { readOnly: true })
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name))
    // The chat after a /new or a /branch is its own conversation (Hermes keeps parent_session_id only
    // for lineage): its marker names its immediate parent, or the parent ended at a boundary. Sub-agent
    // runs and compression continuations (inherited markers name an older ancestor) stay out.
    const ownConversation = columns.has('model_config') && columns.has('end_reason')
      ? `OR (COALESCE(json_extract(CASE WHEN json_valid(model_config) THEN model_config END, '$._delegate_from'), '') = ''
             AND (json_extract(CASE WHEN json_valid(model_config) THEN model_config END, '$._reset_from') = sessions.parent_session_id
               OR json_extract(CASE WHEN json_valid(model_config) THEN model_config END, '$._branched_from') = sessions.parent_session_id
               OR EXISTS (SELECT 1 FROM sessions parent WHERE parent.id = sessions.parent_session_id
                            AND parent.end_reason IN (${BOUNDARY_END_REASONS}))))`
      : ''
    return database.prepare(`
      SELECT id, source, model, title, started_at, ended_at, end_reason,
             message_count, parent_session_id, last_activity_at AS last_active,
             pinned, archived, hidden
        FROM sessions
       WHERE archived = 1
         AND hidden = 0
         AND (parent_session_id IS NULL ${ownConversation})
         AND message_count > 0
       ORDER BY COALESCE(last_activity_at, started_at) DESC
       LIMIT ?
    `).all(limit).map((session) => ({
      ...session,
      pinned: Boolean(session.pinned),
      archived: Boolean(session.archived),
      hidden: Boolean(session.hidden),
    }))
  } finally {
    database.close()
  }
}
