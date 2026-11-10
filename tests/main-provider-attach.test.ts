// Issue 428: a provider sign-in must not attach itself to the main agent. Switch WIZARD_MAIN_PROVIDER_ATTACH=1
// (option mainProviderAttach), off by default: the main agent's picker and runs use only the providers the owner
// attached; the onboarding provider is attached first; everything connected later waits in the box's pool.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { createMainProviderAttach } from '../server/main-provider-attach.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

// The owner chose Tinfoil at onboarding, then signed in to ChatGPT and Claude for an agent he has not built yet.
const options = (provider = 'custom:wizard-tinfoil') => ({ provider, model: 'glm-5-3', providers: [
  { slug: 'wizard-tinfoil', name: 'Tinfoil', is_user_defined: true, authenticated: true, models: ['glm-5-3'] },
  { slug: 'openai-codex', name: 'ChatGPT', authenticated: true, models: ['gpt-6.1-sol'] },
  { slug: 'anthropic', name: 'Claude', authenticated: true, models: ['claude-opus-5-5'] },
  { slug: 'openrouter', name: 'OpenRouter', authenticated: false, models: [] },
] })

async function box(on: boolean, current = 'custom:wizard-tinfoil') {
  const reached: { path: string, body: string }[] = []
  const main = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      reached.push({ path, body: raw })
      const json = (v: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
      if (path === '/health') return json({ status: 'ok' })
      if (path === '/api/model/options') return json(options(current))
      if (/^\/api\/sessions\/[^/]+\/model$/u.test(path)) return json({ ok: true })
      if (path === '/api/sessions' && req.method === 'POST') return json({ id: 'wizard_s1' })
      if (/^\/api\/sessions\/[^/]+$/u.test(path)) return json({ id: path.split('/').pop() })
      if (path === '/api/sessions') return json({ data: [] })
      res.writeHead(404); res.end('{}')
    })
  })
  servers.push(main)
  const mainAddress = await listen(main) as import('node:net').AddressInfo
  const dir = mkdtempSync(join(tmpdir(), 'main-providers-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  const svc = createWizardServer({
    upstreamOrigin: `http://127.0.0.1:${mainAddress.port}`, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
    followThrough: false, agentBasePort: 47990, runQueue: false, ...(on ? { mainProviderAttach: true } : {}),
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  return { dir, call, reached }
}

const slugs = (payload: any) => (payload?.providers ?? []).map((p: any) => p.slug)

describe('main agent provider attach (issue 428)', () => {
  it('switch off: the main agent picker shows every connected provider, as before', async () => {
    const { call } = await box(false)
    const r = await call('GET', '/wizard/hermes/api/model/options')
    expect(r.status).toBe(200)
    expect(slugs(r.json)).toEqual(['wizard-tinfoil', 'openai-codex', 'anthropic', 'openrouter'])
    expect((await call('GET', '/wizard/v1/main-providers')).status).toBe(404)
  })

  it('switch on: later sign-ins stay in the pool; the main agent keeps only its onboarding provider', async () => {
    const { call, dir } = await box(true)
    const r = await call('GET', '/wizard/hermes/api/model/options')
    expect(r.status).toBe(200)
    expect(slugs(r.json)).toEqual(['wizard-tinfoil'])
    expect(r.json.provider).toBe('custom:wizard-tinfoil')
    expect(r.json.wizard_attached_providers).toEqual(['wizard-tinfoil'])
    expect(r.json.wizard_unattached_providers.map((p: any) => p.slug)).toEqual(['openai-codex', 'anthropic'])
    expect(JSON.parse(readFileSync(join(dir, 'agents', '.main-providers.json'), 'utf8')).attached).toEqual(['wizard-tinfoil'])
    const state = await call('GET', '/wizard/v1/main-providers')
    expect(state.json.pool).toEqual([
      { slug: 'wizard-tinfoil', name: 'Tinfoil', attached: true },
      { slug: 'openai-codex', name: 'ChatGPT', attached: false },
      { slug: 'anthropic', name: 'Claude', attached: false },
    ])
  })

  it('switch on: a thread model change, new thread or run on an unattached provider never reaches Hermes', async () => {
    const { call, reached } = await box(true)
    const before = reached.length
    for (const [method, path, body] of [
      ['POST', '/wizard/hermes/api/sessions/wizard_s1/model', { model: 'gpt-6.1-sol', provider: 'openai-codex' }],
      ['POST', '/wizard/hermes/api/sessions', { id: 'wizard_s2', model: 'claude-opus-5-5', provider: 'anthropic' }],
      ['POST', '/wizard/hermes/v1/runs', { session_id: 'wizard_s1', input: 'hi', model: 'claude-opus-5-5', provider: 'anthropic' }],
    ] as const) {
      const r = await call(method, path, body)
      expect(r.status).toBe(409)
      expect(r.json.error).toBe('provider_not_attached')
    }
    // Only reads happened (thread lookups, the inventory): no write carried the unattached provider.
    expect(reached.slice(before).filter((x) => x.body).map((x) => x.path)).toEqual([])
    // The attached provider still works, in either spelling.
    expect((await call('POST', '/wizard/hermes/api/sessions/wizard_s1/model', { model: 'glm-5-3', provider: 'custom:wizard-tinfoil' })).status).toBe(200)
    expect(reached.some((x) => x.path === '/api/sessions/wizard_s1/model')).toBe(true)
  })

  it('switch on: attaching is an explicit owner action, and detaching takes the provider away again', async () => {
    const { call } = await box(true)
    const put = await call('PUT', '/wizard/v1/main-providers', { attached: ['custom:wizard-tinfoil', 'openai-codex'] })
    expect(put.status).toBe(200)
    expect(put.json.attached).toEqual(['wizard-tinfoil', 'openai-codex'])
    expect(slugs((await call('GET', '/wizard/hermes/api/model/options')).json)).toEqual(['wizard-tinfoil', 'openai-codex'])
    expect((await call('POST', '/wizard/hermes/api/sessions/wizard_s1/model', { model: 'gpt-6.1-sol', provider: 'openai-codex' })).status).toBe(200)
    expect((await call('PUT', '/wizard/v1/main-providers', { attached: 'anthropic' })).status).toBe(400)
    expect((await call('PUT', '/wizard/v1/main-providers', { attached: ['Bad Slug!'] })).status).toBe(400)
    await call('PUT', '/wizard/v1/main-providers', { attached: ['wizard-tinfoil'] })
    expect((await call('POST', '/wizard/hermes/api/sessions/wizard_s1/model', { model: 'gpt-6.1-sol', provider: 'openai-codex' })).status).toBe(409)
  })

  it('a box with no provider yet is left alone until onboarding picks one', async () => {
    const { call, dir } = await box(true, '')
    expect(slugs((await call('GET', '/wizard/hermes/api/model/options')).json)).toHaveLength(4)
    expect(existsSync(join(dir, 'agents', '.main-providers.json'))).toBe(false)
  })

  it('attaches only the configured provider, once: a later default switch by a sign-in hook adds nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'main-providers-unit-'))
    let current = options()
    const attach = createMainProviderAttach({ path: join(dir, 'p.json'), loadOptions: async () => current })
    expect(slugs(attach.filterOptions(current))).toEqual(['wizard-tinfoil'])
    current = options('anthropic')
    expect(slugs(attach.filterOptions(current))).toEqual(['wizard-tinfoil'])
    expect(await attach.refusal({ provider: 'anthropic' })).toMatchObject({ error: 'provider_not_attached', provider: 'anthropic' })
    expect(await attach.refusal({ model: 'claude-opus-5-5' })).toBeNull()
  })
})
