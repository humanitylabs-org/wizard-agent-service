import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readHermesListRevision, readHermesMessageDelta, readRecentHermesRootIds } from '../server/session-truth.mjs'
import * as projection from '../server/session-list-cache.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const { projectListSlices } = projection

test('cooperative list projection preserves every row, global offset and HTTP turns', async () => {
  const source = Array.from({ length: 237 }, (_, i) => ({ id: `synthetic-${i}` })), sizes = [], offsets = []
  let turns = 0, running = true
  const tick = () => { if (running) { turns++; setImmediate(tick) } }; setImmediate(tick)
  try {
    const result = await projectListSlices(source, async (rows, head, offset) => {
      sizes.push(rows.length); offsets.push(offset)
      return rows.map(r => ({ ...r, enriched: head }))
    }, true)
    assert.deepEqual(result, source.map(r => ({ ...r, enriched: true })))
    assert.ok(sizes.every(n => n <= 20)); assert.ok(turns >= sizes.length)
    assert.deepEqual(offsets, sizes.map((_, i) => i * 20))
  } finally { running = false }
})
test('archive slices do not enable head enrichment or duplicate boundaries', async () => {
  const source = Array.from({ length: 101 }, (_, i) => ({ id: `archive-${i}` }))
  assert.deepEqual(await projectListSlices(source, async (rows, head) => { assert.equal(head, false); return rows }, false), source)
  assert.deepEqual(await projectListSlices([], () => { throw Error('empty batch') }, true), [])
})

for (const mode of ['on', 'off', 'shadow']) test(`global 48 preview cap survives chunks, missing/slow upstream: ${mode}`, { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ready-cap-')), calls = [], now = Date.now() / 1000
  mkdirSync(join(root, 'os'))
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: `wizard_cap_${i}`, source: 'wizard-mobile', title: `Synthetic ${i}`,
    message_count: 2, last_active: now - i, started_at: now - 1000 - i,
    latest_message: { role: 'assistant', content: `List fallback ${i}`, timestamp: now - i } }))
  // The production cache reads message deltas, lineage and revision from SQLite even
  // when canonicalSessionReader supplies list rows. An absent DB silently tests off.
  const state = join(root, 'state.db'), db = new DatabaseSync(state)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, started_at REAL, last_activity_at REAL, message_count INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT, active INTEGER);
    CREATE INDEX idx_messages_session_id ON messages(session_id);`)
  const insertSession = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)')
  for (const row of rows) insertSession.run(row.id, null, row.started_at, row.last_active, row.message_count)
  db.close()
  assert.notEqual(readHermesListRevision(state), null, 'real canonical revision must be available')
  assert.deepEqual(readHermesMessageDelta(state, Number.NaN), { maxId: 0, roots: null })
  assert.equal(readRecentHermesRootIds(state, now - 7 * 86400).size, rows.length)
  let writes = 0
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  const server = createWizardServer({ requireAccess: false, agents: false, agentBridge: false, followThrough: false,
    runQueue: false, ownedOpenWork: false, joinedDelegation: 'off', hermesKey: 'synthetic-cap-only',
    wizardOsHome: join(root, 'os'), hermesStatePath: state,
    canonicalSessionReader: () => rows, archivedSessionReader: () => [], pendingFirstSendReader: () => [],
    listCacheMode: mode, listCacheCheckMs: 3600000,
    fetchImpl: async (url, init = {}) => {
      if (init.method && init.method !== 'GET') { writes++; throw Error('upstream writes refused') }
      const path = new URL(url).pathname, m = path.match(/^\/api\/sessions\/wizard_cap_(\d+)\/messages$/)
      if (m) {
        const i = Number(m[1]); calls.push(i)
        // Slow and absent history right at the cap must not spend later rows' budget.
        if (i === 47) { await new Promise(r => setTimeout(r, 20)); return json({}, 503) }
        if (i === 46) return json({ data: [] })
        return json({ data: [{ role: 'user', content: `Request ${i}`, timestamp: now - i - 1 },
          { role: 'assistant', content: `History answer ${i}`, timestamp: now - i, display_kind: 'final', finish_reason: 'stop' }], has_more: false })
      }
      if (path === '/api/sessions') return json({ data: rows, has_more: false })
      return json({ data: [], status: 'ok' })
    } })
  t.after(async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); await server.drained; rmSync(root, { recursive: true, force: true }) })
  const address = await listen(server), origin = `http://127.0.0.1:${address.port}`
  const listUrl = `${origin}/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100`
  // Shadow's normal list intentionally serves the unsliced reference. Body search
  // uses the actual shared sliced projector in shadow too; warm it explicitly.
  const projectionUrl = mode === 'shadow' ? `${listUrl}&mode=body&q=Synthetic` : listUrl
  const projected = await fetch(projectionUrl)
  assert.equal(projected.status, 200)
  const projectedBody = await projected.json()
  const stats = await (await fetch(`${origin}/wizard/list-cache`)).json()
  assert.equal(stats.mode, mode)
  assert.equal(stats.disabled, '')
  assert.equal(stats.fallbacks, 0, 'cap fixture must never fall back to the unsliced reference')
  assert.equal(stats.builds, mode === 'off' ? 0 : 1, 'on/shadow must execute the real shared projector')
  assert.equal(stats.last_projected, mode === 'off' ? 0 : rows.length)
  assert.equal(stats.resets, mode === 'off' ? 0 : 1)
  assert.equal(stats.checks, 0, 'no timer may contaminate the history budget')
  if (mode !== 'off') assert.notEqual(stats.snapshot_age_ms, null)
  console.log('READY_CAP_PATH ' + JSON.stringify({ mode, stats, calls: calls.slice() }))
  assert.deepEqual(calls.slice().sort((a, b) => a - b), Array.from({ length: 48 }, (_, i) => i), 'exactly the original first 48 rows may fetch history')
  const body = mode === 'shadow' ? await (await fetch(listUrl)).json() : projectedBody
  assert.ok(calls.every(i => i < 48), 'reference list must not fetch beyond the original cap')
  assert.equal(body.data.length, 100)
  assert.equal(new Set(body.data.map(r => r.id)).size, 100)
  for (const i of [45, 46, 47, 48, 99]) assert.ok(body.data.some(r => r.id === `wizard_cap_${i}`), `row ${i + 1} preserved`)
  const finalStats = await (await fetch(`${origin}/wizard/list-cache`)).json()
  assert.equal(finalStats.fallbacks, 0)
  assert.equal(finalStats.disabled, '')
  assert.equal(finalStats.builds, stats.builds)
  assert.equal(writes, 0)
})

test('concurrent self-checks join one owner and reset after success', async () => {
  let calls = 0, release
  const check = projection.createJoinedListCheck(() => { calls++; return new Promise(r => { release = r }) })
  const a = check(), b = check()
  assert.equal(a, b)
  await Promise.resolve(); assert.equal(calls, 1)
  release('checked'); assert.deepEqual(await Promise.all([a, b]), ['checked', 'checked'])
  const c = check(); assert.notEqual(c, a)
  await Promise.resolve(); assert.equal(calls, 2); release('again'); assert.equal(await c, 'again')
})
test('concurrent self-check failure is shared and next check can retry (including sync throw)', async () => {
  let calls = 0, reject
  const failure = Error('synthetic check failure')
  const check = projection.createJoinedListCheck(() => { calls++; if (calls === 2) throw failure; return new Promise((_, r) => { reject = r }) })
  const a = check(), b = check(); assert.equal(a, b)
  const settled = Promise.allSettled([a, b]); await Promise.resolve(); reject(failure)
  for (const result of await settled) { assert.equal(result.status, 'rejected'); assert.equal(result.reason, failure) }
  await assert.rejects(check(), e => e === failure); assert.equal(calls, 2)
  const retry = check(); const observed = assert.rejects(retry, e => e === failure)
  await Promise.resolve(); assert.equal(calls, 3); reject(failure); await observed
})
