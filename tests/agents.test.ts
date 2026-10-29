import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { standardChatRpc, searchHistory, readHistory } from '../server/standard-chats.mjs'
import { privateChatMatches } from '../server/private-chat-search.mjs'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { agentVisionHelper, createAgentRegistry, claudeModelId, hermesConfigYaml, normalizeMemory, parseAgentFile } from '../server/agents.mjs'
import { readApps } from '../server/wizard-os-settings.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

type Seen = { method: string, path: string, auth: string, body: any }

async function readBody(req: IncomingMessage) {
  let raw = ''
  for await (const c of req) raw += c
  return raw ? JSON.parse(raw) : undefined
}

// A stock-shaped Hermes API: sessions, runs, model options, health. Records every request.
async function fakeHermes(name: string, sessions: string[] = [], messages?: unknown[], socketPath?: string) {
  const seen: Seen[] = []
  const known = new Set(sessions)
  const rows = new Map(sessions.map(id => [id, { id, title: `${name} ${id}`, source: 'api_server', archived: false }]))
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = await readBody(req)
    seen.push({ method: req.method ?? '', path: url.pathname + url.search, auth: String(req.headers.authorization ?? ''), body })
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/v1/capabilities') return json(200, { features: {} })
    if (url.pathname === '/api/model/options') return json(200, { provider: 'anthropic', model: 'claude-opus-5-5', providers: [
      { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5', 'claude-fable-5'] },
      { slug: 'openai-codex', name: 'Codex', authenticated: true, models: ['gpt-6.1-sol'] },
      { slug: 'nous', name: 'Nous', authenticated: false, models: [] },
    ] })
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, { data: [...known].map((id) => rows.get(id)) })
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'DELETE' && sessionMatch) { const id = decodeURIComponent(sessionMatch[1]); rows.delete(id); return known.delete(id) ? json(200,{ok:true}) : json(404,{error:'not found'}) }
    if (req.method === 'GET' && sessionMatch) { const row = rows.get(decodeURIComponent(sessionMatch[1])); return row ? json(200, { session: row }) : json(404, { error: 'not found' }) }
    if (req.method === 'PATCH' && sessionMatch) { const row = rows.get(decodeURIComponent(sessionMatch[1])); if (!row) return json(404, { error: 'not found' }); Object.assign(row, body); return json(200, { session: row }) }
    if (req.method === 'GET' && /\/messages$/.test(url.pathname)) return json(200, { data: messages ?? [{ role: 'assistant', content: `${name} says hi` }] })
    if (req.method === 'POST' && url.pathname === '/api/sessions') { const id = body?.id ?? 'generated_1'; known.add(id); rows.set(id, { ...body, id, archived: false }); return json(201, { session: rows.get(id) }) }
    if (req.method === 'POST' && url.pathname === '/v1/runs') { known.add(body.session_id); const row = rows.get(body.session_id) ?? { id: body.session_id, title: name, source: 'api_server', archived: false }; row.archived = false; rows.set(body.session_id, row); return json(202, { run_id: `${name}-run-1`, status: 'started' }) }
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) return json(200, { run_id: url.pathname.split('/').at(-1), status: 'completed', output: `${name} done` })
    json(404, { error: 'nope' })
  })
  servers.push(server)
  if (socketPath) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    chmodSync(socketPath, 0o600)
    return { port: 0, origin: '', seen, known, rows }
  }
  const address = await listen(server) as import('node:net').AddressInfo
  return { port: address.port, origin: `http://127.0.0.1:${address.port}`, seen, known, rows }
}

function box() {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  mkdirSync(join(dir, 'agents', 'claude-explore', 'home'), { recursive: true })   // unrelated experiment folder
  writeFileSync(join(dir, 'agents', 'claude-explore', 'notes.json'), '{"x":1}')
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [
    { id: 'meditate', name: 'Meditate', status: 'running', view: { url: '/meditate/' }, mcp: { url: 'http://127.0.0.1:1/mcp' }, summary: 'm' },
    { id: 'transcriber', name: 'Transcriber', status: 'running', mcp: { url: 'http://127.0.0.1:2/mcp' } },
    { id: 'agent-old', name: 'Old (agent)', type: 'agent', category: 'agent', status: 'running' },
  ] }))
  return dir
}

async function start(dir: string, main: { origin: string }, extra: Record<string, unknown> = {}) {
  const calls: string[] = []
  const deliveries: any[] = []
  const runtime = {
    apply: async (id: string) => {
      if (extra.agentIsolation === 'restricted') {
        const gateway = join(dir, 'agents', id, 'gateway', 'gateway.sock')
        expect(lstatSync(gateway).isSocket()).toBe(true) // transport exists before Docker sees the request
        expect(lstatSync(gateway).mode & 0o777).toBe(0o600)
      }
      calls.push(`apply ${id}`); return { ok: true }
    },
    start: async (id: string) => { calls.push(`start ${id}`); return { ok: true } },
    stop: async (id: string) => { calls.push(`stop ${id}`); return { ok: true } },
    deliver: async (id: string, payload: any) => { deliveries.push({ id, payload }); return { verified: true, already_delivered: false, session_id: payload.session_id, message_id: 3 } },
    ...(extra.runtimeFetch ? { fetch: extra.runtimeFetch } : {}),
  }
  const svc = createWizardServer({
    upstreamOrigin: main.origin, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: runtime, agentDeliveryToken: 'delivery-token-0123456789abcdef', followThrough: false,
    // Away from the default 18650, which a real agent on the test machine may hold.
    agentBasePort: 47650, ...extra,
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  return { base: `http://127.0.0.1:${address.port}`, calls, deliveries, server: svc }
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
// Explicitly off: these tests switch standard-chat reading themselves (the default-on rule has its own test).
const PRIVATE = { label: 'Private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private', read_standard_chats: false } }

// Create the private agent and point it at a fake Hermes on the port the registry assigned.
async function withPrivate(dir: string, base: string, privatePort?: number) {
  const created = await fetch(`${base}/wizard/v1/agents`, json(PRIVATE, { 'Idempotency-Key': 'create-private-1' }))
  const payload = await created.json()
  if (privatePort) {
    const file = join(dir, 'agents', payload.agent.id, 'agent.json')
    const agent = JSON.parse(readFileSync(file, 'utf8'))
    agent.runtime.port = privatePort
    writeFileSync(file, JSON.stringify(agent))
  }
  return { status: created.status, agent: payload.agent }
}

describe('agents registry and API', () => {
  it('owner can hide/unhide agents without stopping them; hidden must be boolean and survives readback', async () => {
    const dir = box(), main = await fakeHermes('main'), { base, calls } = await start(dir, main)
    const { agent } = await withPrivate(dir, base)
    const route = base + '/wizard/v1/agents/' + agent.id
    const patch = (hidden: unknown) => fetch(route, { ...json({ hidden }), method: 'PATCH' })
    expect((await patch('true')).status).toBe(400)
    const before = calls.slice()
    expect((await patch(true)).status).toBe(200)
    expect((await (await fetch(route)).json()).agent.hidden).toBe(true)
    expect((await (await fetch(base + '/wizard/v1/agents')).json()).agents.find((a:any)=>a.id===agent.id).hidden).toBe(true)
    expect(calls).toEqual(before)
    expect(JSON.parse(readFileSync(join(dir, 'agents', agent.id, 'agent.json'), 'utf8')).hidden).toBe(true)
    expect((await patch(false)).status).toBe(200)
    expect((await (await fetch(route)).json()).agent.hidden === true).toBe(false)
    expect((await fetch(base + '/wizard/v1/agents/hermes', { ...json({hidden:true}), method:'PATCH' })).status).toBe(200)
    expect((await (await fetch(base + '/wizard/v1/agents/hermes')).json()).agent.hidden).toBe(true)
  })

  it('prepares only the reserved import socket through an owner-only API, without runtime calls', async () => {
    const dir = box(), main = await fakeHermes('main')
    const registry = createAgentRegistry({ agentsDir: join(dir, 'agents'), isolation: 'restricted',
      mainProviders: async () => [{ slug: 'anthropic', models: ['claude-opus-5-5'], authenticated: true }],
      runtime: { apply() { throw new Error('must not start') } } })
    const { agent } = await registry.create({ label: 'Reserve', model: { provider: 'anthropic', model: 'claude-opus-5-5' } }, { deferStart: true })
    const proof = 'synthetic-owner-proof-01234567890123456789'
    const { base, calls } = await start(dir, main, { agentIsolation: 'restricted', ownerProof: proof })
    const route = base + '/wizard/v1/agents/' + agent.id + '/prepare-import'
    expect((await fetch(route, json({}))).status).toBe(403)
    const headers = { 'x-wizard-owner-proof': proof }
    expect((await fetch(route, json({}, headers))).status).toBe(202)
    expect(calls).toEqual([])
    expect(existsSync(join(dir, 'agents', agent.id, 'home', 'config.yaml'))).toBe(false)
    const options = await (await fetch(base + '/wizard/v1/agent-options', { headers })).json()
    expect(options.import_capabilities).toEqual({ socket_prepare: true, heavy_enabled: false, heavy_sandbox: false })
    const recordPath = join(dir, 'agents', agent.id, 'agent.json')
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    delete record.runtime.admission
    writeFileSync(recordPath, JSON.stringify(record))
    expect((await fetch(route, json({}, headers))).status).toBe(409)
    expect(calls).toEqual([])
  })
  it('reserves imports stopped through the restricted allocator and refuses future sensitive app grants', async () => {
    const dir = box()
    const calls: string[] = []
    const registry = createAgentRegistry({ agentsDir: join(dir, 'agents'), appsJsonPath: join(dir, 'apps.json'),
      isolation: 'restricted', basePort: 47800,
      mainProviders: async () => [{ slug: 'anthropic', models: ['claude-opus-5-5'], authenticated: true }],
      beforeRestrictedStart: async () => { calls.push('socket') },
      runtime: { apply: async () => { calls.push('apply') } },
    })
    const { agent } = await registry.create({ label: 'Import reserve', model: { provider: 'anthropic', model: 'claude-opus-5-5' },
      permissions: { preset: 'standard', outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [] },
    }, { deferStart: true })
    expect(calls).toEqual([])
    const folder = join(dir, 'agents', agent.id)
    const record = JSON.parse(readFileSync(join(folder, 'agent.json'), 'utf8'))
    expect(record.runtime.admission).toBe('importing')
    expect(existsSync(join(folder, 'home', 'config.yaml'))).toBe(false)
    const configBefore = 'memory: {provider: synthetic}\n'
    mkdirSync(join(folder, 'home'), { recursive: true })
    writeFileSync(join(folder, 'home', 'config.yaml'), configBefore)
    await registry.prepareImport(agent.id)
    expect(calls).toEqual(['socket'])
    expect(readFileSync(join(folder, 'home', 'config.yaml'), 'utf8')).toBe(configBefore)
    expect(record.runtime.network).toEqual({ uplink: '10.250.0.16/28', sandbox: '10.251.0.16/28' })
    expect(JSON.parse(readFileSync(join(folder, 'service-state.json'), 'utf8')).desired).toBe('stopped')
    record.imported = { schema: 1, format: 'hermes' }
    delete record.runtime.admission
    writeFileSync(join(folder, 'agent.json'), JSON.stringify(record))
    registry.list()
    await expect(registry.prepareImport(agent.id)).rejects.toMatchObject({ error: 'agent_not_importing' })
    writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [{ id: 'privacy-com', status: 'running', mcp: { url: 'http://127.0.0.1:1/mcp' } }] }))
    registry.list()
    const after = JSON.parse(readFileSync(join(folder, 'agent.json'), 'utf8'))
    expect(after.permissions.wizard_apps).toEqual([])
    await expect(registry.update(agent.id, { permissions: { wizard_apps: ['privacy-com'] } })).rejects.toMatchObject({ error: 'import_sensitive_app_denied' })
  })

  it('preserves imported memory/auth harness bytes and fails closed on lost import keys', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base, calls } = await start(dir, main)
    const response = await fetch(`${base}/wizard/v1/agents`, json({ label: 'Imported', harness: 'hermes', model: { provider: 'anthropic', model: 'claude-opus-5-5' }, permissions: { preset: 'standard' } }, { 'Idempotency-Key': 'import-fixture' }))
    expect(response.status).toBe(201)
    const { agent } = await response.json()
    const folder = join(dir, 'agents', agent.id)
    const record = JSON.parse(readFileSync(join(folder, 'agent.json'), 'utf8'))
    record.imported = { schema: 1, format: 'hermes' }
    writeFileSync(join(folder, 'agent.json'), JSON.stringify(record))
    const original = 'memory:\n  provider: holographic\nplugins:\n  hermes-memory-store:\n    hrr_dim: 2048\n'
    writeFileSync(join(folder, 'home', 'config.yaml'), original)
    writeFileSync(join(folder, 'home', 'auth.json'), '{"fixture":"not-a-credential"}')
    const started = await fetch(`${base}/wizard/v1/agents/${agent.id}/start`, json({}))
    expect(started.status).toBe(202)
    expect(calls).toContain(`start ${agent.id}`)
    expect(readFileSync(join(folder, 'home', 'config.yaml'), 'utf8')).toBe(original)
    expect(readFileSync(join(folder, 'home', 'auth.json'), 'utf8')).toBe('{"fixture":"not-a-credential"}')
    writeFileSync(join(folder, 'runtime.key'), '')
    const refused = await fetch(`${base}/wizard/v1/agents/${agent.id}/start`, json({}))
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'import_keys_unavailable' })
    expect(readFileSync(join(folder, 'home', 'config.yaml'), 'utf8')).toBe(original)
  })
  it('restricted isolation gives each new agent its own uplink/sandbox /28 and the edge as its gateway', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main, { agentIsolation: 'restricted', agentGatewayUrl: 'http://wizard-agent-service:8923/wizard/mcp' })
    const create = (label: string, key: string, model = { provider: 'anthropic', model: 'claude-opus-5-5' }) => fetch(`${base}/wizard/v1/agents`, json({ label, harness: 'hermes', model, permissions: { preset: 'standard' } }, { 'Idempotency-Key': key }))
    const make = async (label: string, key: string) => (await (await create(label, key)).json()).agent
    // No Tinfoil attestation sidecar in the restricted runtime yet: refused up front, and nothing is created.
    const tinfoil = await create('Confidential', 'restricted-0', { provider: 'tinfoil', model: 'glm-5-3' })
    expect(tinfoil.status).toBe(409)
    expect(await tinfoil.json()).toMatchObject({ error: 'restricted_provider_unsupported' })
    expect(existsSync(join(dir, 'agents', 'confidential'))).toBe(false)
    const first = await make('Daily', 'restricted-1')
    const second = await make('Other', 'restricted-2')
    const stored = (id: string) => JSON.parse(readFileSync(join(dir, 'agents', id, 'agent.json'), 'utf8'))
    expect(stored(first.id).runtime).toMatchObject({ isolation: 'restricted', network: { uplink: '10.250.0.16/28', sandbox: '10.251.0.16/28' } })
    expect(stored(second.id).runtime).toMatchObject({ isolation: 'restricted', network: { uplink: '10.250.0.32/28', sandbox: '10.251.0.32/28' } })
    // Managed files go to managed/: the home belongs to the agent's container user and stays empty here.
    const config = readFileSync(join(dir, 'agents', first.id, 'managed', 'config.yaml'), 'utf8')
    expect(config).toContain('security:\n  redact_secrets: true')
    expect(config).toContain('http://edge:8923/wizard/mcp')
    expect(config).not.toContain('wizard-agent-service:8923')
    expect(readFileSync(join(dir, 'agents', first.id, 'managed', '.env'), 'utf8')).toContain('WIZARD_MCP_TOKEN=')
    expect(readdirSync(join(dir, 'agents', first.id, 'home'))).toEqual([])
    // The network allocation is not part of the public agent shape.
    expect(JSON.stringify(first)).not.toContain('10.250.')
    // ...and an existing restricted agent cannot move onto Tinfoil either.
    const moved = await fetch(`${base}/wizard/v1/agents/${first.id}`, { ...json({ model: { provider: 'tinfoil', model: 'glm-5-3' } }), method: 'PATCH' })
    expect(moved.status).toBe(409)
    expect(stored(first.id).model.provider).toBe('anthropic')
  })

  it('routes sealed-agent session reads and writes over ingress while preserving its own API key', async () => {
    const dir = box(), main = await fakeHermes('main')
    const { base } = await start(dir, main, { agentIsolation: 'restricted' })
    const created = await fetch(`${base}/wizard/v1/agents`, json({ label: 'Sealed', model: { provider: 'anthropic', model: 'claude-opus-5-5' } }))
    expect(created.status).toBe(201)
    const folder = join(dir, 'agents', 'sealed')
    const stored = JSON.parse(readFileSync(join(folder, 'agent.json'), 'utf8'))
    expect(stored.runtime.ingress_socket).toBe(join(folder, 'gateway', 'ingress.sock'))
    const sealed = await fakeHermes('sealed', ['wizard_socket_thread'], undefined, stored.runtime.ingress_socket)
    const listing = await fetch(`${base}/wizard/hermes/api/sessions?agent=sealed`)
    expect(listing.status).toBe(200)
    expect((await listing.json()).data[0].id).toBe('wizard_socket_thread')
    const made = await fetch(`${base}/wizard/hermes/api/sessions?agent=sealed`, json({ id: 'socket-created' }))
    expect(made.status).toBe(201); await made.json()
    const key = readFileSync(join(folder, 'runtime.key'), 'utf8').trim()
    expect(sealed.seen.filter(r => r.path.startsWith('/api/sessions')).every(r => r.auth === `Bearer ${key}`)).toBe(true)
    expect(sealed.known.has('socket-created')).toBe(true)
    expect(main.seen.some(r => r.body?.id === 'socket-created')).toBe(false)
  })

  it('without isolation, new agents keep the existing runtime shape', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main)
    const { agent } = await withPrivate(dir, base)
    const runtime = JSON.parse(readFileSync(join(dir, 'agents', agent.id, 'agent.json'), 'utf8')).runtime
    expect(runtime.isolation).toBeUndefined()
    expect(runtime.network).toBeUndefined()
  })
  it('redacts shared and agent-local attachment roots in routed context', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const original = '[Wizard follow-through] Please inspect /private/attachments/PRIVATE_PATH_CANARY.wav and /opt/data/attachments/CONTAINER_PATH_CANARY.wav and ' + join(dir, 'agents/private/home/attachments/HOST_PATH_CANARY.wav')
    const priv = await fakeHermes('private', ['wizard_private_paths'], [{ id: 4, role: 'user', timestamp: 42, content: original }])
    const { base } = await start(dir, main, { inboxTrustedRoots: ['/private/attachments'] })
    await withPrivate(dir, base, priv.port)
    const response = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_paths/messages?agent=private&view=wizard`)
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.data[0].run_context.redacted).toBe(true)
    expect(JSON.stringify(payload)).not.toMatch(/(?:PRIVATE|CONTAINER|HOST)_PATH_CANARY/)
    expect(payload.data[0].run_context.original).toContain('[private attachment]')
  })

  it('turns a routed agent\'s own MEDIA files into openable attachments kept in that agent\'s folder', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const home = join(dir, 'agents', 'private', 'home')
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
    const priv = await fakeHermes('private', ['wizard_private_media'], [
      { id: 1, role: 'assistant', timestamp: 1, content: 'Here are your notes.\n\nMEDIA:/opt/data/cache/documents/notes.md\nMEDIA:/opt/data/cache/images/chart.png' },
      { id: 2, role: 'assistant', timestamp: 2, content: `Escapes.\n\nMEDIA:/opt/data/cache/documents/escape.md\nMEDIA:${join(dir, 'outside.md')}` },
    ])
    const { base } = await start(dir, main)
    await withPrivate(dir, base, priv.port)
    mkdirSync(join(home, 'cache', 'documents'), { recursive: true })
    mkdirSync(join(home, 'cache', 'images'), { recursive: true })
    writeFileSync(join(home, 'cache', 'documents', 'notes.md'), '# OUTBOUND_MD_CANARY\n')
    writeFileSync(join(home, 'cache', 'images', 'chart.png'), png)
    writeFileSync(join(dir, 'outside.md'), 'OUTSIDE_CANARY')
    symlinkSync(join(dir, 'outside.md'), join(home, 'cache', 'documents', 'escape.md'))
    const response = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_media/messages?agent=private&view=wizard`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain('/opt/data')
    expect(text).not.toContain(dir)
    const rows = JSON.parse(text).data
    const envelopes = [...rows[0].content.matchAll(/<helm_attachments>(.*?)<\/helm_attachments>/gs)].map(match => JSON.parse(match[1]))
    const items = envelopes.flatMap(envelope => envelope.items)
    expect(items).toHaveLength(2)
    expect(items.map((i: any) => [i.name, i.kind])).toEqual(expect.arrayContaining([['notes.md', 'file'], ['chart.png', 'image']]))
    expect(envelopes.find(envelope => envelope.inline)?.items[0].name).toBe('chart.png')
    expect(rows[1].content).toContain('[file: escape.md unavailable]')
    expect(rows[1].content).toContain('[file: outside.md unavailable]')
    expect(rows[1].content).not.toContain('<helm_attachments>')
    // Bytes live in the agent's own folder, not the main agent's shared artifact store.
    expect(readdirSync(join(dir, 'agents', 'private', 'wizard-artifacts')).filter(n => n.endsWith('.bin')).length).toBe(2)
    const md = await fetch(`${base}/wizard/attachments/${items.find(item => item.kind === 'file').id}`)
    expect(md.status).toBe(200)
    expect(md.headers.get('content-disposition')).toContain('notes.md')
    expect(await md.text()).toContain('OUTBOUND_MD_CANARY')
    const image = await fetch(`${base}/wizard/attachments/${items.find(item => item.kind === 'image').id}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
  })

  it('reads a sandboxed agent\'s MEDIA file through the runtime as the agent and serves it', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const priv = await fakeHermes('private', ['wizard_private_sandbox'], [
      { id: 1, role: 'assistant', timestamp: 1, content: 'Report ready.\n\nMEDIA:/opt/data/cache/documents/report.md\nMEDIA:/opt/data/cache/documents/missing.md' },
    ])
    let report = Buffer.from('# SANDBOX_CANARY\n')
    const fetched: string[] = []
    const runtimeFetch = async (id: string, payload: any) => {
      fetched.push(`${id} ${payload.path}`)
      if (!payload.path.endsWith('report.md')) throw Object.assign(new Error('file_unavailable'), { code: 'file_unavailable' })
      return { verified: true, bytes: report.length, sha256: createHash('sha256').update(report).digest('hex'), data_base64: report.toString('base64') }
    }
    const { base } = await start(dir, main, { runtimeFetch })
    await withPrivate(dir, base, priv.port)
    const home = join(dir, 'agents', 'private', 'home')
    mkdirSync(home, { recursive: true })
    chmodSync(home, 0o000)   // owned by the sandbox uid in production: unreadable to the service
    try {
      for (let pass = 0; pass < 2; pass++) {
        const response = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_sandbox/messages?agent=private&view=wizard`)
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).not.toContain('/opt/data')
        const content = JSON.parse(text).data[0].content
        const envelope = JSON.parse(content.match(/<helm_attachments>(.*)<\/helm_attachments>/s)[1])
        expect(envelope.items.map((i: any) => i.name)).toEqual(['report.md'])
        expect(content).toContain('[file: missing.md unavailable]')
        const file = await fetch(`${base}/wizard/attachments/${envelope.items[0].id}`)
        expect(await file.text()).toBe('# SANDBOX_CANARY\n')
      }
      // Fetched once, then served from the mirror; a miss is not retried on every poll.
      expect(fetched).toEqual(['private /opt/data/cache/documents/report.md', 'private /opt/data/cache/documents/missing.md'])
      // The agent rewrites the same file and sends it again: a stale mirror is read again.
      report = Buffer.from('# SANDBOX_CANARY v2\n')
      const mirrored = join(dir, 'agents', 'private', 'wizard-artifacts', 'mirror', 'cache', 'documents', 'report.md')
      utimesSync(mirrored, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
      const again = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_sandbox/messages?agent=private&view=wizard`)
      const envelope = JSON.parse(JSON.parse(await again.text()).data[0].content.match(/<helm_attachments>(.*)<\/helm_attachments>/s)[1])
      expect(await (await fetch(`${base}/wizard/attachments/${envelope.items[0].id}`)).text()).toBe('# SANDBOX_CANARY v2\n')
    } finally { chmodSync(home, 0o700) }
  })

  it('tells routed agents how to send files and projects a finished run\'s MEDIA output', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const priv = await fakeHermes('private', ['wizard_private_run'])
    const { base } = await start(dir, main)
    await withPrivate(dir, base, priv.port)
    const run = await fetch(`${base}/wizard/hermes/v1/runs?agent=private`, json({ session_id: 'wizard_private_run', input: 'send it' }))
    expect(run.status).toBe(202)
    const sent = priv.seen.find(r => r.path === '/v1/runs')
    expect(sent?.body.instructions).toContain('MEDIA:/absolute/path')
    expect(sent?.body.instructions).toContain('Put each MEDIA line right after the sentence that talks about it; it shows there as a tappable picture.')
    const status = await fetch(`${base}/wizard/hermes/v1/runs/private-run-1?agent=private`)
    expect(status.status).toBe(200)
  })

  it('gives a text-only Tinfoil agent its allowed Tinfoil vision model as confidential eyes', () => {
    const agent: any = { id: 'private', privacy: 'private', model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3', 'deepseek-v4-1-flash'], fallback: false },
      permissions: { files: 'own', outside_tools: [], other_agents: 'none' }, apps: [], runtime: { kind: 'container' } }
    expect(agentVisionHelper(agent)).toBe('deepseek-v4-1-flash')
    const yaml = hermesConfigYaml(agent)
    expect(yaml).toContain("auxiliary:\n  vision:\n    provider: custom\n    model: \"deepseek-v4-1-flash\"\n    base_url: \"http://agent-private-tinfoil:3301/v1\"\n    key_env: TINFOIL_API_KEY")
    const disabled = yaml.match(/disabled_toolsets: \[(.*)\]/)[1]
    expect(disabled).not.toContain('"vision"')
    expect(disabled).toContain('"web"')
    // No vision model allowed, files off, or a vision main model: no helper, the public vision tool stays off.
    for (const change of [{ model: { ...agent.model, allowed_models: ['glm-5-3'] } }, { permissions: { ...agent.permissions, files: 'none' } }, { model: { ...agent.model, model: 'deepseek-v4-1-flash' } }]) {
      const other = { ...agent, ...change }
      expect(agentVisionHelper(other)).toBeNull()
      expect(hermesConfigYaml(other)).not.toContain('auxiliary:')
      expect(hermesConfigYaml(other).match(/disabled_toolsets: \[(.*)\]/)[1]).toContain('"vision"')
    }
  })

  it('lists the main agent and only schema-1 agent folders', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main)
    const list = await (await fetch(`${base}/wizard/v1/agents`)).json()
    expect(list.agents.map((a: any) => a.id)).toEqual(['hermes'])
    expect(list.agents[0]).toMatchObject({ is_default: true, harness: 'hermes', status: 'running' })
  })

  it('creates the Private agent: folder, harness config, no secrets in the response, runtime applied, idempotent', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base, calls } = await start(dir, main)
    const first = await withPrivate(dir, base)
    expect(first.status).toBe(201)
    expect(first.agent).toMatchObject({
      id: 'private', label: 'Private', harness: 'hermes', privacy: 'private', appearance: { glyph: 'lock', hue: 160 },
      model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3'], fallback: false },
      permissions: { preset: 'private', outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [], other_agents: 'none' },
      is_default: false,
    })
    expect(['starting', 'error', 'running']).toContain(first.agent.status)
    expect(calls).toEqual(['apply private'])
    const folder = join(dir, 'agents', 'private')
    const stored = JSON.parse(readFileSync(join(folder, 'agent.json'), 'utf8'))
    expect(stored).toMatchObject({ schema: 1, id: 'private', runtime: { kind: 'container', app_id: 'agent-private', api: 'http://agent-private:8642', port: 47650 } })
    const key = readFileSync(join(folder, 'runtime.key'), 'utf8').trim()
    expect(key.length).toBeGreaterThan(30)
    const env = readFileSync(join(folder, 'home', '.env'), 'utf8')
    expect(env).toContain(`API_SERVER_KEY=${key}`)
    expect(env).not.toContain('TINFOIL_API_KEY')
    const config = readFileSync(join(folder, 'home', 'config.yaml'), 'utf8')
    expect(config).toContain('base_url: "http://agent-private-tinfoil:3301/v1"')
    expect(config).toContain('fallback_providers: []')
    for (const tool of ['web', 'browser', 'image_gen', 'tts', 'vision', 'delegation', 'x_search']) expect(config).toContain(`"${tool}"`)
    expect(config).toContain('mcp_servers: {}')
    const text = JSON.stringify(first.agent)
    expect(text).not.toContain(key)
    expect(text).not.toContain(dir)
    // Same key + same body replays; same key + other body is refused.
    const replay = await withPrivate(dir, base)
    expect(replay.status).toBe(200)
    expect(calls).toEqual(['apply private'])
    const reused = await fetch(`${base}/wizard/v1/agents`, json({ ...PRIVATE, label: 'Other' }, { 'Idempotency-Key': 'create-private-1' }))
    expect(reused.status).toBe(409)
    expect(await reused.json()).toMatchObject({ check: 'agent.idempotency_key' })
    const list = await (await fetch(`${base}/wizard/v1/agents`)).json()
    expect(list.agents.map((a: any) => a.id)).toEqual(['hermes', 'private'])
  })

  it('refuses a public provider for a private agent, on create and on edit, naming the check', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main)
    const bad = await fetch(`${base}/wizard/v1/agents`, json({ ...PRIVATE, model: { provider: 'anthropic', model: 'claude-opus-5-5' } }))
    expect(bad.status).toBe(409)
    expect(await bad.json()).toMatchObject({ error: 'confidential_provider_required', check: 'agent.confidential_provider' })
    await withPrivate(dir, base)
    const patch = await fetch(`${base}/wizard/v1/agents/private`, { ...json({ model: { provider: 'anthropic', model: 'claude-opus-5-5' } }), method: 'PATCH' })
    expect(patch.status).toBe(409)
    expect(await patch.json()).toMatchObject({ check: 'agent.confidential_provider' })
    const fallback = await fetch(`${base}/wizard/v1/agents/private`, { ...json({ model: { provider: 'tinfoil', model: 'glm-5-3', fallback: true } }), method: 'PATCH' })
    expect(fallback.status).toBe(409)
    expect(await fallback.json()).toMatchObject({ check: 'agent.fallback' })
    const unknown = await fetch(`${base}/wizard/v1/agents/private`, { ...json({ model: { provider: 'tinfoil', model: 'gpt-6.1-sol' } }), method: 'PATCH' })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ check: 'agent.model.model' })
  })

  it('edits permissions any time and rewrites the harness config', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base, calls } = await start(dir, main)
    await withPrivate(dir, base)
    const patch = await fetch(`${base}/wizard/v1/agents/private`, { ...json({ label: 'Vault', appearance: { glyph: 'key', hue: 30 }, permissions: { outside_tools: ['web'], wizard_apps: ['meditate'], agent_apps: ['transcriber'], files: 'shared-read' } }), method: 'PATCH' })
    expect(patch.status).toBe(200)
    const { agent } = await patch.json()
    expect(agent).toMatchObject({ label: 'Vault', appearance: { glyph: 'key', hue: 30 }, privacy: 'private', permissions: { preset: 'private', outside_tools: ['web'], wizard_apps: ['meditate'], agent_apps: ['transcriber'], files: 'shared-read' } })
    const config = readFileSync(join(dir, 'agents', 'private', 'home', 'config.yaml'), 'utf8')
    expect(config).not.toMatch(/disabled_toolsets: \[[^\]]*"web"/)
    expect(config).toMatch(/disabled_toolsets: \[[^\]]*"browser"/)
    expect(calls).toEqual(['apply private', 'apply private'])
    const badTool = await fetch(`${base}/wizard/v1/agents/private`, { ...json({ permissions: { outside_tools: ['rm-rf'] } }), method: 'PATCH' })
    expect(await badTool.json()).toMatchObject({ check: 'agent.permissions.outside_tools' })
    const preset = await fetch(`${base}/wizard/v1/agents/private`, { ...json({ permissions: { preset: 'standard' } }), method: 'PATCH' })
    expect(preset.status).toBe(409)
    const mainEdit = await fetch(`${base}/wizard/v1/agents/hermes`, { ...json({ label: 'x' }), method: 'PATCH' })
    expect(await mainEdit.json()).toMatchObject({ check: 'agent.main' })
    const stop = await fetch(`${base}/wizard/v1/agents/private/stop`, json({}))
    expect(stop.status).toBe(202)
    expect((await stop.json()).agent.status).toBe('stopped')
    expect(calls.at(-1)).toBe('stop private')
  })

  it('an unchanged update re-applies only a config an older release wrote, not one Hermes normalised', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base, calls } = await start(dir, main)
    await withPrivate(dir, base)
    const same = () => fetch(`${base}/wizard/v1/agents/private`, { ...json({ label: 'Private' }), method: 'PATCH' })
    const applies = () => calls.filter((c: string) => c === 'apply private').length
    const before = applies()
    writeFileSync(join(dir, 'agents', 'private', 'home', 'config.yaml'), '# normalised by Hermes on start\n')
    expect((await same()).status).toBe(200)
    expect(applies()).toBe(before)                     // Hermes rewriting its own file is not stale
    rmSync(join(dir, 'agents', 'private', 'config.sha256'))   // a release before the stamp, or a changed generator
    expect((await same()).status).toBe(200)
    expect(applies()).toBe(before + 1)
    expect((await same()).status).toBe(200)
    expect(applies()).toBe(before + 1)
  })

  it('agent options: harnesses, Tinfoil plus signed-in AI Accounts providers, presets, Wizard apps vs agent apps', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main)
    const options = await (await fetch(`${base}/wizard/v1/agent-options`)).json()
    expect(options.harnesses).toEqual([{ id: 'hermes', label: 'Hermes' }])
    expect(options.providers.map((p: any) => [p.id, p.confidential])).toEqual([['tinfoil', true], ['anthropic', false], ['openai-codex', false]])
    expect(options.providers[0].models).toEqual([{ id: 'glm-5-3', label: 'GLM 5.3', images: false }, { id: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash', images: true }])
    expect(options.presets.map((p: any) => p.id)).toEqual(['private', 'standard'])
    expect(options.wizard_apps.map((a: any) => a.id)).toEqual(['meditate'])
    expect(options.agent_apps.map((a: any) => a.id)).toEqual(['transcriber'])
    expect(options.outside_tools.map((t: any) => t.id)).toContain('web')
  })

  it('writes need JSON (CSRF floor)', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main)
    const form = await fetch(`${base}/wizard/v1/agents`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'label=x' })
    expect(form.status).toBe(415)
  })
})

describe('per-agent threads and runs', () => {
  it('projects private-agent startup context from received text without forwarding view', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const original = '[Wizard follow-through] Please finish the original request.'
    const priv = await fakeHermes('private', ['wizard_private_context'], [{ id: 4, role: 'user', timestamp: 42, content: original + '\n[WIZARD_STATUS_V1] {"state":"done"}\nprivate-tail' }])
    const { base } = await start(dir, main)
    await withPrivate(dir, base, priv.port)
    const response = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_context/messages?agent=private&view=wizard`)
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.data[0]).toMatchObject({ id: 4, timestamp: 42, content: '', role: 'system', display_kind: 'run_context', run_context: { original, redacted: true, kind: 'continuation' } })
    expect(JSON.stringify(payload)).not.toContain('private-tail')
    expect(priv.seen.find(s => s.path.includes('/messages'))?.path).toBe('/api/sessions/wizard_private_context/messages')
  })

  it('routes a private run to the private Hermes only, pins the thread, and never touches the main Hermes', async () => {
    const dir = box()
    const main = await fakeHermes('main', ['wizard_main_1'])
    const priv = await fakeHermes('private')
    const { base } = await start(dir, main)
    await withPrivate(dir, base, priv.port)
    const key = readFileSync(join(dir, 'agents', 'private', 'runtime.key'), 'utf8').trim()
    const mainBefore = main.seen.length
    const run = await fetch(`${base}/wizard/hermes/v1/runs?agent=private`, json({ session_id: 'wizard_private_1', input: 'secret plan', agent: 'private' }))
    expect(run.status).toBe(202)
    expect(run.headers.get('x-wizard-agent')).toBe('private')
    expect((await run.json()).run_id).toBe('private-run-1')
    const sent = priv.seen.find((s) => s.path === '/v1/runs')!
    expect(sent.auth).toBe(`Bearer ${key}`)
    expect(sent.body.input).toBe('secret plan')
    expect(sent.body.agent).toBeUndefined()
    expect(sent.body.instructions).toContain('separate agent')
    expect(sent.body.delegation_delivery).toBeUndefined()
    // Only the pin check reached the main Hermes (does main already have this thread?), never the content.
    const mainNew = main.seen.slice(mainBefore)
    expect(mainNew.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /api/sessions/wizard_private_1'])
    expect(JSON.stringify(main.seen)).not.toContain('secret plan')
    // The thread is pinned to the private agent: read through its own Chats (agent named); by id alone it is sealed
    // (#59); naming the main agent is refused.
    const sealedRead = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_1/messages`)
    expect(sealedRead.status).toBe(409)
    expect(await sealedRead.json()).toMatchObject({ check: 'agent.private_sealed' })
    const messages = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_1/messages?agent=private`)
    expect(await messages.json()).toMatchObject({ data: [{ content: 'private says hi' }] })
    const swap = await fetch(`${base}/wizard/hermes/v1/runs?agent=hermes`, json({ session_id: 'wizard_private_1', input: 'x' }))
    expect(swap.status).toBe(409)
    expect(await swap.json()).toMatchObject({ error: 'thread_agent_pinned', check: 'thread.agent_pinned' })
    // A main thread cannot be continued under the private agent either.
    const steal = await fetch(`${base}/wizard/hermes/v1/runs?agent=private`, json({ session_id: 'wizard_main_1', input: 'x' }))
    expect(steal.status).toBe(409)
    expect(await steal.json()).toMatchObject({ check: 'thread.agent_pinned' })
    // Run status for the private run id goes to the private Hermes.
    const status = await fetch(`${base}/wizard/hermes/v1/runs/private-run-1`)
    expect((await status.json()).output).toBe('private done')
    expect(JSON.stringify(main.seen)).not.toContain('private-run-1')
  })

  it('rejects a model outside allowed_models server-side and shows only allowed models', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const priv = await fakeHermes('private')
    const { base } = await start(dir, main)
    await withPrivate(dir, base, priv.port)
    for (const body of [
      { session_id: 'wizard_private_2', input: 'x', model: 'claude-opus-5-5' },
      { session_id: 'wizard_private_2', input: 'x', model: 'anthropic/claude-opus-5-5' },
      { session_id: 'wizard_private_2', input: 'x', model: 'glm-5-3', provider: 'anthropic' },
    ]) {
      const refused = await fetch(`${base}/wizard/hermes/v1/runs?agent=private`, json(body))
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ error: 'model_not_allowed', check: 'agent.allowed_models' })
    }
    const switchModel = await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_2/model?agent=private`, json({ model: 'gpt-6.1-sol', provider: 'openai-codex' }))
    expect(switchModel.status).toBe(409)
    expect(priv.seen.filter((s) => s.method === 'POST')).toEqual([])
    const ok = await fetch(`${base}/wizard/hermes/v1/runs?agent=private`, json({ session_id: 'wizard_private_2', input: 'x', model: 'tinfoil/glm-5-3' }))
    expect(ok.status).toBe(202)
    expect(priv.seen.find((s) => s.path === '/v1/runs')!.body.model).toBeUndefined()
    const options = await (await fetch(`${base}/wizard/hermes/api/model/options?agent=private`)).json()
    expect(options.providers).toEqual([expect.objectContaining({ slug: 'tinfoil', models: ['glm-5-3'] })])
  })

  it('thread lists carry the server-side agent; each agent lists only its own threads', async () => {
    const dir = box()
    const main = await fakeHermes('main', ['wizard_main_1'])
    const priv = await fakeHermes('private', ['wizard_private_9', 'cron_job_1'])
    const { base } = await start(dir, main)
    await withPrivate(dir, base, priv.port)
    const privateList = await (await fetch(`${base}/wizard/hermes/api/sessions?agent=private`)).json()
    expect(privateList.data.map((s: any) => s.id)).toEqual(['wizard_private_9'])   // internal sessions hidden like the main list
    expect(privateList.data[0].agent).toEqual({ id: 'private', label: 'Private', privacy: 'private', appearance: { glyph: 'lock', hue: 160 } })
    const mainList = await (await fetch(`${base}/wizard/hermes/api/sessions`)).json()
    const ids = (mainList.data ?? mainList.sessions).map((s: any) => s.id)
    expect(ids).toContain('wizard_main_1')
    expect(ids).not.toContain('wizard_private_9')
    expect((mainList.data ?? mainList.sessions)[0].agent).toMatchObject({ id: 'hermes', privacy: 'standard' })
    const unknown = await fetch(`${base}/wizard/hermes/api/sessions?agent=nobody`)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ check: 'agent.id' })
  })

  it('projects same-id follow-up watchers only inside their owning agent list', async () => {
    const dir = box()
    const main = await fakeHermes('main', ['wizard_shared'])
    const priv = await fakeHermes('private', ['wizard_shared'])
    const { base, server } = await start(dir, main, { schedulerStatePath: join(dir, 'schedules.sqlite3') })
    await withPrivate(dir, base, priv.port)
    server.scheduler.create({ name: 'Main dependency', kind: 'watch', when: { every: 5 }, prompt: 'Check main.', thread: 'wizard_shared', agent: 'main' })
    server.scheduler.create({ name: 'Private dependency', kind: 'watch', when: { every: 5 }, prompt: 'Check private.', thread: 'wizard_shared', agent: 'private' })

    const mainList = await (await fetch(`${base}/wizard/hermes/api/sessions`)).json()
    const mainRow = (mainList.data ?? mainList.sessions).find((row: any) => row.id === 'wizard_shared')
    expect(mainRow.wizard_follow_up).toMatchObject({ active: true, count: 1, names: ['Main dependency'] })

    const privateList = await (await fetch(`${base}/wizard/hermes/api/sessions?agent=private`)).json()
    const privateRow = privateList.data.find((row: any) => row.id === 'wizard_shared')
    expect(privateRow.wizard_follow_up).toMatchObject({ active: true, count: 1, names: ['Private dependency'] })
  })

  it('delivers a routed watcher only through its owning agent and restores that same routed thread', async () => {
    const dir = box()
    const main = await fakeHermes('main', ['wizard_shared'])
    const priv = await fakeHermes('private', ['wizard_shared'])
    priv.rows.get('wizard_shared')!.archived = true
    const { base, server } = await start(dir, main, { schedulerStatePath: join(dir, 'schedules.sqlite3'), runQueueStatePath: join(dir, 'queue.sqlite3'), runQueuePollIntervalMs: 20 })
    await withPrivate(dir, base, priv.port)
    const watch = server.scheduler.create({ name: 'Private result', kind: 'watch', when: { every: 5 }, prompt: 'Check private.', thread: 'wizard_shared', agent: 'private' })
    server.scheduler.runNow(watch.id); await server.scheduler.tick(false)
    expect(priv.seen.some((row) => row.method === 'POST' && row.path === '/v1/runs')).toBe(true)
    expect(main.seen.some((row) => row.method === 'POST' && row.path === '/v1/runs')).toBe(false)
    for (let i = 0; i < 100 && server.scheduler.get(watch.id).enabled; i++) {
      await new Promise(resolve => setTimeout(resolve, 20)); await server.scheduler.refreshRuns()
    }
    expect(server.scheduler.get(watch.id).enabled).toBe(false)
    expect(priv.rows.get('wizard_shared')!.archived).toBe(false)
    expect(priv.seen.filter((row) => row.method === 'PATCH' && row.path === '/api/sessions/wizard_shared').map(row => row.body.archived)).toEqual([true, true, false]) // Original and one Reporter rewrite stay hidden; only the final result resurfaces.
    expect(main.seen.some((row) => row.method === 'PATCH' && row.path === '/api/sessions/wizard_shared')).toBe(false)
  })

  it('recap delivery: token required, goes through the runtime into the agent, pins the thread', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const priv = await fakeHermes('private')
    const { base, deliveries } = await start(dir, main)
    await withPrivate(dir, base, priv.port)
    const payload = { session_id: 'wizard_private_recording_abc', title: 'Recording · Call', body: 'recap', delivery_key: 'private-recording:r1' }
    const anonymous = await fetch(`${base}/wizard/v1/agents/private/deliveries`, json(payload))
    expect(anonymous.status).toBe(403)
    const missing = await fetch(`${base}/wizard/v1/agents/nobody/deliveries`, json(payload, { Authorization: 'Bearer delivery-token-0123456789abcdef' }))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: 'agent_not_found' })
    const ok = await fetch(`${base}/wizard/v1/agents/private/deliveries`, json(payload, { Authorization: 'Bearer delivery-token-0123456789abcdef' }))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ verified: true, session_id: 'wizard_private_recording_abc', agent: { id: 'private' } })
    expect(deliveries).toEqual([{ id: 'private', payload }])
    await fetch(`${base}/wizard/hermes/api/sessions/wizard_private_recording_abc/messages?agent=private`)
    expect(priv.seen.some((s) => s.path.startsWith('/api/sessions/wizard_private_recording_abc/messages'))).toBe(true)
    expect(main.seen.some((s) => s.path.includes('wizard_private_recording_abc'))).toBe(false)
  })
})

describe('agent folder parsing and harness config', () => {
  it('ignores folders that are not schema-1 agents', () => {
    expect(parseAgentFile({ schema: 2, id: 'x' }, 'x')).toBeNull()
    expect(parseAgentFile({ schema: 1, id: 'hermes', harness: 'hermes' }, 'hermes')).toBeNull()
    expect(parseAgentFile(null, 'claude-explore')).toBeNull()
  })

  it('standard agents keep outside tools; files none turns file tools off', () => {
    const base = { id: 'a', model: { provider: 'anthropic', model: 'claude-opus-5-5', allowed_models: ['claude-opus-5-5'], fallback: true }, permissions: { outside_tools: ['web', 'browser'], files: 'none', wizard_apps: ['meditate'], agent_apps: [] } }
    const text = hermesConfigYaml(base)
    expect(text).toContain('provider: "claude-subscription-directsdk-experimental"')
    expect(text).not.toContain('fallback_providers')
    expect(text).toMatch(/disabled_toolsets: \[[^\]]*"terminal"/)
    expect(text).not.toMatch(/disabled_toolsets: \[[^\]]*"web"/)
    expect(text).not.toContain('mcp_servers: {}')
  })

  it('pins supported secret redaction only in restricted standard Claude harnesses', () => {
    const base = { id: 'a', privacy: 'standard', runtime: { isolation: 'restricted' },
      model: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: false },
      permissions: { outside_tools: [], files: 'none', wizard_apps: [], agent_apps: [] } }
    expect(hermesConfigYaml(base)).toContain('security:\n  redact_secrets: true')
    for (const changes of [{ privacy: 'private' }, { privacy: 'unknown' }, { runtime: {} },
      { model: { ...base.model, provider: 'local' } }]) {
      expect(hermesConfigYaml({ ...base, ...changes })).not.toContain('redact_secrets:')
    }
  })

  it('raised memory budgets reach the harness config; out-of-range budgets are refused', () => {
    const base = { id: 'a', memory: { user_chars: 6000 }, model: { provider: 'anthropic', model: 'claude-fable-5-1', allowed_models: ['claude-fable-5-1'], fallback: false }, permissions: { outside_tools: [], files: 'none', wizard_apps: [], agent_apps: [] } }
    const text = hermesConfigYaml(base)
    expect(text).toContain('user_char_limit: 6000')
    expect(text).not.toContain('memory_char_limit')
    expect(text).toContain('fallback_providers: []')
    expect(normalizeMemory({ user_chars: 6000 })).toEqual({ user_chars: 6000 })
    expect(() => normalizeMemory({ user_chars: 99999 })).toThrow()
    expect(() => normalizeMemory({ other: 1 })).toThrow()
    expect(claudeModelId('claude-fable-5.1')).toBe('claude-fable-5-1')
  })

  it('agent containers never get a launcher tile', () => {
    const dir = box()
    const apps = readApps({ appsJsonPath: join(dir, 'apps.json'), launcherPath: join(dir, 'none.json') }).apps.map((a: any) => a.id)
    expect(apps).toContain('meditate')
    expect(apps).not.toContain('agent-old')
    expect(existsSync(join(dir, 'agents', 'claude-explore', 'notes.json'))).toBe(true)
  })
})

function historyFixture(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,source TEXT,parent_session_id TEXT,hidden INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
    CREATE VIRTUAL TABLE messages_fts USING fts5(content,content='messages',content_rowid='id');`)
  const add = (id: string, hidden: number, source: string, text: string) => {
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(id,id,source,null,hidden)
    db.prepare("INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,'user',?,1)").run(id,text)
  }
  add('standard',0,'wizard-mobile','roundtwo mango lighthouse')
  add('hidden_probe',1,'wizard-mobile','roundtwo hidden mango')
  add('cron_noise',0,'cron','roundtwo cron mango')
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
  db.close()
}

describe('same-origin hosted Agents app',()=>{
  it('permits only the nested app document to be framed; the shell stays DENY',async()=>{
    const ux=mkdtempSync(join(tmpdir(),'was-ux-frame-'));mkdirSync(join(ux,'agents'))
    writeFileSync(join(ux,'index.html'),'<!doctype html>shell');writeFileSync(join(ux,'agents','index.html'),'<!doctype html>agents')
      const main=await fakeHermes('main'),{base}=await start(box(),main,{uxDir:ux})
      const outer=await fetch(base+'/wizard-os-home/'),inner=await fetch(base+'/wizard-os-home/agents/index.html')
      expect(outer.status).toBe(200);expect(outer.headers.get('x-frame-options')).toBe('DENY')
      expect(outer.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(inner.status).toBe(200);expect(inner.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(inner.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")

  })
})

describe('private round 2: read-only standard retrieval, private search and deletion', () => {
  it('FTS excludes hidden and cron noise by default; hidden opt-in supports probes; read is bounded', () => {
    const path = join(box(),'standard.db'); historyFixture(path)
    expect(searchHistory(path,'roundtwo').map((r: any)=>r.session_id)).toEqual(['standard'])
    expect(searchHistory(path,'roundtwo',{include_hidden:true}).map((r: any)=>r.session_id).sort()).toEqual(['hidden_probe','standard'])
    expect(searchHistory(path,'" OR content:*')).toEqual([])
    expect(() => searchHistory(path,'x'.repeat(301))).toThrow()
    expect(readHistory(path,'standard',{limit:1}).messages[0].content).toContain('lighthouse')
    expect(() => readHistory(path,'cron_noise')).toThrow()
    expect(() => readHistory(path,'../../private')).toThrow()
  })
  it('rejects owner, standard agents, and private agents without the explicit permission', () => {
    const rpc={jsonrpc:'2.0',id:1,method:'tools/list'}
    const agent={id:'private',privacy:'private',permissions:{read_standard_chats:true}}
    expect(() => standardChatRpc(agent,{kind:'owner'},rpc,'')).toThrow()
    expect(() => standardChatRpc({...agent,privacy:'standard'},{kind:'agent',agentId:'private'},rpc,'')).toThrow()
    expect(() => standardChatRpc({...agent,permissions:{}},{kind:'agent',agentId:'private'},rpc,'')).toThrow()
    expect(() => standardChatRpc(agent,{kind:'agent',agentId:'other'},rpc,'')).toThrow()
    const result: any=standardChatRpc(agent,{kind:'agent',agentId:'private'},rpc,'')
    expect(result.result.tools.map((t: any)=>t.name)).toEqual(['standard_chats_search','standard_chat_read','standard_memory_read'])
    expect(result.result.tools.every((t: any)=>!t.name.includes('write'))).toBe(true)
  })
  it('owner switch generates a stock MCP config; agent token reads; immediate revocation blocks cached calls', async () => {
    const dir=box(), main=await fakeHermes('main'), path=join(dir,'standard.db'); historyFixture(path)
    const {base}=await start(dir,main,{hermesStatePath:path,agentGatewayUrl:'http://gateway:8923/wizard/mcp'})
    const {agent}=await withPrivate(dir,base)
    const call=(headers: Record<string,string>={})=>fetch(base+'/wizard/standard-chats/mcp',json({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'standard_chats_search',arguments:{query:'lighthouse'}}},headers))
    expect((await call()).status).toBe(403)
    const token=readFileSync(join(dir,'agents',agent.id,'gateway.key'),'utf8').trim()
    expect((await call({Authorization:`Bearer ${token}`})).status).toBe(403)
    const patchAccess=(enabled: unknown)=>fetch(`${base}/wizard/v1/agents/${agent.id}`,{...json({permissions:{read_standard_chats:enabled}}),method:'PATCH'})
    expect((await patchAccess('true')).status).toBe(400)
    expect((await patchAccess(true)).status).toBe(200)
    const config=readFileSync(join(dir,'agents',agent.id,'home','config.yaml'),'utf8')
    expect(config).toContain('standard_chats:')
    expect(config).toContain('http://gateway:8923/wizard/standard-chats/mcp')
    expect(config).not.toContain(token)
    expect(config).toContain('  wizard:') // own Spaces are available without ticking apps
    const reply=await call({Authorization:`Bearer ${token}`})
    expect(reply.status).toBe(200)
    expect(JSON.stringify(await reply.json())).toContain('lighthouse')
    expect((await patchAccess(false)).status).toBe(200)
    expect((await call({Authorization:`Bearer ${token}`})).status).toBe(403)
    expect(readFileSync(join(dir,'agents',agent.id,'home','config.yaml'),'utf8')).not.toContain('standard_chats:')
  })
  it('guards standard history and memory against service and agent credential disclosure', async () => {
    const dir=box(),main=await fakeHermes('main'),path=join(dir,'state.db');historyFixture(path)
    const {base}=await start(dir,main,{hermesStatePath:path,agentGatewayUrl:'http://gateway:8923/wizard/mcp'})
    const {agent}=await withPrivate(dir,base)
    const token=readFileSync(join(dir,'agents',agent.id,'gateway.key'),'utf8').trim()
    await fetch(`${base}/wizard/v1/agents/${agent.id}`,{...json({permissions:{read_standard_chats:true}}),method:'PATCH'})
    const db=new DatabaseSync(path);db.prepare("UPDATE messages SET content=? WHERE session_id='standard'").run('lighthouse '+token+' fixture-key');db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");db.close()
    mkdirSync(join(dir,'memories'));writeFileSync(join(dir,'memories','MEMORY.md'),'fixture-key')
    const call=(name: string,args: any)=>fetch(base+'/wizard/standard-chats/mcp',json({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{Authorization:`Bearer ${token}`}))
    for(const [name,args] of [['standard_chats_search',{query:'lighthouse'}],['standard_chat_read',{session_id:'standard'}],['standard_memory_read',{name:'MEMORY.md'}]] as const) {
      const result=await(await call(name,args)).json();expect(result.result.isError).toBe(false);expect(JSON.stringify(result)).not.toContain(token);expect(JSON.stringify(result)).not.toContain('fixture-key')
      const payload=JSON.parse(result.result.content[0].text)
      if(name==='standard_chats_search')expect(payload.results).toEqual([])
      else expect(JSON.stringify(payload)).toContain('[redacted')
    }
    // A full credential spanning the 8k read / 24k memory boundary cannot leak a prefix.
    const alter=new DatabaseSync(path);alter.prepare("UPDATE messages SET content=? WHERE session_id='standard'").run('x'.repeat(7980)+token+' lighthouse');alter.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");alter.close()
    writeFileSync(join(dir,'memories','MEMORY.md'),'x'.repeat(23980)+token+' tail')
    const readResult=await(await call('standard_chat_read',{session_id:'standard'})).json()
    expect(JSON.stringify(readResult)).not.toContain(token.slice(0,16))
    const memoryResult=await(await call('standard_memory_read',{name:'MEMORY.md'})).json()
    expect(JSON.stringify(memoryResult)).not.toContain(token.slice(0,16))
    // Multibyte input must not expose an unfinished key in the overread tail.
    writeFileSync(join(dir,'memories','MEMORY.md'),'€'.repeat(8000)+'x'.repeat(Buffer.byteLength(token)-10)+token)
    const unicodeResult=await(await call('standard_memory_read',{name:'MEMORY.md'})).json()
    expect(JSON.stringify(unicodeResult)).not.toContain(token.slice(0,8))
    expect(JSON.parse(unicodeResult.result.content[0].text).text).toBe('€'.repeat(8000))
    const prefixResult=await(await call('standard_chats_search',{query:token.slice(0,8)+'*'})).json()
    expect(JSON.parse(prefixResult.result.content[0].text).results).toEqual([])
    const malformed=await fetch(base+'/wizard/standard-chats/mcp',json({jsonrpc:'2.0',id:1,method:7},{Authorization:`Bearer ${token}`}))
    expect((await malformed.json()).error.code).toBe(-32600)
  })
  it('dedicated read-only transport works with app gateway entirely unset',async()=>{
    const dir=box(),main=await fakeHermes('main'),{base}=await start(dir,main,{standardChatsUrl:'http://readonly-relay:18986/wizard/standard-chats/mcp'})
    const created=await fetch(base+'/wizard/v1/agents',json({...PRIVATE,permissions:{preset:'private',read_standard_chats:true}}))
    expect(created.status).toBe(201)
    const config=readFileSync(join(dir,'agents','private','home','config.yaml'),'utf8')
    expect(config).toContain('http://readonly-relay:18986/wizard/standard-chats/mcp');expect(config).not.toContain('  wizard:') // no app gateway URL configured
    expect(readFileSync(join(dir,'agents','private','home','.env'),'utf8')).toContain('WIZARD_MCP_TOKEN=')
    const standard=await(await fetch(base+'/wizard/v1/agents',json({label:'Ordinary',model:{provider:'anthropic',model:'claude-opus-5-5'}}))).json()
    expect(readFileSync(join(dir,'agents',standard.agent.id,'home','.env'),'utf8')).not.toContain('WIZARD_MCP_TOKEN=')
    expect(readFileSync(join(dir,'agents',standard.agent.id,'home','config.yaml'),'utf8')).not.toContain('readonly-relay')
  })
  it('private agents read standard chats by default when the transport exists; explicit false wins; none without transport',async()=>{
    const dir=box(),main=await fakeHermes('main'),{base}=await start(dir,main,{standardChatsUrl:'http://readonly-relay:18986/wizard/standard-chats/mcp'})
    const on=await(await fetch(base+'/wizard/v1/agents',json({...PRIVATE,permissions:{preset:'private'}}))).json()
    expect(on.agent.permissions.read_standard_chats).toBe(true)
    const off=await(await fetch(base+'/wizard/v1/agents',json({...PRIVATE,label:'Diary',permissions:{preset:'private',read_standard_chats:false}}))).json()
    expect(off.agent.permissions.read_standard_chats).toBe(false)
    const std=await(await fetch(base+'/wizard/v1/agents',json({label:'Ordinary',model:{provider:'anthropic',model:'claude-opus-5-5'}}))).json()
    expect(std.agent.permissions.read_standard_chats).toBe(false)
    const dir2=box(),main2=await fakeHermes('main'),{base:base2}=await start(dir2,main2)
    const bare=await fetch(base2+'/wizard/v1/agents',json({...PRIVATE,permissions:{preset:'private'}}))
    expect(bare.status).toBe(201);expect((await bare.json()).agent.permissions.read_standard_chats).toBe(false)
  })
  it('refuses a nonfunctional grant before persisting when no retrieval transport is configured',async()=>{
    const dir=box(),main=await fakeHermes('main'),{base}=await start(dir,main);await withPrivate(dir,base)
    const result=await fetch(base+'/wizard/v1/agents/private',{...json({permissions:{read_standard_chats:true}}),method:'PATCH'})
    expect(result.status).toBe(409);expect((await result.json()).error).toBe('standard_chats_unconfigured')
    expect(JSON.parse(readFileSync(join(dir,'agents','private','agent.json'),'utf8')).permissions.read_standard_chats).toBe(false)
  })
  it('never enables the permission for a standard agent', async () => {
    const main=await fakeHermes('main'),{base}=await start(box(),main)
    const r=await fetch(base+'/wizard/v1/agents',json({label:'Standard',model:{provider:'anthropic',model:'claude-opus-5-5'},permissions:{preset:'standard',read_standard_chats:true}}))
    expect(r.status).toBe(409)
    expect((await r.json()).check).toBe('agent.permissions.read_standard_chats')
  })
  it('owner deletes an explicitly named private thread without reading it; subsequent GET is 404', async () => {
    const dir=box(),main=await fakeHermes('main'),privateApi=await fakeHermes('private',['private_delete'])
    const {base}=await start(dir,main);await withPrivate(dir,base,privateApi.port)
    const path='/wizard/hermes/api/sessions/private_delete?agent=private'
    for(const method of ['GET','HEAD','DELETE','PATCH','POST']) {
      const init: RequestInit = ['PATCH','POST'].includes(method) ? {...json({title:'not applied'}),method} : {method}
      expect((await fetch(base+path.replace('?agent=private',''),init)).status).toBe(409)
    }
    expect((await fetch(base+path,{method:'DELETE'})).status).toBe(200)
    expect((await fetch(base+path)).status).toBe(404)
    expect(privateApi.seen.filter(r=>r.method==='DELETE')).toHaveLength(1)
    expect(main.seen.filter(r=>r.method==='DELETE')).toHaveLength(0)
    const token=readFileSync(join(dir,'agents','private','gateway.key'),'utf8').trim()
    expect((await fetch(base+path,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})).status).toBe(403)
  })
  it('never persists a private transcript-derived fingerprint, even from an older owner client',async()=>{
    const dir=box(),file=join(dir,'seen.json'),main=await fakeHermes('main'),privateApi=await fakeHermes('private',['private_seen'])
    const {base}=await start(dir,main,{threadSeenStatePath:file});await withPrivate(dir,base,privateApi.port)
    const key='agent/private/direct:private_seen',now=Date.now()
    const result=await fetch(base+'/wizard/thread-seen',{...json({schema:1,initializedAt:now,threads:{[key]:{seenAt:now,assistantActivityAt:new Date(now).toISOString(),messageCount:2,updatedAt:new Date(now).toISOString(),previewFingerprint:'transcript-derived-hash',agent_id:'private',session_id:'private_seen'}}}),method:'PUT'})
    expect(result.status).toBe(200);expect((await result.json()).state.threads[key].previewFingerprint).toBe('private')
    expect(readFileSync(file,'utf8')).not.toContain('transcript-derived-hash')
    expect((await(await fetch(base+'/wizard/thread-seen')).json()).state.threads[key].previewFingerprint).toBe('private')
  })
  it('private FTS uses only its own database and excludes hidden probes', () => {
    const dir=box(),home=join(dir,'agents','private','home');mkdirSync(home,{recursive:true});historyFixture(join(home,'state.db'))
    const matches=privateChatMatches(join(dir,'agents'),'private','mango lighthouse')
    expect([...matches.keys()]).toEqual(['standard'])
    expect(matches.has('hidden_probe')).toBe(false)
    expect(privateChatMatches(join(dir,'agents'),'missing','mango')).toBe(null)
  })
})
