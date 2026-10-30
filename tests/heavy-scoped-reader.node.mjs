// Synthetic-only ledger/query-plan regression. Run on the admitted Linux worker.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DurableHeavyQueue } from '../server/heavy-queue.mjs'
import { guardHeavyStatus } from '../server/thread-status.mjs'

// Execute the real service closure, as in ready-thread-speed.node.mjs. The
// optional source file is for a pinned before-fix negative control, not a live hook.
function serviceGuard(queue) {
  const source = readFileSync(process.env.HEAVY_GUARD_COUNTERFACTUAL_SOURCE || new URL('../server/service.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('  const heavyStatus = '), end = source.indexOf('\n  const heavyNotices = ', start)
  assert.ok(start >= 0 && end > start)
  const expression = source.slice(start + '  const heavyStatus = '.length, end).trim()
  const wrap = new Function('guardHeavyStatus', 'heavyWork', 'readNonHoldingFollowUps', 'hermesStatePath', 'runQueue', 'agents', `return (${expression})`)
  return wrap(guardHeavyStatus, { queue }, () => { throw Error('discarded transcript evidence') }, '',
    { get: id => id === 'delivered' ? { upstreamRunId: 'synthetic' } : null },
    { runThread: (_agent, id) => id === 'delivered' ? { session_id: 'thread', heavy_origin: 'origin' } : null })
}
function fixture(t, { legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'scoped-heavy-')), statePath = join(root, 'heavy.db')
  if (legacy) {
    const db = new DatabaseSync(statePath)
    db.exec(`CREATE TABLE heavy_jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL, origin TEXT NOT NULL,
      key TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session,origin,key))`)
    db.prepare('INSERT INTO heavy_jobs VALUES(?,?,?,?,?,?)').run('legacy', 'thread', 'origin', 'legacy', 'hash',
      JSON.stringify({ job_id: 'legacy', sessionId: 'thread', state: 'running', origin: 'origin' }))
    db.close()
  }
  const q = new DurableHeavyQueue({ statePath,
    transport: async () => { throw Error('worker contact forbidden') },
    continuation: async () => { throw Error('continuation forbidden') }, current: async () => false })
  const external = new DatabaseSync(statePath)
  const put = (id, agentId = 'synthetic-agent', sessionId = 'thread', extra = {}) => {
    const job = { job_id: id, agent_id: agentId, sessionId, session_id: sessionId,
      origin: 'origin', state: 'running', resume: '', ...extra }
    external.prepare('INSERT OR REPLACE INTO heavy_jobs(id,session,origin,key,hash,data,agent_id) VALUES(?,?,?,?,?,?,?)')
      .run(id, sessionId, 'origin', id, 'hash', JSON.stringify(job), agentId)
    return job
  }
  t.after(async () => { external.close(); await q.close(); rmSync(root, { recursive: true, force: true }) })
  return { q, external, put }
}
const check = { state: 'check', ask: 'Synthetic', subject: 'Tests', title: 'Synthetic', app_id: 'wizard-quest' }

test('routed heavy guard hydrates no foreign jobs from historical ledger', t => {
  const { q, put } = fixture(t)
  // Two independent dimensions: another agent's same thread, and this agent's
  // other threads. The measured regression was decoding every ledger JSON body.
  for (let i = 0; i < 600; i++) put(`foreign-${i}`, i % 2 ? 'other-agent' : 'synthetic-agent',
    i % 2 ? 'thread' : 'other-thread', { payload: 'synthetic-only'.repeat(512) })
  const relevant = Array.from({ length: 7 }, (_, i) => put(`relevant-${i}`))
  const run = serviceGuard(q), parse = JSON.parse
  let decoded = 0, foreign = 0
  const spy = mock.method(JSON, 'parse', (...args) => {
    const value = parse(...args)
    if (value?.job_id) { decoded++; if (value.job_id.startsWith('foreign-')) foreign++ }
    return value
  })
  let actual
  try { actual = run('synthetic-agent', 'thread', check) } finally { spy.mock.restore() }
  assert.equal(foreign, 0, 'REGRESSION_FOREIGN_LEDGER_HYDRATION')
  assert.equal(decoded, relevant.length, 'hydrate exactly the selected pair, never the full ledger')
  assert.deepEqual(actual, guardHeavyStatus(check, { jobs: relevant, agentId: 'synthetic-agent', sessionId: 'thread' }))
  console.log('SCOPED_HEAVY_WORK ' + JSON.stringify({ foreignRows: 600, matchingRows: 7, decoded, foreign }))
})

test('non-check attention and explicit phase snapshots perform zero default reads', () => {
  let reads = 0
  const queue = { rows: () => { reads++; throw Error('broad read') }, rowsForThread: () => { reads++; throw Error('default read') } }
  const run = serviceGuard(queue)
  for (const status of [undefined, null, { state: 'done' }, { state: 'needs_you' }, { state: 'fyi' }, { state: 'unknown' }]) {
    assert.equal(run('synthetic-agent', 'thread', status), status)
  }
  for (const jobs of [[], null, [{ agent_id: 'synthetic-agent', sessionId: 'thread', state: 'running' }]]) {
    assert.deepEqual(run('synthetic-agent', 'thread', check, jobs),
      guardHeavyStatus(check, { jobs, agentId: 'synthetic-agent', sessionId: 'thread' }))
  }
  assert.equal(reads, 0)
})

test('scoped lookup preserves guard semantics, qualified identities and matching row order', t => {
  const { q, put } = fixture(t)
  const states = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']
  for (const [i, state] of states.entries()) {
    put(`own-${i}`, 'synthetic-agent', 'thread', { state, resume: i % 2 ? 'delivered' : '' })
    put(`foreign-${i}`, 'other-agent', 'thread', { state })
    put(`other-${i}`, 'synthetic-agent', 'other-thread', { state })
  }
  put('main', 'hermes', 'thread')
  // Legacy JSON spelling is still accepted by the guard and scoped reader.
  put('alias', 'synthetic-agent', 'thread', { sessionId: null })
  const run = serviceGuard(q)
  for (const agentId of ['hermes', 'synthetic-agent', 'other-agent', 'absent-agent']) {
    const matching = q.rows().filter(job => (job.agent_id ?? 'hermes') === agentId && (job.sessionId ?? job.session_id) === 'thread')
    assert.deepEqual(q.rowsForThread(agentId, 'thread'), matching)
    for (const state of ['check', 'done', 'fyi', 'needs_you']) {
      const status = { ...check, state }
      assert.deepEqual(run(agentId, 'thread', status), run(agentId, 'thread', status, q.rows()))
    }
  }
  assert.deepEqual(q.rowsForThread('synthetic-agent', 'absent'), [])
})

test('terminal delivery, cancellation and dropped notices match the full-ledger guard for main and routed pairs', t => {
  const { q, external, put } = fixture(t), run = serviceGuard(q)
  put('foreign-running', 'other-agent', 'thread')
  for (const agentId of ['hermes', 'synthetic-agent']) {
    for (const state of ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']) {
      for (const resume of ['', 'delivered', 'suppressed']) {
        for (const flags of [{}, { cancel_requested: true }, { continuation_invalidated: true },
          { completion_delivered_at: 1 }, { continuation_invalidated: true, notice_delivered_at: 1 }]) {
          external.prepare('DELETE FROM heavy_jobs WHERE id=?').run('changing')
          put('changing', agentId, 'thread', { state, resume, ...flags })
          assert.deepEqual(run(agentId, 'thread', check), run(agentId, 'thread', check, q.rows()),
            JSON.stringify({ agentId, state, resume, flags }))
        }
      }
    }
    external.prepare('DELETE FROM heavy_jobs WHERE id=?').run('changing')
  }
})

test('fresh reads observe external ledger mutations without time, cache or revision changes', t => {
  const { q, external, put } = fixture(t), run = serviceGuard(q)
  assert.equal(run('synthetic-agent', 'thread', check), check)
  const job = put('changing')
  assert.equal(run('synthetic-agent', 'thread', check).state, 'fyi')
  external.prepare('UPDATE heavy_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...job, state: 'completed', completion_delivered_at: 1 }), job.job_id)
  assert.equal(run('synthetic-agent', 'thread', check), check)
  put('changing', 'synthetic-agent', 'thread', { state: 'failed', resume: 'superseded' })
  assert.equal(run('synthetic-agent', 'thread', check).state, 'fyi')
  external.prepare('DELETE FROM heavy_jobs WHERE id=?').run(job.job_id)
  assert.equal(run('synthetic-agent', 'thread', check), check)
})

test('scoped query uses the existing qualified index, not a ledger scan', t => {
  const { q, put } = fixture(t)
  for (let i = 0; i < 1000; i++) put(`other-${i}`, 'other-agent', `thread-${i}`)
  put('own')
  const prepare = q.db.prepare.bind(q.db), queries = []
  const spy = mock.method(q.db, 'prepare', (sql, ...rest) => { queries.push(sql); return prepare(sql, ...rest) })
  try { assert.equal(q.rowsForThread('synthetic-agent', 'thread').length, 1) } finally { spy.mock.restore() }
  assert.equal(queries.length, 1)
  const details = prepare('EXPLAIN QUERY PLAN ' + queries[0]).all('synthetic-agent', 'thread').map(row => row.detail)
  assert.ok(details.some(line => /SEARCH heavy_jobs USING INDEX .*\(agent_id=\? AND session=\?\)/.test(line)), JSON.stringify(details))
  assert.ok(details.every(line => !/SCAN heavy_jobs/.test(line)), JSON.stringify(details))
  // A temp sort of matching rowids is allowed; the index need not order all jobs.
  console.log('SCOPED_HEAVY_PLAN ' + JSON.stringify(details))
})

test('legacy migration already supplies qualified relational identity and index', t => {
  const { q } = fixture(t, { legacy: true })
  assert.deepEqual(q.rowsForThread('hermes', 'thread'), q.rows())
  assert.deepEqual(q.rowsForThread('synthetic-agent', 'thread'), [])
  assert.equal(q.rowsForThread('hermes', 'thread')[0].agent_id, 'hermes')
})
