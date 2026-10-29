// Synthetic-only triggering-user query regressions; Node >=22.5, no service needed.
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHermesSessionTruth } from '../server/session-truth.mjs'

function fixture({ view = false, compacted = true, affinity = 'INTEGER' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trigger-seek-'))
  const path = join(root, 'synthetic.sqlite'), db = new DatabaseSync(path)
  const table = view ? 'message_rows' : 'messages'
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,started_at REAL);
    INSERT INTO sessions VALUES('thread',1);
    CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL);
    CREATE TABLE ${table}(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,finish_reason TEXT,
      timestamp REAL,content TEXT,display_kind TEXT,active ${affinity}${compacted ? ',compacted INTEGER' : ''});
    CREATE INDEX recent_messages ON ${table}(session_id,active,timestamp);
    ${view ? 'CREATE VIEW messages AS SELECT * FROM message_rows;' : ''}`)
  const put = (role, timestamp, content, active = 1, kept = 0) => db.prepare(`INSERT INTO ${table}
    (session_id,role,finish_reason,timestamp,content,display_kind,active${compacted ? ',compacted' : ''})
    VALUES(?,?,?,?,?,?,?${compacted ? ',?' : ''})`).run('thread', role, role === 'assistant' ? 'stop' : null,
      timestamp, content, role === 'assistant' ? 'final' : '', active, ...(compacted ? [kept] : []))
  return { db, path, put, table, compacted,
    close() { db.close(); rmSync(root, { recursive: true, force: true }) } }
}
function capture(f) {
  const queries = [], original = DatabaseSync.prototype.prepare
  mock.method(DatabaseSync.prototype, 'prepare', function(sql) {
    const statement = original.call(this, sql)
    if (!/SELECT content FROM messages WHERE session_id\s*=/u.test(sql)) return statement
    return { get(...args) {
      queries.push({ sql, args })
      return statement.get(...args)
    } }
  })
  try {
    const truth = readHermesSessionTruth(f.path, ['thread'], 1000).get('thread')
    assert.ok(truth, 'projection must return the synthetic thread')
    assert.ok(queries.length, 'real projector must execute its triggering-user lookup')
    return { truth, query: queries[0] }
  } finally { mock.restoreAll() }
}
function lookup(f, query, through) {
  // The same test file runs unchanged against baseline positional binds and candidate named binds.
  return f.db.prepare(query.sql).get(...(query.args.length === 3 ? ['thread', 'thread', through]
    : [{ ':sessionId': 'thread', ':through': through }]))
}
function oracle(f, through) {
  const retained = `(COALESCE(active,1)=1${f.compacted ? ' OR (active=0 AND compacted=1)' : ''})`
  const tie = f.table === 'messages' ? ', rowid DESC' : ''
  return f.db.prepare(`SELECT content FROM messages WHERE session_id=? AND role='user' AND ${retained}
    AND timestamp=(SELECT MAX(timestamp) FROM messages WHERE session_id=? AND role='user' AND ${retained} AND timestamp<=?)
    ORDER BY timestamp DESC${tie} LIMIT 1`).get('thread', 'thread', through)
}
for (const options of [{ view: false, compacted: true }, { view: true, compacted: false }]) {
  const label = options.view ? 'legacy view' : 'retained table'
  test(`triggering-user lookup bounds every retained timestamp range (${label})`, () => {
    const f = fixture(options)
    try {
      // Old history is deliberately before the current owner request. Timing is not the oracle.
      f.db.exec('BEGIN')
      for (let i = 0; i < 512; i++) f.put(i % 2 ? 'assistant' : 'user', i, `old-${i}`)
      f.put('user', 900, 'Current request'); f.put('assistant', 910, 'Current answer')
      f.db.exec('COMMIT')
      const { truth, query } = capture(f)
      assert.equal(truth.lastAssistantAt, 910)
      assert.equal(truth.requestPreview, 'Current request')
      const plan = f.db.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.args).map(row => row.detail)
      const ranges = plan.filter(line => /recent_messages.*\(session_id=\? AND active=\? AND timestamp<\?\)/u.test(line))
      assert.equal(ranges.length, options.compacted ? 3 : 2,
        'every retained branch must bound active and timestamp in the existing index')
      assert.equal(lookup(f, query, 910)?.content, 'Current request')
    } finally { f.close() }
  })
}
for (const affinity of ['INTEGER', 'TEXT', '']) {
  test(`triggering-user winner matches original retention and ties (affinity ${affinity || 'none'})`, () => {
    const f = fixture({ affinity })
    try {
      f.put('user', 1, 'Owner'); f.put('assistant', 2, 'Answer')
      const { query } = capture(f)
      // Includes NULL-active authority, rewound history, compacted history, invalid states,
      // text-affinity edge cases, equal timestamps, foreign sessions and future requests.
      for (const active of [1, 0, null, 2, '1', '0', 'other']) for (const kept of [0, 1]) {
        const time = 10 + Math.floor(Number(f.db.prepare(`SELECT count(*) AS n FROM ${f.table}`).get().n) / 2)
        f.put('user', time, `request:${String(active)}:${kept}`, active, kept)
        f.put('assistant', time, 'not a triggering user', active, kept)
      }
      f.db.exec(`INSERT INTO messages(session_id,role,timestamp,content,active,compacted)
        VALUES('foreign','user',999,'foreign',1,0)`)
      for (const through of [0, 1, 2, 10, 11, 15, 30, 1000]) {
        assert.deepEqual(lookup(f, query, through), oracle(f, through), `cutoff ${through}`)
      }
      f.put('user', 100, 'Earlier tie'); f.put('user', 100, 'Later tie', 0, 1)
      assert.equal(lookup(f, query, 100)?.content, 'Later tie')
      // A separate connection's changes must be visible immediately, with no cached truth.
      const external = new DatabaseSync(f.path)
      try { external.exec("UPDATE messages SET active=0,compacted=0 WHERE content='Later tie'") }
      finally { external.close() }
      if (affinity !== 'TEXT') assert.equal(lookup(f, query, 100)?.content, 'Earlier tie')
      assert.deepEqual(lookup(f, query, 100), oracle(f, 100))
    } finally { f.close() }
  })
}
test('triggering-user provenance preserves active, compacted, NULL and rewound boundaries', () => {
  const f = fixture()
  try {
    f.put('user', 10, 'Owner request'); f.put('assistant', 20, 'Owner answer')
    f.put('user', 30, '[Agent-to-agent test] synthetic request', 0, 1)
    f.put('assistant', 40, 'Machine answer')
    assert.equal(capture(f).truth.lastAssistantAt, 20, 'retained machine request hides its answer')
    f.db.exec('UPDATE messages SET compacted=0 WHERE timestamp=30')
    assert.equal(capture(f).truth.lastAssistantAt, 40, 'rewound machine request grants no authority')
    f.db.exec('UPDATE messages SET active=NULL WHERE timestamp=30')
    assert.equal(capture(f).truth.lastAssistantAt, 20, 'NULL-active request remains retained')
    f.db.exec('UPDATE messages SET active=1 WHERE timestamp=30')
    assert.equal(capture(f).truth.lastAssistantAt, 20, 'active machine request hides its answer')
    f.put('user', 50, 'Next owner request'); f.put('assistant', 60, 'Next owner answer')
    assert.equal(capture(f).truth.lastAssistantAt, 60, 'next genuine owner request restores its answer')
  } finally { f.close() }
})
test('triggering-user view fallback preserves timestamp winner without rowid ordering', () => {
  const f = fixture({ view: true, compacted: false })
  try {
    f.put('user', 10, 'Owner'); f.put('assistant', 20, 'Answer')
    const { query } = capture(f)
    f.put('user', 30, 'Inactive request', 0)
    f.put('user', 40, '[Agent-to-agent test] NULL retained', null)
    for (const through of [0, 10, 20, 30, 40, 50]) assert.deepEqual(lookup(f, query, through), oracle(f, through))
    assert.ok(!query.sql.includes('rowid'), 'view fallback must not require rowid')
  } finally { f.close() }
})
