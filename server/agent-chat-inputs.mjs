import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

// Service-owned input receipts, never an index of runtime history. Only accepted
// image turns are retained. Every lookup is an exact (agent, session) pair.
export class AgentChatInputs {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`CREATE TABLE IF NOT EXISTS image_inputs (
      agent TEXT NOT NULL, session TEXT NOT NULL, identity TEXT NOT NULL,
      body TEXT NOT NULL, created_at REAL NOT NULL,
      PRIMARY KEY(agent, session, identity))`)
  }
  note(agent, session, run, body, createdAt = Date.now() / 1000) {
    const value = JSON.parse(body)
    if (!Array.isArray(value.input) || !value.input.some(message =>
      message?.role === 'user' && Array.isArray(message.content) && message.content.some(part => part?.type === 'image_url'))) return
    const identity = `${run}:${createHash('sha256').update(body).digest('hex')}`
    this.db.prepare('INSERT OR IGNORE INTO image_inputs VALUES(?,?,?,?,?)').run(agent, session, identity, body, Number(createdAt))
  }
  forSession(agent, session) {
    return this.db.prepare('SELECT body, created_at AS createdAt FROM image_inputs WHERE agent=? AND session=? ORDER BY created_at').all(agent, session)
  }
  forget(agent, session) { this.db.prepare('DELETE FROM image_inputs WHERE agent=? AND session=?').run(agent, session) }
  close() { this.db.close() }
}
