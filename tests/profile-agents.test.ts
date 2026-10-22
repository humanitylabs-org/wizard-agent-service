import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentRegistry, parseAgentFile, PRESETS } from '../server/agents.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: Server[] = [], dirs: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const quick = () => ({
  schema: 1, id: 'quick', label: 'Quick', harness: 'hermes', privacy: 'standard', appearance: { glyph: 'spark', hue: 45 },
  model: { provider: 'anthropic', model: 'claude-opus-5-5', allowed_models: ['claude-opus-5-5'], fallback: false },
  permissions: { preset: 'standard', ...structuredClone(PRESETS.find(p => p.id === 'standard')!.permissions) },
  runtime: { kind: 'profile', profile: 'quick' }, created_at: 123,
})
function box() {
  const dir = mkdtempSync(join(tmpdir(), 'profile-agents-')); dirs.push(dir)
  const folder = join(dir, 'agents', 'quick'); mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'agent.json'), JSON.stringify(quick()))
  writeFileSync(join(folder, 'runtime.key'), 'quick-fixture-key\n', { mode: 0o600 })
  return dir
}
const post = (body = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
async function serve(server: Server) {
  servers.push(server); const address = await listen(server) as import('node:net').AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('file-provisioned host profile agents', () => {
  it('parses a profile runtime without container fields', () => {
    expect(parseAgentFile(quick(), 'quick')).toMatchObject({ id: 'quick', runtime: { kind: 'profile', profile: 'quick' } })
    expect(parseAgentFile({ ...quick(), runtime: { kind: 'container', app_id: 'agent-quick', port: 18650 } }, 'quick')).not.toBeNull()
  })
  it.each(['', '../quick', 'Quick', 'a/b', 'a?x=1', 'a#x', 'a.b', 'a_foo', '1quick', 'a'.repeat(32), null, 1])('rejects invalid profile %s', profile => {
    expect(parseAgentFile({ ...quick(), runtime: { kind: 'profile', profile } }, 'quick')).toBeNull()
  })
  it.each(['host', 'network'])('uses the configured main origin plus a profile prefix in %s mode', upstreamMode => {
    const registry = createAgentRegistry({ agentsDir: join(box(), 'agents'), mainUpstreamOrigin: 'http://gateway:8642', upstreamMode })
    expect(registry.upstream(registry.read('quick'))).toBe('http://gateway:8642/p/quick')
  })
  it('probes the prefixed health route with only the profile key; failures are not running', async () => {
    let ok = true; const seen: any[] = []
    const registry = createAgentRegistry({ agentsDir: join(box(), 'agents'), mainUpstreamOrigin: 'http://gateway:8642', fetchImpl: async (url, init) => {
      seen.push([url, new Headers(init.headers).get('Authorization')]); return new Response('{}', { status: ok ? 200 : 503 })
    } })
    const agent = registry.read('quick')
    expect(await registry.status(agent)).toEqual({ status: 'running', status_detail: '' })
    expect(seen).toEqual([['http://gateway:8642/p/quick/health', 'Bearer quick-fixture-key']])
    ok = false
    expect(await registry.status(agent, { fresh: true })).toMatchObject({ status: 'error' })
  })
  it('never invokes the container driver or writes a harness for profile agents', async () => {
    const dir = box(), calls: string[] = []
    const runtime = Object.fromEntries(['apply', 'start', 'stop'].map(key => [key, async () => calls.push(key)]))
    const registry = createAgentRegistry({ agentsDir: join(dir, 'agents'), runtime })
    for (const running of [true, false]) await expect(registry.setRunning('quick', running)).rejects.toMatchObject({ status: 409, error: 'profile_agent_read_only' })
    await expect(registry.update('quick', { permissions: { files: 'none' } })).rejects.toMatchObject({ status: 409, error: 'profile_agent_read_only' })
    await expect(registry.create({ ...quick(), runtime: quick().runtime })).rejects.toMatchObject({ status: 400, error: 'invalid_runtime' })
    expect(calls).toEqual([])
    expect(existsSync(join(dir, 'agents', 'quick', 'home'))).toBe(false)
    expect(existsSync(join(dir, 'agents', 'quick', 'service-state.json'))).toBe(false)
  })
  it('does not rewrite file-provisioned profile permissions when installed apps change', () => {
    const dir = box(), apps = join(dir, 'apps.json'), file = join(dir, 'agents', 'quick', 'agent.json')
    writeFileSync(apps, JSON.stringify({ apps: [] }))
    const registry = createAgentRegistry({ agentsDir: join(dir, 'agents'), appsJsonPath: apps })
    registry.list(); const before = readFileSync(file, 'utf8')
    writeFileSync(apps, JSON.stringify({ apps: [{ id: 'new-app', name: 'App', view: '/app/' }] }))
    registry.list()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(join(dir, 'agents', 'quick', 'home'))).toBe(false)
  })
  it('preserves the profile prefix, authentication, pins and badges for sessions, runs, SSE, stop and steer', async () => {
    const seen: any[] = []; let runStatus = 'running'
    const main = await serve(createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk
      seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null })
      const path = req.url!.split('?')[0]
      const json = (status: number, value: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (path === '/health' || path === '/p/quick/health') return json(200, { status: 'ok' })
      if (path === '/api/sessions/wizard_quick') return json(404, {})
      if (path === '/p/quick/api/sessions') return req.method === 'POST'
        ? json(201, { session: { id: 'wizard_quick', source: 'wizard-mobile' } })
        : json(200, { data: [{ id: 'wizard_quick', source: 'wizard-mobile', title: 'Quick chat' }], has_more: false })
      if (path === '/p/quick/v1/runs') return json(202, { run_id: 'quick-run', status: 'started' })
      if (path === '/p/quick/v1/runs/quick-run') return json(200, { run_id: 'quick-run', session_id: 'wizard_quick', status: runStatus, created_at: 1792612000, updated_at: 1792612002, output: runStatus === 'completed' ? 'Quick reply' : '' })
      if (path === '/p/quick/v1/runs/quick-run/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('event: run.completed\ndata: {"output":"Quick reply"}\n\n')
      }
      if (['/p/quick/v1/runs/quick-run/stop', '/p/quick/v1/runs/quick-run/steer'].includes(path)) return json(200, { ok: true })
      return json(404, {})
    }))
    const dir = box()
    const base = await serve(createWizardServer({ upstreamOrigin: main, hermesKey: 'main-fixture-key', requireAccess: false, agentBridge: false, wizardOsHome: dir, followThrough: false }))
    const listed = await (await fetch(`${base}/wizard/v1/agents`)).json()
    expect(listed.agents.find(a => a.id === 'quick')).toMatchObject({ label: 'Quick', status: 'running' })
    const created = await fetch(`${base}/wizard/hermes/api/sessions`, post({ id: 'wizard_quick', source: 'wizard-mobile', agent: 'quick' }))
    expect(created.status).toBe(201)
    expect((await created.json()).session.agent).toMatchObject({ id: 'quick', label: 'Quick' })
    const admission = await fetch(`${base}/wizard/hermes/v1/runs`, post({ session_id: 'wizard_quick', input: 'Hi', agent: 'quick' }))
    expect(admission.status).toBe(202)
    expect((await admission.json()).run_id).toBe('quick-run')
    const running = await (await fetch(`${base}/wizard/hermes/api/sessions?agent=quick&view=list&window=archive-50`)).json()
    expect(running.data[0]).toMatchObject({ status: 'running', runId: 'quick-run', lastRunStatus: 'running', agent: 'quick' })
    runStatus = 'completed'
    const completed = await (await fetch(`${base}/wizard/hermes/api/sessions?agent=quick&view=list&window=archive-50`)).json()
    expect(completed.data[0]).toMatchObject({ status: 'completed', runId: 'quick-run', lastRunStatus: 'completed', preview: 'Quick reply', previewRole: 'assistant', lastAssistantAt: new Date(1792612002 * 1000).toISOString() })
    const events = await fetch(`${base}/wizard/hermes/v1/runs/quick-run/events`)
    expect(events.headers.get('content-type')).toContain('text/event-stream')
    expect(await events.text()).toContain('Quick reply')
    for (const action of ['stop', 'steer']) {
      const response = await fetch(`${base}/wizard/hermes/v1/runs/quick-run/${action}`, post(action === 'steer' ? { input: 'Shorter' } : {}))
      expect(response.status).toBe(200)
    }
    const sessions = await (await fetch(`${base}/wizard/hermes/api/sessions?agent=quick`)).json()
    expect(sessions.data[0].agent).toMatchObject({ id: 'quick', label: 'Quick' })
    expect(seen.filter(r => r.path.startsWith('/p/quick/')).every(r => r.auth === 'Bearer quick-fixture-key')).toBe(true)
    expect(seen.filter(r => r.method === 'POST').map(r => r.path)).toEqual([
      '/p/quick/api/sessions', '/p/quick/v1/runs', '/p/quick/v1/runs/quick-run/stop', '/p/quick/v1/runs/quick-run/steer',
    ])
    expect(seen.find(r => r.path === '/p/quick/v1/runs').body.agent).toBeUndefined()
    expect(Object.values(JSON.parse(readFileSync(join(dir, 'agents', '.threads.json'), 'utf8')).threads)).toContainEqual(expect.objectContaining({ agent_id: 'quick', session_id: 'wizard_quick' }))
  })
})
