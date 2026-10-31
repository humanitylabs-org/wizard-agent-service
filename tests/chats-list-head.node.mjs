import test from 'node:test'
import assert from 'node:assert/strict'
import { createHybridProjector, diffProjectedRows, projectListSlices } from '../server/session-list-cache.mjs'

function fixture() {
  let at = 0
  const sessions = Array.from({ length: 1100 }, (_, i) => ({ id: `synthetic-${i}`, title: `Title ${i}`, message_count: 2, last_active: 1000 - i }))
  const calls = [], stamps = new Map(), status = new Map()
  const projectBatch = async (batch, head, offset = 0) => {
    calls.push(...batch.map(s => s.id))
    return batch.map((s, i) => ({ ...s, head, enriched: head && (Array.isArray(offset) ? offset[i] : offset + i) < 48, status: status.get(s.id) ?? 'completed' }))
  }
  const projector = createHybridProjector({ now: () => at })
  return { sessions, calls, stamps, status, projector, projectBatch, clock: value => { at = value },
    build: (extra = {}) => projector.project({ sessions, stamps, projectBatch, ...extra }) }
}

test('chats list reuses unchanged head rows', async () => {
  const w = fixture()
  await w.build(); w.calls.length = 0; w.clock(1000)
  const out = await w.build()
  assert.equal(out.head_reused, 100)
  assert.equal(out.head_projected, 0)
  assert.equal(out.projected, 0)
  assert.equal(out.cached, 1100)
  assert.deepEqual(w.calls, [])
  assert(out.cachedIds.includes(w.sessions[0].id), 'self-check must include reused head rows')
})

for (const change of ['new message', 'run status change', 'title change']) test(`chats list re-projects a head row on ${change}`, async () => {
  const w = fixture(); await w.build(); w.calls.length = 0
  const s = w.sessions[7]
  if (change === 'new message') { s.message_count++; s.last_active++ }
  if (change === 'title change') s.title = 'Renamed'
  if (change === 'run status change') { w.stamps.set(s.id, 'run-2=running:200'); w.status.set(s.id, 'running') }
  const out = await w.build()
  assert.equal(out.head_projected, 1)
  assert.equal(out.head_reused, 99)
  assert.deepEqual(w.calls, [s.id])
  assert.deepEqual(out.rows.find(r => r.id === s.id), (await w.projectBatch([s], true, 7))[0])
})

test('head rows are refreshed within the max age, rolling rather than all at once', async () => {
  const w = fixture(); await w.build()
  const refreshed = new Set()
  for (const at of [15000, 30000, 45000, 60000]) {
    w.clock(at); w.calls.length = 0
    const out = await w.build()
    assert(out.head_projected < 100, 'do not refresh the whole head on one deadline')
    for (const id of w.calls) if (Number(id.split('-').at(-1)) < 100) refreshed.add(id)
  }
  assert.equal(refreshed.size, 100)
})

test('output identical to full projection, including sparse head preview offsets and head/cold moves', async () => {
  const w = fixture(); await w.build()
  for (const i of [0, 3, 46, 47, 48, 49, 99, 500]) w.sessions[i].message_count++
  // Unchanged rows crossing the enrichment boundary must be rebuilt too.
  ;[w.sessions[47], w.sessions[48]] = [w.sessions[48], w.sessions[47]]
  ;[w.sessions[99], w.sessions[100]] = [w.sessions[100], w.sessions[99]]
  const hybrid = await w.build()
  const full = [...await w.projectBatch(w.sessions.slice(0, 100), true), ...await w.projectBatch(w.sessions.slice(100), false)]
  assert.deepEqual(hybrid.rows, full)
  assert.deepEqual(diffProjectedRows(full, hybrid.rows), [])
})

test('head cache invalidates global context, outside stamps, live state and explicit clear', async () => {
  const w = fixture(); await w.build({ headContext: 'before' })
  assert.equal((await w.build({ headContext: 'after' })).head_projected, 100)
  w.stamps.set(w.sessions[8].id, 'heavy:delivery-v2')
  assert.equal((await w.build({ headContext: 'after' })).head_projected, 1)
  w.stamps.clear()
  assert.equal((await w.build({ headContext: 'after' })).head_projected, 1)
  w.status.set(w.sessions[9].id, 'running')
  await w.build({ headContext: 'after', hot: new Set([w.sessions[9].id]) })
  w.status.clear()
  assert.equal((await w.build({ headContext: 'after' })).head_projected, 1, 'live cached row must refresh even after hot clears')
  w.projector.clear()
  assert.equal((await w.build({ headContext: 'after' })).head_projected, 100)
})

test('head cache retains filtered rows and drops deleted sessions', async () => {
  const w = fixture(), base = w.projectBatch
  w.projectBatch = async (...args) => (await base(...args)).filter(s => s.id !== 'synthetic-4')
  await w.build({ projectBatch: w.projectBatch })
  const quiet = await w.build({ projectBatch: w.projectBatch })
  assert.equal(quiet.head_reused, 100)
  assert(!quiet.rows.some(s => s.id === 'synthetic-4'))
  w.sessions.splice(5, 1)
  const removed = await w.build({ projectBatch: w.projectBatch })
  assert(!removed.rows.some(s => s.id === 'synthetic-5'))
  assert.equal(w.projector.size(), w.sessions.length)
})

test('first-send extra rows retain the original full-head projection when reuse is disabled', async () => {
  const w = fixture(), base = w.projectBatch
  const projectBatch = async (batch, head, offset) => [...await base(batch, head, offset), ...(head ? [{ id: 'pending-first-send', wizard_pending_first_send: true }] : [])]
  const full = await projectBatch(w.sessions.slice(0, 100), true)
  for (let i = 0; i < 2; i++) {
    const out = await w.build({ projectBatch, reuseHead: false })
    assert.deepEqual(out.rows.slice(0, 101), full)
    assert.equal(out.head_projected, 100)
    assert.equal(out.head_reused, 0)
  }
})

test('cooperative slices retain a sparse batch original preview offset', async () => {
  const offsets = []
  await projectListSlices(Array.from({ length: 23 }, (_, i) => ({ id: `${i}` })), async (rows, head, offset) => {
    offsets.push(offset); assert.equal(head, true); return rows
  }, true, 20, 39)
  assert.deepEqual(offsets, [39, 59])
  const positions = [2, 47, 48, 75, 99], sparseOffsets = []
  await projectListSlices(positions.map(id => ({ id })), async (rows, head, offset) => {
    sparseOffsets.push(offset); return rows
  }, true, 2, positions)
  assert.deepEqual(sparseOffsets, [[2, 47], [48, 75], [99]])
})
