// Issue 649: an agent with no state.db the Service can read (Pi: an external runtime, no local home) asked the
// list worker for its archive with an empty path, and the worker read the main Hermes state.db instead. Pi's
// Chats window then listed every archived main thread as Pi's, and the list pinned each one to Pi next to its
// main pin, so the thread itself answered 409 ambiguous_thread.
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'
import { createListEvidenceReader } from '../server/list-evidence.mjs'
import { createAgentRegistry } from '../server/agents.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  for (const s of servers.splice(0).reverse()) await new Promise(r => { s.closeAllConnections?.(); s.close(r) })
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})

// A Hermes-shaped main state.db: live rows plus archived rows.
function mainDb(path: string, now: number) {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL, ended_at REAL, end_reason TEXT,
      message_count INTEGER, parent_session_id TEXT, last_activity_at REAL, pinned INTEGER, archived INTEGER, hidden INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT, active INTEGER);`)
  const session = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const message = db.prepare('INSERT INTO messages(session_id, role, content, timestamp, active) VALUES(?,?,?,?,1)')
  const rows = []
  for (let i = 0; i < 2; i++) {
    const id = `wizard_main_${i}`, at = now - 60 * (i + 1)
    session.run(id, 'api_server', '', `Synthetic main ${i}`, at - 30, null, null, 2, null, at, 0, 0, 0)
    message.run(id, 'user', `Synthetic ask ${i}`, at - 20)
    rows.push({ id, source: 'api_server', title: `Synthetic main ${i}`, hidden: false, archived: false, parent_session_id: null, message_count: 2, last_active: at, started_at: at - 30 })
  }
  for (let i = 0; i < 5; i++) {
    const id = `wizard_main_archived_${i}`
    session.run(id, 'api_server', '', `Archived main ${i}`, now - 900 - i, null, null, 2, null, now - 800 - i, 0, 1, 0)
    message.run(id, 'user', `Archived synthetic ask ${i}`, now - 850 - i)
  }
  db.close()
  return rows
}

it('the list worker reads no database for an empty path, and the main one only when no path is given', () => {
  const root = mkdtempSync(join(tmpdir(), 'no-home-archive-')); dirs.push(root)
  const main = join(root, 'state.db'); mainDb(main, Date.now() / 1000)
  const reader = createListEvidenceReader(main)
  try {
    expect(reader.read({ kind: 'archive', limit: 100 }).value.length).toBe(5)
    expect(reader.read({ kind: 'archive', path: '', limit: 100 }).value).toEqual([])
    expect([...reader.read({ kind: 'first-requests', path: '', ids: ['wizard_main_0'] }).value]).toEqual([])
    const posts = reader.read({ kind: 'first-posts', path: '', posts: { ids: ['wizard_main_0'] } }).value
    expect(JSON.stringify(posts)).not.toContain('Synthetic ask')
  } finally { reader.close() }
})

it('an agent with no readable state.db lists only its own runtime rows and pins no main thread to itself', async () => {
  const root = mkdtempSync(join(tmpdir(), 'no-home-archive-')); dirs.push(root)
  const now = Date.now() / 1000
  const mainState = join(root, 'state.db'), mainRows = mainDb(mainState, now)
  const piRows = [{ id: 'wizard_pi_0', source: 'api_server', title: 'Synthetic pi', hidden: false, archived: false, parent_session_id: null, message_count: 2, last_active: now, started_at: now - 10 }]
  const upstream = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/sessions') return res.end(JSON.stringify({ data: req.headers.authorization?.includes('synthetic-pi') ? piRows : mainRows, has_more: false }))
    // Each runtime holds only its own threads (the main one also its archived ones).
    const own = req.headers.authorization?.includes('synthetic-pi') ? (id: string) => id.startsWith('wizard_pi_') : (id: string) => id.startsWith('wizard_main_')
    const id = decodeURIComponent(url.pathname.split('/')[3] || '')
    if (id && !own(id)) { res.statusCode = 404; return res.end('{"error":"not_found"}') }
    if (url.pathname.endsWith('/messages')) return res.end(JSON.stringify({ data: [], has_more: false }))
    res.end(JSON.stringify(id ? { id } : {}))
  })
  servers.push(upstream)
  const { port: upstreamPort } = await listen(upstream)
  const folder = join(root, 'os', 'agents', 'pi'); mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'agent.json'), JSON.stringify({ schema: 1, id: 'pi', label: 'Pi', harness: 'pi', privacy: 'standard',
    appearance: { glyph: 'spark', hue: 45 }, model: { provider: 'openai-codex', model: 'synthetic-model', allowed_models: ['synthetic-model'], fallback: false },
    permissions: { preset: 'standard', outside_tools: [], files: 'none', wizard_apps: [], agent_apps: [], other_agents: 'none', shared_with_agents: false },
    runtime: { kind: 'external', port: upstreamPort }, created_at: now }))
  writeFileSync(join(folder, 'runtime.key'), 'synthetic-pi-runtime-key', { mode: 0o600 })
  const server = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, hermesKey: 'synthetic-main-api-key', requireAccess: false,
    agentBridge: false, followThrough: false, joinedDelegation: 'off', wizardOsHome: join(root, 'os'), hermesStatePath: mainState,
    canonicalSessionReader: () => mainRows, runQueue: false, listCacheMode: 'on', listCacheStaleMs: 0, listCacheCheckMs: 3_600_000 })
  servers.push(server)
  const { port } = await listen(server)
  const base = `http://127.0.0.1:${port}`
  const list = async (agent = '') => {
    const reply = await fetch(`${base}/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100&offset=0&include_children=false${agent ? `&agent=${agent}` : ''}`)
    expect(reply.status).toBe(200)
    return reply.json()
  }
  const main = await list()
  expect(main.data.map((row: any) => row.id)).toContain('wizard_main_0')
  const pi = await list('pi')
  expect(pi.data.map((row: any) => row.id)).toEqual(['wizard_pi_0'])
  expect(pi.archive_total ?? 0).toBe(0)
  const archived = await fetch(`${base}/wizard/hermes/api/sessions?view=list&window=archive-50&archived=1&limit=100&offset=0&include_children=false&agent=pi`)
  expect(JSON.stringify(await archived.json())).not.toContain('wizard_main_archived')
  const threads = JSON.parse(readFileSync(join(root, 'os', 'agents', '.threads.json'), 'utf8')).threads
  expect(Object.values(threads).filter((row: any) => row.agent_id === 'pi').map((row: any) => row.session_id)).toEqual(['wizard_pi_0'])
  // The main threads still open: one owner each.
  const opened = await fetch(`${base}/wizard/hermes/api/sessions/wizard_main_archived_0?view=detail`)
  expect(opened.status).toBe(200)
}, 30_000)

it('a pin the bug wrote (a runtime_verified pin of an agent for a thread it never listed, also pinned to another agent) is dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'no-home-pins-')); dirs.push(root)
  const agentsDir = join(root, 'agents'), folder = join(agentsDir, 'pi'); mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'agent.json'), JSON.stringify({ schema: 1, id: 'pi', label: 'Pi', harness: 'pi', privacy: 'standard',
    appearance: { glyph: 'spark', hue: 45 }, model: { provider: 'openai-codex', model: 'synthetic-model', allowed_models: ['synthetic-model'], fallback: false },
    permissions: { preset: 'standard', outside_tools: [], files: 'none', wizard_apps: [], agent_apps: [], other_agents: 'none', shared_with_agents: false },
    runtime: { kind: 'external', port: 18659 }, created_at: 1 }))
  writeFileSync(join(folder, 'runtime.key'), 'synthetic-pi-runtime-key', { mode: 0o600 })
  const pin = (agent: string, id: string, provenance = 'runtime_verified') => [`${JSON.stringify([agent, id])}`, { agent_id: agent, session_id: id, provenance }]
  writeFileSync(join(agentsDir, '.threads.json'), JSON.stringify({ schema: 2, threads: Object.fromEntries([
    pin('hermes', 'wizard_main_x'), pin('pi', 'wizard_main_x'),
    pin('pi', 'wizard_pi_own'), pin('hermes', 'wizard_pi_own'),
    pin('pi', 'wizard_pi_alone'),
    pin('hermes', 'wizard_admitted'), pin('pi', 'wizard_admitted', 'service_admission'),
    pin('hermes', 'wizard_main_y'), pin('gone', 'wizard_main_y'),
  ]) }))
  writeFileSync(join(agentsDir, '.session-catalog.json'), JSON.stringify({ schema: 1, agents: { pi: { at: 1, complete: false, seal: null, ids: ['wizard_pi_own', 'wizard_pi_alone'] } } }))
  const registry = createAgentRegistry({ agentsDir })
  expect(registry.pinnedAgent('wizard_main_x')).toBe('hermes')
  expect(registry.pinnedAgents('wizard_pi_alone')).toEqual(['pi'])
  // An agent since removed (James removed Pi) leaves no second owner behind either.
  expect(registry.pinnedAgent('wizard_main_y')).toBe('hermes')
  // Only the bogus list pin goes: a thread the agent itself listed, or a pin the Service admitted, is evidence.
  expect(registry.pinnedAgents('wizard_pi_own').sort()).toEqual(['hermes', 'pi'])
  expect(registry.pinnedAgents('wizard_admitted').sort()).toEqual(['hermes', 'pi'])
})
