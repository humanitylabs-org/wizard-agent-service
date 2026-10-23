import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchHermesSessionText } from '../server/session-truth.mjs'
import { searchHermesSessionTextAsync } from '../server/session-text-search-worker.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-search-worker-')), path = join(dir, 'state.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT,display_kind TEXT,finish_reason TEXT,timestamp REAL); CREATE INDEX by_session ON messages(session_id)')
  const put = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)')
  const ids = Array.from({ length: 210 }, (_, i) => `wizard_fixture_${i}`)
  db.exec('BEGIN')
  for (const id of ids) {
    put.run(id, 'user', 'owner-visible needle', null, null, 1)
    put.run(id, 'assistant', 'newer needle', 'tool_call', 'tool_calls', 2)
    put.run(id, 'tool', 'tool needle', null, null, 3)
  }
  put.run('outside-scope', 'user', 'needle', null, null, 1)
  // An absent term must inspect every body. Keep the fixture modest but real.
  for (let i = 0; i < 1500; i++) put.run(ids[i % ids.length], 'user', 'ordinary history '.repeat(500), null, null, 4 + i)
  db.exec('COMMIT'); db.close()
  return { path, ids, close: () => rmSync(dir, { recursive: true, force: true }) }
}

test('worker preserves approved scopes, visible text and batches past 200 IDs', async () => {
  const f = fixture()
  try {
    const expected = new Map()
    for (let i = 0; i < f.ids.length; i += 200) for (const row of searchHermesSessionText(f.path, f.ids.slice(i, i + 200), 'needle')) expected.set(...row)
    const actual = await searchHermesSessionTextAsync(f.path, f.ids, 'needle')
    assert.deepEqual(actual, expected)
    assert.equal(actual.size, 210)
    assert(!actual.has('outside-scope'))
    assert([...actual.values()].every(text => text === 'owner-visible needle'))
  } finally { f.close() }
})

test('search admission is bounded and recovers capacity after queued jobs complete', async () => {
  const f = fixture()
  try {
    const jobs = Array.from({ length: 16 }, (_, i) => searchHermesSessionTextAsync(f.path, f.ids, `absent-${i}`))
    await assert.rejects(searchHermesSessionTextAsync(f.path, f.ids, 'overflow'), error => error.status === 503)
    assert((await Promise.all(jobs)).every(hits => hits.size === 0))
    assert.equal((await searchHermesSessionTextAsync(f.path, f.ids, 'needle')).size, 210)
  } finally { f.close() }
})

test('full-body SQLite scan leaves the HTTP event loop runnable and deduplicates identical reads', async () => {
  const f = fixture()
  try {
    const first = searchHermesSessionTextAsync(f.path, f.ids, 'absent-term')
    assert.equal(searchHermesSessionTextAsync(f.path, f.ids, 'absent-term'), first)
    let finished = false
    first.finally(() => { finished = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false, 'event loop runs while worker is scanning')
    assert.equal((await first).size, 0)
    assert.equal((await searchHermesSessionTextAsync(f.path, [], 'needle')).size, 0)
  } finally { f.close() }
})
