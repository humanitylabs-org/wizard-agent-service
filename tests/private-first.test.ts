// Issue 545 (wizard-os DECISIONS 115, spec/AGENTS.md section 10): private first. Switch `wizard/private-first-setup`
// (Look file) or option privateFirst (env WIZARD_PRIVATE_FIRST), off by default. Tinfoil connected first on a fresh
// box makes one private agent the box's agent; Claude or ChatGPT switches on the separate standard agent.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { PRIVATE_FIRST_SWITCH } from '../server/private-first.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

const TOKEN = 'private-first-token-0123456789abcdef'
const APPS = [
  { id: 'wizard-mail', name: 'Mail', status: 'running', view: { url: '/mail/' }, mcp: { url: 'http://mail/mcp' }, agent_binding: { required: true, purpose: 'Where mail summaries go' } },
  { id: 'messenger', name: 'Messenger', status: 'running', view: { url: '/messenger/' }, mcp: { url: 'http://messenger/mcp' }, agent_binding: true },
  { id: 'photos', name: 'Photos', status: 'running', view: { url: '/photos/' }, agent_binding: { required: false, purpose: 'Photo notes' } },
  { id: 'meditate', name: 'Meditate', status: 'running', view: { url: '/meditate/' } },
]

async function box({ on = true, mainModel = '', look }: { on?: boolean | null, mainModel?: string, look?: boolean } = {}) {
  const reached: { method: string, path: string, body: string }[] = []
  const state = { model: mainModel }
  const main = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      reached.push({ method: req.method ?? 'GET', path, body: raw })
      const json = (v: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
      if (path === '/health') return json({ status: 'ok' })
      if (path === '/api/model/options') {
        return json({ provider: state.model ? 'openai-codex' : '', model: state.model, providers: [
          { slug: 'openai-codex', name: 'ChatGPT', authenticated: true, models: ['gpt-6.1-sol'] },
          { slug: 'anthropic', name: 'Claude', authenticated: true, models: ['claude-opus-5-5'] },
        ] })
      }
      if (/^\/api\/sessions\/[^/]+\/model$/u.test(path)) return json({ ok: true })
      if (path === '/api/sessions') return json({ data: [] })
      res.writeHead(404); res.end('{}')
    })
  })
  servers.push(main)
  const mainAddress = await listen(main) as import('node:net').AddressInfo
  const dir = mkdtempSync(join(tmpdir(), 'private-first-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: APPS }))
  if (look !== undefined) {
    mkdirSync(join(dir, 'Pages', 'wizard-look'), { recursive: true })
    writeFileSync(join(dir, 'Pages', 'wizard-look', 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { [PRIVATE_FIRST_SWITCH]: { on: look, at: 1 } } }))
  }
  const applied: string[] = []
  const svc = createWizardServer({
    upstreamOrigin: `http://127.0.0.1:${mainAddress.port}`, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir, heavyToken: TOKEN,
    agentRuntime: { apply: async (id: string) => { applied.push(id); return { ok: true } }, start: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
    followThrough: false, agentBasePort: 47890, runQueue: false,
    pagesRoot: join(dir, 'Pages'), pagesGitDir: join(dir, 'pages-history.git'), pagesWatch: false, privateFirstTtlMs: 0,
    ...(on === null ? {} : { privateFirst: on }),
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, json: await r.json().catch(() => null) as any }
  }
  const internal = (action: string, body: unknown = {}, token = TOKEN) => call('POST', `/wizard/internal/private-first/${action}`, body, { Authorization: `Bearer ${token}` })
  const agents = async () => (await call('GET', '/wizard/v1/agents')).json.agents as any[]
  const settings = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  return { dir, call, internal, agents, settings, reached, applied, state }
}

const TINFOIL = { provider: 'tinfoil', model: 'kimi-k3', models: ['kimi-k3', 'glm-5-3'] }

describe('private first (issue 545)', () => {
  it('switch off: nothing changes and every change is refused', async () => {
    const b = await box({ on: null })
    expect((await b.internal('state')).json).toMatchObject({ schema: 'wizard.private-first/1', on: false })
    expect((await b.internal('private-agent', TINFOIL)).status).toBe(409)
    expect((await b.internal('standard-agent', { provider: 'openai-codex', model: 'gpt-6.1-sol' })).status).toBe(409)
    expect((await b.agents()).map((a) => a.id)).toEqual(['hermes'])
    expect((await b.call('GET', '/wizard/v1/main-providers')).status).toBe(404)
    expect(existsSync(join(b.dir, 'agents', '.private-first.json'))).toBe(false)
  })

  it('the loopback route needs the token and no browser headers', async () => {
    const b = await box()
    expect((await b.internal('state', {}, 'wrong-token-0123456789abcdef-xxxxx')).status).toBe(403)
    expect((await b.call('POST', '/wizard/internal/private-first/state', {}, { Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example' })).status).toBe(403)
    expect((await b.call('GET', '/wizard/internal/private-first/state')).status).toBe(405)
  })

  it('fresh box, only Tinfoil: exactly one agent, private on Tinfoil, the default, with every app and the bindings', async () => {
    const b = await box()
    const r = await b.internal('private-agent', TINFOIL)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, agent: 'private' })
    const list = await b.agents()
    const visible = list.filter((a) => !a.hidden)
    expect(visible.map((a) => a.id)).toEqual(['private'])
    const priv = visible[0]
    expect(priv).toMatchObject({ privacy: 'private', is_default: true, model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3'], fallback: false } })
    expect(priv.permissions.preset).toBe('private')
    expect([...priv.permissions.wizard_apps].sort()).toEqual(['meditate', 'messenger', 'photos', 'wizard-mail'])
    // The standard agent is off: hidden, no apps.
    const main = list.find((a) => a.id === 'hermes')
    expect(main).toMatchObject({ hidden: true, is_default: false })
    expect(main.permissions.wizard_apps).toEqual([])
    expect(b.settings().agents.default_agent_id).toBe('private')
    const bindings = (await b.call('GET', '/wizard/v1/app-bindings')).json.bindings
    expect(Object.fromEntries(bindings.map((x: any) => [x.app_id, x.agent]))).toEqual({ 'wizard-mail': 'private', messenger: 'private', photos: 'private' })
    expect((await b.internal('state')).json).toMatchObject({ on: true, private_agent: 'private', standard_on: false })
    // Every start asks again: same agent, nothing new.
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private' })
    expect((await b.agents()).filter((a) => a.id !== 'hermes')).toHaveLength(1)
    expect(b.applied).toEqual(['private'])
  })

  it('then ChatGPT and Claude: a separate standard agent on, the private agent untouched', async () => {
    const b = await box()
    await b.internal('private-agent', TINFOIL)
    const before = (await b.agents()).find((a) => a.id === 'private')
    const r = await b.internal('standard-agent', { provider: 'openai-codex', model: 'gpt-6.1-sol' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, agent: 'hermes', apply_model: true, model: 'gpt-6.1-sol' })
    b.state.model = 'gpt-6.1-sol'
    const claude = await b.internal('standard-agent', { provider: 'anthropic', model: 'claude-opus-5-5' })
    expect(claude.json).toMatchObject({ ok: true, agent: 'hermes', apply_model: false })
    const list = await b.agents()
    const main = list.find((a) => a.id === 'hermes')
    expect(main.hidden).toBeFalsy()
    expect(main.permissions.wizard_apps).toEqual([])
    const after = list.find((a) => a.id === 'private')
    expect({ model: after.model, permissions: after.permissions, is_default: after.is_default }).toEqual({ model: before.model, permissions: before.permissions, is_default: true })
    expect(JSON.parse(readFileSync(join(b.dir, 'agents', '.main-providers.json'), 'utf8')).attached).toEqual(['openai-codex', 'anthropic'])
    expect((await b.internal('state')).json).toMatchObject({ standard_on: true, private_agent: 'private' })
    // A sign-in never reaches the private agent's container.
    expect(b.applied).toEqual(['private'])
  })

  it('a model change on the private agent to ChatGPT or Claude is refused', async () => {
    const b = await box()
    await b.internal('private-agent', TINFOIL)
    await b.internal('standard-agent', { provider: 'openai-codex', model: 'gpt-6.1-sol' })
    const r = await b.call('PATCH', '/wizard/v1/agents/private', { model: { provider: 'openai-codex', model: 'gpt-6.1-sol' } })
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ error: 'confidential_provider_required', check: 'agent.confidential_provider' })
    expect((await b.agents()).find((a) => a.id === 'private').model.provider).toBe('tinfoil')
  })

  it('switch on with no env setting: the main-agent attach protection is active', async () => {
    const b = await box()
    const r = await b.call('GET', '/wizard/v1/main-providers')
    expect(r.status).toBe(200)
    expect(r.json.schema).toBe('wizard.main-providers/1')
    await b.internal('standard-agent', { provider: 'openai-codex', model: '' })
    const options = await b.call('GET', '/wizard/hermes/api/model/options')
    expect(options.json.providers.map((p: any) => p.slug)).toEqual(['openai-codex'])
    expect(options.json.wizard_unattached_providers.map((p: any) => p.slug)).toEqual(['anthropic'])
  })

  it('an app installed later starts on the private agent only', async () => {
    const b = await box()
    await b.internal('private-agent', TINFOIL)
    await b.internal('standard-agent', { provider: 'openai-codex', model: '' })
    writeFileSync(join(b.dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [...APPS, { id: 'notes', name: 'Notes', status: 'running', view: { url: '/notes/' } }] }))
    await b.agents()
    await new Promise((r) => setTimeout(r, 50))
    const list = await b.agents()
    expect(list.find((a) => a.id === 'private').permissions.wizard_apps).toContain('notes')
    expect(list.find((a) => a.id === 'hermes').permissions.wizard_apps).not.toContain('notes')
  })

  it('the Look file switch turns it on without the env setting', async () => {
    const b = await box({ on: null, look: true })
    expect((await b.internal('state')).json.on).toBe(true)
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private' })
    const off = await box({ on: null, look: false })
    expect((await off.internal('state')).json.on).toBe(false)
    // env 0 wins over the Look file
    const forced = await box({ on: false, look: true })
    expect((await forced.internal('state')).json.on).toBe(false)
  })

  it('Claude or ChatGPT connected before Tinfoil: the standard agent stays the box\'s agent', async () => {
    const b = await box()
    expect((await b.internal('standard-agent', { provider: 'anthropic', model: 'claude-opus-5-5' })).json).toMatchObject({ ok: true, agent: 'hermes' })
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private' })
    const list = await b.agents()
    const main = list.find((a) => a.id === 'hermes')
    expect(main).toMatchObject({ is_default: true })
    expect(main.hidden).toBeFalsy()
    expect(main.permissions.wizard_apps.length).toBe(4)
    expect(list.find((a) => a.id === 'private')).toMatchObject({ is_default: false, permissions: { wizard_apps: [] } })
    expect((await b.call('GET', '/wizard/v1/app-bindings')).json.bindings.every((x: any) => x.agent === 'hermes')).toBe(true)
    expect((await b.internal('state')).json).toMatchObject({ on: true, private_agent: null, standard_on: true })
  })

  it('an existing install is not migrated: no new default, app lists or bindings', async () => {
    const b = await box({ mainModel: 'gpt-6.1-sol' })
    const r = await b.internal('private-agent', TINFOIL)
    expect(r.json).toMatchObject({ ok: true, agent: 'private' })
    const list = await b.agents()
    const main = list.find((a) => a.id === 'hermes')
    expect(main.hidden).toBeFalsy()
    expect(main.is_default).toBe(true)
    expect(main.permissions.wizard_apps.length).toBe(4)
    expect(list.find((a) => a.id === 'private').permissions.wizard_apps).toEqual([])
    expect((await b.call('GET', '/wizard/v1/app-bindings')).json.bindings.every((x: any) => x.agent === 'hermes')).toBe(true)
    // Asked again: the same private agent answers.
    expect((await b.internal('private-agent', TINFOIL)).json.agent).toBe('private')
    expect((await b.agents()).filter((a) => a.privacy === 'private')).toHaveLength(1)
  })
})
