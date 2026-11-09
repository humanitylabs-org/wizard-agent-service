// Issue 409: the agent builder offers Claude from a connected Claude app when the gateway's
// anthropic slug reads signed out (the box's Claude login is app-owned). Switch:
// WIZARD_AGENT_CLAUDE_FROM_APP=1 (option agentClaudeFromApp), off by default.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { createAgentRegistry } from '../server/agents.mjs'
import { connectedProviderModels } from '../server/ai-usage.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

const CLAUDE_MODELS = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'fast', abilities: ['text'] },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'standard', abilities: ['text'] },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'frontier', abilities: ['text'] },
]
const connected = { contract: 'wizard.ai-connection/2', provider: 'claude', name: 'Claude', status: 'connected', plan: 'Max 20x', account: null, usage: null, error: null, models: CLAUDE_MODELS }
// What the live gateway reports on a box whose Claude login lives in the Claude app.
const gatewayProviders = [
  { slug: 'anthropic', name: 'Anthropic', authenticated: false, models: [] },
  { slug: 'claude-subscription-directsdk-experimental', name: 'Claude (DirectSDK)', authenticated: true, models: ['claude-opus-5-5'] },
  { slug: 'openai-codex', name: 'Codex', authenticated: true, models: ['gpt-6.1-sol'] },
]

async function serve(handler: (path: string) => unknown) {
  const server = createServer((req, res) => {
    const body = handler(new URL(req.url ?? '/', 'http://x').pathname)
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body ?? { error: 'nope' }))
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function box(claudeOrigin: string) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-from-app-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [
    { id: 'wizard-claude', name: 'Claude', status: 'running', provides: ['ai-connection', 'claude-subscription'], view: { local: `${claudeOrigin}/` } },
  ] }))
  return dir
}

const ids = (providers: any[]) => providers.map((p) => p.id)

describe('connectedProviderModels', () => {
  it('returns the curated models of a connected /2 app and nothing otherwise', async () => {
    let payload: unknown = connected
    const origin = await serve((path) => (path === '/api/connection' ? payload : undefined))
    const apps = join(box(origin), 'apps.json')
    expect(await connectedProviderModels(apps, 'claude')).toEqual(CLAUDE_MODELS.map(({ id, label }) => ({ id, label })))
    expect(await connectedProviderModels(apps, 'chatgpt')).toEqual([])
    payload = { ...connected, status: 'not_connected', error: { code: 'signed_out', message: 'x' } }
    expect(await connectedProviderModels(apps, 'claude')).toEqual([])
    payload = { ...connected, contract: 'wizard.ai-connection/1' }
    expect(await connectedProviderModels(apps, 'claude')).toEqual([])
    payload = { ...connected, models: [{ id: 'bad id!' }, { id: 'claude-sonnet-5' }, { id: 'claude-sonnet-5' }] }
    expect(await connectedProviderModels(apps, 'claude')).toEqual([{ id: 'claude-sonnet-5', label: 'claude-sonnet-5' }])
    expect(await connectedProviderModels('', 'claude')).toEqual([])
  })
})

describe('agent builder providers (issue 409)', () => {
  it('adds the Claude row from the connector when the gateway slug is signed out', async () => {
    const registry = createAgentRegistry({ agentsDir: mkdtempSync(join(tmpdir(), 'agents-')), mainProviders: async () => gatewayProviders,
      claudeConnectionModels: async () => CLAUDE_MODELS })
    const providers = await registry.providers()
    expect(ids(providers)).toEqual(['tinfoil', 'anthropic', 'openai-codex'])
    expect(providers[1]).toEqual({ id: 'anthropic', label: 'Claude (AI Accounts)', confidential: false,
      models: CLAUDE_MODELS.map(({ id, label }) => ({ id, label })) })
  })

  it('keeps the gateway row when the gateway is signed in, and the old list without the connector', async () => {
    let asked = 0
    const signedIn = [{ slug: 'anthropic', authenticated: true, models: ['claude-opus-5.5'] }, gatewayProviders[2]]
    const registry = createAgentRegistry({ agentsDir: mkdtempSync(join(tmpdir(), 'agents-')), mainProviders: async () => signedIn,
      claudeConnectionModels: async () => { asked += 1; return CLAUDE_MODELS } })
    expect((await registry.providers())[1].models).toEqual([{ id: 'claude-opus-5-5', label: 'claude-opus-5-5' }])
    expect(asked).toBe(0)
    const off = createAgentRegistry({ agentsDir: mkdtempSync(join(tmpdir(), 'agents-')), mainProviders: async () => gatewayProviders })
    expect(ids(await off.providers())).toEqual(['tinfoil', 'openai-codex'])
    const failing = createAgentRegistry({ agentsDir: mkdtempSync(join(tmpdir(), 'agents-')), mainProviders: async () => gatewayProviders,
      claudeConnectionModels: async () => { throw new Error('down') } })
    expect(ids(await failing.providers())).toEqual(['tinfoil', 'openai-codex'])
  })

  for (const on of [false, true]) {
    it(`GET /wizard/v1/agent-options ${on ? 'offers' : 'does not offer'} Claude from the app with the switch ${on ? 'on' : 'off'}`, async () => {
      const claude = await serve((path) => (path === '/api/connection' ? connected : undefined))
      const main = await serve((path) => (path === '/health' ? { status: 'ok' } : path === '/api/model/options' ? { providers: gatewayProviders } : undefined))
      const dir = box(claude)
      const svc = createWizardServer({
        upstreamOrigin: main, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
        appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
        agentRuntime: { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
        followThrough: false, agentBasePort: 47950, ...(on ? { agentClaudeFromApp: true } : {}),
      })
      servers.push(svc)
      const address = await listen(svc) as import('node:net').AddressInfo
      const options = await (await fetch(`http://127.0.0.1:${address.port}/wizard/v1/agent-options`)).json()
      expect(ids(options.providers)).toEqual(on ? ['tinfoil', 'anthropic', 'openai-codex'] : ['tinfoil', 'openai-codex'])
      if (on) expect(options.providers[1].models.map((m: any) => m.id)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5'])
    })
  }
})
