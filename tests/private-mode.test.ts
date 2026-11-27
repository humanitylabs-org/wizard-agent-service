// Issue 626: turn private mode on / off on an existing box, plus the Privacy check data. On for everyone (James said
// yes at show-and-tell, 27 Nov 2026: the `wizard/private-mode` switch is removed).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { jobRunsOnApp, providerCompany } from '../server/private-mode.mjs'

const servers: Server[] = []
const schedulers: any[] = []
afterEach(async () => {
  for (const s of schedulers.splice(0)) s?.stop?.()
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)))
})

const APPS = [
  { id: 'wizard-mail', name: 'Mail', status: 'running', privacy: 'private', view: { url: '/mail/' }, mcp: { url: 'http://mail/mcp' }, agent_binding: { required: true, purpose: 'Where mail summaries go' } },
  { id: 'wizard-notes', name: 'Notes', status: 'running', view: { url: '/notes/' }, mcp: { url: 'http://notes/mcp' } },
  { id: 'messenger', name: 'Messenger', status: 'running', view: { url: '/messenger/' }, mcp: { url: 'http://messenger/mcp' }, agent_binding: true },
  { id: 'meditate', name: 'Meditate', status: 'running', view: { url: '/meditate/' } },
  { id: 'wizard-claude', name: 'Claude', status: 'running', provides: ['ai-connection'], mcp: { url: 'http://claude/mcp' } },
]

async function box({ look = undefined as boolean | undefined, standardChats = false, mainApps = undefined as string[] | undefined } = {}) {
  const main = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      const json = (v: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
      if (path === '/health') return json({ status: 'ok' })
      if (path === '/api/model/options') return json({ provider: 'anthropic', model: 'claude-opus-5-5', providers: [{ slug: 'anthropic', name: 'Claude', authenticated: true, models: ['claude-opus-5-5'] }] })
      if (path === '/api/sessions') return json({ data: [] })
      res.writeHead(404); res.end('{}')
    })
  })
  servers.push(main)
  const mainAddress = await listen(main) as import('node:net').AddressInfo
  const dir = mkdtempSync(join(tmpdir(), 'private-mode-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: APPS }))
  // Mail on the standard agent today (the owner ticked it before private mode).
  writeFileSync(join(dir, 'agents', '.main-agent.json'), JSON.stringify({ schema: 1, wizard_apps: mainApps ?? ['wizard-mail', 'wizard-notes', 'messenger', 'meditate'], agent_apps: ['wizard-claude'] }))
  if (look !== undefined) {
    mkdirSync(join(dir, 'Pages', 'wizard-look'), { recursive: true })
    writeFileSync(join(dir, 'Pages', 'wizard-look', 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { 'wizard/private-mode': { on: look, at: 1 } } }))
  }
  const applied: string[] = []
  const svc = createWizardServer({
    upstreamOrigin: `http://127.0.0.1:${mainAddress.port}`, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: { apply: async (id: string) => { applied.push(id); return { ok: true } }, start: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
    schedulerStatePath: join(dir, 'schedules.sqlite'), schedulerIntervalMs: 3_600_000,
    followThrough: false, agentBasePort: 47930, runQueue: false,
    ...(standardChats ? { standardChatsUrl: 'http://wizard-agent-service:8787/wizard/standard-chats/mcp' } : {}),
    pagesRoot: join(dir, 'Pages'), pagesGitDir: join(dir, 'pages-history.git'), pagesWatch: false,
  }) as Server & { scheduler?: any }
  servers.push(svc)
  schedulers.push(svc.scheduler)
  const address = await listen(svc) as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, json: await r.json().catch(() => null) as any }
  }
  const agents = async () => (await call('GET', '/wizard/v1/agents')).json.agents as any[]
  const appsOf = async (id: string) => { const a = (await agents()).find((x) => x.id === id); return a ? [...a.permissions.wizard_apps, ...a.permissions.agent_apps].sort() : null }
  const bindings = async () => Object.fromEntries((await call('GET', '/wizard/v1/app-bindings')).json.bindings.map((x: any) => [x.app_id, x.agent]))
  const settings = () => { try { return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) } catch { return {} } }
  return { dir, call, agents, appsOf, bindings, settings, applied }
}

describe('private mode on an existing box (issue 626)', () => {
  it('no switch: available on every box, even with an old Look file saying off; reading it changes nothing; the owner page only', async () => {
    for (const look of [undefined, false]) {
      const b = await box({ look })
      expect((await b.call('GET', '/wizard/v1/private-mode')).json).toMatchObject({ schema: 'wizard.private-mode/1', on: true, mode: 'off', next_step: 'agent', private_agent: null })
      expect((await b.call('GET', '/wizard/v1/privacy-check')).status).toBe(200)
      expect((await b.agents()).map((a) => a.id)).toEqual(['hermes'])
      expect(existsSync(join(b.dir, 'agents', '.private-mode.json'))).toBe(false)
      expect(b.applied).toEqual([])
    }
    const b = await box()
    expect((await b.call('POST', '/wizard/v1/private-mode/agent', {}, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await b.call('GET', '/wizard/v1/private-mode/agent')).status).toBe(405)
  })

  it('turn on with Mail and Notes: private agent is the default, the apps reach only it, Mail sends its work there, its schedule moves; off undoes it', async () => {
    const b = await box()
    const job = await b.call('POST', '/wizard/v1/schedules', { name: 'Morning digest', when: { cron: '0 8 * * *' }, prompt: 'Summarise my Mail inbox', agent: 'main' })
    expect(job.status).toBe(201)
    const other = await b.call('POST', '/wizard/v1/schedules', { name: 'Weather', when: { cron: '0 7 * * *' }, prompt: 'Weather today', agent: 'main' })
    const r = await b.call('POST', '/wizard/v1/private-mode/on', { apps: ['wizard-mail', 'wizard-notes'] })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, agent: 'private', created: true, state: { mode: 'on', next_step: 'done', private_agent: 'private', moved_apps: ['wizard-mail', 'wizard-notes'], default_agent: 'private', context: { granted: true } } })
    const priv = (await b.agents()).find((a) => a.id === 'private')
    expect(priv).toMatchObject({ privacy: 'private', is_default: true, model: { provider: 'tinfoil', fallback: false } })
    expect(await b.appsOf('private')).toEqual(['wizard-mail', 'wizard-notes'])
    expect(await b.appsOf('hermes')).toEqual(['meditate', 'messenger', 'wizard-claude'])
    expect(b.settings().agents.default_agent_id).toBe('private')
    // Mail's work lands on the private agent; Messenger (not moved) keeps sending to the standard agent.
    expect(await b.bindings()).toEqual({ 'wizard-mail': 'private', messenger: 'hermes' })
    const jobs = (await b.call('GET', '/wizard/v1/schedules')).json.schedules
    expect(jobs.find((j: any) => j.id === job.json.id)).toMatchObject({ agent: 'private', thread: null })
    expect(jobs.find((j: any) => j.id === other.json.id)).toMatchObject({ agent: 'main' })
    // Bring your context along: one way, private reads standard.
    expect((await b.call('GET', '/wizard/v1/agent-grants')).json.grants).toMatchObject([{ reader: 'private', source: 'hermes', scope: 'read' }])

    // Retry: nothing doubled.
    const again = await b.call('POST', '/wizard/v1/private-mode/on', { apps: ['wizard-mail', 'wizard-notes'] })
    expect(again.json.results.map((x: any) => x.moved)).toEqual([false, false])
    expect((await b.agents()).filter((a) => a.privacy === 'private')).toHaveLength(1)
    expect((await b.call('GET', '/wizard/v1/agent-grants')).json.grants).toHaveLength(1)
    expect(b.applied.filter((id) => id === 'private').length).toBeGreaterThan(0)

    const off = await b.call('POST', '/wizard/v1/private-mode/off', {})
    expect(off.status).toBe(200)
    expect(off.json.state).toMatchObject({ mode: 'off', private_agent: 'private', default_agent: 'hermes', moved_apps: [] })
    expect(await b.appsOf('hermes')).toEqual(['meditate', 'messenger', 'wizard-claude', 'wizard-mail', 'wizard-notes'])
    expect(b.settings().agents.default_agent_id).toBe('hermes')
    expect(await b.bindings()).toEqual({ 'wizard-mail': 'hermes', messenger: 'hermes' })
    expect((await b.call('GET', '/wizard/v1/schedules')).json.schedules.find((j: any) => j.id === job.json.id)).toMatchObject({ agent: 'main' })
    expect((await b.call('GET', '/wizard/v1/agent-grants')).json.grants).toEqual([])
    // The private agent is kept (sealed, with its history); deleting it stays separate.
    expect((await b.agents()).find((a) => a.id === 'private')).toMatchObject({ privacy: 'private', is_default: false })
    const pm = JSON.parse(readFileSync(join(b.dir, 'agents', '.private-mode.json'), 'utf8'))
    expect(pm.private_agent).toBe('private')

    // On again: the same private agent, nothing new.
    const on2 = await b.call('POST', '/wizard/v1/private-mode/on', { apps: ['wizard-mail'] })
    expect(on2.json).toMatchObject({ agent: 'private', created: false, state: { mode: 'on', moved_apps: ['wizard-mail'] } })
    expect((await b.agents()).filter((a) => a.privacy === 'private')).toHaveLength(1)
  })

  it('leaving after the agent step resumes at the Privacy check with nothing duplicated', async () => {
    const b = await box()
    const first = await b.call('POST', '/wizard/v1/private-mode/agent', {})
    expect(first.json).toMatchObject({ agent: 'private', created: true, state: { mode: 'setting_up', next_step: 'apps' } })
    expect((await b.call('GET', '/wizard/v1/private-mode')).json).toMatchObject({ mode: 'setting_up', next_step: 'apps', default_agent: 'hermes' })
    expect((await b.call('POST', '/wizard/v1/private-mode/agent', {})).json).toMatchObject({ agent: 'private', created: false })
    expect((await b.call('POST', '/wizard/v1/private-mode/apps', { move: ['wizard-mail', 'wizard-claude'] })).json.results)
      .toEqual([{ app_id: 'wizard-mail', ok: true, moved: true, schedules: [] }, { app_id: 'wizard-claude', ok: false, error: 'standard_only_app' }])
    expect((await b.call('GET', '/wizard/v1/private-mode')).json).toMatchObject({ next_step: 'context' })
    expect((await b.call('POST', '/wizard/v1/private-mode/context', { grant: false })).json).toMatchObject({ granted: false, state: { next_step: 'default' } })
    expect((await b.call('GET', '/wizard/v1/agent-grants')).json.grants).toEqual([])
    expect((await b.call('POST', '/wizard/v1/private-mode/default', { private: false })).json).toMatchObject({ default_agent: 'hermes', state: { mode: 'on' } })
    expect((await b.agents()).filter((a) => a.privacy === 'private')).toHaveLength(1)
    // Move to standard from the Privacy check.
    expect((await b.call('POST', '/wizard/v1/private-mode/apps', { back: ['wizard-mail'] })).json.results).toEqual([{ app_id: 'wizard-mail', ok: true, moved: true }])
    expect(await b.appsOf('hermes')).toContain('wizard-mail')
    expect(await b.bindings()).toEqual({ 'wizard-mail': 'hermes', messenger: 'hermes' })
  })

  it('reuses an owner-made private agent and grants DECISIONS 81 standard-chat reads where the box has them', async () => {
    const b = await box({ standardChats: true })
    const made = await b.call('POST', '/wizard/v1/agents', { label: 'Vault', permissions: { preset: 'private', read_standard_chats: false }, model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3'], fallback: false } })
    expect(made.status).toBe(201)
    const r = await b.call('POST', '/wizard/v1/private-mode/on', { apps: [], make_default: false })
    expect(r.json).toMatchObject({ agent: 'vault', created: false, state: { context: { granted: true, how: 'read_standard_chats' }, default_agent: 'hermes' } })
    expect((await b.agents()).find((a) => a.id === 'vault').permissions.read_standard_chats).toBe(true)
    await b.call('POST', '/wizard/v1/private-mode/off', {})
    expect((await b.agents()).find((a) => a.id === 'vault').permissions.read_standard_chats).toBe(false)
  })

  it('Privacy check: every app, its personal-data flag, which agent uses it and whose servers, with private mode off and on', async () => {
    const b = await box()
    const offCheck = (await b.call('GET', '/wizard/v1/privacy-check')).json
    expect(offCheck).toMatchObject({ schema: 'wizard.privacy-check/1', private_mode: 'off', default_agent: 'hermes' })
    const mail = offCheck.apps.find((a: any) => a.app_id === 'wizard-mail')
    expect(mail).toMatchObject({ personal_data: true, lines: ['Mail → Hermes → Anthropic'], private_only: false, sends_work_to: { id: 'hermes', company: 'Anthropic' } })
    expect(offCheck.apps[0].app_id).toBe('wizard-mail')
    expect(offCheck.apps.find((a: any) => a.app_id === 'meditate').personal_data).toBe(false)
    expect(offCheck.agents).toEqual([{ id: 'hermes', label: 'Hermes', privacy: 'standard', is_default: true, provider: 'anthropic', model: 'claude-opus-5-5', company: 'Anthropic', private_inference: false }])
    await b.call('POST', '/wizard/v1/private-mode/on', { apps: ['wizard-mail'] })
    const onCheck = (await b.call('GET', '/wizard/v1/privacy-check')).json
    expect(onCheck.private_mode).toBe('on')
    expect(onCheck.apps.find((a: any) => a.app_id === 'wizard-mail')).toMatchObject({ lines: ['Mail → Private → Tinfoil'], private_only: true, moved: true, sends_work_to: { id: 'private', privacy: 'private' } })
    expect(onCheck.agents.find((a: any) => a.id === 'private')).toMatchObject({ company: 'Tinfoil', private_inference: true, is_default: true })
  })

  it('wizard-os#929: an app declares personal data with personal_data (a label only); undeclared apps are not personal', async () => {
    const b = await box()
    const apps = [
      ...APPS.filter((a) => a.id !== 'messenger'),
      { id: 'messenger', name: 'Messenger', status: 'running', view: { url: '/messenger/' }, mcp: { url: 'http://messenger/mcp' }, personal_data: 'reads your messages' },
      { id: 'photos', name: 'Photos', status: 'running', view: { url: '/photos/' }, personal_data: true },
      { id: 'game', name: 'Game', status: 'running', view: { url: '/game/' }, personal_data: '' },
      { id: 'wizard-notes2', name: 'Diary', status: 'running', view: { url: '/diary/' }, privacy: 'private', personal_data: '  reads your\n notes.  ' },
    ]
    writeFileSync(join(b.dir, 'apps.json'), JSON.stringify({ schema: 1, apps }))
    const check = (await b.call('GET', '/wizard/v1/privacy-check')).json
    const row = (id: string) => check.apps.find((a: any) => a.app_id === id)
    expect(row('messenger')).toMatchObject({ personal_data: true, personal_data_reads: 'reads your messages' })
    expect(row('photos').personal_data).toBe(true)
    expect(row('photos')).not.toHaveProperty('personal_data_reads')
    expect(row('wizard-notes2')).toMatchObject({ personal_data: true, personal_data_reads: 'reads your notes' })
    expect(row('game').personal_data).toBe(false)
    expect(row('meditate').personal_data).toBe(false)
    // The install sheet's read: the label is reported, and nothing about who can use the app changes.
    const sheet = (await b.call('GET', '/wizard/v1/apps/messenger/agents')).json
    expect(sheet).toMatchObject({ privacy: 'standard', personal_data: true, personal_data_reads: 'reads your messages' })
    expect(sheet).not.toHaveProperty('needs_private_agent')
    expect(sheet.agents.find((a: any) => a.id === 'hermes').enabled).toBe(true)
    const game = (await b.call('GET', '/wizard/v1/apps/game/agents')).json
    expect(game).not.toHaveProperty('personal_data')
    expect(game).not.toHaveProperty('personal_data_reads')
  })

  it('helpers: provider company and which schedules run on an app', () => {
    expect(providerCompany('openai-codex')).toBe('OpenAI')
    expect(providerCompany('claude-subscription-directsdk-experimental')).toBe('Anthropic')
    expect(providerCompany('tinfoil')).toBe('Tinfoil')
    expect(providerCompany('')).toBe(null)
    const mail = { id: 'wizard-mail', name: 'Mail' }
    expect(jobRunsOnApp({ skill: 'wizard-mail' }, mail)).toBe(true)
    expect(jobRunsOnApp({ prompt: 'check wizard-mail for invoices' }, mail)).toBe(true)
    expect(jobRunsOnApp({ prompt: 'Summarise my mail' }, mail)).toBe(true)
    expect(jobRunsOnApp({ prompt: 'reply to the email from Bob' }, mail)).toBe(false)
    expect(jobRunsOnApp({ prompt: 'wizard-mailer stats' }, mail)).toBe(false)
  })
})
