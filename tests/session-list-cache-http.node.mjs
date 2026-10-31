import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'

const close = (s) => new Promise((r) => s.close(r))
const strip = ({ snapshot, archive_cursor, ...rest }) => rest

test('Chats window: the shared list cache serves exactly what the full rebuild serves', { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'list-cache-')); const servers = []
  t.after(async () => { for (const s of servers.reverse()) await close(s); rmSync(root, { recursive: true, force: true }) })
  let wall = Date.now()
  t.mock.method(Date, 'now', () => wall)
  const now = wall / 1000
  const rows = Array.from({ length: 260 }, (_, i) => ({ id: `wizard_synthetic_${i}`, source: 'api_server', title: `Synthetic ${i}`, hidden: false,
    parent_session_id: null, message_count: 4, last_active: now - 20 * 86400 - i, started_at: now - 20 * 86400 - i, archived: i % 2 === 0,
    latest_message: { role: 'assistant', content: `preview ${i}`, timestamp: now - 20 * 86400 - i } }))
  rows.push({ ...rows[0], id: 'wizard_failed', status: 'failed', last_active: now })
  const state = join(root, 'state.db'); const db = new DatabaseSync(state)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, started_at REAL, last_activity_at REAL, message_count INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT, active INTEGER);
    CREATE INDEX idx_messages_session_id ON messages(session_id);`)
  const insertSession = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)')
  for (const r of rows) insertSession.run(r.id, null, r.started_at, r.last_active, 4)
  db.prepare('INSERT INTO messages(session_id, role, content, timestamp) VALUES(?,?,?,?)').run(rows[250].id, 'user', 'old request', now - 50 * 86400)
  db.close()
  const up = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json'); const url = new URL(req.url, 'http://fixture')
    if (url.pathname.endsWith('/messages')) { res.end(JSON.stringify({ data: [], has_more: false })); return }
    if (url.pathname === '/api/sessions') { const off = Number(url.searchParams.get('offset') || 0); res.end(JSON.stringify({ data: rows.slice(off, off + 100), has_more: off + 100 < rows.length })); return }
    res.end('{}')
  }); servers.push(up); const u = await listen(up); mkdirSync(join(root, 'os'))
  const options = { upstreamOrigin: `http://127.0.0.1:${u.port}`, hermesKey: 'synthetic-api-key', requireAccess: false, agents: false, agentBridge: false,
    followThrough: false, joinedDelegation: 'off', wizardOsHome: join(root, 'os'), hermesStatePath: state, canonicalSessionReader: () => rows, runQueue: false }
  const cached = createWizardServer({ ...options, listCacheMode: 'on', listCacheStaleMs: 0, listCacheCheckMs: 1_000 }); servers.push(cached)
  const full = createWizardServer({ ...options, listCacheMode: 'off' }); servers.push(full)
  const [a, b] = [await listen(cached), await listen(full)]
  const get = async (port, suffix) => (await fetch(`http://127.0.0.1:${port}${suffix}`)).json()
  const windowPage = '/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100'
  const same = async (label) => {
    const [left, right] = [await get(a.port, windowPage), await get(b.port, windowPage)]
    assert.deepEqual(strip(left), strip(right), label)
    const [olderLeft, olderRight] = [await get(a.port, `${windowPage}&cursor=${left.archive_cursor}`), await get(b.port, `${windowPage}&cursor=${right.archive_cursor}`)]
    assert.deepEqual(strip(olderLeft), strip(olderRight), `${label} (older archive)`)
    return left
  }
  await same('first load')
  wall += 31_000 // expire the shared 30-s snapshot without an owner-write/global invalidation
  await same('unchanged head is reused')
  const reused = await get(a.port, '/wizard/list-cache')
  assert(reused.head_reused > 0 && reused.head_projected < 100, JSON.stringify(reused))
  assert.equal(reused.check_differences, 0)
  // Exercise the real joined periodic full-projection safety net, not just the
  // initial zero-valued diagnostic counters.
  for (let attempt = 0; attempt < 50 && !(await get(a.port, '/wizard/list-cache')).checks; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert((await get(a.port, '/wizard/list-cache')).checks > 0)
  // Owner action (any write) makes the next list rebuild immediately, never from the snapshot.
  rows[180] = { ...rows[180], title: 'Renamed far down the list', archived: false, last_active: now }
  await fetch(`http://127.0.0.1:${a.port}/wizard/nothing-here`, { method: 'POST' }).catch(() => undefined)
  const renamed = await same('after a rename and restore outside the newest batch')
  assert(renamed.data.some((r) => r.id === rows[180].id && r.title === 'Renamed far down the list'))
  rows[230] = { ...rows[230], status: 'failed', archived: false, last_active: rows[230].last_active }
  await fetch(`http://127.0.0.1:${a.port}/wizard/nothing-here`, { method: 'POST' }).catch(() => undefined)
  await same('an old thread that failed')
  const stats = await get(a.port, '/wizard/list-cache')
  assert.equal(stats.mode, 'on')
  assert(Number.isFinite(stats.head_ms) && Number.isFinite(stats.hot_ms))
  assert(Number.isFinite(stats.speed.event_loop.delay_p99_ms))
  const routes = Object.entries(stats.speed.routes)
  assert(routes.some(([key, row]) => key.includes('/wizard/:id/api/sessions') && row.count >= 1 && row.total_ms >= 0))
  assert.equal(stats.fallbacks, 0, JSON.stringify(stats))
  assert.equal(stats.check_differences, 0, JSON.stringify(stats))
  assert.equal(stats.check_live_differences, 0, JSON.stringify(stats))
  assert(stats.builds >= 3 && stats.last_cached > 100, JSON.stringify(stats))
  const check = await get(b.port, '/wizard/list-cache')
  assert.equal(check.mode, 'off')
})

async function headFixture(t, { count = 105, pending = [], checkMs = 3600000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'head-writes-')), servers = []
  t.after(async () => { for (const s of servers.reverse()) await close(s); rmSync(root, { recursive: true, force: true }) })
  let wall = Date.now()
  t.mock.method(Date, 'now', () => wall)
  const now = wall / 1000, apps = join(root, 'apps.json'), state = join(root, 'state.db')
  const rows = Array.from({ length: count }, (_, i) => ({ id: `wizard_fixture_${i}`, source: 'api_server', title: `Synthetic ${i}`,
    hidden: false, parent_session_id: null, message_count: 2, last_active: now - 86400 - i, started_at: now - 86400 - i }))
  const db = new DatabaseSync(state)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, started_at REAL, last_activity_at REAL, message_count INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT, active INTEGER);
    CREATE INDEX idx_messages_session_id ON messages(session_id);
    ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'api_server';
    ALTER TABLE sessions ADD COLUMN hidden INTEGER DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN last_activity_description TEXT DEFAULT '';
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);`)
  for (const r of [...rows, ...pending]) db.prepare('INSERT INTO sessions(id,parent_session_id,started_at,last_activity_at,message_count) VALUES(?,?,?,?,?)').run(r.id, null, r.started_at ?? now, r.last_active ?? now, r.message_count)
  db.close()
  const setApps = ids => writeFileSync(apps, JSON.stringify({ apps: ids.map(id => ({ id, name: id, view: `/apps/${id}/` })) }))
  setApps(['synthetic-app'])
  const options = { upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'synthetic-key', requireAccess: false, agents: false, agentBridge: false,
    followThrough: false, scheduler: false, joinedDelegation: 'off', hermesStatePath: state, canonicalSessionReader: () => rows,
    appsJsonPath: apps, pendingFirstSendReader: () => pending,
    fetchImpl: async (url, init) => {
      assert.equal(init?.method ?? 'GET', 'GET', 'fixture must never admit work')
      assert(new URL(url).pathname.endsWith('/messages'), `unexpected fetch: ${url}`)
      return new Response(JSON.stringify({ data: [{ role: 'assistant', content: 'Synthetic answer.\n[WIZARD_STATUS_V1] {"state":"done","app_id":"synthetic-app"}', timestamp: now - 86400 }], has_more: false }), { headers: { 'Content-Type': 'application/json' } })
    } }
  const ports = []
  for (const mode of ['on', 'off']) {
    const home = join(root, mode); mkdirSync(home)
    const server = createWizardServer({ ...options, wizardOsHome: home, runQueueStatePath: join(home, 'queue.sqlite3'), listCacheMode: mode, listCacheStaleMs: 0, listCacheCheckMs: checkMs })
    servers.push(server); ports.push((await listen(server)).port)
  }
  const get = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json()
  const same = async () => {
    const [a, b] = await Promise.all(ports.map(port => get(port, '/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100')))
    assert.deepEqual(strip(a), strip(b))
    return a
  }
  const stats = () => get(ports[0], '/wizard/list-cache')
  const touch = async () => {
    for (const port of ports) {
      const res = await fetch(`http://127.0.0.1:${port}/wizard/thread-seen`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initializedAt: wall, threads: {} }) })
      assert.equal(res.status, 200)
    }
  }
  const cachedPage = () => get(ports[0], '/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100')
  return { rows, pending, same, cachedPage, stats, touch, setApps, advance: ms => { wall += ms } }
}

test('head rows are reused across unrelated owner writes', async t => {
  const w = await headFixture(t)
  await w.same()
  for (let i = 0; i < 8; i++) await w.touch()
  w.advance(10000)
  await w.same()
  assert.equal((await w.stats()).head_reused, 100, JSON.stringify(await w.stats()))
  assert.equal((await w.stats()).head_projected, 0)
})

test('head rows are re-projected when a write that affects rows happens', async t => {
  const w = await headFixture(t)
  await w.same(); await w.touch(); await w.same()
  w.rows[4] = { ...w.rows[4], title: 'Owner rename', pinned: true }
  await w.touch(); await w.same()
  assert.equal((await w.stats()).head_projected, 1, JSON.stringify(await w.stats()))
  // Catalog membership, unlike read-state writes, changes core app provenance.
  w.setApps([]); await w.touch()
  const page = await w.same()
  assert.equal((await w.stats()).head_projected, 100)
  assert.equal((await w.stats()).head_blocked.context, 100)
  assert(!page.data.some(row => row.wizard_app_id === 'synthetic-app'))
})

test('pending first-send exceptions preserve full self-check parity across owner writes', async t => {
  const pending = [{ id: 'wizard_stale_empty', source: 'api_server', message_count: 0, hidden: false, archived: false, parent_session_id: null, wizard_pending_first_send: true }]
  const w = await headFixture(t, { pending, checkMs: 1000 })
  await w.cachedPage(); await w.touch(); w.advance(10000)
  const page = await w.cachedPage()
  assert.equal(page.data.filter(row => row.id === pending[0].id).length, 5, 'preserve the existing full-core slice output, including duplicates')
  assert.equal((await w.stats()).head_reused, 100)
  assert.equal((await w.stats()).head_extras, 5)
  for (let attempt = 0; attempt < 50 && !(await w.stats()).checks; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  const stats = await w.stats()
  assert(stats.checks > 0)
  assert.equal(stats.check_differences, 0)
  assert.equal(stats.check_live_differences, 0)
  assert.equal(stats.fallbacks, 0)
  pending.length = 0; await w.touch()
  assert(!(await w.cachedPage()).data.some(row => row.id === 'wizard_stale_empty'))
  assert.equal((await w.stats()).head_extras, 0)
})
