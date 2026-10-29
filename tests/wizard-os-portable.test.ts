import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { externalUrl, normalizeSettings } from '../server/wizard-os-settings.mjs'
import { routerSystemPrompt } from '../server/voice-router.mjs'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

type Upstream = { origin: string, bodies: Record<string, unknown>[] }

async function startHermes(features: Record<string, unknown>): Promise<Upstream> {
  const bodies: Record<string, unknown>[] = []
  const upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/v1/capabilities') {
      response.end(JSON.stringify({ features }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/runs') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(202).end(JSON.stringify({ run_id: 'run-1', status: 'started' }))
      return
    }
    response.writeHead(404).end('{}')
  })
  servers.push(upstream)
  const address = await listen(upstream)
  return { origin: `http://127.0.0.1:${(address as import('node:net').AddressInfo).port}`, bodies }
}

async function startWizard(options: Record<string, unknown>) {
  const wizard = createWizardServer({ hermesKey: 'fixture-key', requireAccess: false, ...options })
  servers.push(wizard)
  const address = await listen(wizard)
  return `http://127.0.0.1:${(address as import('node:net').AddressInfo).port}`
}

const STOCK = { delegation_delivery: undefined }
const FORK = {
  delegation_delivery: { supported: true, modes: ['background', 'join'], default: 'background' },
  response_rendering: { field: 'response_rendering', modes: ['plain_text', 'markdown'], default: 'plain_text' },
}

async function postRun(wizard: string) {
  return fetch(`${wizard}/wizard/hermes/v1/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'wizard_stock_1', input: 'hello' }),
  })
}

describe('stock Hermes compatibility', () => {
  it('prefer mode sends a plain run to a Hermes without join or markdown rendering', async () => {
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, joinedDelegation: 'prefer' })
    const response = await postRun(wizard)
    expect(response.status).toBe(202)
    expect(hermes.bodies).toHaveLength(1)
    expect(hermes.bodies[0]).not.toHaveProperty('delegation_delivery')
    expect(hermes.bodies[0]).not.toHaveProperty('response_rendering')
    expect(hermes.bodies[0].instructions).toEqual(expect.stringContaining('Wizard'))
  })

  it('prefer mode still asks for join and Markdown when Hermes advertises them', async () => {
    const hermes = await startHermes(FORK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, joinedDelegation: 'prefer' })
    expect((await postRun(wizard)).status).toBe(202)
    expect(hermes.bodies[0]).toMatchObject({ delegation_delivery: 'join', response_rendering: 'markdown' })
  })

  it('require mode keeps failing closed on a Hermes without join', async () => {
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, joinedDelegation: 'require' })
    expect((await postRun(wizard)).status).toBe(503)
    expect(hermes.bodies).toHaveLength(0)
  })
})

describe('Wizard OS settings, bootstrap and apps', () => {
  function osHome() {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-os-'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      owner: { name: 'Ada', place: 'Lisbon' }, agent: { name: 'Merlin' },
      clock: { timezone: 'Europe/Lisbon', day_starts_at: '05:30' }, voice: { vocabulary: ['Alfama'] },
    }))
    writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [
      { id: 'defleur-video', name: 'DeFleur Video', summary: 'Edit video', status: 'running', view: '/defleur/' },
      { id: 'bad', name: 'Bad', view: 'javascript:alert(1)' },
    ] }))
    writeFileSync(join(dir, 'launcher.json'), JSON.stringify({ links: [{ id: 'notes', name: 'Notes', url: '/notes/' }] }))
    return dir
  }

  it('bootstrap returns the settings file and what this box can do', async () => {
    const dir = osHome()
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, joinedDelegation: 'prefer', settingsPath: join(dir, 'settings.json') })
    const body = await (await fetch(`${wizard}/wizard/v1/bootstrap`)).json()
    expect(body.settings).toMatchObject({
      owner: { name: 'Ada', place: 'Lisbon' }, agent: { name: 'Merlin' },
      clock: { timezone: 'Europe/Lisbon', day_starts_at: '05:30' },
    })
    expect(body.capabilities).toMatchObject({ joined_delegation: false, markdown: false, router: false })
    expect(body.endpoints.route).toBe('')
  })

  it('bootstrap defaults to a neutral Wizard with the device clock', async () => {
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, joinedDelegation: 'prefer', settingsPath: '/nonexistent/settings.json' })
    const body = await (await fetch(`${wizard}/wizard/v1/bootstrap`)).json()
    expect(body.settings_source).toBe('default')
    expect(body.settings).toMatchObject({ owner: { name: '', place: '' }, agent: { name: 'Wizard' }, clock: { timezone: '', day_starts_at: '00:00' } })
  })

  it('network: base_url is one https origin (or loopback http); aliases are hostnames', () => {
    expect(normalizeSettings({}).network).toEqual({ base_url: '', aliases: [] })
    const n = normalizeSettings({ network: { base_url: 'https://Wizard.Tail1234.ts.net', aliases: ['private.example.com', 'PRIVATE.example.com', 'bad host', 'x'] } }).network
    expect(n).toEqual({ base_url: 'https://wizard.tail1234.ts.net', aliases: ['private.example.com'] })
    expect(normalizeSettings({ network: { base_url: 'http://127.0.0.1:8923' } }).network.base_url).toBe('http://127.0.0.1:8923')
    for (const bad of ['http://wizard.tail1234.ts.net', 'https://wizard.tail1234.ts.net/apps/', 'https://u:p@wizard.ts.net', 'javascript:alert(1)', 'https://w.ts.net/?a=1', 42]) {
      expect(normalizeSettings({ network: { base_url: bad } }).network.base_url).toBe('')
    }
  })

  it('externalUrl joins base_url and a path, and is empty before the box has an outside address', () => {
    const on = normalizeSettings({ network: { base_url: 'https://wizard.tail1234.ts.net' } })
    expect(externalUrl(on, '/cinequeue/')).toBe('https://wizard.tail1234.ts.net/cinequeue/')
    expect(externalUrl(on, '//evil.test/')).toBe('')
    expect(externalUrl(on, 'cinequeue')).toBe('')
    expect(externalUrl(normalizeSettings({}), '/cinequeue/')).toBe('')
  })

  it('bootstrap carries the network block to front ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-os-'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ network: { base_url: 'https://wizard.tail1234.ts.net', aliases: ['private.example.com'] } }))
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, joinedDelegation: 'prefer', settingsPath: join(dir, 'settings.json') })
    const body = await (await fetch(`${wizard}/wizard/v1/bootstrap`)).json()
    expect(body.settings.network).toEqual({ base_url: 'https://wizard.tail1234.ts.net', aliases: ['private.example.com'] })
  })

  it('rejects an invalid time zone instead of guessing one', () => {
    expect(normalizeSettings({ clock: { timezone: 'Mars/Olympus', day_starts_at: '25:00' } }).clock)
      .toEqual({ timezone: '', day_starts_at: '00:00' })
  })

  it('apps merges apps.json with the owner launcher and drops unsafe links', async () => {
    const dir = osHome()
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, appsJsonPath: join(dir, 'apps.json'), launcherPath: join(dir, 'launcher.json') })
    const body = await (await fetch(`${wizard}/wizard/v1/apps`)).json()
    expect(body.apps.map((app: { id: string, url: string }) => [app.id, app.url])).toEqual([
      ['defleur-video', '/defleur/'], ['bad', ''], ['notes', '/notes/'],
    ])
  })

  it('every run is told it is inside Wizard OS and which jobs the apps do, re-read per run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-os-'))
    const appsJson = join(dir, 'apps.json')
    writeFileSync(appsJson, JSON.stringify({ schema: 1, apps: [
      { id: 'defleur-video', name: 'DeFleur Video', summary: 'Edit a talking-head video into a vertical short.', status: 'running',
        provides: ['video-editing', 'short-form-video'], mcp: { url: 'http://127.0.0.1:20002/mcp', transport: 'streamable-http' },
        skill: 'skills/defleur-video/SKILL.md', view: null },
      { id: 'stopped-app', name: 'Stopped', summary: 'Not running', status: 'stopped', mcp: { url: 'http://127.0.0.1:1/mcp' } },
    ] }))
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, joinedDelegation: 'prefer', appsJsonPath: appsJson })
    expect((await postRun(wizard)).status).toBe(202)
    const first = String(hermes.bodies[0].instructions)
    // The agent-bridge kernel replaced the URL- and path-heavy block (spec/AGENT_BRIDGE.md).
    expect(first).toContain("Wizard OS: you are the owner's agent on this box.")
    // No plugin (generic harness): the fixed kernel plus the job -> app map, one line per job.
    expect(first).toContain('- short-form video -> DeFleur Video (`mcp__wizard__defleur_video__*`)')
    expect(first).toContain('- video editing -> DeFleur Video (`mcp__wizard__defleur_video__*`)')
    // A stopped app does no job in the kernel/job map. It is still installed, so the separate app-provenance
    // catalogue (live 41de73a) lists its id/name as data; check the kernel text before that catalogue.
    expect(first.split('Installed app IDs and names (data):')[0]).not.toContain('Stopped')
    expect(first).toContain('{"id":"stopped-app","name":"Stopped"}')
    expect(first).not.toContain('http://127.0.0.1:20002/mcp')
    expect(first).not.toContain(join(dir, 'skills'))
    expect(first).toContain('Save routing-only app-job skills.')
    expect(first).toContain('first load `wizard-builder` with skill_view')
    expect(first).toContain('For ordinary app use:')
    writeFileSync(appsJson, JSON.stringify({ schema: 1, apps: [] }))
    expect((await postRun(wizard)).status).toBe(202)
    const second = String(hermes.bodies[1].instructions)
    expect(second).toContain('- (no apps installed yet)')
    expect(second).not.toContain('DeFleur Video (')
  })

  it('serves a Wizard UX build under its prefix and refuses dotfiles and traversal', async () => {
    const ux = mkdtempSync(join(tmpdir(), 'wizard-ux-'))
    writeFileSync(join(ux, 'index.html'), '<title>Wizard UX</title>')
    mkdirSync(join(ux, 'core'))
    writeFileSync(join(ux, 'core', 'core.js'), 'ok')
    writeFileSync(join(ux, '.env'), 'SECRET=1')
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, uxDir: ux })
    expect(await (await fetch(`${wizard}/wizard-os-home/`)).text()).toContain('Wizard UX')
    expect(await (await fetch(`${wizard}/wizard-os-home/core/core.js`)).text()).toBe('ok')
    // Nested app documents can be framed; the outer shell cannot (trunk agents security contract).
    expect((await fetch(`${wizard}/wizard-os-home/`)).headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'(;|$)/u)
    expect((await fetch(`${wizard}/wizard-os-home/.env`)).status).toBe(404)
    expect((await fetch(`${wizard}/wizard-os-home/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404)
    const root = await fetch(`${wizard}/`, { redirect: 'manual' })
    expect(root.headers.get('location')).toBe('/wizard-os-home/')
  })
  it('frames only the configured isolated app origin, retaining self-only connections and control ancestors', async () => {
    const ux = mkdtempSync(join(tmpdir(), 'wizard-ux-csp-'))
    writeFileSync(join(ux, 'index.html'), '<title>Wizard UX</title>')
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, uxDir: ux, appsOrigin: 'http://localhost:48023' })
    const csp = (await fetch(`${wizard}/wizard-os-home/`)).headers.get('content-security-policy')
    expect(csp).toContain("frame-src 'self' http://localhost:48023;")
    expect(csp).toContain("connect-src 'self' blob: data:;")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('*')
  })
})

describe('orb router', () => {
  it('takes the place and clock from settings, with nothing built in', () => {
    const settings = normalizeSettings({ owner: { place: 'Lisbon' }, clock: { timezone: 'Europe/Lisbon' } })
    const prompt = routerSystemPrompt({ settings, apps: ['Notes'], timezone: '', view: null, force: false, now: new Date('2026-10-09T12:00:00Z') })
    expect(prompt).toContain('2026-10-09 (Friday, Europe/Lisbon)')
    expect(prompt).toContain('lives in Lisbon')
    expect(prompt).not.toMatch(/Bangkok|Archimedes|James/u)
    const bare = routerSystemPrompt({ settings: normalizeSettings({}), apps: [], timezone: '', view: null, force: false, now: undefined })
    expect(bare).not.toContain('lives in')
  })

  it('routes through the configured OpenAI-compatible endpoint', async () => {
    const llm = createServer(async (request, response) => {
      for await (const _ of request) { /* drain */ }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: '{"route":"command","action":"open_app","app":"Notes"}' } }] }))
    })
    servers.push(llm)
    const port = ((await listen(llm)) as import('node:net').AddressInfo).port
    const hermes = await startHermes(STOCK)
    const wizard = await startWizard({ upstreamOrigin: hermes.origin, router: { url: `http://127.0.0.1:${port}/v1/chat/completions`, model: 'any-small-model' } })
    const body = await (await fetch(`${wizard}/wizard/v1/route`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'open notes', apps: ['Notes'] }),
    })).json()
    expect(body.cmd).toEqual({ route: 'command', action: 'open_app', app: 'Notes' })
  })
})

describe('helper wait keeps a thread in Working', () => {
  it('reports running helpers and an unanswered helper result from Hermes state', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readHermesSessionTruth } = await import('../server/session-truth.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'helper-wait-'))
    const path = join(dir, 'state.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE sessions (id TEXT, started_at REAL, model TEXT, model_config TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, finish_reason TEXT, timestamp REAL, display_kind TEXT, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
      CREATE TABLE async_delegations (delegation_id TEXT, origin_session_id TEXT, state TEXT, dispatched_at REAL);`)
    const now = 1_800_000_000
    for (const id of ['wizard_a', 'wizard_b', 'wizard_c']) db.prepare('INSERT INTO sessions VALUES (?, ?, NULL, NULL)').run(id, now - 100)
    const msg = db.prepare('INSERT INTO messages (session_id, role, content, finish_reason, timestamp) VALUES (?, ?, ?, ?, ?)')
    msg.run('wizard_a', 'user', 'research this', null, now - 90)
    msg.run('wizard_a', 'assistant', 'I have handed this to a helper.', 'stop', now - 80)
    db.prepare('INSERT INTO async_delegations VALUES (?, ?, ?, ?)').run('d1', 'wizard_a', 'running', now - 85)
    msg.run('wizard_b', 'user', 'research that', null, now - 90)
    msg.run('wizard_b', 'assistant', 'Delegated.', 'stop', now - 80)
    msg.run('wizard_b', 'user', '[ASYNC DELEGATION BATCH COMPLETE — d2]\nresult', null, now - 10)
    db.prepare('INSERT INTO async_delegations VALUES (?, ?, ?, ?)').run('d2', 'wizard_b', 'completed', now - 85)
    msg.run('wizard_c', 'user', 'hi', null, now - 90)
    msg.run('wizard_c', 'assistant', 'hello', 'stop', now - 80)
    db.close()
    const truth = readHermesSessionTruth(path, ['wizard_a', 'wizard_b', 'wizard_c'], now)
    expect(truth.get('wizard_a')?.helpersRunning).toBe(1)
    expect(truth.get('wizard_b')?.helperResultUnanswered).toBe(true)
    expect(truth.get('wizard_b')?.helpersRunning ?? 0).toBe(0)
    expect(truth.get('wizard_c')?.helpersRunning ?? 0).toBe(0)
    expect(truth.get('wizard_c')?.helperResultUnanswered).toBeFalsy()
  })
})


describe('fast router and delegation mode settings', () => {
  it('reads fast_router from settings, never exposing the key', async () => {
    const { normalizeSettings, resolveFastRouter } = await import('../server/wizard-os-settings.mjs')
    const s = normalizeSettings({ fast_router: { account: 'claude', model: 'claude-haiku-4-5', endpoint: 'http://127.0.0.1:9/v1/chat/completions', key_env: 'ROUTER_KEY_X', key: 'leak' } })
    expect(s.fast_router).toEqual({ account: 'claude', model: 'claude-haiku-4-5', endpoint: 'http://127.0.0.1:9/v1/chat/completions', key_env: 'ROUTER_KEY_X' })
    expect(resolveFastRouter(s, null, { ROUTER_KEY_X: 'k1' })).toMatchObject({ url: 'http://127.0.0.1:9/v1/chat/completions', model: 'claude-haiku-4-5', key: 'k1', account: 'claude' })
    expect(resolveFastRouter(normalizeSettings({}), { url: 'http://x/v1', model: 'm' })).toMatchObject({ url: 'http://x/v1', model: 'm' })
    expect(resolveFastRouter(normalizeSettings({}), null)).toBeNull()
    expect(normalizeSettings({ fast_router: { endpoint: 'file:///etc/passwd', key_env: 'lower' } }).fast_router).toMatchObject({ endpoint: '', key_env: '' })
  })
  it('detached instructions replace the join sentence', async () => {
    const { runInstructions, OWN_STYLE_RUN_INSTRUCTIONS } = await import('../server/service.mjs')
    expect(runInstructions({ join: true })).toBe(OWN_STYLE_RUN_INSTRUCTIONS)
    const detached = runInstructions({ join: false })
    expect(detached).not.toContain('Join any delegated work in this run')
    expect(detached).toContain('Wizard brings their results back to you as a follow-up turn')
  })
})
