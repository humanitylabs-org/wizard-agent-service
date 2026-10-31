// End to end through the real service: a routed agent's own /wizard/mcp key opens a thread and schedules a
// daily message; the thread shows in that agent's Chats list, its first visible message is the agent's, and the
// owner's reply goes to the same agent. Fake stock-shaped Hermes runtimes, synthetic content only.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: Server[] = []
const roots: string[] = []
beforeEach(() => { vi.stubEnv('WIZARD_SCHEDULER', '1') })
afterEach(async () => {
  for (const s of servers.splice(0)) { (s as any).closeAllConnections?.(); await new Promise((r) => s.close(() => r(undefined))) }
  vi.unstubAllEnvs()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

async function readBody(req: IncomingMessage) { let raw = ''; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : undefined }

// A stock-shaped Hermes API that keeps per-thread messages, so history projection is exercised for real.
async function fakeHermes(name: string, sessions: string[] = []) {
  const seen: { method: string, path: string, body: any }[] = []
  const rows = new Map<string, any>(sessions.map((id) => [id, { id, title: `${name} ${id}`, source: 'api_server', archived: false }]))
  const messages = new Map<string, any[]>()
  let runs = 0
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = await readBody(req)
    seen.push({ method: req.method ?? '', path: url.pathname, body })
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/v1/capabilities') return json(200, { features: {} })
    if (url.pathname === '/api/model/options') return json(200, { provider: 'anthropic', model: 'claude-opus-5-5', providers: [{ slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5'] }] })
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, { data: [...rows.values()] })
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && sessionMatch) { const row = rows.get(decodeURIComponent(sessionMatch[1])); return row ? json(200, { session: row }) : json(404, { error: 'not found' }) }
    if (req.method === 'PATCH' && sessionMatch) { const row = rows.get(decodeURIComponent(sessionMatch[1])); if (!row) return json(404, { error: 'not found' }); Object.assign(row, body); return json(200, { session: row }) }
    const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'GET' && messagesMatch) return json(200, { object: 'list', data: messages.get(decodeURIComponent(messagesMatch[1])) ?? [] })
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const id = body?.id
      if (rows.has(id)) return json(409, { error: 'exists' })
      rows.set(id, { id, title: body.title ?? '', source: 'api_server', archived: false, started_at: Date.now() / 1000 })
      return json(201, { session: rows.get(id) })
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs') {
      runs += 1
      const id = body.session_id
      if (!rows.has(id)) rows.set(id, { id, title: name, source: 'api_server', archived: false })
      const list = messages.get(id) ?? []
      const t = Date.now() / 1000
      list.push({ id: list.length + 1, session_id: id, role: 'user', content: body.input, timestamp: t })
      list.push({ id: list.length + 2, session_id: id, role: 'assistant', content: `${name} reply ${runs}`, timestamp: t + 0.001 })
      messages.set(id, list)
      return json(202, { run_id: `${name}-run-${runs}`, status: 'started' })
    }
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) return json(200, { run_id: url.pathname.split('/').at(-1), status: 'completed', output: `${name} done` })
    json(404, { error: 'nope' })
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { port: address.port, origin: `http://127.0.0.1:${address.port}`, seen, rows, messages }
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

async function box(timezone = 'Asia/Bangkok') {
  const dir = mkdtempSync(join(tmpdir(), 'reach-out-e2e-')); roots.push(dir)
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [] }))
  // The owner's clock: schedules use the settings timezone.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ clock: { timezone } }))
  const main = await fakeHermes('main', ['wizard_main_1'])
  const phil = await fakeHermes('philosopher')
  const priv = await fakeHermes('private')
  let clock = Date.parse('2026-10-31T03:00:00Z')
  const svc: any = createWizardServer({
    upstreamOrigin: main.origin, hermesKey: 'fixture-key', requireAccess: false, appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
    agentDeliveryToken: 'delivery-token-0123456789abcdef', followThrough: false, agentBasePort: 47750,
    agentBridge: true, bridgeWriteSkills: false, mcpToken: 'fixture-main-gateway-token', agentGatewayUrl: 'http://gateway/wizard/mcp', bridgeLog: () => {},
    schedulerEnabled: true, schedulerIntervalMs: 3_600_000, schedulerStatePath: join(dir, 'schedules.sqlite3'), schedulerNow: () => clock,
    runQueueStatePath: join(dir, 'queue.sqlite3'), runQueuePollIntervalMs: 20,
  })
  servers.push(svc)
  const base = `http://127.0.0.1:${((await listen(svc)) as any).port}`
  const make = async (label: string, preset: string, port: number) => {
    const model = preset === 'private' ? { provider: 'tinfoil', model: 'glm-5-3' } : { provider: 'anthropic', model: 'claude-opus-5-5' }
    const created = await fetch(`${base}/wizard/v1/agents`, post({ label, harness: 'hermes', model, permissions: { preset, read_standard_chats: false } }, { 'Idempotency-Key': `create-${label}` }))
    if (created.status !== 201) throw new Error(`${label}: ${created.status} ${await created.text()}`)
    const id = (await created.json()).agent.id
    const file = join(dir, 'agents', id, 'agent.json')
    const agent = JSON.parse(readFileSync(file, 'utf8')); agent.runtime.port = port; writeFileSync(file, JSON.stringify(agent))
    return { id, key: readFileSync(join(dir, 'agents', id, 'gateway.key'), 'utf8').trim() }
  }
  const philosopher = await make('Philosopher', 'standard', phil.port)
  const privateAgent = await make('Private', 'private', priv.port)
  let rpcId = 0
  const mcp = async (key: string, method: string, params: any = {}) => {
    const r = await fetch(`${base}/wizard/mcp`, post({ jsonrpc: '2.0', id: ++rpcId, method, params }, { Authorization: ['Bearer', key].join(' ') }))
    expect(r.status).toBe(200)
    return (await r.json()).result
  }
  const tool = async (key: string, name: string, args: any) => {
    const result = await mcp(key, 'tools/call', { name, arguments: args })
    return { error: result.isError === true, value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) }
  }
  return { dir, base, svc, main, phil, priv, philosopher, privateAgent, mcp, tool, setClock: (ms: number) => { clock = ms } }
}

describe('routed agents reach out (service end to end)', () => {
  it('a philosopher-keyed wizard_start_thread opens a pinned thread in its Chats, speaks first, and the owner reply returns to it', async () => {
    const s = await box()
    const listed = (await s.mcp(s.philosopher.key, 'tools/list')).tools.map((t: any) => t.name)
    expect(listed).toEqual(expect.arrayContaining(['wizard_start_thread', 'wizard_schedule', 'wizard_follow_up']))
    expect((await s.mcp('fixture-main-gateway-token', 'tools/list')).tools.map((t: any) => t.name)).not.toContain('wizard_start_thread')

    const opened = await s.tool(s.philosopher.key, 'wizard_start_thread', { title: 'Stoicism · Morning practice', instructions: 'Ask one question about how their mornings begin.' })
    expect(opened.error).toBe(false)
    expect(opened.value).toMatchObject({ opened: true, state: 'opened', title: 'Stoicism · Morning practice' })
    const id = opened.value.session_id
    expect(opened.value.link).toBe(`/wizard-os-home/?session=${id}`)

    // Created and run in the philosopher's runtime only, with the reach-out note in its run instructions.
    expect(s.phil.seen.filter((r) => r.method === 'POST' && r.path === '/api/sessions').map((r) => r.body)).toEqual([expect.objectContaining({ id, title: 'Stoicism · Morning practice' })])
    const firstRun = s.phil.seen.find((r) => r.method === 'POST' && r.path === '/v1/runs')!
    expect(firstRun.body.session_id).toBe(id)
    expect(firstRun.body.instructions).toContain('wizard_start_thread')
    expect(firstRun.body.instructions).toContain(`This Wizard thread's id is ${id}`)
    expect(s.main.seen.some((r) => r.method === 'POST' && (r.path === '/v1/runs' || r.path === '/api/sessions'))).toBe(false)
    expect(s.priv.seen.some((r) => r.method === 'POST')).toBe(false)

    // The owner's Chats list for that agent shows it, titled as given and labelled with the agent.
    const list = await (await fetch(`${s.base}/wizard/hermes/api/sessions?agent=${s.philosopher.id}`)).json()
    const row = list.data.find((r: any) => r.id === id)
    expect(row).toMatchObject({ title: 'Stoicism · Morning practice', agent: { id: s.philosopher.id, label: 'Philosopher' } })
    expect((await (await fetch(`${s.base}/wizard/hermes/api/sessions`)).json()).data.map((r: any) => r.id)).not.toContain(id)
    // The shell's own Chats read (web/live.js fetchSessions): the slim per-agent window it merges into one list.
    const slim = await (await fetch(`${s.base}/wizard/hermes/api/sessions?view=list&window=archive-50&overrides=%7B%7D&limit=100&offset=0&include_children=false&agent=${s.philosopher.id}`)).json()
    const slimRows = slim.data || slim.sessions || slim.items
    expect(slimRows.find((r: any) => r.id === id)).toMatchObject({ title: 'Stoicism · Morning practice' })

    // First visible message is the agent's: the schedule input is hidden.
    const history = await (await fetch(`${s.base}/wizard/hermes/api/sessions/${id}/messages?agent=${s.philosopher.id}`)).json()
    const visible = history.data.filter((m: any) => m.role === 'user' || m.role === 'assistant')
    expect(visible[0]).toMatchObject({ role: 'assistant', content: expect.stringContaining('philosopher reply 1') })

    // The owner replies by thread id alone (old clients) and with the agent named: both reach the philosopher.
    expect((await fetch(`${s.base}/wizard/hermes/v1/runs`, post({ session_id: id, input: 'Usually coffee first.' }))).status).toBe(202)
    expect((await fetch(`${s.base}/wizard/hermes/v1/runs?agent=${s.philosopher.id}`, post({ session_id: id, input: 'Then a walk.' }))).status).toBe(202)
    expect(s.phil.seen.filter((r) => r.method === 'POST' && r.path === '/v1/runs').map((r) => r.body.input).slice(1)).toEqual(['Usually coffee first.', 'Then a walk.'])
    expect(s.main.seen.some((r) => r.method === 'POST' && r.path === '/v1/runs')).toBe(false)

    // The thread is the philosopher's own: it may schedule into it, the private agent may not.
    expect((await s.tool(s.privateAgent.key, 'wizard_schedule', { when: 'morning', session_id: id, text: 'x' })).value).toContain('does not belong')
    expect((await s.tool(s.philosopher.key, 'wizard_schedule', { when: 'morning', session_id: 'wizard_main_1', text: 'x' })).value).toContain('does not belong')
    expect((await s.tool(s.philosopher.key, 'wizard_schedule', { when: 'morning', session_id: id, text: 'Ask how it went.' })).value).toMatchObject({ thread: id, nextRun: '2026-11-01T01:30:00.000Z' })
  })

  it('a daily 08:30 schedule shows nextRun at 08:30 owner time and delivers into the agent\'s own new thread', async () => {
    // The owner's settings clock, not the server's: 08:30 in New York is 12:30Z before US daylight time ends.
    const s = await box('America/New_York')
    const made = await s.tool(s.philosopher.key, 'wizard_schedule', { action: 'create', when: 'daily 08:30', title: 'Philosophy · Morning thought', text: 'Share one short Stoic thought.' })
    expect(made.error).toBe(false)
    expect(made.value).toMatchObject({ kind: 'message', timezone: 'America/New_York', when: { cron: '30 8 * * *' }, nextRun: '2026-10-31T12:30:00.000Z', nextRunLocal: 'Sat, 31 Oct 2026, 08:30' })
    expect(s.svc.scheduler.get(made.value.id).agent).toBe(s.philosopher.id)
    s.setClock(Date.parse('2026-10-31T12:30:10Z'))
    await s.svc.scheduler.tick()
    const run = s.phil.seen.find((r) => r.method === 'POST' && r.path === '/v1/runs')!
    expect(run.body.session_id).toBe(made.value.thread)
    expect(run.body.input).toMatch(/^\[Wizard schedule\] scheduled message/)
    expect(s.phil.rows.get(made.value.thread)).toMatchObject({ title: 'Philosophy · Morning thought' })
    expect(s.main.seen.some((r) => r.method === 'POST' && r.path === '/v1/runs')).toBe(false)
    const listed = (await s.tool(s.philosopher.key, 'wizard_schedule', { action: 'list' })).value.schedules
    // The next one stays 08:30 local across the daylight-saving change (13:30Z on 1 Nov).
    expect(listed).toEqual([expect.objectContaining({ id: made.value.id, nextRun: '2026-11-01T13:30:00.000Z', nextRunLocal: 'Sun, 01 Nov 2026, 08:30' })])
    expect((await s.tool(s.privateAgent.key, 'wizard_schedule', { action: 'list' })).value.schedules).toEqual([])
    expect((await s.tool(s.privateAgent.key, 'wizard_schedule', { action: 'cancel', id: made.value.id })).error).toBe(true)
  })

  it('the private agent gets the same tools; its thread and jobs stay in its own runtime', async () => {
    const s = await box()
    const opened = await s.tool(s.privateAgent.key, 'wizard_start_thread', { title: 'Private · Check-in', instructions: 'Say hello.' })
    expect(opened.value).toMatchObject({ opened: true })
    expect(s.priv.seen.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/sessions', '/v1/runs'])
    expect(s.main.seen.some((r) => r.method === 'POST' && (r.path === '/v1/runs' || r.path === '/api/sessions'))).toBe(false)
    expect(s.phil.seen.some((r) => r.method === 'POST')).toBe(false)
    const made = await s.tool(s.privateAgent.key, 'wizard_schedule', { when: 'every morning', session_id: opened.value.session_id, text: 'Private check-in.' })
    expect(made.value).toMatchObject({ thread: opened.value.session_id, nextRun: '2026-11-01T01:30:00.000Z' })
    expect((await s.tool(s.philosopher.key, 'wizard_schedule', { action: 'list' })).value.schedules).toEqual([])
    expect((await s.tool(s.philosopher.key, 'wizard_schedule', { when: 'morning', session_id: opened.value.session_id, text: 'x' })).error).toBe(true)
  })
})
