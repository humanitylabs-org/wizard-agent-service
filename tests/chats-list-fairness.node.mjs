import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { truthFixture } from './fixtures/chats-truth.mjs'
import { createListEvidenceLane } from '../server/list-evidence-lane.mjs'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'list-fairness-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, ...truthFixture(join(root, 'fixture'), 31) }
}
const input = f => ({ ids: f.sessions.map(row => row.id), activeSessionIds: [], heavyJobs: [], operator: false, now: f.sec * 1000 })

test('worker list evidence deep-equals the fallback across receipts and optional follow-ups', async t => {
  const f = fixture(t), worker = createListEvidenceLane({ hermesStatePath: f.path }), local = createListEvidenceLane({ hermesStatePath: f.path, enabled: false })
  t.after(async () => { await worker.close(); await local.close() })
  const before = readFileSync(f.path)
  const expected = await local.read(input(f))
  const actual = await worker.read(input(f))
  assert.deepEqual(actual, expected)
  assert.equal(worker.stats().worker_reads, 1)
  assert.equal(worker.stats().fallbacks, 0)
  assert.deepEqual(readFileSync(f.path), before, 'projection must not modify history')
  assert(actual.followUps.get(f.sessions[0].id).has('deleg_optional_0'))
})

test('supervisor hot discovery uses the same read-only worker as full row evidence', async t => {
  const f = fixture(t), supervisorStatePath = join(f.root, 'supervisor.sqlite3')
  const db = new DatabaseSync(supervisorStatePath)
  db.exec('CREATE TABLE reviews(id TEXT,thread TEXT,state TEXT); CREATE TABLE builds(id TEXT,thread TEXT,state TEXT,data TEXT,review TEXT)')
  db.prepare('INSERT INTO reviews VALUES(?,?,?)').run('review', f.sessions[0].id, 'open')
  db.prepare('INSERT INTO builds VALUES(?,?,?,?,?)').run('build', f.sessions[1].id, 'running', JSON.stringify({ created_at: f.sec * 1000 }), 'review')
  db.close()
  const worker = createListEvidenceLane({ hermesStatePath: f.path }), local = createListEvidenceLane({ hermesStatePath: f.path, enabled: false })
  t.after(async () => { await worker.close(); await local.close() })
  const request = { ...input(f), kind: 'signals', supervisorStatePath }
  const expected = await local.read(request)
  assert.deepEqual(await worker.read(request), expected)
  assert.deepEqual(expected.supervisorWaitIds, [f.sessions[0].id])
  assert(expected.supervisorStamps.get(f.sessions[0].id).includes('build:running:open'))
  assert.equal(worker.stats().worker_reads, 1)
})

test('worker never performs transcript SQLite reads on the HTTP thread', async t => {
  const f = fixture(t), worker = createListEvidenceLane({ hermesStatePath: f.path })
  t.after(() => worker.close())
  t.mock.method(DatabaseSync.prototype, 'prepare', () => { throw new Error('main-thread SQLite is forbidden during the worker read') })
  assert.equal((await worker.read(input(f))).sessionTruth.size, 31)
  assert.equal(worker.stats().worker_reads, 1)
  assert.equal(worker.stats().fallbacks, 0)
})

test('worker requests retain separate inputs and see writes on the next projection', async t => {
  const f = fixture(t), worker = createListEvidenceLane({ hermesStatePath: f.path })
  t.after(() => worker.close())
  const a = { ...input(f), ids: [f.sessions[26].id] }, b = { ...input(f), ids: [f.sessions[27].id] }
  const [left, right] = await Promise.all([worker.read(a), worker.read(b)])
  assert.deepEqual([...left.sessionTruth.keys()], a.ids)
  assert.deepEqual([...right.sessionTruth.keys()], b.ids)
  const db = new DatabaseSync(f.path)
  db.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run(a.ids[0], f.sec + 60); db.close()
  assert.equal((await worker.read(a)).sessionTruth.get(a.ids[0]).active, true)
  assert.equal(worker.stats().pending, 0)
})

test('worker failure logs once and preserves list rows through the in-thread fallback', async t => {
  const f = fixture(t), logs = [], local = createListEvidenceLane({ hermesStatePath: f.path, enabled: false })
  const worker = createListEvidenceLane({ hermesStatePath: f.path, log: line => logs.push(line), workerUrl: new URL('./fixtures/no-such-list-worker.mjs', import.meta.url) })
  t.after(async () => { await worker.close(); await local.close() })
  const expected = await local.read(input(f))
  assert.deepEqual(await worker.read(input(f)), expected)
  assert.deepEqual(await worker.read(input(f)), expected)
  assert.equal(logs.length, 1)
  assert.equal(worker.stats().fallbacks, 2)
  assert.equal(worker.stats().pending, 0)
})

test('closing the service evidence lane rejects pending work and leaves no worker or timer', async t => {
  const f = fixture(t), worker = createListEvidenceLane({ hermesStatePath: f.path })
  const rejected = assert.rejects(worker.read(input(f)), /lane closed/)
  await worker.close(); await rejected; await worker.close()
  assert.equal(worker.stats().pending, 0)
  await assert.rejects(worker.read(input(f)), /lane closed/)
})

test('run status refresh does not join an unrelated slow full queue tick', async t => {
  const f = fixture(t)
  let unblock, entered, reads = 0
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const block = new Promise(resolve => { unblock = resolve })
  const queue = new DurableRunQueue({ statePath: join(f.root, 'queue.sqlite3'), pollIntervalMs: 0, canDispatch: () => false,
    launch: async () => { throw new Error('must not dispatch') }, lookup: async record => {
      if (record.sessionId === 'slow') { entered(); await block }
      else { reads++; await new Promise(resolve => setImmediate(resolve)) }
      return { capacityStatus: 'completed', payload: { status: 'completed', output: 'Synthetic result' } }
    } })
  t.after(() => queue.close())
  const add = sid => {
    const body = JSON.stringify({ session_id: sid, input: 'Synthetic request' })
    const { record } = queue._admitRow({ runtime: 'direct', sessionId: sid, body, idempotencyKey: sid, requestHash: queueRequestHash('direct', body) })
    return queue._update(record.publicRunId, { status: 'running', upstreamRunId: `upstream_${sid}` })
  }
  add('slow'); const fast = add('fast')
  const ticking = queue.tick(true); await enteredPromise
  try {
    const at = performance.now()
    const [a, b] = await Promise.all([queue.refreshRun(fast.publicRunId), queue.refreshRun(fast.publicRunId)])
    assert.equal(a.status, 'completed'); assert.deepEqual(a, b)
    assert.equal(reads, 1, 'concurrent polls must share this run only')
    assert(performance.now() - at < 300)
  } finally { unblock(); await ticking }
})
