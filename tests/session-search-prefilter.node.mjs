// Chats search reads message text only through Hermes' word index (or, on stores without it, the trigram index). Without a ready index (old store,
// mid-way rebuild) or for words under 3 letters it answers from titles only: the old instr() content scan read
// the whole store and took >30 s (James, 25 Oct 2026).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { searchHermesSessionText } from '../server/session-truth.mjs'

test('message search: a store without the trigram index never runs the full content scan', () => {
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
    for (const q of ['restart keeper', 'Restart', 'café restart', 'école', 'zzz']) assert.deepEqual(hits(q), [], q)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('message search: trigram index path matches substrings, skips tool rows, goes titles-only mid-rebuild', () => {
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
    assert.deepEqual(hits('ok'), [])  // short words: titles only
    assert.deepEqual(hits('zzzz'), [])
    const w = new DatabaseSync(path); w.prepare("INSERT INTO state_meta VALUES ('fts_rebuild_progress','1')").run(); w.close()
    assert.deepEqual(hits('philosopher'), [])  // a half-built index could miss rows; never fall back to the scan
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('message search: word index path matches word starts, skips tool rows and unlisted threads, many tool hits stay cheap', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'search-'))
  try {
    const path = join(dir, 'state.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT);
      CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE VIEW messages_fts_src AS SELECT id, content FROM messages;
      CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages_fts_src', content_rowid='id');`)
    const add = db.prepare('INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?,?,?,?,?)')
    add.run('a', 'user', 'How does Nostr help with identity?', 1, null)
    add.run('b', 'assistant', 'Wizard-OS keys are #nostr-style', 2, 'stop')
    add.run('private', 'user', 'nostr secret plan', 3, null)
    for (let i = 0; i < 900; i++) add.run('c', 'tool', 'nostr relay log line', 10 + i, null)  // tool output floods the word index
    add.run('d', 'user', 'unrelated', 2000, null)
    db.exec(`INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages`)
    db.close()
    const ids = ['a', 'b', 'c', 'd']  // 'private' is another scope's thread: never searched here
    const hits = (q) => [...searchHermesSessionText(path, ids, q).keys()].sort()
    assert.deepEqual(hits('nostr'), ['a', 'b'])
    assert.deepEqual(hits('nos'), ['a', 'b'])            // typing: a word start finds the whole word
    assert.deepEqual(hits('wizard-os nostr'), ['b'])
    assert.deepEqual(hits('NOSTR identity'), ['a'])
    assert.deepEqual(hits('secret'), [])
    assert.deepEqual(hits('ostr'), [])                   // mid-word text is a title-only match now
    const result = searchHermesSessionText(path, ids, 'nostr')
    assert.equal(result.mode, 'body'); assert.equal(result.get('a').includes('Nostr'), true)
    const w = new DatabaseSync(path); w.prepare("INSERT INTO state_meta VALUES ('fts_rebuild_progress','1')").run(); w.close()
    assert.deepEqual(hits('nostr'), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
