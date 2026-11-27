// Issue 629: private routing, on for everyone (switch wizard/private-routing removed). With a private default agent the
// orb route names the agent each take is for: a spoken agent or model name, else the private router's personal-data
// label (private only), else the thread in front, else the default (private) agent. A non-private router is never
// called. No private default: the route answers exactly as before.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import * as routing from '../server/private-routing.mjs'

const { agentNames, modelWords, nameRule } = routing
const routingNames = routing.routingNames as (input: any) => any
const chooseAgent = routing.chooseAgent as (input: any) => any
const privateLabelBlock = routing.privateLabelBlock as (input: any) => string

const servers: Server[] = []
const schedulers: any[] = []
afterEach(async () => {
  for (const s of schedulers.splice(0)) s?.stop?.()
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)))
})

const OPTIONS = { provider: 'anthropic', model: 'claude-opus-5-5', providers: [
  { slug: 'anthropic', name: 'Claude', authenticated: true, models: ['claude-opus-5-5', 'claude-fable-5'] },
  { slug: 'openai-codex', name: 'ChatGPT', authenticated: true, models: ['gpt-5.5'] },
] }
const PERSONAL = /Messenger|spend|Sam/u

async function box({ lookOff = false, privateDefault = true, routerHost = 'loopback' as 'loopback' | 'public' | 'none' } = {}) {
  const json = (res: any, v: unknown, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
  const main = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const p = new URL(req.url ?? '/', 'http://x').pathname
      if (p === '/health') return json(res, { status: 'ok' })
      if (p === '/api/model/options') return json(res, OPTIONS)
      if (p === '/api/sessions') return json(res, { data: [] })
      json(res, {}, 404)
    })
  })
  servers.push(main)
  const mainAddress = await listen(main) as import('node:net').AddressInfo
  const prompts: string[] = []
  const calls = { private: 0, public: 0 }
  let reply: Record<string, unknown> = { route: 'agent', summary: 'the router rewrite' }
  const router = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      calls.private += 1
      const body = JSON.parse(b)
      prompts.push(body.messages[0].content)
      json(res, { choices: [{ message: { content: JSON.stringify({ ...reply, personal: PERSONAL.test(body.messages[1].content) }) } }] })
    })
  })
  servers.push(router)
  const routerAddress = await listen(router) as import('node:net').AddressInfo
  const dir = mkdtempSync(join(tmpdir(), 'private-routing-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  mkdirSync(join(dir, 'Pages', 'wizard-look'), { recursive: true })
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [
    { id: 'messenger', name: 'Messenger', status: 'running', privacy: 'private', view: { url: '/messenger/' }, mcp: { url: 'http://messenger/mcp' } },
    { id: 'wizard-notes', name: 'Notes', status: 'running', view: { url: '/notes/' }, mcp: { url: 'http://notes/mcp' } },
  ] }))
  const endpoint = routerHost === 'public' ? 'https://router.example.invalid/v1/chat/completions' : `http://127.0.0.1:${routerAddress.port}/v1/chat/completions`
  if (routerHost !== 'none') writeFileSync(join(dir, 'settings.json'), JSON.stringify({ fast_router: { endpoint, model: 'fixture-router' } }))
  writeFileSync(join(dir, 'Pages', 'wizard-look', 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: {
    // An old Look file may still hold the removed switch, saying off: it is ignored.
    ...(lookOff ? { 'wizard/private-routing': { on: false, at: 1 } } : {}) } }))
  const fetchImpl = async (url: any, init: any) => {
    if (String(url).includes('router.example.invalid')) {
      calls.public += 1
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }))
    }
    return fetch(url, init)
  }
  const svc = createWizardServer({
    upstreamOrigin: `http://127.0.0.1:${mainAddress.port}`, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir, fetchImpl,
    agentRuntime: { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
    schedulerStatePath: join(dir, 'schedules.sqlite'), schedulerIntervalMs: 3_600_000, followThrough: false, agentBasePort: 47990, runQueue: false,
    agentInboxStatePath: join(dir, 'state', 'agent-inbox.json'),
    pagesRoot: join(dir, 'Pages'), pagesGitDir: join(dir, 'pages-history.git'), pagesWatch: false,
  }) as Server & { scheduler?: any }
  servers.push(svc)
  schedulers.push(svc.scheduler)
  const address = await listen(svc) as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, json: await r.json().catch(() => null) as any }
  }
  if (privateDefault) expect((await call('POST', '/wizard/v1/private-mode/on', { apps: ['messenger'] })).status).toBe(200)
  expect((await call('POST', '/wizard/v1/agents', { label: 'Philosopher', preset: 'standard', model: { provider: 'anthropic', model: 'claude-fable-5' } })).status).toBe(201)
  const route = async (text: string, extra = {}) => (await call('POST', '/wizard/v1/route', { text, apps: [], ...extra })).json
  return { call, route, calls, prompts, setReply: (r: Record<string, unknown>) => { reply = r } }
}

const THREAD = 'wizard_1764000000000_aaaaaaaaaaaa'

describe('private routing rules (issue 629)', () => {
  const names = routingNames({
    agents: [
      { id: 'hermes', label: 'James', privacy: 'standard', model: { provider: 'host', model: '', allowed_models: [] } },
      { id: 'philosopher', label: 'Philosopher', privacy: 'standard', model: { provider: 'anthropic', model: 'claude-fable-5', allowed_models: ['claude-fable-5', 'claude-opus-5-5'] } },
      { id: 'private', label: 'Private', privacy: 'private', model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3', 'deepseek-v4-1-flash'] } },
      { id: 'helper', label: 'Helper', privacy: 'standard', role: 'recovery', model: { provider: 'anthropic', model: 'x', allowed_models: [] } },
    ],
    providers: [{ id: 'tinfoil', confidential: true, models: [{ id: 'glm-5-3', label: 'GLM 5.3' }] },
      { id: 'anthropic', models: [{ id: 'claude-opus-5-5' }, { id: 'claude-fable-5' }] }, { id: 'openai-codex', models: [{ id: 'gpt-5.5' }] }],
    mainModel: 'claude-opus-5-5',
  })

  it('names come from the registry and the model list', () => {
    expect(agentNames({ id: 'research-bot', label: 'Research Bot' })).toEqual(['research bot', 'research'])
    expect(modelWords('anthropic', 'claude-opus-5-5')).toEqual(['claude', 'opus'])
    expect(modelWords('openai-codex', 'gpt-5.5-mini')).toEqual(['gpt', 'chatgpt', 'openai'])
    expect(names.named.map((a) => a.id)).toEqual(['philosopher', 'private'])   // never main (owner's name), never recovery
  })

  it.each([
    ['Philosopher, what would Heraclitus say about this', { agent_id: 'philosopher' }],
    ['philosopher what would Heraclitus say', { agent_id: 'philosopher' }],
    ['Hey Philosopher: is time real?', { agent_id: 'philosopher' }],
    ['Can you ask the philosopher about Plato', { agent_id: 'philosopher' }],
    ['Philosopher, use Opus for this one', { agent_id: 'philosopher', model: 'claude-opus-5-5' }],
    ['Use Opus to review this plan', { agent_id: 'hermes', model: 'claude-opus-5-5' }],
    ['Fable, write a poem', { agent_id: 'philosopher', model: 'claude-fable-5' }],
    ['Ask ChatGPT for a recipe', { agent_id: 'hermes', model: 'gpt-5.5' }],
    ['use Claude to draft it', { agent_id: 'hermes', model: 'claude-opus-5-5' }],
    ['Use GLM for the summary', { agent_id: 'private', model: 'glm-5-3' }],
    ['Use DeepSeek for the summary', { agent_id: 'private', model: 'deepseek-v4-1-flash' }],
  ])('name rule: %s', (text, want) => expect(nameRule(text, names)).toMatchObject(want))

  it.each(['Fix the Chats scroll bug', 'Claude Monet paintings in Paris', 'What would a philosopher say', 'The opus of Bach', 'Tell Sam I am late', 'Wizard, open notes'])(
    'a topic alone names no agent: %s', (text) => expect(nameRule(text, names)).toBeNull())

  it('the label only ever moves toward the private agent; a private thread keeps personal data', () => {
    const t = { id: THREAD, agent: 'philosopher', private: false }
    expect(chooseAgent({ personal: true, privateId: 'private' })).toEqual({ agent_id: 'private', chosen_by: 'private_label' })
    expect(chooseAgent({ personal: false, privateId: 'private' })).toEqual({ agent_id: 'private', chosen_by: 'default' })
    expect(chooseAgent({ personal: true, thread: t, privateId: 'private' })).toEqual({ agent_id: 'private', chosen_by: 'private_label' })
    expect(chooseAgent({ personal: false, thread: t, privateId: 'private' })).toEqual({ agent_id: 'philosopher', thread_id: THREAD, chosen_by: 'thread' })
    expect(chooseAgent({ personal: true, thread: { id: THREAD, agent: 'private', private: true }, privateId: 'private' })).toMatchObject({ agent_id: 'private', chosen_by: 'thread' })
    expect(chooseAgent({ thread: t, privateId: 'private', rulesOnly: true })).toEqual({ agent_id: 'philosopher', thread_id: THREAD, chosen_by: 'rules_only', rule: 'thread' })
  })

  it('the label block names private apps and the latest corrections', () => {
    const block = privateLabelBlock({ apps: ['Messenger'], examples: [{ utterance: 'Ask about Kant', personal: false }, { utterance: 'Ping mum', personal: true }] })
    expect(block).toContain('"personal": true or false')
    expect(block).toContain('these private apps: Messenger')
    expect(block).toContain('- "Ping mum" -> "personal": true')
  })
})

describe('private routing over HTTP (issue 629)', () => {
  it('Done when: name, model, personal data, default and thread, with the exact words', async () => {
    const b = await box()
    const philosopher = await b.route('Philosopher, what would Heraclitus say about this')
    expect(philosopher.cmd).toEqual({ route: 'agent', summary: 'Philosopher, what would Heraclitus say about this', agent_id: 'philosopher', chosen_by: 'name' })
    expect(b.calls.private).toBe(0)   // a name settles it without any model
    expect((await b.route('Use Opus to review this plan')).cmd).toMatchObject({ route: 'agent', agent_id: 'hermes', model: 'claude-opus-5-5', chosen_by: 'name', summary: 'Use Opus to review this plan' })
    for (const text of ['What did Sam say in Messenger yesterday', 'how much did I spend on food this week']) {
      expect((await b.route(text)).cmd).toEqual({ route: 'agent', summary: text, agent_id: 'private', chosen_by: 'private_label' })
    }
    expect((await b.route('Fix the Chats scroll bug')).cmd).toEqual({ route: 'agent', summary: 'Fix the Chats scroll bug', agent_id: 'private', chosen_by: 'default' })
    expect((await b.route('and what about Plato', { thread_id: THREAD, thread_agent: 'philosopher' })).cmd)
      .toEqual({ route: 'agent', summary: 'and what about Plato', agent_id: 'philosopher', thread_id: THREAD, chosen_by: 'thread' })
    // The private router got the label (with Messenger named as a private app); its rewrite never reaches an agent.
    expect(b.prompts.every((p) => p.includes('PRIVATE LABEL') && p.includes('Messenger'))).toBe(true)
    expect(b.calls.private).toBe(4)
    // A command stays a command.
    b.setReply({ route: 'command', action: 'open_app', app: 'Notes' })
    expect((await b.route('Open notes')).cmd).toEqual({ route: 'command', action: 'open_app', app: 'Notes' })
  })

  it('a non-private router is never called; rules decide with chosen_by rules_only', async () => {
    const b = await box({ routerHost: 'public' })
    expect((await b.route('Fix the Chats scroll bug')).cmd).toEqual({ route: 'agent', summary: 'Fix the Chats scroll bug', agent_id: 'private', chosen_by: 'rules_only', rule: 'default' })
    expect((await b.route('What did Sam say in Messenger yesterday')).cmd).toMatchObject({ agent_id: 'private', chosen_by: 'rules_only', rule: 'default' })
    expect((await b.route('Philosopher, is time real?')).cmd).toMatchObject({ agent_id: 'philosopher', chosen_by: 'rules_only', rule: 'name' })
    expect((await b.route('and Plato?', { thread_id: THREAD, thread_agent: 'philosopher' })).cmd).toMatchObject({ agent_id: 'philosopher', thread_id: THREAD, chosen_by: 'rules_only', rule: 'thread' })
    expect(b.calls).toEqual({ private: 0, public: 0 })
    // No router at all: still routed by rules (before, a 404).
    const none = await box({ routerHost: 'none' })
    expect((await none.route('Fix the Chats scroll bug')).cmd).toMatchObject({ agent_id: 'private', chosen_by: 'rules_only', rule: 'default' })
  })

  it('a dump is the chosen agent\'s visible thread under private routing', async () => {
    const b = await box()
    b.setReply({ route: 'dump', title: 'Flights' })
    const r = await b.route('Research flights to Lisbon', { accept_dump: true })
    expect(r.cmd).toEqual({ route: 'agent', summary: 'Research flights to Lisbon', agent_id: 'private', chosen_by: 'default' })
    expect((await b.call('GET', '/wizard/v1/agent-inbox')).json.records ?? []).toEqual([])
  })

  it('records the choice on the Sent row and takes one correction for the private router', async () => {
    const b = await box()
    const r = await b.route('Fix the Chats scroll bug')
    const row = (await b.call('GET', `/wizard/v1/sent/${r.sent_id}`)).json.row
    expect(row).toMatchObject({ text: 'Fix the Chats scroll bug', route: 'agent', agent_id: 'private', chosen_by: 'default' })
    const fixed = await b.call('POST', `/wizard/v1/sent/${r.sent_id}/correct`, { agent: 'philosopher' })
    expect(fixed.status).toBe(200)
    expect(fixed.json).toMatchObject({ changed: true, row: { corrected: { agent: 'philosopher' } }, example: { wanted: 'philosopher', chosen: 'private', personal: false } })
    expect(fixed.json.row.correction_id).toBe(fixed.json.example.id)
    expect((await b.call('POST', `/wizard/v1/sent/${r.sent_id}/correct`, { agent: 'nobody' })).status).toBe(400)
    await b.route('Something else entirely')
    expect(b.prompts.at(-1)).toContain('- "Fix the Chats scroll bug" -> "personal": false')
  })

  it('no switch: an old Look file that says off changes nothing', async () => {
    const b = await box({ lookOff: true })
    expect((await b.route('Fix the Chats scroll bug')).cmd).toEqual({ route: 'agent', summary: 'Fix the Chats scroll bug', agent_id: 'private', chosen_by: 'default' })
  })

  it('no private default: the answer is exactly today\'s', async () => {
    for (const opts of [{ privateDefault: false }]) {
      const b = await box(opts as any)
      for (const text of ['Philosopher, what would Heraclitus say about this', 'What did Sam say in Messenger yesterday', 'Fix the Chats scroll bug']) {
        const r = await b.route(text)
        expect(Object.keys(r).sort()).toEqual(['cmd', 'model', 'ms', 'sent_id'])
        expect(r.cmd).toEqual({ route: 'agent', summary: 'the router rewrite', personal: PERSONAL.test(text) })
        expect(r.model).toBe('fixture-router')
      }
      expect(b.prompts.some((p) => p.includes('PRIVATE LABEL'))).toBe(false)
      expect(b.calls.private).toBe(3)
      const pub = await box({ ...opts, routerHost: 'public' } as any)
      await pub.route('Fix the Chats scroll bug')
      // A standard default agent: today a non-private router is still used for the orb. A private default agent:
      // never (issue 626, voice follows the default agent; the next test).
      expect(pub.calls.public).toBe(opts.privateDefault === false ? 1 : 0)
      // The agent correction exists only for privately routed rows: here it is today's 400 (should_reply).
      const sent = (await pub.route('Fix the Chats scroll bug again')).sent_id
      expect((await pub.call('POST', `/wizard/v1/sent/${sent}/correct`, { agent: 'philosopher' })).status).toBe(400)
    }
  })

  // owner-correction: humanitylabs-org/wizard-agent-service#626 · 2026-11-27 · "fix the voice leak first (with private mode on, an orb dump or voice router must not reach the standard agent; voice follows the default agent)"
  it('private mode on: no orb dump on the standard agent and no non-private router (issue 626)', async () => {
    {
      const pub = await box({ routerHost: 'public' })
      pub.setReply({ route: 'dump', title: 'Flights' })
      for (const text of ['Research flights to Lisbon', 'What did Sam say in Messenger yesterday']) {
        const r = await pub.route(text, { accept_dump: true })
        expect(r.cmd).toEqual({ route: 'agent', summary: text, agent_id: 'private', chosen_by: 'rules_only', rule: 'default' })
        expect(r.model).toBe('')
        const row = (await pub.call('GET', `/wizard/v1/sent/${r.sent_id}`)).json.row
        expect(row).toMatchObject({ route: 'agent', decided_by: 'fallback' })
        expect(row.rules_matched).toContain('rules_only')
      }
      expect(pub.calls.public).toBe(0)
      expect((await pub.call('GET', '/wizard/v1/agent-inbox')).json.records ?? []).toEqual([])
      // A typed message never starts the background worker either.
      const typed = await pub.route('Research flights to Lisbon', { accept_dump: true, source: 'typed' })
      expect(typed.typed).toEqual({ background: false, why: 'private_routing' })
      // A private router may still route (only it ever sees the words), but never into a dump.
      const loop = await box()
      loop.setReply({ route: 'dump', title: 'Flights' })
      const r = await loop.route('Research flights to Lisbon', { accept_dump: true })
      expect(r.cmd.route).not.toBe('dump')
      expect(loop.calls.private).toBe(1)
      expect((await loop.call('GET', '/wizard/v1/agent-inbox')).json.records ?? []).toEqual([])
    }
  })
})
