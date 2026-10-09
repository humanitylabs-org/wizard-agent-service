import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { normalizeSettings } from '../server/wizard-os-settings.mjs'
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
    expect((await fetch(`${wizard}/wizard-os-home/.env`)).status).toBe(404)
    expect((await fetch(`${wizard}/wizard-os-home/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404)
    const root = await fetch(`${wizard}/`, { redirect: 'manual' })
    expect(root.headers.get('location')).toBe('/wizard-os-home/')
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
