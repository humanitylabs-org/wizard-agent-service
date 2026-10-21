import test from 'node:test'
import assert from 'node:assert/strict'
import { cacheableRow, createHybridProjector, createSharedSnapshot, diffProjectedRows, listCacheMode } from '../server/session-list-cache.mjs'

// A fake projection: a thread's status comes from a mutable "world" (runs, failures), the way the
// real projection reads the queue and Hermes truth. Counts every projected thread.
function world(count = 250) {
  const sessions = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `T${i}`, last_active: 1000 - i, message_count: 4 }))
  const status = new Map()
  const projected = []
  const projectBatch = async (batch, firstPage) => {
    assert(batch.length <= 100, 'batches stay bounded')
    projected.push(...batch.map((s) => s.id))
    return batch.map((s) => ({ id: s.id, title: s.title, ...(status.has(s.id) ? { status: status.get(s.id) } : {}), first: firstPage }))
  }
  return { sessions, status, projected, projectBatch }
}
const row = (rows, id) => rows.find((r) => r.id === id)

test('cache mode setting: on by default, off and shadow honoured', () => {
  assert.equal(listCacheMode(undefined), 'on')
  assert.equal(listCacheMode(' OFF '), 'off')
  assert.equal(listCacheMode('shadow'), 'shadow')
  assert.equal(listCacheMode('nonsense'), 'on')
})

test('only quiet rows are cacheable: Working, failed, waiting and helper rows never are', () => {
  assert.equal(cacheableRow({ id: 'a' }), true)
  assert.equal(cacheableRow(null), true)
  for (const status of ['queued', 'running', 'failed', 'interrupted', 'waiting_for_approval', 'unknown']) assert.equal(cacheableRow({ id: 'a', status }), false, status)
  for (const field of ['wizard_waiting_on', 'wizard_helper_status', 'wizard_background_result', 'wizard_safe_error', 'wizard_pending_first_send']) {
    assert.equal(cacheableRow({ id: 'a', [field]: 'x' }), false, field)
  }
})

test('idle archive threads are served from cache; the newest batch is always rebuilt', async () => {
  const w = world()
  const p = createHybridProjector({ now: () => 0 })
  const first = await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
  assert.equal(first.projected, 250)
  w.projected.length = 0
  const second = await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
  assert.equal(second.projected, 100)
  assert.equal(second.cached, 150)
  assert.deepEqual(second.rows.map((r) => r.id), w.sessions.map((s) => s.id))
})

test('an old cached thread gets a new run: Working, then Ready when it finishes', async () => {
  const w = world()
  const p = createHybridProjector({ now: () => 0 })
  await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
  // A new send to old thread s200: the signal marks it hot for the build that sees the run.
  w.status.set('s200', 'running')
  const working = await p.project({ sessions: w.sessions, hot: new Set(['s200']), projectBatch: w.projectBatch })
  assert.equal(row(working.rows, 's200').status, 'running')
  // The run finishes and no signal names the thread: a Working row is never served from cache.
  w.status.delete('s200')
  const ready = await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
  assert.equal(row(ready.rows, 's200').status, undefined)
})

test('a failed send stays Not sent across refreshes and clears only when the failure clears', async () => {
  const w = world()
  const p = createHybridProjector({ now: () => 0 })
  w.status.set('s180', 'failed')
  for (let i = 0; i < 3; i++) {
    const out = await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
    assert.equal(row(out.rows, 's180').status, 'failed')
  }
  w.status.delete('s180') // dismissed
  const out = await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
  assert.equal(row(out.rows, 's180').status, undefined)
})

test('a changed Hermes row (new message, rename, archive) is re-projected without any hot signal', async () => {
  const w = world()
  const p = createHybridProjector({ now: () => 0 })
  await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
  const changed = w.sessions.map((s) => (s.id === 's150' ? { ...s, title: 'Renamed', message_count: 5 } : s))
  w.projected.length = 0
  const out = await p.project({ sessions: changed, projectBatch: w.projectBatch })
  assert.equal(row(out.rows, 's150').title, 'Renamed')
  assert(w.projected.includes('s150'))
})

test('an archive thread whose old queue run is pruned (or changes) is re-projected without any hot signal', async () => {
  const w = world()
  const lastRun = new Map([['s200', 'wizardq_old']])
  const projectBatch = async (batch, first) => (await w.projectBatch(batch, first))
    .map((r) => (lastRun.has(r.id) ? { ...r, wizard_last_run_id: lastRun.get(r.id) } : r))
  const stamps = () => new Map([...lastRun].map(([id, run]) => [id, `${run}=completed`]))
  const p = createHybridProjector({ now: () => 0 })
  await p.project({ sessions: w.sessions, stamps: stamps(), projectBatch })
  w.projected.length = 0
  const quiet = await p.project({ sessions: w.sessions, stamps: stamps(), projectBatch })
  assert.equal(row(quiet.rows, 's200').wizard_last_run_id, 'wizardq_old')
  assert.equal(w.projected.length, 100, 'nothing changed: only the newest batch')
  lastRun.delete('s200')  // 7-day retention deleted the row
  w.projected.length = 0
  const pruned = await p.project({ sessions: w.sessions, stamps: stamps(), projectBatch })
  assert.equal(row(pruned.rows, 's200').wizard_last_run_id, undefined)
  assert.deepEqual(w.projected.slice(100), ['s200'])
  lastRun.set('s180', 'wizardq_new')
  const added = await p.project({ sessions: w.sessions, stamps: stamps(), projectBatch })
  assert.equal(row(added.rows, 's180').wizard_last_run_id, 'wizardq_new')
})

test('removed threads drop out; new threads appear', async () => {
  const w = world()
  const p = createHybridProjector({ now: () => 0 })
  await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
  const next = [...w.sessions.filter((s) => s.id !== 's210'), { id: 'late', title: 'L', last_active: 1 }]
  const out = await p.project({ sessions: next, projectBatch: w.projectBatch })
  assert.equal(row(out.rows, 's210'), undefined)
  assert.equal(row(out.rows, 'late').title, 'L')
  assert.equal(p.size(), 150)
})

test('a change no signal saw is corrected by the rolling sweep, at ~100 threads a minute', async () => {
  let clock = 0
  const w = world(400)
  const p = createHybridProjector({ now: () => clock, sweepMaxAgeMs: 10 * 60_000, sweepPerMinute: 100 })
  await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
  w.status.set('s399', 'idle-but-changed') // hidden change, not a live status, no signal
  let seenAt = null
  for (clock = 15_000; clock <= 20 * 60_000; clock += 15_000) {
    w.projected.length = 0
    const out = await p.project({ sessions: w.sessions, projectBatch: w.projectBatch })
    assert(w.projected.length - 100 <= 25 + 1, 'sweep budget per 15 s poll stays near 25 threads')
    if (!seenAt && row(out.rows, 's399').status === 'idle-but-changed') seenAt = clock
  }
  assert(seenAt !== null && seenAt <= 14 * 60_000, `corrected within one sweep cycle, got ${seenAt}`)
})

test('a projection that is not one row per thread refuses to cache', async () => {
  const p = createHybridProjector({ now: () => 0 })
  const sessions = Array.from({ length: 150 }, (_, i) => ({ id: `s${i}` }))
  await assert.rejects(p.project({ sessions, projectBatch: async (batch) => batch.map((s) => ({ id: `${s.id}-tip` })) }),
    (error) => error.code === 'list_cache_unkeyed')
})

test('shared snapshot: one rebuild for concurrent clients; reuse only while nothing changed', async () => {
  let clock = 0
  let builds = 0
  const snap = createSharedSnapshot({ now: () => clock, debounceMs: 3000, ceilingMs: 30_000 })
  const build = async () => { builds++; await new Promise((r) => setTimeout(r, 5)); return [builds] }
  const [a, b] = await Promise.all([snap.get({ gate: 'g1', local: 0, build }), snap.get({ gate: 'g1', local: 0, build })])
  assert.equal(builds, 1); assert.deepEqual(a, b)
  clock = 10_000; await snap.get({ gate: 'g1', local: 0, build }); assert.equal(builds, 1, 'unchanged gate reuses')
  clock = 11_000; await snap.get({ gate: 'g2', local: 0, build }); assert.equal(builds, 2, 'changed gate rebuilds')
  clock = 12_000; await snap.get({ gate: 'g3', local: 0, build }); assert.equal(builds, 2, 'changes within 3 s share one rebuild')
  clock = 14_500; await snap.get({ gate: 'g3', local: 0, build }); assert.equal(builds, 3)
  clock = 14_600; await snap.get({ gate: 'g3', local: 1, build }); assert.equal(builds, 4, 'an owner action always rebuilds')
  clock = 50_000; await snap.get({ gate: 'g3', local: 1, build }); assert.equal(builds, 5, 'forced refresh after 30 s')
  clock = 50_100; await snap.get({ gate: null, local: 1, build }); assert.equal(builds, 5, 'unknown gate: debounce only')
  clock = 54_000; await snap.get({ gate: null, local: 1, build }); assert.equal(builds, 6)
})

test('shared snapshot: a rebuild that began before an owner action does not answer for it', async () => {
  let builds = 0
  let release
  const snap = createSharedSnapshot({ now: () => 0 })
  const slow = snap.get({ gate: 'g', local: 0, build: async () => { builds++; await new Promise((r) => { release = r }); return ['before'] } })
  await new Promise((r) => setImmediate(r))
  const after = snap.get({ gate: 'g', local: 1, build: async () => { builds++; return ['after'] } })
  release()
  assert.deepEqual(await slow, ['before'])
  assert.deepEqual(await after, ['after'])
  assert.equal(builds, 2)
})

test('shared snapshot: a failed build is not cached and the next call retries', async () => {
  const snap = createSharedSnapshot({ now: () => 0 })
  await assert.rejects(snap.get({ gate: 'g', local: 0, build: async () => { throw new Error('boom') } }))
  assert.deepEqual(await snap.get({ gate: 'g', local: 0, build: async () => ['ok'] }), ['ok'])
})

test('diff names the threads and fields that differ', () => {
  const d = diffProjectedRows([{ id: 'a', status: 'running' }, { id: 'b' }], [{ id: 'a' }, { id: 'c' }])
  assert.deepEqual(d, [{ id: 'a', kind: 'changed', fields: ['status'] }, { id: 'b', kind: 'missing' }, { id: 'c', kind: 'extra' }])
})
