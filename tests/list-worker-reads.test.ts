// Issue 584 round 3: with the per-row schedule reads and the snapshot decoration fixed, the live box still logged
// event-loop stalls of 1.5 to 11 s with a Chats list read running. The list read's queries of Hermes' state.db
// (the list revision and change set, each row's first post, the archive and a routed agent's open-ask evidence) ran on the HTTP
// thread, and a cold read of a 2 GB state.db waits on the disk for seconds. They run in the list worker now.
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'
import { PRESETS } from '../server/agents.mjs'
import { readFirstPostPages, readHermesFirstPosts, readHermesFirstPostsAsync } from '../server/first-post.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  for (const s of servers.splice(0).reverse()) await new Promise(r => { s.closeAllConnections?.(); s.close(r) })
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})

// A Hermes-shaped state.db: live rows, one archived row, and each thread's first owner message.
function stateDb(path: string, prefix: string, now: number) {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL, ended_at REAL, end_reason TEXT,
      message_count INTEGER, parent_session_id TEXT, last_activity_at REAL, pinned INTEGER, archived INTEGER, hidden INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT, active INTEGER);
    CREATE INDEX idx_messages_session ON messages(session_id, timestamp);`)
  const session = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const message = db.prepare('INSERT INTO messages(session_id, role, content, timestamp, active) VALUES(?,?,?,?,1)')
  const rows = []
  for (let i = 0; i < 3; i++) {
    const id = `wizard_${prefix}_${i}`, at = now - 60 * (i + 1)
    session.run(id, 'api_server', '', `Synthetic ${prefix} ${i}`, at - 30, null, null, 2, null, at, 0, 0, 0)
    message.run(id, 'user', `First synthetic ask ${prefix} ${i}`, at - 20)
    message.run(id, 'assistant', `Synthetic answer ${prefix} ${i}`, at - 10)
    rows.push({ id, source: 'api_server', title: `Synthetic ${prefix} ${i}`, hidden: false, archived: false, parent_session_id: null, message_count: 2,
      last_active: at, started_at: at - 30, latest_message: { role: 'assistant', content: `Synthetic answer ${prefix} ${i}`, timestamp: at - 10 } })
  }
  session.run(`wizard_${prefix}_archived`, 'api_server', '', `Archived ${prefix}`, now - 900, null, null, 2, null, now - 800, 0, 1, 0)
  message.run(`wizard_${prefix}_archived`, 'user', `Archived synthetic ask ${prefix}`, now - 850)
  db.close()
  return rows
}

it('a Chats list read queries Hermes\' state.db in the list worker, for the main list and a routed agent\'s list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'list-worker-')); dirs.push(root)
  const now = Date.now() / 1000
  const mainState = join(root, 'state.db'), mainRows = stateDb(mainState, 'main', now)
  const home = join(root, 'os', 'agents', 'research', 'home'); mkdirSync(home, { recursive: true })
  const agentRows = stateDb(join(home, 'state.db'), 'research', now)
  const upstream = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/sessions') return res.end(JSON.stringify({ data: req.headers.authorization?.includes('synthetic-agent') ? agentRows : mainRows, has_more: false }))
    if (url.pathname.endsWith('/messages')) return res.end(JSON.stringify({ data: [], has_more: false }))
    res.end('{}')
  })
  servers.push(upstream)
  const { port: upstreamPort } = await listen(upstream)
  const folder = join(root, 'os', 'agents', 'research')
  writeFileSync(join(folder, 'agent.json'), JSON.stringify({ schema: 1, id: 'research', label: 'Research', harness: 'hermes', privacy: 'standard',
    appearance: { glyph: 'spark', hue: 45 }, model: { provider: 'custom', model: 'synthetic-model', allowed_models: ['synthetic-model'], fallback: false },
    permissions: { preset: 'standard', ...PRESETS.find(p => p.id === 'standard')!.permissions }, runtime: { kind: 'container', app_id: 'agent-research', port: upstreamPort }, created_at: now }))
  writeFileSync(join(folder, 'runtime.key'), 'synthetic-agent-runtime-key', { mode: 0o600 })
  const server = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, hermesKey: 'synthetic-main-api-key', requireAccess: false,
    agentBridge: false, followThrough: false, joinedDelegation: 'off', wizardOsHome: join(root, 'os'), hermesStatePath: mainState,
    canonicalSessionReader: () => mainRows, runQueue: false, listCacheMode: 'on', listCacheStaleMs: 0, listCacheCheckMs: 3_600_000 })
  servers.push(server)
  const { port } = await listen(server)
  const base = `http://127.0.0.1:${port}`
  const kinds = async () => (await (await fetch(`${base}/wizard/list-cache`)).json()).evidence.kinds as Record<string, number>
  const list = async (agent = '') => {
    const reply = await fetch(`${base}/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100&offset=0&include_children=false${agent ? `&agent=${agent}` : ''}`)
    expect(reply.status).toBe(200)
    return (await reply.json()).data as any[]
  }

  const main = await list()
  expect(main.find(row => row.id === 'wizard_main_0')?.firstRequest).toBe('First synthetic ask main 0')
  const afterMain = await kinds()
  expect(afterMain.revision).toBeGreaterThanOrEqual(1)
  expect(afterMain['first-posts']).toBeGreaterThanOrEqual(1)
  expect(afterMain.hot).toBeGreaterThanOrEqual(1)

  const agent = await list('research')
  expect(agent.map(row => row.id).sort()).toEqual(['wizard_research_0', 'wizard_research_1', 'wizard_research_2', 'wizard_research_archived'])
  expect(agent.find(row => row.id === 'wizard_research_1')?.firstRequest).toBe('First synthetic ask research 1')
  const afterAgent = await kinds()
  expect(afterAgent['agent-evidence']).toBeGreaterThanOrEqual(1)
  expect(afterAgent.archive).toBeGreaterThanOrEqual(1)
  expect(afterAgent['first-posts']).toBeGreaterThan(afterMain['first-posts'])
  const stats = (await (await fetch(`${base}/wizard/list-cache`)).json()).evidence
  expect(stats.fallbacks).toBe(0)
  expect(stats.worker_reads).toBe(stats.reads)
}, 30_000)

it('the worker\'s first-post read gives the same posts as the in-thread read, and memo hits skip the message bodies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'first-post-split-')); dirs.push(root)
  const path = join(root, 'state.db'), ids = stateDb(path, 'split', Date.now() / 1000).map(row => row.id)
  const memoA = new Map(), memoB = new Map()
  const inThread = readHermesFirstPosts(path, ids, { memo: memoA })
  let bodies = -1
  const split = await readHermesFirstPostsAsync(async input => { const pages = readFirstPostPages(path, input); bodies = pages.pages.length; return pages }, ids, { memo: memoB })
  expect([...split]).toEqual([...inThread])
  expect(bodies).toBe(3)
  const again = await readHermesFirstPostsAsync(async input => { const pages = readFirstPostPages(path, input); bodies = pages.pages.length; return pages }, ids, { memo: memoB })
  expect([...again]).toEqual([...inThread])
  expect(bodies).toBe(0)
})
