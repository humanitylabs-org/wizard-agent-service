import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { STATUS_INSTRUCTIONS, parseStatus } from '../server/thread-status.mjs'
import { ANCHOR_SECONDS, ThreadTitleStore, looksLikeSentence, normalizeTitle, titleContextLine, titleToApply } from '../server/thread-titles.mjs'
import { WIZARD_RUN_INSTRUCTIONS, createWizardServer, listen } from '../server/service.mjs'

const directories: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const tempDir = async () => { const d = await mkdtemp(join(tmpdir(), 'wizard-titles-')); directories.push(d); return d }
const tag = (value: object) => `Reply.\n\n[WIZARD_STATUS_V1]${JSON.stringify(value)}[/WIZARD_STATUS_V1]`

describe('title format', () => {
  it('compacts proposals into a short Project · Feature label', () => {
    expect(normalizeTitle('DeFleur - Captions')).toBe('DeFleur · Captions')
    expect(normalizeTitle('Wizard OS: Thread titles.')).toBe('Wizard OS · Thread titles')
    expect(normalizeTitle('"DeFleur — House style"')).toBe('DeFleur · House style')
    expect(normalizeTitle('  ')).toBe('')
    const long = normalizeTitle('Wizard OS · An extremely long feature name that keeps going and going')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long.endsWith(' ')).toBe(false)
  })

  it('knows a sentence title from a label', () => {
    expect(looksLikeSentence('Review 0xMovez post on X')).toBe(true)
    expect(looksLikeSentence('Send voice note with text and images together')).toBe(true)
    expect(looksLikeSentence('DeFleur · Captions')).toBe(false)
    expect(looksLikeSentence('Wizard Topics')).toBe(false)
  })

  it('asks the agent for a title in the status line and to keep it unless the work changed', () => {
    expect(STATUS_INSTRUCTIONS).toContain('"title":"Wizard OS · Desks"')
    expect(STATUS_INSTRUCTIONS).toContain('Return the thread\'s current title exactly')
    expect(WIZARD_RUN_INSTRUCTIONS).toContain('Project · Feature')
    expect(parseStatus(tag({ state: 'done', ask: 'Shipped', subject: 'DeFleur', title: 'DeFleur - Captions' }))).toEqual({ state: 'done', ask: 'Shipped', subject: 'DeFleur', title: 'DeFleur · Captions' })
    expect(parseStatus(tag({ state: 'done', ask: 'Shipped' }))).toEqual({ state: 'done', ask: 'Shipped' })
  })
})

describe('when a title changes', () => {
  it('renames only on a different project or feature, once per reply, never over a lock', () => {
    expect((titleToApply as any)({ currentTitle: 'DeFleur · Captions', proposed: 'DeFleur · Captions', record: null, assistantAt: 1 })).toBe('')
    expect((titleToApply as any)({ currentTitle: 'DeFleur · Captions', proposed: 'deFleur · captions', record: null, assistantAt: 1 })).toBe('')
    expect((titleToApply as any)({ currentTitle: 'DeFleur · Captions #2', proposed: 'DeFleur · Captions', record: null, assistantAt: 1 })).toBe('')
    expect((titleToApply as any)({ currentTitle: 'Review 0xMovez post on X', proposed: 'DeFleur · Video pipeline', record: null, assistantAt: 1 })).toBe('DeFleur · Video pipeline')
    expect((titleToApply as any)({ currentTitle: 'A', proposed: 'B project', record: { locked: true }, assistantAt: 1 })).toBe('')
    expect((titleToApply as any)({ currentTitle: 'A', proposed: 'B project', record: { appliedFor: 7 }, assistantAt: 7 })).toBe('')
  })

  it('marks renames in the thread, quietly for a barely-seen opener title', async () => {
    let now = 1_000_000
    const path = join(await tempDir(), 'titles.json')
    const store: any = new ThreadTitleStore(path, { now: () => now })
    // The opener's sentence title, replaced minutes after the thread started: nothing to mark.
    store.recordRename('s1', { from: 'Send voice note with text', to: 'Wizard OS · Voice notes', by: 'agent', assistantAt: 1, since: now - 120 })
    expect(store.visibleHistory('s1')).toEqual([])
    // Days later the work moves: the thread marks where.
    now += 2 * 86400
    store.recordRename('s1', { from: 'Wizard OS · Voice notes', to: 'DeFleur · Captions', by: 'agent', assistantAt: 2 })
    expect(store.visibleHistory('s1').map((r: any) => r.from)).toEqual(['Wizard OS · Voice notes'])
    expect(new ThreadTitleStore(path).get('s1')?.title).toBe('DeFleur · Captions')
    // The owner renames: locked.
    store.recordRename('s1', { from: 'DeFleur · Captions', to: 'Captions', by: 'you' })
    expect(store.get('s1')?.locked).toBe(true)
    expect(ANCHOR_SECONDS).toBe(1800)
  })

  it('tells each run what the thread is called', () => {
    expect(titleContextLine('DeFleur · Captions', {})).toContain('“DeFleur · Captions”')
    // The owner's name comes from settings (owner.name); no name means "The owner". Never a hardcoded person.
    expect(titleContextLine('Captions', { locked: true })).toBe('This thread is titled “Captions”. The owner named it: put exactly that in the status line\'s title.')
    expect(titleContextLine('Captions', { locked: true }, 'Alex')).toContain('Alex named it')
    expect(titleContextLine('Captions', { locked: true }, '  ')).toContain('The owner named it')
    expect(titleContextLine('Captions', { locked: true }, 'Alex')).not.toMatch(/James|himself/u)
  })
})

describe('the Agent Service applies titles through Hermes', () => {
  async function fixture({ titleSource = 'llm', startedAgo = 5 * 86400 } = {}) {
    const directory = await tempDir()
    const now = Date.now() / 1000
    const statePath = join(directory, 'state.db')
    const state = new DatabaseSync(statePath)
    state.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL, title TEXT, title_source TEXT);
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
    `)
    state.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('wizard_t1', now - startedAgo, 'Review 0xMovez post on X', titleSource)
    state.close()
    const reply = { title: 'DeFleur · Video pipeline' }
    const patches: Array<{ id: string, body: any }> = []
    const runs: any[] = []
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      res.setHeader('Content-Type', 'application/json')
      if (url.pathname === '/v1/capabilities') { res.end(JSON.stringify({ features: {} })); return }
      if (req.method === 'POST' && url.pathname === '/v1/runs') { runs.push(JSON.parse(raw)); res.end(JSON.stringify({ run_id: 'run_1', status: 'running' })); return }
      const patch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (patch && req.method === 'PATCH') {
        const body = JSON.parse(raw)
        patches.push({ id: patch[1], body })
        const db = new DatabaseSync(statePath)
        db.prepare("UPDATE sessions SET title = ?, title_source = 'user' WHERE id = ?").run(body.title, patch[1])
        db.close()
        res.end(JSON.stringify({ session: { id: patch[1], title: body.title } }))
        return
      }
      if (url.pathname === '/api/sessions') {
        const db = new DatabaseSync(statePath, { readOnly: true })
        const title = (db.prepare('SELECT title FROM sessions WHERE id = ?').get('wizard_t1') as any).title
        db.close()
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'wizard_t1', source: 'api_server', title, message_count: 2, last_active: now }] }))
        return
      }
      if (/^\/api\/sessions\/wizard_t1\/messages$/.test(url.pathname)) {
        res.end(JSON.stringify({ data: [
          { role: 'user', timestamp: now - 60, content: 'Go' },
          { role: 'assistant', display_kind: 'final', timestamp: now - 10, content: tag({ state: 'done', ask: 'Shipped captions', subject: 'DeFleur', ...reply }) },
        ] }))
        return
      }
      res.statusCode = 404; res.end('{}')
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream) as any
    const app = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'fixture-key',
      requireAccess: false,
      hermesStatePath: statePath,
      archivedSessionReader: () => [],
      threadTitleStatePath: join(directory, 'titles.json'),
    })
    servers.push(app)
    const origin = `http://127.0.0.1:${(await listen(app) as any).port}`
    const list = async () => (await (await fetch(`${origin}/wizard/hermes/api/sessions?limit=20`)).json()).data[0]
    return { origin, list, patches, runs, reply, statePath }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

  it('renames a sentence-titled thread from the status line once, then marks it in the thread only', async () => {
    const { list, patches } = await fixture()
    await list(); await settle()
    expect(patches).toEqual([{ id: 'wizard_t1', body: { title: 'DeFleur · Video pipeline' } }])
    const row = await list(); await settle()
    expect(row.title).toBe('DeFleur · Video pipeline')
    expect(row.wizard_title_was).toBeUndefined()
    expect(row.wizard_title_renames).toEqual([expect.objectContaining({ from: 'Review 0xMovez post on X', to: 'DeFleur · Video pipeline', by: 'agent' })])
    expect(patches).toHaveLength(1)
  })

  it('leaves a title the owner set alone and remembers their own renames', async () => {
    const { origin, list, patches } = await fixture({ titleSource: 'user' })
    await list(); await settle()
    expect(patches).toEqual([])
    const renamed = await fetch(`${origin}/wizard/hermes/api/sessions/wizard_t1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Movez thread' }) })
    expect(renamed.ok).toBe(true)
    const row = await list(); await settle()
    expect(row.title).toBe('Movez thread')
    expect(row.wizard_title_was).toBeUndefined()
    expect(patches).toHaveLength(1)
  })

  it('tells the next run the current title', async () => {
    const { origin, runs } = await fixture()
    const sent = await fetch(`${origin}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'wizard_t1', input: 'hi' }) })
    expect(sent.ok).toBe(true)
    expect(String(runs[0].instructions)).toContain('This thread is currently titled “Review 0xMovez post on X”.')
  })
})
