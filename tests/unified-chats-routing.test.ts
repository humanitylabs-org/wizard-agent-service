// Unified Chats (wizard-os spec/AGENTS.md): the owner's Chats lists every agent's threads, and the model picker routes
// a new chat to the agent that owns the chosen model. A confidential provider's model belongs to a private agent that
// allows it; everything else stays on the main agent. #59 sealing still applies to id-only and operator reads.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { agentForModel, hermesConfigYaml, TINFOIL } from '../server/agents.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r(undefined))) } })

async function readBody(req: IncomingMessage) {
  let raw = ''
  for await (const c of req) raw += c
  return raw ? JSON.parse(raw) : undefined
}

type Seen = { method: string, path: string, body: any }
async function fakeHermes(name: string, sessions: string[] = []) {
  const seen: Seen[] = []
  const known = new Set(sessions)
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = await readBody(req)
    seen.push({ method: req.method ?? '', path: url.pathname + url.search, body })
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/v1/capabilities') return json(200, { features: {} })
    if (url.pathname === '/api/model/options') return json(200, { provider: 'anthropic', model: 'claude-opus-5-5', providers: [{ slug: 'anthropic', authenticated: true, models: ['claude-opus-5-5'] }] })
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, { data: [...known].map((id) => ({ id, title: `${name} ${id}`, source: 'api_server' })) })
    const one = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && one) return known.has(decodeURIComponent(one[1])) ? json(200, { session: { id: decodeURIComponent(one[1]), title: name } }) : json(404, { error: 'not found' })
    if (req.method === 'PATCH' && one) return json(200, { session: { id: decodeURIComponent(one[1]), ...body } })
    if (req.method === 'POST' && url.pathname === '/api/sessions') { known.add(body?.id); return json(201, { session: { id: body?.id, source: body?.source } }) }
    if (req.method === 'GET' && /\/messages$/.test(url.pathname)) return json(200, { data: [{ role: 'assistant', content: `${name} reply` }] })
    if (req.method === 'POST' && url.pathname === '/v1/runs') { known.add(body.session_id); return json(202, { run_id: `${name}-run-${seen.length}` }) }
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) return json(200, { run_id: 'x', status: 'completed', output: `${name} output` })
    json(404, { error: 'nope' })
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { port: address.port, origin: `http://127.0.0.1:${address.port}`, seen, known }
}

async function start(dir: string, main: { origin: string }) {
  const runtime = { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }), deliver: async () => ({ verified: true }) }
  const svc = createWizardServer({
    upstreamOrigin: main.origin, hermesKey: 'fixture-key', requireAccess: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: runtime, followThrough: false, agentBasePort: 47850, bridgeWatchMs: 0, bridgeWriteSkills: false, bridgeLog: () => {},
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  return `http://127.0.0.1:${address.port}`
}

const json = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const PRIVATE = { label: 'Private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3', 'deepseek-v4-1-flash'] }, permissions: { preset: 'private' } }

async function box() {
  const dir = mkdtempSync(join(tmpdir(), 'unified-chats-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [] }))
  const main = await fakeHermes('main', ['wizard_main_1'])
  const priv = await fakeHermes('private')
  const base = await start(dir, main)
  const created = await fetch(`${base}/wizard/v1/agents`, json(PRIVATE))
  expect(created.status).toBe(201)
  const { agent } = await created.json()
  const file = join(dir, 'agents', agent.id, 'agent.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  stored.runtime.port = priv.port
  writeFileSync(file, JSON.stringify(stored))
  return { dir, base, main, priv, agent }
}
const hits = (seen: Seen[], path: string) => seen.filter((s) => s.path.startsWith(path))

describe('unified Chats: the picker routes a new chat to the agent owning the model', () => {
  it('agentForModel: only a confidential provider routes, only to a private agent that allows the model, oldest first', () => {
    const agent = (id: string, created_at: number, allowed: string[], privacy = 'private', provider = 'tinfoil') =>
      ({ id, created_at, privacy, model: { provider, model: allowed[0], allowed_models: allowed } })
    const list = [agent('zeta', 5, ['glm-5-3', 'deepseek-v4-1-flash']), agent('alpha', 9, ['deepseek-v4-1-flash']), agent('open', 1, ['deepseek-v4-1-flash'], 'standard'), agent('hermes', 0, ['deepseek-v4-1-flash'])]
    expect(agentForModel(list, { model: 'deepseek-v4-1-flash', provider: 'tinfoil' })?.id).toBe('zeta')
    expect(agentForModel([list[1], list[0]], { model: 'deepseek-v4-1-flash', provider: 'tinfoil' })?.id).toBe('zeta')
    expect(agentForModel([agent('b', 3, ['glm-5-3']), agent('a', 3, ['glm-5-3'])], { model: 'glm-5-3', provider: 'tinfoil' })?.id).toBe('a')
    expect(agentForModel(list, { model: 'claude-opus-5-5', provider: 'anthropic' })).toBeNull()
    expect(agentForModel(list, { model: 'glm-5-3', provider: 'custom:tinfoil-operator' })).toBeNull()
    expect(agentForModel(list, { model: 'kimi-k3', provider: 'tinfoil' })).toBeNull()
  })

  it('a new chat on a private model (no agent named) is created on, pinned to and run by the private agent only', async () => {
    const { base, main, priv } = await box()
    const sid = 'wizard_unified_new_1'
    const create = await fetch(`${base}/wizard/hermes/api/sessions`, json({ id: sid, source: 'wizard-mobile', model: 'deepseek-v4-1-flash', provider: 'tinfoil' }))
    expect(create.status).toBe(201)
    expect(create.headers.get('x-wizard-agent')).toBe('private')
    const run = await fetch(`${base}/wizard/hermes/v1/runs`, json({ session_id: sid, input: 'hello', model: 'deepseek-v4-1-flash', provider: 'tinfoil' }))
    expect(run.status).toBe(202)
    expect(run.headers.get('x-wizard-agent')).toBe('private')
    // The private agent got the run on its own provider; the main Hermes saw only the id-existence probe.
    const runs = hits(priv.seen, '/v1/runs').filter((s) => s.method === 'POST')
    expect(runs).toHaveLength(1)
    expect(runs[0].body).toMatchObject({ session_id: sid, model: 'deepseek-v4-1-flash' })
    expect(runs[0].body.provider).toBeUndefined()
    expect(main.seen.filter((s) => s.method !== 'GET')).toEqual([])
    expect(JSON.stringify(main.seen)).not.toContain('hello')
    // Pinned: replies by id go to the private agent; reads still need the agent named (#59).
    const reply = await fetch(`${base}/wizard/hermes/v1/runs`, json({ session_id: sid, input: 'again' }))
    expect(reply.headers.get('x-wizard-agent')).toBe('private')
    const sealed = await fetch(`${base}/wizard/hermes/api/sessions/${sid}/messages`)
    expect(sealed.status).toBe(409)
    expect(await sealed.json()).toMatchObject({ error: 'private_agent_sealed' })
    const own = await fetch(`${base}/wizard/hermes/api/sessions/${sid}/messages?agent=private`)
    expect(own.status).toBe(200)
    const op = await fetch(`${base}/wizard/operator/api/sessions/${sid}/messages`)
    expect(op.status).toBe(409)
  })

  it('standard models and existing main threads stay on the main agent; the operator surface is never routed', async () => {
    const { base, priv } = await box()
    const before = priv.seen.length
    const std = await fetch(`${base}/wizard/hermes/api/sessions`, json({ id: 'wizard_std_1', source: 'wizard-mobile', model: 'claude-opus-5-5', provider: 'anthropic' }))
    expect(std.headers.get('x-wizard-agent')).toBeNull()
    // A thread that already lives on the main agent is never moved by a model choice.
    const existing = await fetch(`${base}/wizard/hermes/api/sessions`, json({ id: 'wizard_main_1', source: 'wizard-mobile', model: 'glm-5-3', provider: 'tinfoil' }))
    expect(existing.headers.get('x-wizard-agent')).toBeNull()
    // A private model the private agent does not allow does not route.
    await fetch(`${base}/wizard/hermes/api/sessions`, json({ id: 'wizard_kimi_1', source: 'wizard-mobile', model: 'kimi-k3', provider: 'tinfoil' }))
    await fetch(`${base}/wizard/operator/api/sessions`, json({ id: 'wizard_op_x', model: 'glm-5-3', provider: 'tinfoil' }))
    expect(priv.seen.slice(before).filter((s) => s.method === 'POST')).toEqual([])
  })

  it('the owner can allow GLM and DeepSeek on the private agent; a public model is still refused', async () => {
    const { base } = await box()
    const ok = await fetch(`${base}/wizard/v1/agents/private`, json({ model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3', 'deepseek-v4-1-flash'] } }, 'PATCH'))
    expect(ok.status).toBe(200)
    expect((await ok.json()).agent.model).toMatchObject({ model: 'glm-5-3', allowed_models: ['glm-5-3', 'deepseek-v4-1-flash'], fallback: false })
    const bad = await fetch(`${base}/wizard/v1/agents/private`, json({ model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3', 'claude-opus-5-5'] } }, 'PATCH'))
    expect(bad.status).toBe(400)
    const options = await (await fetch(`${base}/wizard/v1/agent-options`)).json()
    expect(options.providers.find((p: any) => p.id === 'tinfoil').models.map((m: any) => m.id)).toEqual(['glm-5-3', 'deepseek-v4-1-flash'])
  })

  it('a private thread cannot switch to a public model (private → public never possible)', async () => {
    const { base } = await box()
    const sid = 'wizard_unified_lock_1'
    await fetch(`${base}/wizard/hermes/api/sessions`, json({ id: sid, source: 'wizard-mobile', model: 'glm-5-3', provider: 'tinfoil' }))
    const swap = await fetch(`${base}/wizard/hermes/api/sessions/${sid}/model?agent=private`, json({ model: 'claude-opus-5-5', provider: 'anthropic' }))
    expect(swap.status).toBe(409)
    const swapById = await fetch(`${base}/wizard/hermes/api/sessions/${sid}/model`, json({ model: 'claude-opus-5-5', provider: 'anthropic' }))
    expect(swapById.status).toBe(409)
  })

  it('harness config: DeepSeek on Tinfoil gets supports_reasoning: false, only when the agent may use it', () => {
    const base = { id: 'private', privacy: 'private', permissions: { outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [] } }
    const withDs = hermesConfigYaml({ ...base, model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3', 'deepseek-v4-1-flash'], fallback: false } })
    expect(withDs).toContain('model_overrides:\n  custom:\n    "deepseek-v4-1-flash":\n      supports_reasoning: false\n')
    const glmOnly = hermesConfigYaml({ ...base, model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3'], fallback: false } })
    expect(glmOnly).not.toContain('model_overrides')
    expect(TINFOIL.models.find((m: any) => m.id === 'glm-5-3')).not.toHaveProperty('supports_reasoning')
  })
})
