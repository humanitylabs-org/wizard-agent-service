// Chats search: the SQL prefilter (instr(lower())) must never hide a hit the JS check would find.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { searchHermesSessionText } from '../server/session-truth.mjs'

test('message search: same hits with the SQL prefilter, including case and non-ASCII words', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'search-'))
  try {
    const path = join(dir, 'state.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT)`)
    const add = db.prepare('INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?,?,?,?,?)')
    add.run('a', 'user', 'Please RESTART the Keeper', 1, null)
    add.run('b', 'assistant', 'Café opens at nine; restart later', 2, 'stop')
    add.run('c', 'user', 'nothing relevant', 3, null)
    add.run('d', 'tool', 'restart keeper', 4, null)
    add.run('e', 'user', 'ÉCOLE restart', 5, null)
    db.close()
    const ids = ['a', 'b', 'c', 'd', 'e']
    const hits = (q) => [...searchHermesSessionText(path, ids, q).keys()].sort()
    assert.deepEqual(hits('restart keeper'), ['a'])
    assert.deepEqual(hits('Restart'), ['a', 'b', 'e'])
    assert.deepEqual(hits('café restart'), ['b'])
    assert.deepEqual(hits('école'), ['e'])  // non-ASCII words skip the prefilter; JS folds them
    assert.deepEqual(hits('zzz'), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
