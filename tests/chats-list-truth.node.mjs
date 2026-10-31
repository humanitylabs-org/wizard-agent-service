import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, renameSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as truth from '../server/session-truth.mjs'
import * as receipts from '../server/delegation-receipts.mjs'
import { readHelperStatuses } from '../server/helper-status.mjs'
import { readNonHoldingFollowUps } from '../server/owned-open-work-follow-through.mjs'
import { truthFixture, instrumentProjection } from './fixtures/chats-truth.mjs'

function fixture(t, count = 12) {
  const root = mkdtempSync(join(tmpdir(), 'chats-truth-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, ...truthFixture(join(root, 'fixture'), count) }
}

test('single session-truth read per projected row, shared with background isBusy', async t => {
  const f = fixture(t); t.mock.method(Date, 'now', () => f.sec * 1000)
  const run = await instrumentProjection(resolve('.'), join(f.root, 'archive'), f)
  t.after(() => run.close())
  await run.core.projectBatch(f.sessions, true)
  run.reset()
  await run.core.projectBatch(f.sessions, true)
  assert.equal(run.probe.truth_sessions, f.sessions.length)
  assert.equal(run.probe.truth_calls, 1)
})

test('owned-open-work is read once per session for truth and helper status in a projection', async t => {
  const f = fixture(t); t.mock.method(Date, 'now', () => f.sec * 1000)
  const run = await instrumentProjection(resolve('.'), join(f.root, 'archive'), f)
  t.after(() => run.close()); run.reset()
  await run.core.projectBatch(f.sessions, true)
  assert.equal(run.probe.owned_reads, f.sessions.length)
})

test('projected rows deep-equal unshared evidence over helpers, receipts and optional follow-ups', async t => {
  const f = fixture(t); t.mock.method(Date, 'now', () => f.sec * 1000)
  const run = await instrumentProjection(resolve('.'), join(f.root, 'optimized'), f)
  const optimized = await run.core.fullCore(f.sessions)
  await run.close()
  const legacy = await instrumentProjection(resolve('.'), join(f.root, 'unshared'), f, { legacy: true })
  try {
    assert.deepEqual(optimized, await legacy.core.fullCore(f.sessions))
    assert.equal(optimized.length, f.sessions.length)
    assert(optimized.some(row => row.wizard_background_result), 'fixture must exercise manual receipt projection')
    assert(readNonHoldingFollowUps(f.path, f.sessions[0].id).has('deleg_optional_0'), 'fixture must exercise real optional follow-up authority')
  } finally { await legacy.close() }
})

test('prepared truth statements are reused per read-only handle without caching results', t => {
  const f = fixture(t), ids = f.sessions.map(s => s.id)
  assert.equal(typeof truth.createHermesSessionTruthReader, 'function')
  const reader = truth.createHermesSessionTruthReader(f.path)
  t.after(() => reader.close())
  let prepares = 0
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function(sql) { prepares++; return prepare.call(this, sql) })
  reader.read(ids, f.sec)
  prepares = 0
  const nonHolding = new Map(ids.map(id => [id, readNonHoldingFollowUps(f.path, id)]))
  const options = { nonHoldingFor: id => nonHolding.get(id) }
  const second = reader.read(ids, f.sec, options)
  // Owned-work readers are deliberately independent transactions; the truth/receipt
  // connection itself must prepare nothing on repeated fixed-shape reads.
  prepares = 0
  assert.deepEqual(reader.read(ids, f.sec, options), second)
  assert.equal(prepares, 0)
  const writer = new DatabaseSync(f.path)
  t.after(() => writer.close())
  writer.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run(ids[0], f.sec + 60)
  assert.equal(reader.busy(ids[0], f.sec), true)
  assert.equal(reader.read(ids, f.sec).get(ids[0]).active, true)
  writer.exec('DELETE FROM session_turn_leases')
  assert.equal(reader.busy(ids[0], f.sec), false)
})

test('long-lived truth reader reopens replaced stores and sees schema changes', t => {
  const f = fixture(t, 1)
  assert.equal(typeof truth.createHermesSessionTruthReader, 'function')
  const reader = truth.createHermesSessionTruthReader(f.path)
  t.after(() => reader.close())
  assert.equal(reader.read([f.sessions[0].id], f.sec).size, 1)
  const replacement = truthFixture(join(f.root, 'replacement'), 1, f.sec)
  const writer = new DatabaseSync(replacement.path)
  writer.prepare('UPDATE messages SET content=? WHERE role=?').run('Replacement request', 'user')
  writer.close(); renameSync(replacement.path, f.path)
  assert.equal(reader.read([f.sessions[0].id], f.sec).get(f.sessions[0].id).requestPreview, 'Replacement request')
  const ddl = new DatabaseSync(f.path)
  ddl.exec('ALTER TABLE messages ADD COLUMN extra TEXT'); ddl.close()
  assert.equal(reader.read([f.sessions[0].id], f.sec).size, 1)
})

test('batched receipt consumption preserves identity, timestamp, tool delivery and 513-row fence', t => {
  const f = fixture(t, 1), db = new DatabaseSync(f.path)
  t.after(() => db.close())
  assert.equal(typeof receipts.receiptsConsumed, 'function')
  const sid = f.sessions[0].id, add = db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)')
  add.run(sid, 'user', receipts.RECEIPT_PREFIX + 'deleg_a\nFindings', 100)
  add.run(sid, 'tool', '{"delegation_id":"deleg_b","status":"completed","results":[{"summary":"Finding"}]}', 200)
  add.run(sid, 'tool', '{"delegation_id":"deleg_wrong","status":"completed","results":[{"summary":"deleg_c"}]}', 200)
  db.exec('BEGIN')
  for (let i = 0; i < 513; i++) add.run(sid, 'user', 'Not delivery: deleg_fence', 300 + i)
  db.exec('COMMIT')
  const cases = ['deleg_a', 'deleg_b', 'deleg_c', 'deleg_fence'].flatMap(id => [0, 150, 900].map(completedAt => ({ sessionId: sid, id, completedAt })))
  const expected = cases.map(r => receipts.receiptConsumed(db, r.sessionId, r.id, r.completedAt))
  let calls = 0
  const prepare = db.prepare.bind(db)
  t.mock.method(db, 'prepare', sql => { calls++; return prepare(sql) })
  assert.deepEqual(receipts.receiptsConsumed(db, cases), expected)
  assert.equal(calls, 1)
  assert.deepEqual(receipts.receiptsConsumed(db, []), [])
})

test('shared follow-up evidence is not retained across separate builds', t => {
  const f = fixture(t, 1), sid = f.sessions[0].id
  assert.equal(typeof truth.createHermesSessionTruthReader, 'function')
  const reader = truth.createHermesSessionTruthReader(f.path)
  t.after(() => reader.close())
  const build = () => {
    const memo = new Map(), nonHoldingFor = id => { if (!memo.has(id)) memo.set(id, readNonHoldingFollowUps(f.path, id)); return memo.get(id) }
    const result = reader.read([sid], f.sec, { nonHoldingFor })
    const helper = readHelperStatuses(f.path, [sid], { now: f.sec * 1000, nonHoldingFor })
    return { result, helper }
  }
  assert.equal(build().result.get(sid).helpersRunning, undefined)
  const writer = new DatabaseSync(f.path)
  writer.prepare("UPDATE messages SET content='Waiting for required work' WHERE role='assistant' AND content<>''").run(); writer.close()
  assert.equal(build().result.get(sid).helpersRunning, 1)
})

test('automatic full list self-check is thinned to 30 minutes without losing the independent oracle', async t => {
  const f = fixture(t, 31); t.mock.method(Date, 'now', () => f.sec * 1000)
  const run = await instrumentProjection(resolve('.'), join(f.root, 'archive'), f)
  t.after(() => run.close())
  const source = readFileSync('server/service.mjs', 'utf8')
  assert.match(source, /configured === 'shadow' \? 2 \* 60_000 : 30 \* 60_000/)
  assert.match(source, /const expected = await fullCore\(all\)/)
  assert.equal((await run.core.fullCore(f.sessions)).length, f.sessions.length)
  const check = await run.core.check()
  assert.deepEqual(check.faults, [])
})
