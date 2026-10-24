// Reuse: n/a (rig fixture admission regression; no frontend changes).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

it('rehearsal uses server-minted sessions when unrelated main history is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rig-admission-'))
  const sessions = new Set<string>()
  const seen: string[] = []
  const runtime = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const path = new URL(req.url || '/', 'http://fixture').pathname
    seen.push(`${req.method} ${path}`)
    const send = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (path === '/health') return send(200, { status: 'ok' })
    if (path === '/api/sessions' && req.method === 'POST') {
      sessions.add(body.id); return send(201, { session: { id: body.id } })
    }
    if (path === '/api/sessions') return send(200, { data: [...sessions].map(id => ({ id, source: 'api_server' })) })
    if (path.startsWith('/api/sessions/')) return send(sessions.has(decodeURIComponent(path.slice('/api/sessions/'.length))) ? 200 : 404, {})
    if (path === '/v1/runs') return send(202, { run_id: 'rig-synthetic-run', status: 'started' })
    return send(404, {})
  })
  const address = await listen(runtime) as import('node:net').AddressInfo
  const folder = join(root, 'agents', 'pp-test-legacy'); mkdirSync(join(folder, 'home'), { recursive: true })
  writeFileSync(join(folder, 'runtime.key'), 'synthetic-rig-only-key')
  writeFileSync(join(folder, 'agent.json'), JSON.stringify({ schema: 1, id: 'pp-test-legacy', label: 'pp-test-legacy', harness: 'hermes', privacy: 'private', model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3'], fallback: false }, permissions: { preset: 'private', outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [], other_agents: 'none' }, runtime: { kind: 'container', app_id: 'agent-pp-test-legacy', port: address.port }, created_at: 1 }))
  const appsJsonPath = join(root, 'apps.json'); writeFileSync(appsJsonPath, JSON.stringify({ schema: 1, apps: [] }))
  const service = createWizardServer({ wizardOsHome: root, appsJsonPath, settingsPath: join(root, 'settings.json'), upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'synthetic-main-key', requireAccess: false, agentBridge: false, followThrough: false, scheduler: false })
  const api = await listen(service) as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${api.port}/wizard/hermes`
  const post = (path: string, body: unknown) => fetch(base + path + '?agent=pp-test-legacy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const manufactured = await post('/api/sessions', { id: 'wizard_rig_fabricated' })
    expect(manufactured.status).toBe(503)
    expect(await manufactured.json()).toMatchObject({ error: 'agent_unavailable', check: 'agent.history' })
    const created = await post('/api/sessions', { source: 'wizard-mobile', title: 'Synthetic rehearsal history' })
    expect(created.status).toBe(201)
    const body = await created.json(); expect(body.session.id).toMatch(/^wizard_/)
    const run = await post('/v1/runs', { session_id: body.session.id, input: 'Synthetic turn; fake runtime only.' })
    expect(run.status).toBe(202)
    expect(sessions.has(body.session.id)).toBe(true)
    expect(seen.filter(p => p === 'POST /api/sessions')).toHaveLength(1)
  } finally {
    for (const server of [service, runtime]) { server.closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())) }
    rmSync(root, { recursive: true, force: true })
  }
})
