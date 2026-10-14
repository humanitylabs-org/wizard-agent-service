import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { appThreadId, bindingDeclaration } from '../server/app-bindings.mjs'

// App → agent binding (wizard-os spec/AGENTS.md "App → agent binding").
const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

async function fakeHermes(name: string) {
  const seen: string[] = []
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) { /* drain */ }
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push(`${req.method} ${url.pathname}`)
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/api/model/options') return json(200, { providers: [] })
    if (/\/messages$/.test(url.pathname)) return json(200, { data: [{ role: 'assistant', content: `${name} recap` }] })
    json(404, { error: 'nope' })
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { port: address.port, origin: `http://127.0.0.1:${address.port}`, seen, server }
}

function box() {
  const dir = mkdtempSync(join(tmpdir(), 'bindings-'))
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [
    { id: 'meeting-recorder', name: 'Meeting Recorder', status: 'running', view: { url: '/apps/meeting-recorder/' }, agent_binding: { required: true, purpose: 'Where your recording recaps go' } },
    { id: 'meditate', name: 'Meditate', status: 'running', view: { url: '/meditate/' } },
  ] }))
  return dir
}

async function start(dir: string, main: { origin: string }, deliver?: (id: string, payload: any) => Promise<any>) {
  const deliveries: { id: string, payload: any }[] = []
  const runtime = {
    apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }),
    deliver: async (id: string, payload: any) => {
      deliveries.push({ id, payload })
      if (deliver) return deliver(id, payload)
      return { verified: true, already_delivered: false, session_id: payload.session_id, message_id: 7 }
    },
  }
  const svc = createWizardServer({
    upstreamOrigin: main.origin, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: runtime, agentDeliveryToken: 'delivery-token-0123456789abcdef', followThrough: false, agentBasePort: 47650,
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  return { base: `http://127.0.0.1:${address.port}`, deliveries }
}

const send = (method: string, body: unknown, headers: Record<string, string> = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const PRIVATE = { label: 'Private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }
const RECAP = { delivery_key: 'meeting-42', title: 'Recording · Team sync', body: 'Recap: decisions and actions.', thread: 'recordings', metadata: { meeting_id: '42' } }

async function withPrivate(dir: string, base: string, port: number) {
  const created = await (await fetch(`${base}/wizard/v1/agents`, send('POST', PRIVATE))).json()
  const file = join(dir, 'agents', created.agent.id, 'agent.json')
  const agent = JSON.parse(readFileSync(file, 'utf8'))
  agent.runtime.port = port
  writeFileSync(file, JSON.stringify(agent))
  // A start clears the cached status probed on the old port.
  await fetch(`${base}/wizard/v1/agents/${created.agent.id}/start`, send('POST', {}))
  return created.agent.id as string
}

const token = (dir: string, app = 'meeting-recorder') => readFileSync(join(dir, 'app-tokens', app), 'utf8').trim()
const deliver = (base: string, bearer: string, body: unknown = RECAP, app = 'meeting-recorder') =>
  fetch(`${base}/wizard/v1/apps/${app}/deliveries`, send('POST', body, { Authorization: `Bearer ${bearer}` }))

describe('app → agent binding', () => {
  it('defaults to the main agent, issues an app-scoped token, and shows the app on the agent', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main)
    const got = await (await fetch(`${base}/wizard/v1/apps/meeting-recorder/binding`)).json()
    expect(got.binding).toMatchObject({ app_id: 'meeting-recorder', agent: 'hermes', is_default: true, required: true, purpose: 'Where your recording recaps go', agent_info: { id: 'hermes' } })
    expect(statSync(join(dir, 'app-tokens', 'meeting-recorder')).mode & 0o777).toBe(0o600)
    expect(token(dir).length).toBeGreaterThan(30)
    expect(JSON.stringify(got)).not.toContain(token(dir))
    const hermes = await (await fetch(`${base}/wizard/v1/agents/hermes`)).json()
    expect(hermes.agent.bound_apps).toEqual([{ id: 'meeting-recorder', label: 'Meeting Recorder', purpose: 'Where your recording recaps go' }])
    const options = await (await fetch(`${base}/wizard/v1/agent-options`)).json()
    expect(options.binding_apps.map((b: any) => [b.app_id, b.agent])).toEqual([['meeting-recorder', 'hermes']])
    const list = await (await fetch(`${base}/wizard/v1/app-bindings`)).json()
    expect(list.bindings).toHaveLength(1)
  })

  it('refuses apps that are not installed or declare no binding, unknown agents and non-JSON writes', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main)
    const plain = await fetch(`${base}/wizard/v1/apps/meditate/binding`)
    expect(plain.status).toBe(409)
    expect(await plain.json()).toMatchObject({ error: 'binding_not_declared', check: 'app.agent_binding' })
    const missing = await fetch(`${base}/wizard/v1/apps/nope/binding`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ check: 'app.id' })
    const ghost = await fetch(`${base}/wizard/v1/apps/meeting-recorder/binding`, send('PUT', { agent: 'ghost' }))
    expect(ghost.status).toBe(404)
    expect(await ghost.json()).toMatchObject({ check: 'agent.id' })
    const form = await fetch(`${base}/wizard/v1/apps/meeting-recorder/binding`, { method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'agent=private' })
    expect(form.status).toBe(415)
  })

  it('delivers to the main agent by default; the app token is required and the app cannot pick the agent', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base, deliveries } = await start(dir, main)
    await fetch(`${base}/wizard/v1/apps/meeting-recorder/binding`)
    expect((await deliver(base, 'wrong-token-0123456789abcdefghij')).status).toBe(403)
    expect((await deliver(base, 'delivery-token-0123456789abcdef')).status).toBe(403)   // the internal token is not an app token
    const ok = await deliver(base, token(dir), { ...RECAP, agent: 'private', session_id: 'wizard_main_x' })
    expect(ok.status).toBe(200)
    const receipt = await ok.json()
    const sid = appThreadId('meeting-recorder', 'recordings')
    expect(receipt).toMatchObject({ verified: true, already_delivered: false, session_id: sid, agent: { id: 'hermes' } })
    expect(deliveries).toEqual([{ id: 'hermes', payload: {
      session_id: sid, title: 'Recording · Team sync', body: 'Recap: decisions and actions.', delivery_key: 'app:meeting-recorder:meeting-42',
      display_metadata: { meeting_id: '42', app_id: 'meeting-recorder' },
    } }])
    const bad = await deliver(base, token(dir), { ...RECAP, title: '' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ check: 'delivery.title' })
  })

  it('routes to the bound private agent, pins the thread there, and moves the app on the agents pages', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const priv = await fakeHermes('private')
    const { base, deliveries } = await start(dir, main)
    const id = await withPrivate(dir, base, priv.port)
    const put = await fetch(`${base}/wizard/v1/apps/meeting-recorder/binding`, send('PUT', { agent: id }))
    expect(put.status).toBe(200)
    expect((await put.json()).binding).toMatchObject({ agent: 'private', is_default: false, agent_info: { id: 'private', privacy: 'private' } })
    expect(JSON.parse(readFileSync(join(dir, 'app-bindings.json'), 'utf8')).apps['meeting-recorder'].agent).toBe('private')
    const ok = await deliver(base, token(dir))
    expect(ok.status).toBe(200)
    expect((await ok.json()).agent).toMatchObject({ id: 'private' })
    expect(deliveries.map((d) => d.id)).toEqual(['private'])
    const sid = appThreadId('meeting-recorder', 'recordings')
    // The delivered thread is pinned: reading it without naming an agent goes to the private Hermes only.
    // #59: a private agent's thread is read through its own Chats (agent named), never by id alone.
    expect((await fetch(`${base}/wizard/hermes/api/sessions/${sid}/messages`)).status).toBe(409)
    const read = await (await fetch(`${base}/wizard/hermes/api/sessions/${sid}/messages?agent=private`)).json()
    expect(read.data[0].content).toBe('private recap')
    expect(main.seen.some((line) => line.includes(sid))).toBe(false)
    const agents = await (await fetch(`${base}/wizard/v1/agents`)).json()
    expect(Object.fromEntries(agents.agents.map((a: any) => [a.id, a.bound_apps.map((b: any) => b.id)]))).toEqual({ hermes: [], private: ['meeting-recorder'] })
    // Back to the main agent: the stored entry goes away (default).
    const back = await (await fetch(`${base}/wizard/v1/apps/meeting-recorder/binding`, send('PUT', { agent: 'hermes' }))).json()
    expect(back.binding).toMatchObject({ agent: 'hermes', is_default: true })
  })

  it('fails loudly when the bound private agent is down, never falling back to the main agent', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const priv = await fakeHermes('private')
    const { base, deliveries } = await start(dir, main)
    const id = await withPrivate(dir, base, priv.port)
    await fetch(`${base}/wizard/v1/apps/meeting-recorder/binding`, send('PUT', { agent: id }))
    priv.server.closeAllConnections()
    await new Promise((r) => priv.server.close(() => r(undefined)))
    servers.splice(servers.indexOf(priv.server), 1)
    const down = await deliver(base, token(dir))
    expect(down.status).toBe(503)
    expect(await down.json()).toMatchObject({ error: 'bound_agent_unavailable', check: 'app.binding.agent_running' })
    expect(deliveries).toEqual([])
  })

  it('maps a runtime "not running" answer to bound_agent_unavailable', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main, async () => { throw Object.assign(new Error('agent_not_running'), { code: 'agent_not_running' }) })
    await fetch(`${base}/wizard/v1/apps/meeting-recorder/binding`)
    const res = await deliver(base, token(dir))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'bound_agent_unavailable' })
  })

  it('reads the wizard.md declaration shapes', () => {
    expect(bindingDeclaration({ agent_binding: { required: true, purpose: 'x' } })).toEqual({ required: true, purpose: 'x' })
    expect(bindingDeclaration({ agent_binding: true })).toEqual({ required: false, purpose: '' })
    expect(bindingDeclaration({})).toBeNull()
    expect(appThreadId('a.b', 't')).toMatch(/^wizard_app_a-b_[0-9a-f]{20}$/)
  })
})
