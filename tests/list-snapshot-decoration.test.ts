// Issue 584 round 2: after the schedule re-reads were gone, every Chats list snapshot build still blocked the event
// loop for about a second on a box with 2,000 chats. The shared decoration parsed and re-serialised the whole list
// once per step and looked the main agent up once per row (each lookup stats the agent and app files).
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

const fsCalls = vi.hoisted(() => ({ stat: 0 }))
vi.mock('node:fs', async (load) => {
  const fs: any = await load()
  const statSync = (...args: any[]) => { fsCalls.stat++; return fs.statSync(...args) }
  return { ...fs, statSync, default: { ...fs, statSync } }
})

const { createWizardServer, listen } = await import('../server/service.mjs')
const { clean } = await import('../server/session-list-view.mjs')
const { decorateThreadAgent, decorateThreadAgentPayload } = await import('../server/agents-http.mjs')
const { projectFollowUps, projectFollowUpsPayload } = await import('../server/scheduler.mjs')

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  for (const s of servers.splice(0).reverse()) await new Promise(r => { s.closeAllConnections?.(); s.close(r) })
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})

it('a list snapshot build over 2,000 chats parses the list once and looks the main agent up once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'list-decorate-')); dirs.push(root)
  mkdirSync(join(root, 'os', 'agents'), { recursive: true })
  let wall = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall)
  const now = wall / 1000
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: `wizard_synthetic_${i}`, source: 'api_server', title: `Synthetic ${i}`, hidden: false,
    parent_session_id: null, message_count: 6, last_active: now - 60 * i, started_at: now - 60 * i - 30,
    latest_message: { role: 'assistant', content: `Synthetic reply ${i} `.repeat(40), timestamp: now - 60 * i } }))
  const state = join(root, 'state.db'), db = new DatabaseSync(state)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, started_at REAL, last_activity_at REAL, message_count INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT, active INTEGER);
    CREATE INDEX idx_messages_session_id ON messages(session_id);`)
  const insert = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)')
  db.exec('BEGIN'); for (const r of rows) insert.run(r.id, null, r.started_at, r.last_active, 6); db.exec('COMMIT'); db.close()
  const up = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(new URL(req.url!, 'http://x').pathname.endsWith('/messages') ? JSON.stringify({ data: [], has_more: false }) : '{}')
  })
  servers.push(up)
  const u = await listen(up)
  const server = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${u.port}`, hermesKey: 'synthetic-api-key', requireAccess: false,
    agentBridge: false, followThrough: false, joinedDelegation: 'off', wizardOsHome: join(root, 'os'), hermesStatePath: state, canonicalSessionReader: () => rows,
    runQueue: false, listCacheMode: 'on', listCacheStaleMs: 0, listCacheCheckMs: 3_600_000 })
  servers.push(server)
  const { port } = await listen(server)
  const read = async () => {
    const reply = await fetch(`http://127.0.0.1:${port}/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100`)
    expect(reply.status).toBe(200)
    return reply.json()
  }
  const first = await read()
  expect(first.data).toHaveLength(100)
  expect(first.data[0].agent).toBe('hermes')
  // A rebuild of the shared snapshot (past its 30 s ceiling), with every row already projected: only shared decoration runs.
  wall += 31_000
  const parse = vi.spyOn(JSON, 'parse')
  fsCalls.stat = 0
  const second = await read()
  const wholeList = parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('wizard_synthetic_0"') && text.includes('wizard_synthetic_1999"')).length
  parse.mockRestore(); clock.mockRestore()
  const stats = await (await fetch(`http://127.0.0.1:${port}/wizard/list-cache`)).json()
  expect(stats.builds).toBe(2) // the second read did rebuild the snapshot
  expect(stats.fallbacks).toBe(0)
  expect(second.data.map((row: any) => row.id)).toEqual(first.data.map((row: any) => row.id))
  expect(wholeList).toBeLessThanOrEqual(1)
  // Before: three or more stats per row (agent file, apps.json, settings) on every build.
  expect(fsCalls.stat).toBeLessThan(200)
}, 60_000)

it('the payload forms decorate exactly as the buffer forms', () => {
  const rows = () => ({ data: [{ id: 'a' }, { id: 'b', session_id: 'b' }, null] })
  const agent = { id: 'hermes', label: 'Hermes' }
  expect(decorateThreadAgentPayload(rows(), agent)).toEqual(JSON.parse(decorateThreadAgent(Buffer.from(JSON.stringify(rows())), agent).toString()))
  expect(decorateThreadAgentPayload({ id: 'solo' }, agent)).toEqual({ id: 'solo', agent, agent_id: 'hermes', session_id: 'solo' })
  const jobs = [{ id: 'j1', kind: 'watch', enabled: true, thread: 'a', agent: 'main', name: 'Watch A' }, { id: 'j2', kind: 'remind', enabled: true, thread: 'b', agent: 'main', name: 'B' }]
  const scheduler = { list: () => jobs, project: (job: any) => ({ name: job.name, nextRun: '2026-11-23T06:00:00.000Z' }) }
  const payload = rows()
  expect(projectFollowUpsPayload(payload, scheduler, { agent: 'main' })).toBe(true)
  expect(payload).toEqual(JSON.parse(projectFollowUps(Buffer.from(JSON.stringify(rows())), scheduler, { agent: 'main' }).toString()))
  expect((payload.data[0] as any).wizard_follow_up).toEqual({ active: true, count: 1, names: ['Watch A'], nextRun: '2026-11-23T06:00:00.000Z' })
  expect(projectFollowUpsPayload({ nothing: true }, scheduler, { agent: 'main' })).toBe(false)
})

it('clean gives the same text for a long message on every call', () => {
  const long = `**Synthetic** reply with a [WIZARD_FILES_V1][{"mime":"image/png","filename":"a.png"}][/WIZARD_FILES_V1] chip ${'and more words '.repeat(40)}`
  const once = clean(long)
  expect(once.startsWith('Synthetic reply with a 🖼 Photo chip and more words')).toBe(true)
  for (let i = 0; i < 3; i++) expect(clean(long)).toBe(once)
  expect(clean(`${long} changed`)).toBe(`${once} changed`)
  expect(clean('short **text**')).toBe('short text')
  expect(clean(null)).toBe('')
})
