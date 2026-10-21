import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'

const close = (s) => new Promise((r) => s.close(r))
const strip = ({ snapshot, archive_cursor, ...rest }) => rest

test('Chats window: the shared list cache serves exactly what the full rebuild serves', { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'list-cache-')); const servers = []
  t.after(async () => { for (const s of servers.reverse()) await close(s); rmSync(root, { recursive: true, force: true }) })
  const now = Date.now() / 1000
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
  const cached = createWizardServer({ ...options, listCacheMode: 'on' }); servers.push(cached)
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
  assert.equal(stats.fallbacks, 0, JSON.stringify(stats))
  assert(stats.builds >= 3 && stats.last_cached > 100, JSON.stringify(stats))
  const check = await get(b.port, '/wizard/list-cache')
  assert.equal(check.mode, 'off')
})
