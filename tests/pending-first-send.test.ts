// 17 Oct 2026: a gateway restart failed six brand-new Wizard threads' first sends. With zero Hermes
// messages, every list reader dropped them, so James's messages vanished from Working and Ready.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { readPendingFirstSendSessions } from '../server/service.mjs'
import { DurableRunQueue as RunQueue } from '../server/run-queue.mjs'

function stateDb(dir: string) {
  const path = join(dir, 'state.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL,
    ended_at REAL, end_reason TEXT, message_count INTEGER, parent_session_id TEXT, last_activity_at REAL,
    pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0)`)
  const add = db.prepare('INSERT INTO sessions (id, source, started_at, message_count, hidden, archived) VALUES (?,?,?,?,?,?)')
  add.run('wizard_1_failedfirst', 'api_server', 1, 0, 0, 0)
  add.run('wizard_2_hasreply', 'api_server', 1, 4, 0, 0)
  add.run('wizard_3_hidden', 'api_server', 1, 0, 1, 0)
  db.close()
  return path
}

describe('pending first sends stay listed', () => {
  it('returns only empty, visible, top-level sessions and flags them', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pending-first-send-'))
    try {
      const rows = readPendingFirstSendSessions(stateDb(dir), ['wizard_1_failedfirst', 'wizard_2_hasreply', 'wizard_3_hidden'])
      expect(rows.map((row: any) => row.id)).toEqual(['wizard_1_failedfirst'])
      expect(rows[0].wizard_pending_first_send).toBe(true)
      expect(readPendingFirstSendSessions(join(dir, 'missing.db'), ['x'])).toEqual([])
      expect(readPendingFirstSendSessions(stateDb(mkdtempSync(join(dir, 'b'))), [])).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('queue names recent sessions that never completed a send', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pending-queue-'))
    try {
      const queue: any = new RunQueue({ statePath: join(dir, 'q.sqlite3'), launch: async () => ({}), lookup: async () => ({}),
        activeSessionIds: async () => [], canDispatch: async () => false })
      const insert = queue.database.prepare(`INSERT INTO wizard_run_queue (public_run_id, runtime, session_id, idempotency_key,
        request_hash, body, trusted_paths_json, status, payload_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      const now = Date.now() / 1000
      insert.run('wizardq_a', 'hermes', 'wizard_1_failedfirst', 'k1', 'h1', '{"session_id":"wizard_1_failedfirst","input":"hi"}', '[]', 'failed', '{}', now, now)
      insert.run('wizardq_b', 'hermes', 'wizard_2_hasreply', 'k2', 'h2', '{"session_id":"wizard_2_hasreply","input":"hi"}', '[]', 'completed', '{}', now, now)
      insert.run('wizardq_c', 'hermes', 'wizard_old', 'k3', 'h3', '{"session_id":"wizard_old","input":"hi"}', '[]', 'failed', '{}', now - 30 * 86400, now)
      expect(queue.recentUnfinishedSessionIds(now - 7 * 86400)).toEqual(['wizard_1_failedfirst'])
      queue.close?.()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
