// Regressions for the 31 Oct 2026 Agent Service CPU saturation: every Chats list row re-read and
// re-parsed the whole heavy ledger, routed rows opened the agent's state.db three times each, and
// the list cache switched itself off over direct runs it never fingerprinted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { heavyJobsForSession } from '../server/heavy-wait.mjs'
import { createHeavyStatusGuard, guardHeavyStatus } from '../server/thread-status.mjs'
import { createHybridProjector, directRunStamps, mergeStamps } from '../server/session-list-cache.mjs'
import { projectProfileSessions } from '../server/agents-http.mjs'

const check = { state: 'check', ask: 'pending' }
const ledger = (sessions, perSession) => {
  const jobs = []
  for (let s = 0; s < sessions; s++) for (let j = 0; j < perSession; j++) jobs.push({
    job_id: `job_${s}_${j}`, sessionId: `wizard_s${s}`, agent_id: s % 3 === 0 ? 'helper' : 'hermes',
    state: j === perSession - 1 && s % 2 ? 'running' : 'completed', resume: j === perSession - 1 && s % 2 ? '' : 'delivered',
    completion_delivered_at: j === perSession - 1 && s % 2 ? undefined : 1,
  })
  return Object.freeze(jobs)
}

test('heavy session index returns exactly the ledger-order jobs of one agent thread, built once per snapshot', () => {
  const jobs = ledger(40, 5)
  for (const agentId of ['hermes', 'helper']) for (let s = 0; s < 40; s++) {
    const expected = jobs.filter(job => (job.agent_id ?? 'hermes') === agentId && (job.sessionId ?? job.session_id) === `wizard_s${s}`)
    assert.deepEqual(heavyJobsForSession(jobs, agentId, `wizard_s${s}`), expected)
  }
  assert.equal(heavyJobsForSession(jobs, 'hermes', 'wizard_s1'), heavyJobsForSession(jobs, 'hermes', 'wizard_s1'), 'one index per snapshot')
  assert.deepEqual(heavyJobsForSession(jobs, 'hermes', 'missing'), [])
  assert.deepEqual(heavyJobsForSession(null, 'hermes', 'wizard_s1'), [])
  // Legacy rows carry session_id and no agent_id (main agent).
  assert.deepEqual(heavyJobsForSession([{ job_id: 'legacy', session_id: 'wizard_old' }], 'hermes', 'wizard_old').map(job => job.job_id), ['legacy'])
})

test('heavyStatus never reads the ledger per listed row and decides exactly like the full-ledger guard', () => {
  const jobs = ledger(300, 4)
  let reads = 0
  const delivered = []
  const heavyStatus = createHeavyStatusGuard({ rows: () => { reads++; return jobs }, isDelivered: (agentId, sessionId, job) => { delivered.push([agentId, sessionId, job.job_id]); return false } })
  // Non-check statuses cannot change: no ledger read at all.
  for (let s = 0; s < 300; s++) heavyStatus('hermes', `wizard_s${s}`, { state: 'done' })
  assert.equal(reads, 0)
  // A list projection passes one snapshot for all rows.
  for (let s = 0; s < 300; s++) {
    for (const agentId of ['hermes', 'helper']) {
      const got = heavyStatus(agentId, `wizard_s${s}`, check, jobs)
      const want = guardHeavyStatus(check, { agentId, sessionId: `wizard_s${s}`, jobs, isDelivered: () => false })
      assert.deepEqual(got, want, `${agentId} wizard_s${s}`)
    }
  }
  assert.equal(reads, 0, 'rows() is not called per session when a snapshot is passed')
  assert(delivered.every(([agentId, sessionId, id]) => id.startsWith(`job_${sessionId.slice(9)}_`) && ['hermes', 'helper'].includes(agentId)),
    'delivery callbacks only see the row\'s own jobs')
  // Without a snapshot it reads the queue's (cached) snapshot once per call, not a scan per row.
  assert.equal(heavyStatus('hermes', 'wizard_s1', check).state, 'fyi')
  assert.equal(reads, 1)
})

test('routed Chats list prepares open-ask evidence once per list and hands it to every row', async () => {
  const now = Date.now() / 1000
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `wizard_routed_${i}`, title: `Routed ${i}`, last_active: now - i }))
  const prepared = [], seen = []
  const ctx = {
    registry: { fetchAgent: async (_agent, path) => new Response(JSON.stringify(path.endsWith('/messages') ? { data: [] } : {}), { headers: { 'Content-Type': 'application/json' } }) },
    prepareOpenAsk: (agent, ids) => { prepared.push([agent.id, ids]); return new Map(ids.map(id => [id, { marker: id }])) },
    projectOpenAsk: (_agent, row, _replies, _lastUserAt, evidence) => { seen.push(evidence?.get(row.id)?.marker); return { ...row, projected: true } },
  }
  const out = await projectProfileSessions(ctx, { id: 'helper' }, rows, new Headers(), [])
  assert.equal(prepared.length, 1, 'one evidence read per list, not per row')
  assert.deepEqual(prepared[0], ['helper', rows.map(row => row.id)])
  assert.deepEqual(seen.sort(), rows.map(row => row.id).sort())
  assert(out.every(row => row.projected))
  // Older contexts without the batch hook keep the per-row projection.
  delete ctx.prepareOpenAsk
  seen.length = 0
  await projectProfileSessions(ctx, { id: 'helper' }, rows.slice(0, 3), new Headers(), [])
  assert.deepEqual(seen, [undefined, undefined, undefined])
  // A failing batch read does not hide rows: projection falls back per row.
  ctx.prepareOpenAsk = () => { throw new Error('unreadable') }
  const fallback = await projectProfileSessions(ctx, { id: 'helper' }, rows.slice(0, 2), new Headers(), [])
  assert(fallback.every(row => row.projected))
})

test('a direct run leaving the tracker re-projects its cached Chats row (list cache stays on, never stale)', async () => {
  const sessions = Array.from({ length: 150 }, (_, i) => ({ id: `wizard_c${i}`, title: `T${i}` }))
  const target = 'wizard_c140' // outside the always-rebuilt newest batch
  const directRuns = new Map([['run_direct', { sessionId: target, runId: 'run_direct', status: 'running' }]])
  const queueRun = { sessionId: target, publicRunId: 'run_queued', status: 'completed', idempotencyKey: 'k' }
  let projections = 0
  // Mirrors filterSessionList: the newest run (direct or queued) decides wizard_last_run_*; an
  // unqueued direct run has no public run id, so its presence hides the queued receipt's fields.
  const projectBatch = async (batch) => batch.map((session) => {
    projections++
    const runs = [queueRun, ...directRuns.values()].filter(run => run.sessionId === session.id)
    const latest = runs.at(-1)
    return latest?.publicRunId ? { ...session, wizard_last_run_id: latest.publicRunId, wizard_last_run_status: latest.status } : { ...session }
  })
  const stamps = () => mergeStamps(new Map([[target, 'run_queued=completed']]), directRunStamps(directRuns.values()))
  const projector = createHybridProjector({ now: () => 1000 })
  const build = async (hot) => projector.project({ sessions, hot, stamps: stamps(), epoch: 'direct', projectBatch })
  // While tracked the thread is hot (as in hotIds) and its row has no last-run fields.
  let result = await build(new Set([target]))
  assert.equal(result.rows.find(row => row.id === target).wizard_last_run_id, undefined)
  // The run ends and leaves the tracker: no longer hot, queue fingerprint unchanged.
  directRuns.delete('run_direct')
  projections = 0
  result = await build(new Set())
  const row = result.rows.find(row => row.id === target)
  assert.equal(row.wizard_last_run_id, 'run_queued', 'the cached row must not keep the direct run projection')
  assert(!result.cachedIds.includes(target))
  assert.equal(projections, 100 + 1, 'only the newest batch and the changed thread are re-projected')
  // Unchanged afterwards: served from cache again.
  result = await build(new Set())
  assert(result.cachedIds.includes(target))
  // Fingerprints are order-independent and per thread.
  assert.deepEqual(directRunStamps([{ sessionId: 'a', runId: '2', status: 'running' }, { sessionId: 'a', runId: '1', status: 'queued' }, { sessionId: '', runId: 'x' }]),
    new Map([['a', 'direct:1=queued,2=running']]))
})
