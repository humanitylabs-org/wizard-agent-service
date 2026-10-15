import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { bridgeApps, createAgentBridge, renderKernel, pointerSkills, writePointerSkills, appsDelta, renderDelta, ThreadAppSnapshots } from '../server/agent-bridge.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const PLUGIN = resolve(__dirname, '../hermes-plugin/wizard-os')
const TOKEN = 'test-token-0123456789'

// A tiny stock-shaped app MCP server (like hello-wizard): JSON responses, session id on initialize.
function fakeApp(tools = [{ name: 'wizard_time', description: 'Current UTC time.', inputSchema: { type: 'object', properties: {} } }]) {
  const calls = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const msg = JSON.parse(body || '{}')
    calls.push({ method: msg.method, session: req.headers['mcp-session-id'] || '' })
    const send = (result) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'app-s1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
    if (msg.id === undefined) { res.writeHead(202); res.end(); return }
    if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } })
    if (msg.method === 'tools/list') return send({ tools })
    if (msg.method === 'tools/call') return send({ content: [{ type: 'text', text: `ran ${msg.params.name} ${JSON.stringify(msg.params.arguments)}` }] })
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }))
  })
  return { server, calls }
}

function box(apps) {
  const dir = mkdtempSync(join(tmpdir(), 'wab-'))
  mkdirSync(join(dir, 'skills', 'hello-wizard'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'hello-wizard', 'SKILL.md'), '---\nname: hello-wizard\n---\n')
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps }))
  return dir
}

const app = (id, port, extra = {}) => ({
  id, name: id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '), status: 'running', summary: `${id} summary`,
  provides: ['diagnostics'], mcp: { url: `http://127.0.0.1:${port}/mcp`, internal: `http://${id}:8799/mcp`, transport: 'streamable-http' },
  skill: `skills/${id}/SKILL.md`, ...extra,
})

async function rpc(base, body, session = '', token = TOKEN) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (session) headers['Mcp-Session-Id'] = session
  const r = await fetch(`${base}/wizard/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, session: r.headers.get('mcp-session-id') || '', json: text ? JSON.parse(text) : null }
}

const servers = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

async function start(dir, extra = {}) {
  const svc = createWizardServer({
    upstreamOrigin: 'http://127.0.0.1:9', requireAccess: false, appsJsonPath: join(dir, 'apps.json'),
    settingsPath: join(dir, 'settings.json'), mcpToken: TOKEN, bridgeWatchMs: 50, bridgeLog: (l) => extra.logs?.push(l), ...extra.options,
  })
  servers.push(svc)
  const addr = await listen(svc)
  return `http://127.0.0.1:${addr.port}`
}

describe('agent bridge: kernel', () => {
  it('skips the shell and the agent, keeps apps with MCP, sorts by id', () => {
    const apps = bridgeApps({ apps: [
      app('transcriber', 1, { provides: ['transcription', 'speech-to-text-engine'] }),
      { id: 'wizard-shell', provides: ['shell'], status: 'running' },
      app('hermes-agent', 2, { provides: ['agent'] }),
      { id: 'files', provides: ['files'], status: 'running', mcp: null },
      app('browser', 3, { provides: ['browser'] }),
    ] })
    expect(apps.map((a) => a.id)).toEqual(['browser', 'transcriber'])
  })

  it('the kernel is fixed, under 900 characters, and holds no app list', () => {
    const many = Array.from({ length: 20 }, (_, i) => app(`app-number-${String(i).padStart(2, '0')}`, 1000 + i, { provides: [`job-${i}`, 'short-form-video'] }))
    const none = renderKernel([])
    const full = renderKernel(bridgeApps({ apps: many }))
    expect(full).toBe(none)
    expect(full.length).toBeLessThanOrEqual(900)
    expect(full).toContain('`mcp__wizard__wizard_apps`')
    expect(full).toContain('wizard-job-<job>')
    expect(full).toContain('Never search the disk')
    expect(full).not.toContain('app-number')
    // Fallback / generic harness: a job -> app map, at most 12 lines.
    const map = renderKernel(bridgeApps({ apps: many }), { jobMap: true })
    expect(map.split('\n').filter((l) => l.startsWith('- ')).length).toBe(12)
    expect(renderKernel(bridgeApps({ apps: [app('hello-wizard', 1)] }), { harness: 'generic' })).toContain('- diagnostics -> Hello Wizard (`hello_wizard__*`)')
  })

  it('routes app development to the OS builder before ordinary job routing, including an empty box', () => {
    for (const apps of [[], bridgeApps({ apps: [app('hello-wizard', 1)] })]) {
      const text = renderKernel(apps)
      expect(text).toContain('To build, port, redesign or modify a Wizard app, first load `wizard-builder` with skill_view')
      expect(text.indexOf('wizard-builder')).toBeLessThan(text.indexOf('wizard-job-<job>'))
      expect(text).toContain('follow its coding and wam workflow')
      expect(text).toContain('For ordinary app use: Never search the disk')
      expect(text).toContain('Use the installed app for its job.')
      expect(text).not.toContain('An installed app beats')
    }
    // Non-Hermes harnesses retain their own discovery path, not a nonexistent skill_view tool.
    expect(renderKernel([], { harness: 'generic' })).not.toContain('skill_view')
  })

  it('writes one pointer skill per job, names real tools, and removes stale ones', () => {
    const dir = box([])
    const apps = bridgeApps({ apps: [app('hello-wizard', 1), app('transcriber', 2, { provides: ['transcription'], skill: '' })] })
    mkdirSync(join(dir, 'skills', '_jobs', 'old'), { recursive: true })
    mkdirSync(join(dir, 'skills', 'wizard-job-gone'), { recursive: true })
    const tools = { 'hello-wizard': [{ name: 'wizard_time', description: 'Current UTC time on the Wizard. Second sentence.' }, 'wizard_echo'] }
    expect(writePointerSkills(dir, apps, { tools })).toEqual(['wizard-job-diagnostics', 'wizard-job-transcription'])
    const diag = readFileSync(join(dir, 'skills', 'wizard-job-diagnostics', 'SKILL.md'), 'utf8')
    expect(diag).toContain('name: wizard-job-diagnostics')
    expect(diag).toContain('description: Use when the owner asks for diagnostics.')
    expect(diag).toContain('- Hello Wizard: pick the tool whose purpose matches the request and call it.\n  - `mcp__wizard__hello_wizard__wizard_time`: Current UTC time on the Wizard\n  - `mcp__wizard__hello_wizard__wizard_echo`\n  Its address (for files it serves): http://127.0.0.1:1\n  Its skill `hello-wizard` (skill_view)')
    expect(readFileSync(join(dir, 'skills', 'wizard-job-transcription', 'SKILL.md'), 'utf8')).toContain('- Transcriber: pick the tool whose purpose matches the request and call it.\n  - `mcp__wizard__transcriber__*`')
    expect(existsSync(join(dir, 'skills', '_jobs'))).toBe(false)
    expect(existsSync(join(dir, 'skills', 'wizard-job-gone'))).toBe(false)
    expect(existsSync(join(dir, 'skills', 'hello-wizard', 'SKILL.md'))).toBe(true) // app skills untouched
  })

  it('the Python plugin renders the same bytes as the service', () => {
    const fixtures = [
      [app('hello-wizard', 1), app('transcriber', 2, { provides: ['transcription', 'speech-to-text-engine'], status: 'stopped' })],
      Array.from({ length: 20 }, (_, i) => app(`app-number-${String(i).padStart(2, '0')}`, 1000 + i, { provides: [`job-${i}`] })),
      [],
    ]
    const py = (code, reg) => execFileSync('python3', ['-c', `import sys,json; sys.path.insert(0, ${JSON.stringify(PLUGIN)}); import kernel; apps = kernel.bridge_apps(json.load(sys.stdin)); ${code}`], { input: JSON.stringify(reg) }).toString()
    for (const apps of fixtures) {
      const reg = { apps }
      expect(py("print(kernel.render_kernel(apps), end='')", reg)).toBe(renderKernel(bridgeApps(reg)))
      expect(py("print(kernel.render_kernel(apps, job_map=True), end='')", reg)).toBe(renderKernel(bridgeApps(reg), { jobMap: true }))
      expect(py("print(kernel.render_kernel(apps, 'generic'), end='')", reg)).toBe(renderKernel(bridgeApps(reg), { harness: 'generic' }))
      expect(JSON.parse(py('print(json.dumps(kernel.pointer_skills(apps)))', reg))).toEqual(pointerSkills(bridgeApps(reg)))
      const tools = Object.fromEntries(bridgeApps(reg).map((a) => [a.id, [{ name: 'run', description: 'Does it. Then more! And more.' }, { name: 'x', description: 'A'.repeat(140) }, 'bare']]))
      expect(JSON.parse(py(`print(json.dumps(kernel.pointer_skills(apps, tools=${JSON.stringify(JSON.stringify(tools))} and json.loads(${JSON.stringify(JSON.stringify(tools))}))))`, reg))).toEqual(pointerSkills(bridgeApps(reg), { tools }))
    }
  })

  it('the plugin writes the pointers itself when the service has not', () => {
    const dir = box([app('hello-wizard', 1), app('transcriber', 2, { provides: ['transcription'] })])
    const out = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(PLUGIN)}); import kernel; from pathlib import Path; print(kernel.refresh_pointer_skills(Path(sys.argv[1])))`, dir]).toString().trim()
    expect(out).toBe("['wizard-job-diagnostics', 'wizard-job-transcription']")
    expect(existsSync(join(dir, 'skills', 'wizard-job-transcription', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, 'skills', '.wizard-jobs'))).toBe(true)
  })

  it('per-run delta is one line per new app, pointing at its wizard-job skill', () => {
    const before = { 'hello-wizard': 'running' }
    const apps = bridgeApps({ apps: [app('hello-wizard', 1), app('transcriber', 2, { provides: ['transcription'] })] })
    expect(appsDelta(apps, before).map((a) => a.id)).toEqual(['transcriber'])
    expect(renderDelta(appsDelta(apps, before))).toBe('Wizard OS, new app: Transcriber for transcription; load `wizard-job-transcription`.')
    expect(renderDelta([])).toBe('')
    const snaps = new ThreadAppSnapshots('')
    expect(snaps.take('s1', before)).toEqual(before)
    expect(snaps.take('s1', { other: 'running' })).toEqual(before)
  })
})

describe('agent bridge: MCP gateway', () => {
  it('needs the token and refuses proxied (off-box) requests', async () => {
    const dir = box([])
    const base = await start(dir)
    expect((await rpc(base, { jsonrpc: '2.0', id: 1, method: 'ping' }, '', '')).status).toBe(401)
    expect((await rpc(base, { jsonrpc: '2.0', id: 1, method: 'ping' }, '', 'wrong')).status).toBe(401)
    const r = await fetch(`${base}/wizard/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forwarded-For': '100.64.0.1', 'Content-Type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(403)
  })

  it('proxies app tools as <app>__<tool> with an [App · jobs] prefix, adds wizard_apps, logs without arguments', async () => {
    const a = fakeApp([{ name: 'wizard_time', description: 'Current UTC time.', inputSchema: { type: 'object', properties: {} } }, { name: 'wizard_echo', description: 'Echo.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }])
    servers.push(a.server)
    const port = (await listen(a.server)).port
    const dir = box([app('hello-wizard', port), { id: 'wizard-shell', provides: ['shell'], status: 'running' }])
    const logs = []
    const base = await start(dir, { logs })
    const init = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } } })
    expect(init.status).toBe(200)
    expect(init.json.result.capabilities.tools.listChanged).toBe(true)
    expect(init.json.result.instructions).toContain('wizard-job-<job>')
    const list = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.session)
    const names = list.json.result.tools.map((t) => t.name)
    expect(names).toEqual(['wizard_apps', 'hello_wizard__wizard_time', 'hello_wizard__wizard_echo'])
    expect(list.json.result.tools[1].description).toBe('[Hello Wizard · diagnostics] Current UTC time.')
    const call = await rpc(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hello_wizard__wizard_echo', arguments: { text: 'secret-arg' } } }, init.session)
    expect(call.json.result.content[0].text).toBe('ran wizard_echo {"text":"secret-arg"}')
    const meta = await rpc(base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wizard_apps', arguments: {} } }, init.session)
    expect(meta.json.result.content[0].text).toContain('Hello Wizard (hello-wizard), running: diagnostics.')
    const callLogs = logs.filter((l) => l.includes('"event":"call"')).map((l) => JSON.parse(l))
    expect(callLogs[0]).toMatchObject({ app: 'hello-wizard', tool: 'wizard_echo', ok: true })
    expect(typeof callLogs[0].ms).toBe('number')
    expect(logs.join('\n')).not.toContain('secret-arg')
  })

  it('a down app returns a clear tool error and the gateway keeps serving', async () => {
    const dir = box([app('hello-wizard', 9), app('stopped-app', 9, { status: 'stopped' })])
    const base = await start(dir)
    const init = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const down = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hello_wizard__wizard_time', arguments: {} } }, init.session)
    expect(down.json.result.isError).toBe(true)
    expect(down.json.result.content[0].text).toMatch(/Hello Wizard could not run wizard_time: it is not reachable/u)
    const stopped = await rpc(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stopped_app__x', arguments: {} } }, init.session)
    expect(stopped.json.result.content[0].text).toContain('installed but stopped')
    const unknown = await rpc(base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope__x', arguments: {} } }, init.session)
    expect(unknown.json.result.content[0].text).toContain('Call wizard_apps')
    expect((await rpc(base, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, init.session)).json.result.tools[0].name).toBe('wizard_apps')
  })

  it('sends notifications/tools/list_changed on the GET stream when apps.json changes, and rewrites pointer skills', async () => {
    const dir = box([app('hello-wizard', 9)])
    const base = await start(dir)
    expect(readFileSync(join(dir, 'skills', 'wizard-job-diagnostics', 'SKILL.md'), 'utf8')).toContain('description: Use when the owner asks for diagnostics.')
    const init = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const controller = new AbortController()
    const stream = await fetch(`${base}/wizard/mcp`, { headers: { Authorization: `Bearer ${TOKEN}`, 'Mcp-Session-Id': init.session, Accept: 'text/event-stream' }, signal: controller.signal })
    expect(stream.status).toBe(200)
    const reader = stream.body.getReader()
    await reader.read() // the opening comment
    writeFileSync(join(dir, 'apps.json'), JSON.stringify({ apps: [app('hello-wizard', 9), app('transcriber', 9, { provides: ['transcription'] })] }))
    utimesSync(join(dir, 'apps.json'), new Date(), new Date(Date.now() + 5000))
    let seen = ''
    const deadline = Date.now() + 4000
    while (!seen.includes('list_changed') && Date.now() < deadline) {
      const { value } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: new Uint8Array() }), 500))])
      seen += new TextDecoder().decode(value)
    }
    controller.abort()
    expect(seen).toContain('notifications/tools/list_changed')
    expect(existsSync(join(dir, 'skills', 'wizard-job-transcription', 'SKILL.md'))).toBe(true)
  })
})

describe('agent bridge: kernel route and per-run instructions', () => {
  it('GET /wizard/v1/agent-context serves text and JSON', async () => {
    const dir = box([app('hello-wizard', 9)])
    const base = await start(dir)
    const text = await (await fetch(`${base}/wizard/v1/agent-context`)).text()
    expect(text).toContain('Wizard OS: you are the owner\'s agent')
    expect(text).not.toContain('Hello Wizard')
    const json = await (await fetch(`${base}/wizard/v1/agent-context?format=json`)).json()
    expect(json.apps[0]).toMatchObject({ id: 'hello-wizard', status: 'running', jobs: ['diagnostics'] })
    expect(json.chars).toBe(json.text.length)
    expect(json.job_skills).toEqual(['wizard-job-diagnostics'])
  })

  it('runs carry the full kernel without the plugin, and only the delta with agent.adapter hermes-plugin', async () => {
    const seen = []
    const hermes = createServer(async (req, res) => {
      let body = ''
      for await (const c of req) body += c
      if (req.url === '/v1/runs') seen.push(JSON.parse(body).instructions)
      res.writeHead(req.url === '/v1/runs' ? 202 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(req.url === '/v1/runs' ? { run_id: 'run_1', status: 'started' } : { features: {} }))
    })
    servers.push(hermes)
    const hp = (await listen(hermes)).port
    const dir = box([app('hello-wizard', 9)])
    const opts = { upstreamOrigin: `http://127.0.0.1:${hp}`, hermesKey: 'fixture-key', joinedDelegation: 'prefer' }
    let base = await start(dir, { options: opts })
    const post = (b, sid) => fetch(`${b}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sid, input: 'hi' }) })
    const first = await post(base, 's-generic')
    expect([first.status, await first.text()]).toEqual([202, expect.any(String)])
    expect(seen.at(-1)).toContain('Wizard OS: you are the owner\'s agent')
    expect(seen.at(-1)).toContain('- diagnostics -> Hello Wizard (`mcp__wizard__hello_wizard__*`)')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ agent: { adapter: 'hermes-plugin' } }))
    base = await start(dir, { options: { ...opts, threadAppsStatePath: join(dir, 'thread-apps.json') } })
    await post(base, 's-plugin')
    expect(seen.at(-1)).not.toContain('Wizard OS: you are')
    expect(seen.at(-1)).not.toContain('Wizard OS, new app')
    writeFileSync(join(dir, 'apps.json'), JSON.stringify({ apps: [app('hello-wizard', 9), app('transcriber', 9, { provides: ['transcription'] })] }))
    utimesSync(join(dir, 'apps.json'), new Date(), new Date(Date.now() + 5000))
    await post(base, 's-plugin')
    expect(seen.at(-1)).toContain('Wizard OS, new app: Transcriber for transcription; load `wizard-job-transcription`.')
    expect(seen.at(-1)).toContain('Transcriber')
    // The delta names only the new app. The separate app-provenance catalogue (live 41de73a, every run) lists
    // every installed app id/name as data, so the delta rule is checked on the text before that catalogue.
    const delta = String(seen.at(-1)).split('Installed Wizard app IDs and names (data):')[0]
    expect(delta).not.toContain('Hello Wizard')
    expect(seen.at(-1)).toContain('Installed Wizard app IDs and names (data): [{"id":"hello-wizard","name":"Hello Wizard"},{"id":"transcriber","name":"Transcriber"}')
  })
})
