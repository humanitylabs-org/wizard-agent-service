// Owner-only private search: use that agent's existing FTS, never build a shared index.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withHistory } from './standard-chats.mjs'
import { AgentError } from './agents.mjs'
export function privateChatMatches(agentsDir, agentId, query) {
  const path = join(agentsDir, agentId, 'home', 'state.db')
  if (!existsSync(path)) return null // remote runtime / older schema: use its own API instead
  return withHistory(path, db => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='messages_fts'").get()) return null
    const words = String(query).trim().split(/\s+/u).filter(Boolean).slice(0,24)
    if (!words.length) return new Map()
    // Intersection by session permits words in separate messages, matching Chats semantics.
    let matches = null
    for (const word of words) {
      const literal = '"' + word.replaceAll('"','""') + '"'
      const rows = db.prepare(`SELECT m.session_id, substr(m.content,1,1600) AS excerpt FROM messages_fts
        JOIN messages m ON m.id=messages_fts.rowid JOIN sessions s ON s.id=m.session_id
        WHERE messages_fts MATCH ? AND COALESCE(s.hidden,0)=0 AND m.role IN ('user','assistant')
        GROUP BY m.session_id LIMIT 10001`).all(literal)
      if (rows.length > 10000) throw new AgentError(422,'search_too_broad','agent.search')
      const current = new Map(rows.map(r => [r.session_id,String(r.excerpt || '')]))
      matches = matches === null ? current : new Map([...matches].filter(([id]) => current.has(id)))
    }
    return matches
  })
}
