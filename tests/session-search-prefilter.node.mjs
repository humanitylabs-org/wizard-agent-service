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

test('message search: trigram index path matches substrings, skips tool rows, honours a mid-way rebuild', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'search-'))
  try {
    const path = join(dir, 'state.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT);
      CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE VIEW messages_fts_trigram_src AS SELECT id, role, content FROM messages WHERE role <> 'tool';
      CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(content, content='messages_fts_trigram_src', content_rowid='id', tokenize='trigram');`)
    const add = db.prepare('INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?,?,?,?,?)')
    add.run('a', 'user', 'Should we add a Philosopher filter to Chats?', 1, null)
    add.run('a', 'assistant', 'Old reply about pills', 2, 'stop')
    add.run('b', 'assistant', 'The philosophers agree', 3, 'stop')
    add.run('c', 'tool', 'philosopher filter', 4, null)
    add.run('d', 'user', 'unrelated', 5, null)
    db.exec(`INSERT INTO messages_fts_trigram(rowid, content) SELECT id, content FROM messages WHERE role <> 'tool'`)
    // A row the index has not seen: only found once the rebuild flag sends search to the content scan.
    add.run('d', 'user', 'philosopher late arrival', 6, null)
    db.close()
    const ids = ['a', 'b', 'c', 'd']
    const hits = (q) => [...searchHermesSessionText(path, ids, q).keys()].sort()
    assert.deepEqual(hits('philosoph'), ['a', 'b'])
    assert.deepEqual(hits('PHILOSOPHER filter'), ['a'])
    assert.deepEqual(hits('pills'), ['a'])
    assert.deepEqual(hits('ok'), [])  // short words use the content scan
    assert.deepEqual(hits('zzzz'), [])
    const w = new DatabaseSync(path); w.prepare("INSERT INTO state_meta VALUES ('fts_rebuild_progress','1')").run(); w.close()
    assert.deepEqual(hits('philosopher'), ['a', 'b', 'd'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
