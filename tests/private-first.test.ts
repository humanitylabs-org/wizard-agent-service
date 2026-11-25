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
const GATEWAY_KEY = 'main-gateway-key-0123456789abcdef'
const APPS = [
  { id: 'wizard-mail', name: 'Mail', status: 'running', view: { url: '/mail/' }, mcp: { url: 'http://mail/mcp' }, agent_binding: { required: true, purpose: 'Where mail summaries go' } },
  { id: 'messenger', name: 'Messenger', status: 'running', view: { url: '/messenger/' }, mcp: { url: 'http://messenger/mcp' }, agent_binding: true },
  { id: 'photos', name: 'Photos', status: 'running', view: { url: '/photos/' }, agent_binding: { required: false, purpose: 'Photo notes' } },
  { id: 'meditate', name: 'Meditate', status: 'running', view: { url: '/meditate/' } },
]

async function box({ on = true, mainModel = '', mainProvider = 'openai-codex', look, heavy = true, gateway = false, boundary = false, runtime = true, reuse = '', apps = APPS }: { on?: boolean | null, mainModel?: string, mainProvider?: string, look?: boolean, heavy?: boolean, gateway?: boolean, boundary?: boolean, runtime?: boolean, reuse?: string, apps?: unknown[] } = {}) {
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
        return json({ provider: state.model ? mainProvider : '', model: state.model, providers: [
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
  const dir = reuse || mkdtempSync(join(tmpdir(), 'private-first-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps }))
  if (look !== undefined) {
    mkdirSync(join(dir, 'Pages', 'wizard-look'), { recursive: true })
    writeFileSync(join(dir, 'Pages', 'wizard-look', 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { [PRIVATE_FIRST_SWITCH]: { on: look, at: 1 } } }))
  }
  const applied: string[] = []
  const svc = createWizardServer({
    upstreamOrigin: `http://127.0.0.1:${mainAddress.port}`, hermesKey: 'fixture-key', requireAccess: false,
    ...(boundary ? { browserBoundary: { enabled: true, token: 'a'.repeat(64) } } : {}),
    ...(gateway ? { agentBridge: true, mcpToken: GATEWAY_KEY, bridgeWriteSkills: false, bridgeLog: () => {} } : { agentBridge: false }),
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir, ...(heavy ? { heavyToken: TOKEN } : {}),
    ...(runtime ? { agentRuntime: { apply: async (id: string) => { applied.push(id); return { ok: true } }, start: async () => ({ ok: true }), stop: async () => ({ ok: true }) } } : {}),
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
  return { dir, call, internal, agents, settings, reached, applied, state, setProvider: (p: string) => { mainProvider = p } }
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

  // Issue 598 (DECISIONS 115, spec/AGENTS.md section 10): Claude and ChatGPT only ever run on the standard agent, so
  // their connection apps are never granted to a private agent, whichever way it gets its apps.
  const CONNECTIONS = [
    { id: 'wizard-claude', name: 'Claude', type: 'external', category: 'system', status: 'running', view: { url: '/wizard-claude/' }, mcp: { url: 'http://wizard-claude:8799/mcp' }, provides: ['ai-connection', 'claude-subscription'] },
    { id: 'wizard-chatgpt', name: 'ChatGPT', type: 'external', category: 'system', status: 'running', view: { url: '/wizard-chatgpt/' }, mcp: { url: 'http://wizard-chatgpt:8801/mcp' }, provides: ['ai-connection', 'chatgpt-subscription'] },
    { id: 'wizard-tinfoil', name: 'Tinfoil', type: 'external', category: 'system', status: 'running', view: { url: '/wizard-tinfoil/' }, mcp: { url: 'http://wizard-tinfoil:18804/mcp' }, provides: ['ai-connection', 'tinfoil-api-key', 'private-inference'], private_inference: { kind: 'attested-relay', client: 'tinfoil' } },
    { id: 'wizard-connection-router', name: 'Connection Router', type: 'service', category: 'system', status: 'running', view: { url: '/wizard-connection-router/' }, mcp: { url: 'http://wizard-connection-router:8802/mcp' }, provides: ['connection-router'], uses: ['ai-connection'] },
  ]
  const STANDARD_ONLY = ['wizard-claude', 'wizard-chatgpt']

  it('fresh box: the private agent gets every app but the Claude and ChatGPT connection apps (issue 598)', async () => {
    const b = await box({ apps: [...APPS, ...CONNECTIONS] })
    expect((await b.internal('private-agent', TINFOIL)).status).toBe(200)
    const list = await b.agents()
    const priv = list.find((a) => a.id === 'private')
    expect([...priv.permissions.wizard_apps].sort()).toEqual(['meditate', 'messenger', 'photos', 'wizard-connection-router', 'wizard-mail', 'wizard-tinfoil'])
    // Nothing is added to the standard agent.
    expect(list.find((a) => a.id === 'hermes').permissions.wizard_apps).toEqual([])
    // Claude and ChatGPT signing in later changes neither.
    await b.internal('standard-agent', { provider: 'anthropic', model: 'claude-opus-5-5' })
    const after = await b.agents()
    expect(after.find((a) => a.id === 'private').permissions.wizard_apps).not.toEqual(expect.arrayContaining(['wizard-claude']))
    expect(after.find((a) => a.id === 'private').permissions.wizard_apps.filter((id: string) => STANDARD_ONLY.includes(id))).toEqual([])
    expect(after.find((a) => a.id === 'hermes').permissions.wizard_apps).toEqual([])
  })

  it('Claude or ChatGPT installed after the private agent never joins it (issue 598)', async () => {
    const b = await box()
    await b.internal('private-agent', TINFOIL)
    writeFileSync(join(b.dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [...APPS, ...CONNECTIONS] }))
    await b.agents()
    await new Promise((r) => setTimeout(r, 50))
    const list = await b.agents()
    const apps = list.find((a) => a.id === 'private').permissions.wizard_apps
    expect(apps).toEqual(expect.arrayContaining(['wizard-tinfoil', 'wizard-connection-router']))
    expect(apps.filter((id: string) => STANDARD_ONLY.includes(id))).toEqual([])
    expect(list.find((a) => a.id === 'hermes').permissions.wizard_apps).toEqual([])
  })

  it('a private agent that already has them loses them, and they can\'t be ticked for it again (issue 598)', async () => {
    const before = await box({ apps: [...APPS, ...CONNECTIONS] })
    await before.internal('private-agent', TINFOIL)
    // A box set up before the fix: the grant is already in agent.json. The Service then restarts on the new release.
    const file = join(before.dir, 'agents', 'private', 'agent.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    stored.permissions.wizard_apps = [...new Set([...stored.permissions.wizard_apps, ...STANDARD_ONLY])]
    writeFileSync(file, JSON.stringify(stored))
    const b = await box({ apps: [...APPS, ...CONNECTIONS], reuse: before.dir })
    await b.agents()
    await new Promise((r) => setTimeout(r, 50))
    const kept = (await b.agents()).find((a) => a.id === 'private').permissions.wizard_apps
    expect(kept.filter((id: string) => STANDARD_ONLY.includes(id))).toEqual([])
    expect(kept).toEqual(expect.arrayContaining(['wizard-tinfoil', 'meditate']))
    // The gateway change reaches the running agent: its harness is re-applied once.
    expect(b.applied).toEqual(['private'])
    // The owner's app ticks: the shell sends the whole list; Claude and ChatGPT are refused for a private agent.
    const r = await b.call('PATCH', '/wizard/v1/agents/private', { permissions: { wizard_apps: [...kept, 'wizard-claude'] } })
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ check: 'agent.standard_only_app' })
    // The app's settings sheet: moving Claude from the standard agent to the private one is refused before anything
    // moves, so it stays with the standard agent.
    expect((await b.call('PUT', '/wizard/v1/apps/wizard-claude/agents', { agents: ['hermes'] })).status).toBe(200)
    const moved = await b.call('PUT', '/wizard/v1/apps/wizard-claude/agents', { agents: ['private'] })
    expect(moved.status).toBe(409)
    expect(moved.json).toMatchObject({ check: 'agent.standard_only_app' })
    const holders = (await b.call('GET', '/wizard/v1/apps/wizard-claude/agents')).json.agents.filter((a: any) => a.enabled).map((a: any) => a.id)
    expect(holders).toEqual(['hermes'])
    // A standard agent may still be given them.
    const created = await b.call('POST', '/wizard/v1/agents', { label: 'Helper', permissions: { preset: 'standard', wizard_apps: ['wizard-claude'] }, model: { provider: 'openai-codex', model: 'gpt-6.1-sol' } })
    expect(created.status).toBeLessThan(300)
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

  it('no heavy-lane token (every standard install, issue 575): the main Hermes gateway key works the route', async () => {
    const b = await box({ heavy: false, gateway: true })
    expect((await b.internal('state', {}, GATEWAY_KEY)).json).toMatchObject({ schema: 'wizard.private-first/1', on: true, private_agent: null })
    expect((await b.internal('private-agent', TINFOIL, GATEWAY_KEY)).json).toMatchObject({ ok: true, agent: 'private' })
    expect((await b.agents()).find((a) => a.id === 'private')).toMatchObject({ privacy: 'private', is_default: true, model: { provider: 'tinfoil', fallback: false } })
    // Any other key, browser headers or no key: refused.
    expect((await b.internal('state', {}, 'wrong-token-0123456789abcdef-xxxxx')).status).toBe(403)
    expect((await b.call('POST', '/wizard/internal/private-first/state', {})).status).toBe(403)
    expect((await b.call('POST', '/wizard/internal/private-first/state', {}, { Authorization: `Bearer ${GATEWAY_KEY}`, Origin: 'http://evil.example' })).status).toBe(403)
    expect((await b.call('POST', '/wizard/internal/private-first/state', {}, { Authorization: `Bearer ${GATEWAY_KEY}`, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(403)
    // Neither credential on the box: the route is not there.
    const none = await box({ heavy: false })
    expect((await none.internal('state', {}, GATEWAY_KEY)).status).toBe(404)
  })

  it('the browser boundary lets the relay through with either credential (issue 575)', async () => {
    const b = await box({ heavy: false, gateway: true, boundary: true })
    expect((await b.internal('state', {}, GATEWAY_KEY)).json).toMatchObject({ on: true })
    expect((await b.internal('state', {}, 'wrong-token-0123456789abcdef-xxxxx')).status).toBe(401)
    const heavy = await box({ boundary: true })
    expect((await heavy.internal('state')).json).toMatchObject({ on: true })
  })

  it('freshness is decided when the state is first read, before a provider image registers anything (issue 575)', async () => {
    const b = await box()
    expect((await b.internal('state')).json).toMatchObject({ on: true, private_agent: null })
    for (let i = 0; i < 50 && !existsSync(join(b.dir, 'agents', '.private-first.json')); i++) await new Promise((r) => setTimeout(r, 10))
    expect(JSON.parse(readFileSync(join(b.dir, 'agents', '.private-first.json'), 'utf8')).fresh).toBe(true)
    // An older Tinfoil, unable to reach the switch, set a main model in between: still the first run.
    b.state.model = 'kimi-k3-1-pro'
    b.setProvider('wizard-tinfoil')
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private' })
    const list = await b.agents()
    expect(list.find((a) => a.id === 'private')).toMatchObject({ is_default: true })
    expect(list.find((a) => a.id === 'hermes')).toMatchObject({ hidden: true, is_default: false })
  })

  it('no agent runtime (issue 582): stays on with the reason, refuses the hand-off and says so in the log', async () => {
    const lines: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: any, ...rest: any[]) => { lines.push(String(chunk)); return write(chunk, ...rest) }) as any
    try {
      const b = await box({ runtime: false })
      expect((await b.internal('state')).json).toMatchObject({ schema: 'wizard.private-first/1', on: true, reason: 'runtime_unavailable', private_agent: null })
      expect((await b.call('GET', '/wizard/v1/private-first')).json).toMatchObject({ on: true, reason: 'runtime_unavailable' })
      const refused = await b.internal('private-agent', TINFOIL)
      expect(refused.status).toBe(503)
      expect(refused.json).toEqual({ ok: false, error: 'runtime_unavailable' })
      expect((await b.agents()).map((a) => a.id)).toEqual(['hermes'])
      expect((await b.agents()).find((a) => a.id === 'hermes').hidden).toBeFalsy()
      expect(existsSync(join(b.dir, 'agents', 'private'))).toBe(false)
      expect(lines.some((l) => l.startsWith('[private-first] private agent refused: switch on, but this box has no agent runtime'))).toBe(true)
      expect(lines.some((l) => l.startsWith('[private-first] state: switch on, but this box has no agent runtime'))).toBe(true)
      // Still decided as a first run, so the box moves over once a runtime is there.
      for (let i = 0; i < 50 && !existsSync(join(b.dir, 'agents', '.private-first.json')); i++) await new Promise((r) => setTimeout(r, 10))
      expect(JSON.parse(readFileSync(join(b.dir, 'agents', '.private-first.json'), 'utf8')).fresh).toBe(true)
    } finally { process.stdout.write = write as any }
  })

  it('a runtime added later: the saved Tinfoil key moves the box over as the first run (issue 582)', async () => {
    const before = await box({ runtime: false })
    await before.internal('state')
    for (let i = 0; i < 50 && !existsSync(join(before.dir, 'agents', '.private-first.json')); i++) await new Promise((r) => setTimeout(r, 10))
    // An older Tinfoil that could not read private first set the main model in between: still the first run.
    const b = await box({ reuse: before.dir, mainModel: 'kimi-k3-1-pro', mainProvider: 'custom:wizard-tinfoil' })
    expect((await b.internal('state')).json).toMatchObject({ on: true, private_agent: null })
    expect((await b.internal('state')).json.reason).toBeUndefined()
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private', created: true })
    const list = await b.agents()
    expect(list.find((a) => a.id === 'private')).toMatchObject({ is_default: true })
    expect(list.find((a) => a.id === 'hermes')).toMatchObject({ hidden: true })
    expect((await b.internal('state')).json).toMatchObject({ on: true, private_agent: 'private', standard_on: false })
  })

  it('a runtime added later never loses private first, whatever model the main agent got meanwhile (issue 582)', async () => {
    const before = await box({ runtime: false })
    await before.internal('state')
    for (let i = 0; i < 50 && !existsSync(join(before.dir, 'agents', '.private-first.json')); i++) await new Promise((r) => setTimeout(r, 10))
    // Something set a main model on another provider without going through private first: the box was decided
    // fresh while it waited for its runtime, and it stays the first run.
    const b = await box({ reuse: before.dir, mainModel: 'claude-opus-5-5', mainProvider: 'anthropic' })
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private', created: true })
    const list = await b.agents()
    expect(list.find((a) => a.id === 'private')).toMatchObject({ is_default: true })
    expect(list.find((a) => a.id === 'hermes')).toMatchObject({ hidden: true, is_default: false })
    expect(JSON.parse(readFileSync(join(b.dir, 'agents', '.private-first.json'), 'utf8')).fresh).toBe(true)
  })

  it('an install that already chats on Tinfoil through the main Hermes is not migrated', async () => {
    const b = await box({ mainModel: 'kimi-k3-1-pro', mainProvider: 'wizard-tinfoil' })
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private' })
    const list = await b.agents()
    expect(list.find((a) => a.id === 'hermes')).toMatchObject({ is_default: true })
    expect(list.find((a) => a.id === 'hermes').hidden).toBeFalsy()
    expect(list.find((a) => a.id === 'private')).toMatchObject({ is_default: false, permissions: { wizard_apps: [] } })
  })
})

// wizard-ux issue 1800 (standard first): the Welcome asks once, after Connect your AI, whether to set up private AI.
describe('the Welcome\'s private AI offer (wizard-ux issue 1800)', () => {
  const offer = (b: Awaited<ReturnType<typeof box>>, value: unknown, headers: Record<string, string> = {}) => b.call('POST', '/wizard/v1/private-first', value, headers)

  it('ChatGPT first, then Set up private AI: private on Tinfoil is the default, ChatGPT stays on the shown standard agent', async () => {
    const b = await box({ on: null, mainModel: 'gpt-6.1-sol' })
    expect((await b.call('GET', '/wizard/v1/private-first')).json).toMatchObject({ on: false, offer: null })
    const r = await offer(b, { offer: 'setup' }, { 'Sec-Fetch-Site': 'same-origin' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ on: true, offer: 'setup', private_agent: null })
    // Tinfoil's hand-off after its sign-in (the wizard-tinfoil app asks the state, sees on, hands over).
    expect((await b.internal('state')).json.on).toBe(true)
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private', created: true })
    const list = await b.agents()
    expect(list.find((a) => a.id === 'private')).toMatchObject({ privacy: 'private', is_default: true, model: { provider: 'tinfoil' } })
    expect([...list.find((a) => a.id === 'private').permissions.wizard_apps].sort()).toEqual(['meditate', 'messenger', 'photos', 'wizard-mail'])
    const main = list.find((a) => a.id === 'hermes')
    expect(main.hidden).toBeFalsy()
    expect(main.is_default).toBe(false)
    expect(b.settings().agents.default_agent_id).toBe('private')
    expect((await b.call('GET', '/wizard/v1/app-bindings')).json.bindings.every((x: any) => x.agent === 'private')).toBe(true)
    expect((await b.call('GET', '/wizard/v1/private-first')).json).toMatchObject({ on: true, offer: 'setup', private_agent: 'private', standard_on: true })
    // ChatGPT's attach comes first: the private Tinfoil provider never joins the standard agent.
    expect((await b.call('GET', '/wizard/v1/main-providers')).status).toBe(200)
  })

  it('Skip for now, then Set up private AI: the DECISIONS 115 first run (standard agent off until Claude or ChatGPT)', async () => {
    const b = await box({ on: null })
    expect((await offer(b, { offer: 'setup' })).json).toMatchObject({ on: true, offer: 'setup' })
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private' })
    const list = await b.agents()
    expect(list.find((a) => a.id === 'private')).toMatchObject({ is_default: true })
    expect(list.find((a) => a.id === 'hermes')).toMatchObject({ hidden: true, is_default: false })
    expect((await b.call('GET', '/wizard/v1/private-first')).json).toMatchObject({ private_agent: 'private', standard_on: false })
  })

  it('private first forced on and Claude connected first: Set up private AI in the first run still makes it the default', async () => {
    const b = await box({ on: true })
    expect((await b.internal('standard-agent', { provider: 'anthropic', model: 'claude-opus-5-5' })).json).toMatchObject({ ok: true })
    b.state.model = 'claude-opus-5-5'
    b.setProvider('anthropic')
    expect((await offer(b, { offer: 'setup' })).status).toBe(200)
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private' })
    const list = await b.agents()
    expect(list.find((a) => a.id === 'private')).toMatchObject({ is_default: true })
    expect(list.find((a) => a.id === 'hermes').hidden).toBeFalsy()
  })

  it('Later and No thanks are only remembered: private first stays off and a Tinfoil hand-off is refused', async () => {
    const b = await box({ on: null, mainModel: 'gpt-6.1-sol' })
    expect((await offer(b, { offer: 'later' })).json).toMatchObject({ on: false, offer: 'later' })
    expect((await b.internal('private-agent', TINFOIL)).status).toBe(409)
    expect((await offer(b, { offer: 'declined' })).json).toMatchObject({ on: false, offer: 'declined' })
    expect((await b.call('GET', '/wizard/v1/private-first')).json).toMatchObject({ on: false, offer: 'declined' })
    expect((await b.agents()).map((a) => a.id)).toEqual(['hermes'])
    // Later, then Settings › Privacy › Finish setting up private AI: the same opt-in.
    expect((await offer(b, { offer: 'setup' })).json).toMatchObject({ on: true, offer: 'setup' })
  })

  it('after the first run with no AI connected: still no new default (Codex P2)', async () => {
    const b = await box({ on: null })
    expect((await b.call('POST', '/wizard/v1/setup/seen', {})).status).toBe(200)
    expect((await offer(b, { offer: 'setup' })).json).toMatchObject({ on: true })
    await b.call('GET', '/wizard/v1/private-first')
    expect(JSON.parse(readFileSync(join(b.dir, 'agents', '.private-first.json'), 'utf8')).fresh).toBe(false)
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private' })
    expect((await b.agents()).find((a) => a.id === 'hermes')).toMatchObject({ is_default: true })
  })

  it('after the first run (Welcome finished): an opt-in adds a private agent, never a new default', async () => {
    const b = await box({ on: null, mainModel: 'gpt-6.1-sol' })
    expect((await b.call('POST', '/wizard/v1/setup/seen', {})).status).toBe(200)
    expect((await offer(b, { offer: 'setup' })).json).toMatchObject({ on: true })
    expect((await b.internal('private-agent', TINFOIL)).json).toMatchObject({ ok: true, agent: 'private' })
    const list = await b.agents()
    expect(list.find((a) => a.id === 'hermes')).toMatchObject({ is_default: true })
    expect(list.find((a) => a.id === 'private')).toMatchObject({ is_default: false })
  })

  it('env 0 wins, a bad answer or a cross-site page is refused, and nothing is written', async () => {
    const forced = await box({ on: false })
    expect((await offer(forced, { offer: 'setup' })).status).toBe(409)
    expect((await forced.call('GET', '/wizard/v1/private-first')).json.on).toBe(false)
    const b = await box({ on: null })
    expect((await offer(b, { offer: 'yes' })).status).toBe(400)
    expect((await offer(b, ['setup'])).status).toBe(400)
    expect((await offer(b, { offer: 'setup' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await offer(b, { offer: 'setup' }, { 'Sec-Fetch-Site': 'same-site' })).status).toBe(403)
    expect((await b.call('PUT', '/wizard/v1/private-first', { offer: 'setup' })).status).toBe(405)
    // Fetch Metadata left out (an older webview): a text/plain body or another page's Origin is still refused.
    expect((await b.call('POST', '/wizard/v1/private-first', { offer: 'setup' }, { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await offer(b, { offer: 'setup' }, { Origin: 'http://evil.example' })).status).toBe(403)
    expect(existsSync(join(b.dir, 'agents', '.private-first.json'))).toBe(false)
    expect((await b.call('GET', '/wizard/v1/private-first')).json).toMatchObject({ on: false, offer: null })
  })
})
