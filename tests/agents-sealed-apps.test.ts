// #58 (which agents can use an app; the gateway serves each agent only its own apps) and
// #59 (private agents are sealed: never a readable source). wizard-os spec/AGENTS.md sections 5 and 6.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { hermesConfigYaml } from '../server/agents.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r(undefined))) } })
const MAIN_TOKEN = 'main-gw-fixture'

async function readBody(req: IncomingMessage) {
  let raw = ''
  for await (const c of req) raw += c
  return raw ? JSON.parse(raw) : undefined
}

// Stock-shaped Hermes API (sessions, runs, health). Records every request.
async function fakeHermes(name: string, sessions: string[] = []) {
  const seen: { method: string, path: string }[] = []
  const known = new Set(sessions)
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = await readBody(req)
    seen.push({ method: req.method ?? '', path: url.pathname + url.search })
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/api/model/options') return json(200, { providers: [{ slug: 'anthropic', authenticated: true, models: ['claude-opus-5-5'] }] })
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, { data: [...known].map((id) => ({ id, title: `${name} ${id}`, source: 'api_server' })) })
    const one = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && one) return known.has(decodeURIComponent(one[1])) ? json(200, { session: { id: decodeURIComponent(one[1]), title: name } }) : json(404, { error: 'not found' })
    if (req.method === 'GET' && /\/messages$/.test(url.pathname)) return json(200, { data: [{ role: 'assistant', content: `${name} secret` }] })
    if (req.method === 'POST' && url.pathname === '/v1/runs') { known.add(body.session_id); return json(202, { run_id: `${name}-run-1` }) }
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) return json(200, { run_id: 'x', status: 'completed', output: `${name} output` })
    json(404, { error: 'nope' })
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { port: address.port, origin: `http://127.0.0.1:${address.port}`, seen, known }
}

// A tiny app MCP server.
async function fakeApp(tool: string) {
  const calls: string[] = []
  const server = createServer(async (req, res) => {
    const msg = (await readBody(req)) ?? {}
    const send = (result: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
    if (msg.id === undefined) { res.writeHead(202); res.end(); return }
    if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: tool } })
    if (msg.method === 'tools/list') return send({ tools: [{ name: tool, description: `${tool}.`, inputSchema: { type: 'object', properties: {} } }] })
    if (msg.method === 'tools/call') { calls.push(msg.params.name); return send({ content: [{ type: 'text', text: `ran ${msg.params.name}` }] }) }
    send({})
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls }
}

const appEntry = (id: string, url: string, view = true) => ({ id, name: id, status: 'running', provides: [`${id}-job`], mcp: { url }, ...(view ? { view: { url: `/${id}/` } } : {}) })

async function box(appUrls: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'agents-58-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeApps(dir, [appEntry('notes', appUrls.notes), appEntry('scanner', appUrls.scanner, false)])
  return dir
}
function writeApps(dir: string, apps: unknown[]) {
  const path = join(dir, 'apps.json')
  writeFileSync(path, JSON.stringify({ schema: 1, apps }))
}

async function start(dir: string, main: { origin: string }, extra: Record<string, unknown> = {}) {
  const runtime = {
    apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }),
    deliver: async (_id: string, payload: any) => ({ verified: true, session_id: payload.session_id }),
  }
  const svc = createWizardServer({
    upstreamOrigin: main.origin, hermesKey: 'fixture-key', requireAccess: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: runtime, followThrough: false, agentBasePort: 47750, mcpToken: MAIN_TOKEN, bridgeWatchMs: 0,
    bridgeWriteSkills: false, agentGatewayUrl: 'http://wizard-agent-service:8923/wizard/mcp', bridgeLog: () => {}, ...extra,
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  return `http://127.0.0.1:${address.port}`
}

const json = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const PRIVATE = { label: 'Private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }
const STANDARD = (label: string, extra: Record<string, unknown> = {}) => ({ label, harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'standard', ...extra } })

async function create(base: string, body: unknown, port?: number, dir?: string) {
  const r = await fetch(`${base}/wizard/v1/agents`, json(body))
  const { agent } = await r.json()
  if (port && dir) {
    const file = join(dir, 'agents', agent.id, 'agent.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    stored.runtime.port = port
    writeFileSync(file, JSON.stringify(stored))
  }
  return agent
}
const gatewayKey = (dir: string, id: string) => readFileSync(join(dir, 'agents', id, 'gateway.key'), 'utf8').trim()

async function mcp(base: string, token: string, method: string, params: unknown = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }
  const init = await fetch(`${base}/wizard/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) })
  if (init.status !== 200) return { status: init.status, json: null as any }
  const session = init.headers.get('mcp-session-id') ?? ''
  const r = await fetch(`${base}/wizard/mcp`, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) })
  return { status: r.status, json: await r.json() as any, session }
}
const toolNames = async (base: string, token: string) => ((await mcp(base, token, 'tools/list')).json?.result?.tools ?? []).map((t: any) => t.name).sort()

describe('#58 which agents can use an app', () => {
  it('the gateway serves each agent only the apps on its own list; the main agent keeps every app', async () => {
    const notes = await fakeApp('note_add')
    const scanner = await fakeApp('scan')
    const dir = await box({ notes: notes.url, scanner: scanner.url })
    const main = await fakeHermes('main')
    const base = await start(dir, main)
    const priv = await create(base, PRIVATE)
    const helper = await create(base, STANDARD('Helper', { wizard_apps: ['notes'] }))
    expect(priv.permissions).toMatchObject({ wizard_apps: [], agent_apps: [] })
    // Main agent: standard, every current app ticked (no regression for an existing box).
    const mainAgent = (await (await fetch(`${base}/wizard/v1/agents/hermes`)).json()).agent
    expect(mainAgent).toMatchObject({ privacy: 'standard', permissions: { wizard_apps: ['notes'], agent_apps: ['scanner'] } })
    expect(await toolNames(base, MAIN_TOKEN)).toEqual(['notes__note_add', 'scanner__scan', 'wizard_apps'])
    expect(await toolNames(base, gatewayKey(dir, helper.id))).toEqual(['notes__note_add', 'wizard_apps'])
    expect(await toolNames(base, gatewayKey(dir, 'private'))).toEqual(['wizard_apps'])
    // A tool outside the agent's list answers like an app that is not installed, and never reaches the app.
    const refused = await mcp(base, gatewayKey(dir, helper.id), 'tools/call', { name: 'scanner__scan', arguments: {} })
    expect(refused.json.result.isError).toBe(true)
    expect(scanner.calls).toEqual([])
    const allowed = await mcp(base, gatewayKey(dir, helper.id), 'tools/call', { name: 'notes__note_add', arguments: {} })
    expect(allowed.json.result.content[0].text).toBe('ran note_add')
    const listed = await mcp(base, gatewayKey(dir, 'private'), 'tools/call', { name: 'wizard_apps', arguments: {} })
    expect(listed.json.result.content[0].text).not.toContain('notes')
    // A session opened by one agent cannot be used with another agent's token.
    const opened = await mcp(base, gatewayKey(dir, 'private'), 'tools/list')
    const hijack = await fetch(`${base}/wizard/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayKey(dir, helper.id)}`, 'Mcp-Session-Id': opened.session }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) })
    expect(hijack.status).toBe(404)
    expect((await mcp(base, 'not-a-token', 'tools/list')).status).toBe(401)
    // The agent's own kernel route lists only its apps.
    const ctx = await (await fetch(`${base}/wizard/v1/agent-context?format=json`, { headers: { Authorization: `Bearer ${gatewayKey(dir, 'private')}` } })).json()
    expect(ctx.apps).toEqual([])
  })

  it('a new app joins standard agents (main included), never private ones; harness config carries the gateway', async () => {
    const notes = await fakeApp('note_add')
    const scanner = await fakeApp('scan')
    const dir = await box({ notes: notes.url, scanner: scanner.url })
    const main = await fakeHermes('main')
    const base = await start(dir, main)
    await create(base, PRIVATE)
    const helper = await create(base, STANDARD('Helper'))
    // The owner narrows the main agent; a stored choice is kept from then on.
    const narrowed = await fetch(`${base}/wizard/v1/agents/hermes`, json({ permissions: { wizard_apps: ['notes'], agent_apps: [] } }, 'PATCH'))
    expect(narrowed.status).toBe(200)
    expect(await toolNames(base, MAIN_TOKEN)).toEqual(['notes__note_add', 'wizard_apps'])
    // Install a new app.
    const music = await fakeApp('play')
    writeApps(dir, [appEntry('notes', notes.url), appEntry('scanner', scanner.url, false), appEntry('music', music.url)])
    const agents = (await (await fetch(`${base}/wizard/v1/agents`)).json()).agents
    const byId = Object.fromEntries(agents.map((a: any) => [a.id, a]))
    expect(byId.hermes.permissions).toMatchObject({ wizard_apps: ['notes', 'music'], agent_apps: [] })
    expect(byId[helper.id].permissions.wizard_apps).toContain('music')
    expect(byId.private.permissions).toMatchObject({ wizard_apps: [], agent_apps: [] })
    expect(await toolNames(base, gatewayKey(dir, 'private'))).toEqual(['wizard_apps'])
    expect(await toolNames(base, gatewayKey(dir, helper.id))).toContain('music__play')
    // Re-reading does not re-add an app the owner unticked.
    await fetch(`${base}/wizard/v1/agents/${helper.id}`, json({ permissions: { wizard_apps: [] } }, 'PATCH'))
    const again = (await (await fetch(`${base}/wizard/v1/agents/${helper.id}`)).json()).agent
    expect(again.permissions.wizard_apps).toEqual([])
    // Harness config: standard agents get the gateway with their own token; a private agent without apps does not.
    const helperConfig = readFileSync(join(dir, 'agents', helper.id, 'home', 'config.yaml'), 'utf8')
    expect(helperConfig).toContain('url: "http://wizard-agent-service:8923/wizard/mcp"')
    expect(helperConfig).toContain('Authorization: "Bearer ${WIZARD_MCP_TOKEN}"')
    expect(readFileSync(join(dir, 'agents', helper.id, 'home', '.env'), 'utf8')).toContain(`WIZARD_MCP_TOKEN=${gatewayKey(dir, helper.id)}`)
    const privConfig = readFileSync(join(dir, 'agents', 'private', 'home', 'config.yaml'), 'utf8')
    expect(privConfig).toContain('mcp_servers: {}')
    expect(readFileSync(join(dir, 'agents', 'private', 'home', '.env'), 'utf8')).not.toContain('WIZARD_MCP_TOKEN')
    // The main agent's other settings stay read-only here.
    const label = await fetch(`${base}/wizard/v1/agents/hermes`, json({ label: 'x' }, 'PATCH'))
    expect(await label.json()).toMatchObject({ check: 'agent.main' })
  })

  it("the app's settings sheet: GET/PUT /apps/<id>/agents ticks and unticks agents, both sides stay in sync", async () => {
    const notes = await fakeApp('note_add')
    const scanner = await fakeApp('scan')
    const dir = await box({ notes: notes.url, scanner: scanner.url })
    const main = await fakeHermes('main')
    const base = await start(dir, main)
    await create(base, PRIVATE)
    const helper = await create(base, STANDARD('Helper'))
    const before = await (await fetch(`${base}/wizard/v1/apps/notes/agents`)).json()
    expect(before.kind).toBe('wizard_apps')
    expect(before.agents.map((a: any) => [a.id, a.privacy, a.enabled])).toEqual([['hermes', 'standard', true], ['helper', 'standard', false], ['private', 'private', false]])
    const put = await fetch(`${base}/wizard/v1/apps/notes/agents`, json({ agents: ['private', helper.id] }, 'PUT'))
    expect(put.status).toBe(200)
    const after = await put.json()
    expect(after.agents.map((a: any) => [a.id, a.enabled])).toEqual([['hermes', false], ['helper', true], ['private', true]])
    const privAgent = (await (await fetch(`${base}/wizard/v1/agents/private`)).json()).agent
    expect(privAgent.permissions.wizard_apps).toEqual(['notes'])
    expect(await toolNames(base, gatewayKey(dir, 'private'))).toEqual(['notes__note_add', 'wizard_apps'])
    expect(await toolNames(base, MAIN_TOKEN)).toEqual(['scanner__scan', 'wizard_apps'])
    // Ticked from the private agent's side now writes the gateway into its harness config.
    expect(readFileSync(join(dir, 'agents', 'private', 'home', 'config.yaml'), 'utf8')).toContain('/wizard/mcp')
    expect((await fetch(`${base}/wizard/v1/apps/nope/agents`)).status).toBe(404)
    expect(await (await fetch(`${base}/wizard/v1/apps/notes/agents`, json({ agents: ['ghost'] }, 'PUT'))).json()).toMatchObject({ check: 'agent.id' })
  })

  it('hermesConfigYaml: no gateway URL configured = no gateway for anyone', () => {
    const agent = { id: 'x', privacy: 'standard', model: { provider: 'tinfoil', model: 'glm-5-3', fallback: false }, permissions: { outside_tools: [], files: 'own', wizard_apps: ['a'], agent_apps: [] } }
    expect(hermesConfigYaml(agent)).not.toContain('wizard:')
    expect(hermesConfigYaml(agent, { gatewayUrl: 'http://g/wizard/mcp' })).toContain('wizard:')
  })
})

describe('#59 private agents are sealed', () => {
  async function sealedBox() {
    const dir = await box({ notes: 'http://127.0.0.1:1/mcp', scanner: 'http://127.0.0.1:2/mcp' })
    const main = await fakeHermes('main', ['wizard_main_1'])
    const priv = await fakeHermes('private', ['wizard_private_1'])
    const other = await fakeHermes('other', ['wizard_other_1'])
    const base = await start(dir, main)
    await create(base, PRIVATE, priv.port, dir)
    const reader = await create(base, STANDARD('Reader'))
    const other2 = await create(base, STANDARD('Other'), other.port, dir)
    return { dir, base, main, priv, reader, other: other2 }
  }

  it('an agent-data grant whose source is private is refused (409 agent.private_sealed)', async () => {
    const { base, reader, other } = await sealedBox()
    const bad = await fetch(`${base}/wizard/v1/agent-grants`, json({ reader: reader.id, source: 'private', scope: 'read' }))
    expect(bad.status).toBe(409)
    expect(await bad.json()).toMatchObject({ error: 'private_agent_sealed', check: 'agent.private_sealed' })
    const fromMain = await fetch(`${base}/wizard/v1/agent-grants`, json({ reader: 'hermes', source: 'private', scope: 'titles' }))
    expect(await fromMain.json()).toMatchObject({ check: 'agent.private_sealed' })
    const privToPriv = await fetch(`${base}/wizard/v1/agent-grants`, json({ reader: 'private', source: 'private', scope: 'titles' }))
    expect(await privToPriv.json()).toMatchObject({ check: 'agent.private_sealed' })
    const ok = await fetch(`${base}/wizard/v1/agent-grants`, json({ reader: reader.id, source: other.id, scope: 'search' }))
    expect(ok.status).toBe(201)
    const list = await (await fetch(`${base}/wizard/v1/agent-grants?reader=${reader.id}`)).json()
    expect(list.grants.map((g: any) => g.source)).toEqual([other.id])
    expect(list.readable_sources).toEqual([{ source: other.id, scope: 'search' }])
  })

  it('PATCH never opens a private agent as a source: privacy change, downgrade or share fields → 409', async () => {
    const { base } = await sealedBox()
    for (const body of [
      { privacy: 'standard' },
      { model: { provider: 'anthropic', model: 'claude-opus-5-5' }, confirm_downgrade: true },
      { permissions: { readable_by: ['hermes'] } },
    ]) {
      const r = await fetch(`${base}/wizard/v1/agents/private`, json(body, 'PATCH'))
      expect(r.status).toBe(409)
      expect(await r.json()).toMatchObject({ check: 'agent.private_sealed' })
    }
    const still = (await (await fetch(`${base}/wizard/v1/agents/private`)).json()).agent
    expect(still).toMatchObject({ privacy: 'private', model: { provider: 'tinfoil' } })
  })

  it('a standard agent with other_agents raised still cannot read the private agent', async () => {
    const { dir, base, priv, reader, other } = await sealedBox()
    const raised = await fetch(`${base}/wizard/v1/agents/${reader.id}`, json({ permissions: { other_agents: 'read' } }, 'PATCH'))
    expect(raised.status).toBe(200)
    // Even a grant written straight into the store (bypassing the API) is ignored for a private source.
    const grantsPath = join(dir, 'agents', '.agent-grants.json')
    writeFileSync(grantsPath, JSON.stringify({ schema: 1, grants: [{ id: 'grant_aaaaaaaaaaaa', kind: 'agent-data', reader: reader.id, source: 'private', scope: 'read' }] }))
    const sources = (await (await fetch(`${base}/wizard/v1/agent-grants?reader=${reader.id}`)).json()).readable_sources
    expect(sources.map((s: any) => s.source).sort()).toEqual(['hermes', other.id].sort())
    expect(sources.map((s: any) => s.source)).not.toContain('private')
    // The reader's own gateway token is no key to the private agent's threads (pinned once its own Chats listed them).
    await fetch(`${base}/wizard/hermes/api/sessions?agent=private`)
    const token = gatewayKey(dir, reader.id)
    const viaToken = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_1/messages`, { headers: { Authorization: `Bearer ${token}` } })
    // Refused at the principal check: an agent credential never opens another agent's (private) work.
    expect(viaToken.status).toBe(403)
    expect(await viaToken.json()).toMatchObject({ check: 'agent.private_owner' })
    expect(JSON.stringify(priv.seen)).not.toContain('/messages')
  })

  it('thread reads for a private agent only through its own Chats (agent named); operator and id-only reads refused', async () => {
    const { base, priv, other } = await sealedBox()
    // Pin the private thread the normal way (its own Chats names the agent).
    const list = await (await fetch(`${base}/wizard/hermes/api/sessions?agent=private`)).json()
    expect(list.data.map((s: any) => s.id)).toEqual(['wizard_private_1'])
    const own = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_1/messages?agent=private`)
    expect(own.status).toBe(200)
    expect((await own.json()).data[0].content).toBe('private secret')
    // By thread id alone (a link, another agent's view): refused, nothing fetched.
    const before = priv.seen.length
    for (const path of ['/wizard/hermes/api/sessions/wizard_private_1/messages', '/wizard/hermes/api/sessions/wizard_private_1']) {
      const r = await fetch(`${base}${path}`)
      expect(r.status).toBe(409)
      expect(await r.json()).toMatchObject({ check: 'agent.private_sealed' })
    }
    // The operator surface never reaches the private agent, named or pinned.
    const op = await fetch(`${base}/wizard/operator/api/sessions/wizard_private_1/messages`)
    expect(op.status).toBe(409)
    expect(await op.json()).toMatchObject({ check: 'agent.private_sealed' })
    expect(priv.seen.length).toBe(before)
    // A standard agent's thread is still readable by id (pin routing unchanged for standard agents).
    await fetch(`${base}/wizard/hermes/api/sessions?agent=${other.id}`)
    const std = await fetch(`${base}/wizard/hermes/api/sessions/wizard_other_1/messages`)
    expect(std.status).toBe(200)
  })
})
