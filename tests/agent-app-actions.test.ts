import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { catalogueEntry, createAgentAppActions, validForm } from '../server/agent-app-actions.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const TOKEN = 'gateway-token-0123456789'
const MANAGER_TOKEN = 'manager-secret-abcdefghijklmnopqrstuvwxyz0123'

// The app's own MCP server: JSON responses, a session id on initialize.
function fakeApp() {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const msg = JSON.parse(body || '{}')
    const send = (result) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
    if (msg.id === undefined) { res.writeHead(202); res.end(); return }
    if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hello' } })
    if (msg.method === 'tools/list') return send({ tools: [{ name: 'wizard_time', description: 'Current UTC time. More.', inputSchema: { type: 'object', properties: {} } }] })
    if (msg.method === 'tools/call') return send({ content: [{ type: 'text', text: `ran ${msg.params.name}` }] })
    send({})
  })
  return server
}

// A journaling App Manager bridge like wam/lifecycle.py: same key -> the recorded outcome; it writes apps.json.
// `delay`: the operation takes that long (an image pull). `others`: rows from other app stores. `toolless`: apps.json
// lists the app with no MCP endpoint. `staleApps`: apps.json is never rewritten.
function fakeBridge(dir, appPort, { lose = 0, fail = null, installed = {}, delay = 0, others = [], toolless = false, staleApps = false } = {}) {
  const state = { installed: { ...installed }, writes: [], journal: new Map(), lose, fail }
  const writeApps = () => writeFileSync(join(dir, 'apps.json'), JSON.stringify({ apps: Object.entries(state.installed).map(([id, status]) => ({
    id, name: 'Hello View', status, provides: ['diagnostics'], summary: 'Hello.', ...(toolless ? {} : { mcp: { url: `http://127.0.0.1:${appPort}/mcp` } }),
  })) }))
  writeApps()
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (req.headers.authorization !== `Bearer ${MANAGER_TOKEN}` || req.headers.origin) return json(401, { success: false, error: 'unauthorized' })
    if (req.method === 'GET' && req.url === '/api/apps/installed') {
      return json(200, { installed: [...others, ...Object.entries(state.installed).map(([id, status]) => ({ info: { id, urn: `${id}:wizardapps` }, app: { status } }))] })
    }
    const m = /^\/api\/app-lifecycle\/([a-z0-9-]+):wizardapps\/([a-z]+)$/u.exec(req.url || '')
    if (req.method !== 'POST' || !m) return json(404, { success: false, error: 'not_found' })
    const key = String(req.headers['idempotency-key'] || '')
    state.writes.push({ key, app: m[1], action: m[2], body: JSON.parse(body || '{}') })
    if (!state.journal.has(key)) {
      if (delay) await new Promise((r) => setTimeout(r, delay))
      if (state.fail) { state.journal.set(key, state.fail); state.fail = null }
      else {
        state.installed[m[1]] = 'running'
        if (!staleApps) writeApps()
        state.journal.set(key, { code: 200, data: { success: true, noop: false, status: 'running' } })
      }
    }
    if (state.lose > 0) { state.lose -= 1; req.socket.destroy(); return }
    const out = state.journal.get(key)
    json(out.code, { ...out.data, replayed: state.writes.filter((w) => w.key === key).length > 1, registry: { apps: [] } })
  })
  return { server, state }
}

const INDEX = {
  apps: [
    { id: 'hello-view', name: 'Hello View', summary: 'A screen and two tools.', provides: ['diagnostics'], uses: [], repo: 'qa/hello-view', logo: 'https://x/logo.png', url: 'https://github.com/qa/hello-view', install: { git: 'https://github.com/qa/hello-view' }, qa_fixture: true },
    { id: 'needs-dep', name: 'Needs Dep', summary: 'Uses notifications.', provides: ['diagnostics'], uses: ['notifications'] },
    { id: 'wizard-shell', name: 'Wizard Shell', summary: 'The shell.', provides: ['shell'] },
    { id: 'hermes-agent', name: 'Hermes', summary: 'The agent.', provides: ['agent'] },
  ],
}
const indexFetch = async () => Response.json(INDEX)

const servers = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

async function setup(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'waa-'))
  const app = fakeApp(); servers.push(app)
  const appPort = (await listen(app)).port
  const bridge = fakeBridge(dir, appPort, opts); servers.push(bridge.server)
  const bridgePort = (await listen(bridge.server)).port
  const logs = []
  const svc = createWizardServer({
    upstreamOrigin: 'http://127.0.0.1:9', requireAccess: false, appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'),
    mcpToken: TOKEN, bridgeWatchMs: 50, bridgeLog: (l) => logs.push(l), bridgeToolWaitMs: opts.toolWaitMs ?? 3000,
    ...(opts.budget ? { bridgeInstallBudgetMs: opts.budget } : {}),
    appManagerUrl: `http://127.0.0.1:${bridgePort}`, appManagerToken: MANAGER_TOKEN, appIndexUrl: 'http://index.test/v1', appIndexFetch: indexFetch,
  })
  servers.push(svc)
  const base = `http://127.0.0.1:${(await listen(svc)).port}`
  return { base, bridge: bridge.state, logs }
}

async function call(base, args, { token = TOKEN, headers = {} } = {}) {
  const r = await fetch(`${base}/wizard/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wizard_apps', arguments: args } }),
  })
  const text = await r.text()
  const json = text ? JSON.parse(text) : null
  return { status: r.status, raw: text, result: json?.result, text: json?.result?.content?.[0]?.text || '' }
}

describe('wizard_apps: find and install apps through the one gateway', () => {
  it('advertises the actions on the existing meta tool, and only when the App Manager is connected', async () => {
    const { base } = await setup()
    const r = await fetch(`${base}/wizard/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const meta = (await r.json()).result.tools.find((t) => t.name === 'wizard_apps')
    expect(meta.inputSchema.properties.action.enum).toEqual(['installed', 'search', 'install', 'call'])
    expect(meta.description).toContain('action "install"')
  })

  it('refuses without the gateway token, and from a proxy, before anything reaches the installer', async () => {
    const { base, bridge } = await setup()
    expect((await call(base, { action: 'install', app: 'hello-view' }, { token: '' })).status).toBe(401)
    expect((await call(base, { action: 'install', app: 'hello-view' }, { token: 'wrong-token-0000000000000' })).status).toBe(401)
    expect((await call(base, { action: 'install', app: 'hello-view' }, { headers: { 'X-Forwarded-For': '100.64.0.9', 'Tailscale-User-Login': 'owner@example' } })).status).toBe(403)
    expect(bridge.writes).toEqual([])
    // Outside the gateway's own authenticated path the install refuses too.
    const actions = createAgentAppActions({ managerUrl: 'http://127.0.0.1:1', managerToken: MANAGER_TOKEN, indexFetch })
    expect(await actions.install({ app: 'hello-view' })).toEqual({ ok: false, error: 'gateway_token_required' })
  })

  it('search projects the configured index only: no system apps, URLs, repos or install sources', async () => {
    const { base, bridge } = await setup()
    const r = await call(base, { action: 'search', query: 'time' })
    expect(r.text).toContain('Hello View (hello-view): A screen and two tools. Jobs: diagnostics. Not installed. (test catalogue entry)')
    expect(r.text).toContain('Needs: notifications.')
    expect(r.text).toContain('Install one with wizard_apps {"action": "install", "app": "<id>"}.')
    expect(r.text).not.toMatch(/wizard-shell|hermes-agent|https?:|github|logo/u)
    expect(bridge.writes).toEqual([])
    expect(catalogueEntry({ id: '../x' })).toBe(null)
  })

  it('installs with one operation key, reads the status back, returns the new tools and can call one', async () => {
    const { base, bridge, logs } = await setup()
    const r = await call(base, { action: 'install', app: 'hello-view' })
    expect(r.result.isError).toBeFalsy()
    expect(r.text).toContain('Installed Hello View (hello-view); it is running.')
    expect(r.text).toContain('mcp__wizard__hello_view__wizard_time: Current UTC time')
    expect(r.text).toContain('{"action": "call", "tool": "hello_view__<tool>", "arguments": {...}}')
    expect(bridge.writes).toHaveLength(1)
    expect(bridge.writes[0]).toMatchObject({ app: 'hello-view', action: 'install', body: {} })
    expect(bridge.writes[0].key).toMatch(/^[A-Za-z0-9_-]{16,128}$/u)
    const ran = await call(base, { action: 'call', tool: 'mcp__wizard__hello_view__wizard_time', arguments: {} })
    expect(ran.text).toBe('ran wizard_time')
    const again = await call(base, { action: 'install', app: 'hello-view' })
    expect(again.text).toContain('already installed and running')
    expect(bridge.writes).toHaveLength(1)
    const all = [r.raw, ran.raw, again.raw, logs.join('\n')].join('\n')
    expect(all).not.toContain(MANAGER_TOKEN)
    expect(all).not.toContain('Bearer ')
  })

  it('a lost reply is never success: the retry reuses the same key and the bridge replays', async () => {
    const { base, bridge } = await setup({ lose: 1 })
    const first = await call(base, { action: 'install', app: 'hello-view' })
    expect(first.result.isError).toBe(true)
    expect(first.text).toContain('outcome is NOT confirmed (reply_lost)')
    expect(first.text).toContain('Do not tell the owner it worked')
    // The app did get installed by the lost request; the gateway's retry reads that back without a second install.
    const second = await call(base, { action: 'install', app: 'hello-view' })
    expect(second.text).toMatch(/already installed and running/u)
    expect(bridge.writes).toHaveLength(1)
  })

  it('an unconfirmed bridge answer keeps the key; a definitive failure releases it', async () => {
    const { base, bridge } = await setup({ fail: { code: 409, data: { success: false, error: 'operation_unconfirmed' } } })
    const first = await call(base, { action: 'install', app: 'hello-view' })
    expect(first.text).toContain('NOT confirmed (operation_unconfirmed)')
    const key = bridge.writes[0].key
    expect(first.text).toContain(key)
    await call(base, { action: 'install', app: 'hello-view' })
    expect(bridge.writes[1].key).toBe(key)

    const other = await setup({ fail: { code: 422, data: { success: false, error: 'lifecycle_failed' } } })
    const failed = await call(other.base, { action: 'install', app: 'hello-view' })
    expect(failed.text).toContain('tried to install Hello View (hello-view) and it failed')
    const retry = await call(other.base, { action: 'install', app: 'hello-view' })
    expect(retry.text).toContain('Installed Hello View')
    expect(other.bridge.writes[1].key).not.toBe(other.bridge.writes[0].key)
  })

  it('with nothing held, a supplied operation_key resumes that operation (e.g. after a Service restart)', async () => {
    const { base, bridge } = await setup({ fail: { code: 409, data: { success: false, error: 'operation_unconfirmed' } } })
    await call(base, { action: 'install', app: 'hello-view', operation_key: 'agent-retry-key-000001' })
    expect(bridge.writes[0].key).toBe('agent-retry-key-000001')
  })

  it('while an outcome is uncertain only the held key is accepted; another key or form sends nothing and keeps it', async () => {
    const { base, bridge } = await setup({ fail: { code: 409, data: { success: false, error: 'operation_unconfirmed' } } })
    await call(base, { action: 'install', app: 'hello-view' })
    const held = bridge.writes[0].key
    const other = await call(base, { action: 'install', app: 'hello-view', operation_key: 'someone-elses-key-000001' })
    expect(other.result.isError).toBe(true)
    expect(other.text).toContain(`held under operation_key ${held}; a different key was given, so nothing was sent`)
    const form = await call(base, { action: 'install', app: 'hello-view', form: { NAME: 'x' } })
    expect(form.text).toContain(`with other form values is still held (operation_key ${held}); nothing new was sent`)
    expect(bridge.writes).toHaveLength(1)
    // The held key survived both refusals: the next retries (with or without it) use it, and the bridge replays.
    await call(base, { action: 'install', app: 'hello-view', operation_key: held })
    await call(base, { action: 'install', app: 'hello-view' })
    expect(bridge.writes.map((w) => w.key)).toEqual([held, held, held])
  })

  it('answers within its budget while a slow install runs on; a retry joins it and gets the real outcome, one write', async () => {
    const { base, bridge } = await setup({ delay: 700, budget: 300 })
    const t0 = Date.now()
    const first = await call(base, { action: 'install', app: 'hello-view' })
    expect(Date.now() - t0).toBeLessThan(650)
    expect(first.result.isError).toBe(true)
    expect(first.text).toContain('is still running on the box; it is not finished after 0 s, so its outcome is NOT confirmed yet')
    expect(first.text).toContain('Do not tell the owner it worked or failed; tell them it is still installing.')
    expect(bridge.writes).toHaveLength(1)
    const key = bridge.writes[0].key
    expect(first.text).toContain(`"operation_key": "${key}"`)
    // Mid-operation: no token -> refused; a different key -> refused; a plain retry joins (no second write).
    expect((await call(base, { action: 'install', app: 'hello-view' }, { token: '' })).status).toBe(401)
    expect((await call(base, { action: 'install', app: 'hello-view', operation_key: 'someone-elses-key-000001' })).text).toContain('nothing was sent')
    const joined = await call(base, { action: 'install', app: 'hello-view', operation_key: key })
    expect(joined.text).toContain('still running on the box')
    expect(bridge.writes).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 700))
    // The operation finished while nobody waited: the next call reports that outcome, then it is plain status.
    const done = await call(base, { action: 'install', app: 'hello-view' })
    expect(done.result.isError).toBeFalsy()
    expect(done.text).toContain('Installed Hello View (hello-view); it is running.')
    expect(done.text).toContain('mcp__wizard__hello_view__wizard_time')
    expect((await call(base, { action: 'install', app: 'hello-view' })).text).toContain('already installed and running')
    expect(bridge.writes).toHaveLength(1)
  })

  it('a slow install that fails is reported to the retry and releases its key', async () => {
    const { base, bridge } = await setup({ delay: 500, budget: 200, fail: { code: 422, data: { success: false, error: 'lifecycle_failed' } } })
    expect((await call(base, { action: 'install', app: 'hello-view' })).text).toContain('still running on the box')
    await new Promise((r) => setTimeout(r, 600))
    expect((await call(base, { action: 'install', app: 'hello-view' })).text).toContain('tried to install Hello View (hello-view) and it failed')
    expect(bridge.writes).toHaveLength(1)
    await call(base, { action: 'install', app: 'hello-view' })
    await new Promise((r) => setTimeout(r, 600))
    expect(bridge.writes).toHaveLength(2)
    expect(bridge.writes[1].key).not.toBe(bridge.writes[0].key)
  })

  it('reads status from the Wizard app store only: a namesake from another store neither skips an install nor gets started', async () => {
    const running = await setup({ others: [{ info: { id: 'hello-view', urn: 'hello-view:otherstore' }, app: { status: 'running' } }] })
    expect((await call(running.base, { action: 'install', app: 'hello-view' })).text).toContain('Installed Hello View (hello-view); it is running.')
    expect(running.bridge.writes.map((w) => [w.app, w.action])).toEqual([['hello-view', 'install']])
    const stopped = await setup({ others: [{ info: { id: 'hello-view', urn: 'hello-view:otherstore' }, app: { status: 'stopped' } }] })
    await call(stopped.base, { action: 'install', app: 'hello-view' })
    expect(stopped.bridge.writes.map((w) => w.action)).toEqual(['install'])
  })

  it('says tools are not confirmed when the app has not appeared yet, and "own screen" only for a known tool-less app', async () => {
    const slow = await setup({ staleApps: true, toolWaitMs: 300 })
    const r = await call(slow.base, { action: 'install', app: 'hello-view' })
    expect(r.text).toContain('Its tools are not confirmed yet')
    expect(r.text).not.toContain('own screen')
    const screen = await setup({ toolless: true })
    expect((await call(screen.base, { action: 'install', app: 'hello-view' })).text).toContain('It has no tools for you; it is used through its own screen.')
  })

  it('names missing dependencies and installs nothing else; refuses system and unknown apps', async () => {
    const { base, bridge } = await setup({ fail: { code: 409, data: { success: false, error: 'dependencies_required' } } })
    const dep = await call(base, { action: 'install', app: 'needs-dep' })
    expect(dep.text).toContain('needs these apps installed first: notifications. Nothing was installed.')
    expect(bridge.writes.map((w) => w.app)).toEqual(['needs-dep'])
    expect((await call(base, { action: 'install', app: 'wizard-shell' })).text).toContain('part of Wizard itself')
    expect((await call(base, { action: 'install', app: 'not-listed' })).text).toContain('is in the Wizard app catalogue; nothing was installed')
    expect(bridge.writes).toHaveLength(1)
  })

  it('validates ids, form values and keys before any write', async () => {
    const { base, bridge } = await setup()
    expect((await call(base, { action: 'install', app: '../etc' })).text).toContain('Pass the app id as "app"')
    expect((await call(base, { action: 'install', app: 'Hello View' })).text).toContain('Pass the app id as "app"')
    // Literal ids only: no case folding or trimming turns a near miss into a real install.
    for (const app of ['Hello-View', 'HELLO-VIEW', ' hello-view', 'hello-view ', 'hello-view\n', '\thello-view']) {
      expect((await call(base, { action: 'install', app })).text).toContain('Pass the app id as "app"')
    }
    expect((await call(base, { action: 'install', app: 'hello-view', form: { 'bad key': 'x' } })).text).toContain('flat object')
    expect((await call(base, { action: 'install', app: 'hello-view', form: { A: { nested: 1 } } })).text).toContain('flat object')
    expect((await call(base, { action: 'install', app: 'hello-view', operation_key: 'short' })).text).toContain('operation_key')
    expect((await call(base, { action: 'call', tool: 'wizard_apps' })).text).toContain('<app>__<tool>')
    expect((await call(base, { action: 'nope' })).text).toContain('Unknown action')
    expect(bridge.writes).toEqual([])
    expect(validForm({ PORT: 1, NAME: 'x', ON: true })).toEqual({ PORT: 1, NAME: 'x', ON: true })
    expect(validForm({ X: Number.NaN })).toBe(null)
  })

  it('starts an installed but stopped app instead of installing it again', async () => {
    const { base, bridge } = await setup({ installed: { 'hello-view': 'stopped' } })
    const r = await call(base, { action: 'install', app: 'hello-view' })
    expect(r.text).toContain('Started Hello View (hello-view); it is running.')
    expect(bridge.writes.map((w) => w.action)).toEqual(['start'])
    expect(bridge.writes[0].body).toEqual({})
  })
})
