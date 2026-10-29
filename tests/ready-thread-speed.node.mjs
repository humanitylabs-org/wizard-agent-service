import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  let writes = 0
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  const server = createWizardServer({ requireAccess: false, agents: false, agentBridge: false, followThrough: false,
    runQueue: false, ownedOpenWork: false, joinedDelegation: 'off', hermesKey: 'synthetic-cap-only',
    wizardOsHome: join(root, 'os'), hermesStatePath: join(root, 'absent.db'),
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
  const address = await listen(server)
  const response = await fetch(`http://127.0.0.1:${address.port}/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(calls.slice().sort((a, b) => a - b), Array.from({ length: 48 }, (_, i) => i), 'exactly the original first 48 rows may fetch history')
  assert.equal(body.data.length, 100)
  assert.equal(new Set(body.data.map(r => r.id)).size, 100)
  for (const i of [45, 46, 47, 48, 99]) assert.ok(body.data.some(r => r.id === `wizard_cap_${i}`), `row ${i + 1} preserved`)
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
