// Core integration must keep pre-provider-app Private agents usable without migrating their runtime.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAgentRegistry, hermesConfigYaml, parseAgentFile } from '../server/agents.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: Server[] = []
const roots: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function legacyBox(port = 18650) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-')); roots.push(root)
  const agentsDir = join(root, 'agents'), folder = join(agentsDir, 'private')
  mkdirSync(join(folder, 'home'), { recursive: true })
  const agent = {
    schema: 1, id: 'private', label: 'Private', harness: 'hermes', privacy: 'private',
    model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3'], fallback: false },
    permissions: { preset: 'private', outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [], other_agents: 'none' },
    runtime: { kind: 'container', app_id: 'agent-private', port }, created_at: 1,
  }
  writeFileSync(join(folder, 'agent.json'), JSON.stringify(agent))
  writeFileSync(join(folder, 'runtime.key'), 'synthetic-private-api-key')
  // No wizard-tinfoil, local provider or private_inference app is installed.
  const appsJsonPath = join(root, 'apps.json')
  writeFileSync(appsJsonPath, JSON.stringify({ schema: 1, apps: [] }))
  return { root, folder, agentsDir, appsJsonPath, agent }
}

it('legacy private tinfoil sessions and runs are not refused when no provider app is installed', async () => {
  const seen: { path: string, method: string, auth: string, body: any }[] = []
  const runtime = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    const path = new URL(req.url || '/', 'http://fixture').pathname
    seen.push({ path, method: req.method || '', auth: String(req.headers.authorization || ''), body })
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (path === '/health') return send(200, { status: 'ok' })
    if (path === '/api/sessions' && req.method === 'GET') return send(200, { data: [{ id: 'wizard_legacy_thread', title: 'Synthetic legacy thread', source: 'api_server', created_at: 1, updated_at: 1 }] })
    if (path === '/api/sessions' && req.method === 'POST') return send(201, { session: { id: body.id } })
    if (path === '/v1/runs' && req.method === 'POST') return send(202, { run_id: 'legacy-run', status: 'started' })
    return send(404, { error: 'not_found' })
  })
  servers.push(runtime)
  const address = await listen(runtime) as import('node:net').AddressInfo
  const box = legacyBox(address.port)
  const before = readFileSync(join(box.folder, 'agent.json'), 'utf8')
  const service = createWizardServer({
    upstreamOrigin: `http://127.0.0.1:${address.port}`, hermesKey: 'synthetic-main-key', requireAccess: false,
    wizardOsHome: box.root, appsJsonPath: box.appsJsonPath, settingsPath: join(box.root, 'settings.json'),
    agentBridge: false, followThrough: false, scheduler: false,
  })
  servers.push(service)
  const serviceAddress = await listen(service) as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${serviceAddress.port}/wizard/hermes`
  const listing = await fetch(`${base}/api/sessions?agent=private`)
  expect(listing.status).toBe(200)
  expect((await listing.json()).data[0].id).toBe('wizard_legacy_thread')
  const created = await fetch(`${base}/api/sessions?agent=private`, json({ id: 'wizard_legacy_new' }))
  expect(created.status).toBe(201)
  expect((await created.json()).session.id).toBe('wizard_legacy_new')
  const run = await fetch(`${base}/v1/runs?agent=private`, json({ session_id: 'wizard_legacy_new', input: 'Synthetic private compatibility probe' }))
  expect(run.status).toBe(202)
  expect((await run.json()).run_id).toBe('legacy-run')
  const writes = seen.filter(row => row.method === 'POST')
  expect(writes.map(row => row.path)).toEqual(['/api/sessions', '/v1/runs'])
  expect(writes.every(row => row.auth === 'Bearer synthetic-private-api-key')).toBe(true)
  expect(readFileSync(join(box.folder, 'agent.json'), 'utf8')).toBe(before)
  expect(JSON.parse(readFileSync(box.appsJsonPath, 'utf8')).apps).toEqual([])
  const config = hermesConfigYaml(parseAgentFile(box.agent, 'private'))
  expect(config).toContain('http://agent-private-tinfoil:3301/v1')
  expect(config).toContain('${TINFOIL_API_KEY}')
  expect(config).not.toContain('agent-private-client')
})

it('legacy local-model config retains the local URL and key environment references', () => {
  const box = legacyBox()
  const agent = parseAgentFile({ ...box.agent, model: { provider: 'local', model: 'synthetic-local', allowed_models: ['synthetic-local'], fallback: false } }, 'private')
  const config = hermesConfigYaml(agent)
  expect(config).toContain('  provider: custom')
  expect(config).toContain('  base_url: ${WIZARD_LOCAL_MODEL_URL}')
  expect(config).toContain('  api_key: ${WIZARD_LOCAL_MODEL_KEY}')
  expect(config).not.toContain('tinfoil:3301')
})

it('run references preserve optional idempotency keys and heavy continuation lineage', () => {
  const box = legacyBox()
  const registry = createAgentRegistry({ agentsDir: box.agentsDir, appsJsonPath: box.appsJsonPath })
  registry.noteRun('direct', 'private', 'thread', 'request-key')
  registry.noteRun('continuation', 'private', 'thread', { heavyOrigin: 'direct', idempotencyKey: 'heavy-key' })
  registry.noteRun('no-key', 'private', 'other-thread')
  expect(registry.runThread('private', 'direct').idempotency_key).toBe('request-key')
  expect(registry.runThread('private', 'continuation')).toMatchObject({ heavy_origin: 'direct', idempotency_key: 'heavy-key' })
  expect(registry.runThread('private', 'no-key')).not.toHaveProperty('idempotency_key')
  expect(registry.latestRunForSession('private', 'thread').run_id).toBe('direct')
  expect(registry.latestRunForSession('private', 'thread', { includeHeavy: true }).run_id).toBe('continuation')
})
