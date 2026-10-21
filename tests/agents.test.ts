import { DatabaseSync } from 'node:sqlite'
import { standardChatRpc, searchHistory, readHistory } from '../server/standard-chats.mjs'
import { privateChatMatches } from '../server/private-chat-search.mjs'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { claudeModelId, hermesConfigYaml, normalizeMemory, parseAgentFile } from '../server/agents.mjs'
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
async function fakeHermes(name: string, sessions: string[] = [], messages?: unknown[]) {
  const seen: Seen[] = []
  const known = new Set(sessions)
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
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, { data: [...known].map((id) => ({ id, title: `${name} ${id}`, source: 'api_server' })) })
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'DELETE' && sessionMatch) return known.delete(decodeURIComponent(sessionMatch[1])) ? json(200,{ok:true}) : json(404,{error:'not found'})
    if (req.method === 'GET' && sessionMatch) return known.has(decodeURIComponent(sessionMatch[1])) ? json(200, { session: { id: decodeURIComponent(sessionMatch[1]), title: name } }) : json(404, { error: 'not found' })
    if (req.method === 'GET' && /\/messages$/.test(url.pathname)) return json(200, { data: messages ?? [{ role: 'assistant', content: `${name} says hi` }] })
    if (req.method === 'POST' && url.pathname === '/api/sessions') { known.add(body?.id ?? 'generated_1'); return json(201, { session: { id: body?.id ?? 'generated_1' } }) }
    if (req.method === 'POST' && url.pathname === '/v1/runs') { known.add(body.session_id); return json(202, { run_id: `${name}-run-1`, status: 'started' }) }
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) return json(200, { run_id: url.pathname.split('/').at(-1), status: 'completed', output: `${name} done` })
    json(404, { error: 'nope' })
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { port: address.port, origin: `http://127.0.0.1:${address.port}`, seen, known }
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
    apply: async (id: string) => { calls.push(`apply ${id}`); return { ok: true } },
    start: async (id: string) => { calls.push(`start ${id}`); return { ok: true } },
    stop: async (id: string) => { calls.push(`stop ${id}`); return { ok: true } },
    deliver: async (id: string, payload: any) => { deliveries.push({ id, payload }); return { verified: true, already_delivered: false, session_id: payload.session_id, message_id: 3 } },
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
  return { base: `http://127.0.0.1:${address.port}`, calls, deliveries }
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const PRIVATE = { label: 'Private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }

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

  it('agent options: harnesses, Tinfoil plus signed-in AI Accounts providers, presets, Wizard apps vs agent apps', async () => {
    const dir = box()
    const main = await fakeHermes('main')
    const { base } = await start(dir, main)
    const options = await (await fetch(`${base}/wizard/v1/agent-options`)).json()
    expect(options.harnesses).toEqual([{ id: 'hermes', label: 'Hermes' }])
    expect(options.providers.map((p: any) => [p.id, p.confidential])).toEqual([['tinfoil', true], ['anthropic', false], ['openai-codex', false]])
    expect(options.providers[0].models).toEqual([{ id: 'glm-5-3', label: 'GLM 5.3' }, { id: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash' }])
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
    expect(config).not.toContain('  wizard:')
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
    const prefixResult=await(await call('standard_chats_search',{query:token.slice(0,8)+'*'})).json()
    expect(JSON.parse(prefixResult.result.content[0].text).results).toEqual([])
    const malformed=await fetch(base+'/wizard/standard-chats/mcp',json({jsonrpc:'2.0',id:1,method:7},{Authorization:`Bearer ${token}`}))
    expect((await malformed.json()).error.code).toBe(-32600)
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
    expect((await fetch(base+path.replace('?agent=private',''),{method:'DELETE'})).status).toBe(409)
    expect((await fetch(base+path,{method:'DELETE'})).status).toBe(200)
    expect((await fetch(base+path)).status).toBe(404)
    expect(privateApi.seen.filter(r=>r.method==='DELETE')).toHaveLength(1)
    expect(main.seen.filter(r=>r.method==='DELETE')).toHaveLength(0)
    const token=readFileSync(join(dir,'agents','private','gateway.key'),'utf8').trim()
    expect((await fetch(base+path,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})).status).toBe(403)
  })
  it('private FTS uses only its own database and excludes hidden probes', () => {
    const dir=box(),home=join(dir,'agents','private','home');mkdirSync(home,{recursive:true});historyFixture(join(home,'state.db'))
    const matches=privateChatMatches(join(dir,'agents'),'private','mango lighthouse')
    expect([...matches.keys()]).toEqual(['standard'])
    expect(matches.has('hidden_probe')).toBe(false)
    expect(privateChatMatches(join(dir,'agents'),'missing','mango')).toBe(null)
  })
})
