import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, statSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DurableHeavyQueue } from '../server/heavy-queue.mjs'
import { DurableRunQueue } from '../server/run-queue.mjs'
import { createAgentRegistry } from '../server/agents.mjs'

function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chats-cpu-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function heavy(t) {
  const q = new DurableHeavyQueue({ statePath: join(root(t), 'heavy.db'), transport: async () => { throw Error('unexpected RPC') },
    current: async () => true, continuation: async () => { throw Error('unexpected continuation') } })
  t.after(() => q.close())
  const job = { job_id: 'synthetic-heavy', sessionId: 'synthetic-session', agent_id: 'hermes', state: 'completed', resume: 'delivered',
    spec: { argv: ['true'] }, receipt: { exit_code: 0 } }
  q.db.prepare('INSERT INTO heavy_jobs(id,session,origin,key,hash,data,agent_id) VALUES(?,?,?,?,?,?,?)')
    .run(job.job_id, job.sessionId, 'synthetic-origin', 'synthetic-key', 'synthetic-hash', JSON.stringify(job), 'hermes')
  return { q, job }
}
test('heavy queue parses job rows once per data change', async t => {
  const { q, job } = heavy(t)
  let parses = 0
  const parse = JSON.parse
  t.mock.method(JSON, 'parse', (...args) => { parses++; return parse(...args) })
  const initial = q.rows()
  q.rows(); q.summary(); await q.tick(); q.rows()
  assert.equal(parses, 1)
  assert.equal(q.rows(), initial)
  const version = () => q.db.prepare('PRAGMA data_version').get().data_version
  const before = version()
  q.save({ ...job, reason: 'own write' })
  assert.equal(version(), before, 'own writes do not bump data_version')
  assert.equal(q.rows()[0].reason, 'own write')
  assert.equal(parses, 2)
  const other = new DatabaseSync(q.db.location())
  try { other.prepare('UPDATE heavy_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...job, reason: 'external write' }), job.job_id) }
  finally { other.close() }
  assert.equal(q.rows()[0].reason, 'external write')
  q.rows(); assert.equal(parses, 3)
})
test('heavy queue submit invalidates a primed snapshot even when data_version does not change', t => {
  const { q } = heavy(t)
  const prior = { root: process.env.WIZARD_HEAVY_ROOT, hosts: process.env.WIZARD_BUILD_HOSTS, named: process.env.WIZARD_HEAVY_THALES_ROOT }
  process.env.WIZARD_BUILD_HOSTS = 'thales'
  process.env.WIZARD_HEAVY_ROOT = process.env.WIZARD_HEAVY_THALES_ROOT = join(tmpdir(), 'synthetic-heavy-work')
  t.after(() => {
    for (const [key, value] of [['WIZARD_HEAVY_ROOT', prior.root], ['WIZARD_BUILD_HOSTS', prior.hosts], ['WIZARD_HEAVY_THALES_ROOT', prior.named]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })
  const initial = q.rows()
  const version = q.db.prepare('PRAGMA data_version').get().data_version
  const job = q.submit({ sessionId: 'new', origin: 'origin', key: 'new',
    spec: { cwd: process.env.WIZARD_HEAVY_ROOT, argv: ['true'], timeout_seconds: 1 } })
  assert.equal(q.db.prepare('PRAGMA data_version').get().data_version, version)
  assert.notEqual(q.rows(), initial)
  assert.equal(q.rows().length, 2)
  assert.equal(q.rows()[1].job_id, job.job_id)
})
test('heavy queue cached snapshots cannot be mutated by presentation callers', t => {
  const { q } = heavy(t)
  const rows = q.rows()
  assert.throws(() => rows.push({}), TypeError)
  assert.throws(() => { rows[0].receipt.exit_code = 99 }, TypeError)
  assert.throws(() => { rows[0].spec.argv[0] = 'changed' }, TypeError)
  assert.equal(q.get(rows[0].job_id).receipt.exit_code, 0)
  const independent = q.get(rows[0].job_id)
  independent.receipt.exit_code = 42
  assert.equal(q.rows()[0].receipt.exit_code, 0)
})
test('heavy queue skips per-job reads for terminal delivered snapshots', async t => {
  const { q } = heavy(t)
  let reads = 0
  const get = q.get.bind(q)
  q.get = id => { reads++; return get(id) }
  await q.tick()
  assert.equal(reads, 0)
})
test('chats list refresh does not rewrite an unchanged session catalog and still pins sightings', async t => {
  const agentsDir = join(root(t), 'agents')
  mkdirSync(agentsDir)
  let now = 1000
  const registry = createAgentRegistry({ agentsDir, now: () => now })
  registry.observeSessions('hermes', ['a', 'b'], { index: false })
  const path = join(agentsDir, '.session-catalog.json')
  const first = readFileSync(path, 'utf8')
  utimesSync(path, 1, 1)
  now++
  registry.observeSessions('hermes', ['b', 'a', 'a'])
  assert.equal(statSync(path).mtimeMs, 1000)
  assert.equal(readFileSync(path, 'utf8'), first)
  assert.equal(await registry.catalogContains('hermes', 'a'), true)
  const pins = JSON.parse(readFileSync(join(agentsDir, '.threads.json'), 'utf8'))
  assert.equal(Object.keys(pins.threads).length, 2, 'pin loop still runs on an unchanged catalog')
  registry.observeSessions('hermes', ['c'])
  assert.notEqual(readFileSync(path, 'utf8'), first)
  assert.equal(await registry.catalogContains('hermes', 'c'), true)
})
test('latest session run uses indexed MAX rowid without a temporary sort and preserves insertion order', t => {
  const q = new DurableRunQueue({ statePath: join(root(t), 'runs.db'), pollIntervalMs: 0,
    launch: async () => { throw Error('no dispatch') }, lookup: async () => ({}) })
  t.after(() => q.close())
  const insert = q.database.prepare(`INSERT INTO wizard_run_queue
    (public_run_id,runtime,session_id,idempotency_key,request_hash,body,status,created_at,updated_at,agent_id)
    VALUES (?,'direct',?,?,?,?,?,?,?,'hermes')`)
  insert.run('z-first', 'same', 'first', 'hash', '{}', 'failed', 200, 200)
  insert.run('a-second', 'same', 'second', 'hash', '{}', 'unknown', 100, 100)
  insert.run('other', 'different', 'other', 'hash', '{}', 'failed', 300, 300)
  const queries = [], prepare = q.database.prepare.bind(q.database)
  t.mock.method(q.database, 'prepare', sql => { queries.push(sql); return prepare(sql) })
  assert.equal(q.latestForSession('same').publicRunId, 'a-second')
  assert.equal(q.latestForSession('missing'), null)
  assert.match(queries[0], /MAX\(rowid\)/i)
  const plan = prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all('same').map(r => r.detail).join('\n')
  assert.match(plan, /USING COVERING INDEX wizard_run_queue_session_latest/)
  assert.doesNotMatch(plan, /TEMP B-TREE/)
})
