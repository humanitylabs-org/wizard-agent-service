// Issue 584 round 4: after round 3 moved the Chats list's own state.db reads into the list worker, the HTTP thread
// still opened Hermes' state.db for the running-turns list on every queue tick, every /wizard/health call and every
// list rebuild, and for the queue's turn-lease check. Cold, that read waited behind the list worker's disk reads and
// froze the Service. Both run in the state worker now; the answers are unchanged.
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'

// Every DatabaseSync opened on this (the HTTP) thread. Worker threads load the real module and are not counted.
const opened: string[] = []
vi.mock('node:sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:sqlite')>()
  class Watched extends real.DatabaseSync {
    constructor(path: string, options?: object) { opened.push(resolve(String(path))); options === undefined ? super(path) : super(path, options as never) }
  }
  return { ...real, DatabaseSync: Watched, default: { ...real, DatabaseSync: Watched } }
})

const dirs: string[] = [], servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0).reverse()) await new Promise(r => { (s as any).closeAllConnections?.(); s.close(r) })
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})

it('the queue tick, /wizard/health and a Chats list rebuild read running turns off the HTTP thread', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const root = mkdtempSync(join(tmpdir(), 'state-worker-')); dirs.push(root)
  const statePath = join(root, 'state.db'), now = Date.now() / 1000
  const db = new DatabaseSync(statePath)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL, ended_at REAL, end_reason TEXT,
      message_count INTEGER, parent_session_id TEXT, last_activity_at REAL, last_activity_description TEXT, pinned INTEGER, archived INTEGER, hidden INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT, active INTEGER);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
    PRAGMA journal_mode=WAL;`)
  const session = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  // A synthetic owner thread with a turn running on another surface (its lease), and an idle one.
  session.run('wizard_live', 'telegram', '', 'Synthetic live', now - 600, null, null, 2, null, now - 5, 'Tool running', 0, 0, 0)
  session.run('wizard_idle', 'api_server', '', 'Synthetic idle', now - 900, null, null, 2, null, now - 800, '', 0, 0, 0)
  db.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run('wizard_live', now + 120)
  db.close()
  const rows = ['wizard_live', 'wizard_idle'].map((id, i) => ({ id, source: 'api_server', title: `Synthetic ${i}`, hidden: false, archived: false,
    parent_session_id: null, message_count: 2, last_active: now - 10 * (i + 1), started_at: now - 600 }))
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const path = new URL(req.url!, 'http://x').pathname
    if (path === '/api/sessions') return res.end(JSON.stringify({ data: rows, has_more: false }))
    if (path.endsWith('/messages')) return res.end(JSON.stringify({ data: [], has_more: false }))
    res.end('{}')
  })
  servers.push(upstream)
  const { createWizardServer, listen } = await import('../server/service.mjs')
  const { port: upstreamPort } = await listen(upstream)
  const server = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, hermesKey: 'synthetic-main-api-key', requireAccess: false,
    agentBridge: false, followThrough: false, joinedDelegation: 'off', wizardOsHome: join(root, 'os'), hermesStatePath: statePath, channelStore: false,
    canonicalSessionReader: () => rows, runQueueStatePath: join(root, 'queue', 'run-queue.sqlite3'), runQueuePollIntervalMs: 50,
    listCacheMode: 'on', listCacheStaleMs: 0, listCacheCheckMs: 3_600_000 })
  servers.push(server)
  const { port } = await listen(server)
  const base = `http://127.0.0.1:${port}`

  const list = await fetch(`${base}/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100&offset=0&include_children=false`)
  expect(list.status).toBe(200)
  expect(((await list.json()).data as any[]).map(row => row.id).sort()).toEqual(['wizard_idle', 'wizard_live'])
  const health = await (await fetch(`${base}/wizard/health`)).json()
  // The leased thread still counts as a running turn, as before.
  expect(health.queue.active).toBe(1)
  await new Promise(r => setTimeout(r, 400)) // several queue ticks
  const stats = (await (await fetch(`${base}/wizard/list-cache`)).json()).state_reads
  expect(stats.kinds.active).toBeGreaterThanOrEqual(1)
  expect(stats.fallbacks).toBe(0)
  expect(stats.worker_reads).toBe(stats.reads)
  // Nothing on the HTTP thread opened Hermes' state.db (only the fixture above did, before the Service started).
  expect(opened.filter(path => path === resolve(statePath)).length).toBe(1)
}, 30_000)

it('the worker answers running turns and a turn lease the same as the direct reads', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { readActiveHumanSessionIds, readSessionLeaseHeld } = await import('../server/active-sessions.mjs')
  const { createListEvidenceLane } = await import('../server/list-evidence-lane.mjs')
  const root = mkdtempSync(join(tmpdir(), 'state-worker-same-')); dirs.push(root)
  const path = join(root, 'state.db'), now = Date.now() / 1000
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, hidden INTEGER, parent_session_id TEXT, message_count INTEGER,
      started_at REAL, last_activity_at REAL, last_activity_description TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);`)
  const insert = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)')
  insert.run('leased', 'webui', 0, null, 2, now - 600, now - 600, '')
  insert.run('wizard_recent', 'api_server', 0, null, 2, now - 10, now - 10, 'Tool running')
  insert.run('wizard_helper_parent', 'api_server', 0, null, 2, now - 10, now - 10, 'delegate_task: subagent running')
  insert.run('idle', 'webui', 0, null, 2, now - 10, now - 10, '')
  db.prepare('INSERT INTO session_turn_leases VALUES (?,?)').run('leased', now + 60)
  db.close()
  const lane = createListEvidenceLane({ hermesStatePath: path, label: 'state' })
  try {
    const active = await lane.read({ kind: 'active', now: Date.now() })
    expect(new Set(active.value)).toEqual(new Set(readActiveHumanSessionIds(path)))
    expect(new Set(active.value)).toEqual(new Set(['leased', 'wizard_recent']))
    expect((await lane.read({ kind: 'lease', ids: ['leased'], now: Date.now() })).value).toBe(true)
    expect((await lane.read({ kind: 'lease', ids: ['idle'], now: Date.now() })).value).toBe(readSessionLeaseHeld(path, 'idle'))
    expect(lane.stats().fallbacks).toBe(0)
  } finally { await lane.close() }
  // An unreadable state answers { failed }, which the Service turns back into a throw (liveness unavailable).
  const missing = createListEvidenceLane({ hermesStatePath: join(root, 'missing.db'), label: 'state' })
  try { expect((await missing.read({ kind: 'active' })).failed?.message).toMatch(/unavailable/) } finally { await missing.close() }
})
