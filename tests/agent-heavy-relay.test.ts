import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgentRegistry } from '../server/agents.mjs'
import { createHeavyIntegration } from '../server/heavy-integration.mjs'
import { DurableHeavyQueue } from '../server/heavy-queue.mjs'
import { createPrincipalResolver, markAgentIngress } from '../server/principals.mjs'
import { createAgentIngress, createWizardServer, listen } from '../server/service.mjs'

const clean: (() => any)[] = []
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); vi.unstubAllEnvs() })
const token = 'heavy-host-fixture-token-00000000000000000'
const proof = 'owner-proof-fixture-000000000000000000000'
const path = (action: string) => `/wizard/v1/agent-heavy/${action}`
const gateway = (id: string) => `fixture-${id}-gateway-00000000000000000000`
function home() {
  const root = mkdtempSync(join(tmpdir(), 'agent-heavy-'))
  clean.push(() => rmSync(root, { recursive: true, force: true }))
  vi.stubEnv('WIZARD_HEAVY_ROOT', join(root, 'staging'))
  return root
}
function records(root: string) {
  writeFileSync(join(root, 'apps.json'), JSON.stringify({ schema: 1, apps: [] }))
  for (const [id, port] of [['alpha', 47131], ['beta', 47132]] as const) {
    const folder = join(root, 'agents', id); mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'agent.json'), JSON.stringify({ schema: 1, id, harness: 'hermes', label: id,
      privacy: 'standard', grants: { heavy: true }, model: { provider: 'fixture', model: 'model-a', allowed_models: ['model-a'] },
      permissions: { preset: 'standard', files: 'own', outside_tools: [], other_agents: 'none' },
      runtime: { kind: 'container', app_id: `agent-${id}`, port, isolation: 'restricted', network: { uplink: '127.0.0.0/28', sandbox: '127.0.1.0/28' } } }))
    writeFileSync(join(folder, 'runtime.key'), `runtime-${id}-fixture`)
    writeFileSync(join(folder, 'gateway.key'), gateway(id))
  }
}
function fakeRuntime() {
  const posts: any[] = [], reads: any[] = [], remote: any[] = []
  const states = { originDone: false, workerDone: false, human: 'Run the checks', humanId: 1 }
  const fetchImpl = async (url: string, init: any = {}) => {
    const u = new URL(url), id = u.port === '47131' ? 'alpha' : u.port === '47132' ? 'beta' : 'hermes'
    reads.push({ id, path: u.pathname, init })
    const json = (v: any, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
    if (u.pathname === '/health') return json({ status: 'ok' })
    if (u.pathname === '/v1/capabilities') return json({ features: {} })
    if (u.pathname === '/api/sessions') return json({ data: [{ id: 'shared' }], has_more: false })
    if (u.pathname === '/api/sessions/shared') return json({ session: { id: 'shared' } })
    if (u.pathname === '/api/sessions/shared/messages') return json({ data: [{ id: states.humanId, role: 'user', content: states.human }] })
    if (u.pathname.startsWith('/api/sessions/')) return json({ error: 'missing' }, 404)
    if (u.pathname.startsWith('/v1/runs/') && !u.pathname.endsWith('/events')) return json({ run_id: u.pathname.split('/').at(-1), status: states.originDone ? 'completed' : 'running', runtime: { model: 'model-a', provider: 'fixture' } })
    if (u.pathname === '/v1/runs' && init.method === 'POST') {
      posts.push({ id, body: JSON.parse(init.body), headers: new Headers(init.headers) })
      return json({ run_id: `${id}-run-${posts.length}`, status: 'running', session_id: JSON.parse(init.body).session_id }, 202)
    }
    if (u.pathname === '/api/model/options') return json({ providers: [] })
    return json({ error: 'fixture missing' }, 404)
  }
  const admitted = new Set<string>()
  const transport = async (p: any) => {
    remote.push(p)
    if (p.action === 'submit') admitted.add(p.job_id)
    if (!admitted.has(p.job_id)) return null
    return { job_id: p.job_id, state: p.action === 'cancel' ? 'cancelled' : states.workerDone ? 'completed' : 'queued', receipt: states.workerDone ? { exit_code: 0, artifacts: ['result.txt'] } : null }
  }
  return { fetchImpl, transport, states, posts, reads, remote }
}
async function scene(enabled: string | undefined = 'on') {
  const root = home(); records(root)
  const runtime = fakeRuntime()
  const registry = createAgentRegistry({ agentsDir: join(root, 'agents'), appsJsonPath: join(root, 'apps.json'), fetchImpl: runtime.fetchImpl })
  registry.noteRun('origin', 'alpha', 'shared'); registry.noteRun('origin', 'beta', 'shared')
  const resolver = createPrincipalResolver({ ownerProof: proof, agentForToken: (key: string) => registry.agentForGatewayToken(key),
    agentRestricted: (id: string) => registry.agentRestricted(id), agentSubnet: (id: string) => registry.agentUplink(id) })
  const options: any = { heavyStatePath: join(root, 'heavy.db'), heavyToken: token, heavyTransport: runtime.transport, fetchImpl: runtime.fetchImpl, agentHeavy: enabled }
  const hostQueue = { latestForSession: () => ({ publicRunId: 'host-origin', runtime: 'direct', status: 'running', body: JSON.stringify({ model: 'host-model', provider: 'host-provider' }) }) }
  const heavy = createHeavyIntegration({ options, registry, queue: hostQueue, request: async () => ({ data: [{ id: 1, role: 'user', content: 'Host instruction' }] }) })!
  clean.push(() => heavy.close())
  async function req(id = 'alpha', ingress = true, credential = gateway(id)) {
    const r: any = { headers: { authorization: `Bearer ${credential}` }, socket: { remoteAddress: '127.0.0.1' } }
    if (ingress) markAgentIngress(r)
    await resolver.attach(r); return r
  }
  const spec = (id = 'alpha') => ({ cwd: join(root, 'staging', 'agents', id, 'project'), argv: ['true'], timeout_seconds: 10 })
  const submit = async (id = 'alpha', extra: any = {}) => heavy.handleAgent(await req(id), path('submit'), { session_id: 'shared', key: 'same', spec: spec(id), ...extra })
  const change = (id: string, fn: (value: any) => any) => { const file = join(root, 'agents', id, 'agent.json'); writeFileSync(file, JSON.stringify(fn(JSON.parse(readFileSync(file, 'utf8'))))) }
  return { root, registry, heavy, options, req, spec, submit, change, ...runtime }
}

it('is off by default, even with an owner-provisioned grant', async () => {
  const s = await scene('off')
  delete s.options.agentHeavy
  await expect(s.submit()).rejects.toMatchObject({ status: 404 })
  expect(s.remote).toEqual([])
})
it('requires an explicit owner-set boolean grant and refuses private/non-restricted agents', async () => {
  const s = await scene()
  for (const mutate of [
    (v: any) => ({ ...v, grants: {} }),
    (v: any) => ({ ...v, grants: { heavy: 'true' } }),
    (v: any) => ({ ...v, grants: { heavy: true }, privacy: 'private' }),
    (v: any) => ({ ...v, privacy: 'standard', runtime: { ...v.runtime, isolation: '' } }),
  ]) { s.change('alpha', mutate); await expect(s.submit()).rejects.toMatchObject({ status: 403 }) }
  expect(s.remote).toEqual([])
})
it('always refuses recovery, even if configuration claims a grant and restricted runtime', async () => {
  const s = await scene(), read = s.registry.read
  s.registry.read = (id: string) => ({ ...read(id), role: 'recovery' })
  await expect(s.submit()).rejects.toMatchObject({ status: 403 })
})
it('rejects body identity spoofing and both cross-listener credential substitutions', async () => {
  const s = await scene()
  await expect(s.submit('alpha', { agent_id: 'beta' })).rejects.toMatchObject({ status: 403 })
  await expect(s.heavy.handleAgent(await s.req('alpha', true, token), path('submit'), {})).rejects.toMatchObject({ status: 403 })
  await expect(s.heavy.handle(await s.req(), '/wizard/internal/heavy/submit', {})).rejects.toMatchObject({ status: 403 })
  await expect(s.heavy.handle(await s.req('alpha', false), '/wizard/internal/heavy/submit', {})).rejects.toMatchObject({ status: 403 })
  await expect(s.heavy.handleAgent(await s.req('alpha', false), path('submit'), {})).rejects.toMatchObject({ status: 403 })
})
it('hides foreign and missing sessions equally, without touching the other runtime', async () => {
  const s = await scene()
  for (const session_id of ['foreign-beta', 'missing']) await expect(s.submit('alpha', { session_id })).rejects.toMatchObject({ status: 404 })
  expect(s.reads.every(row => row.id === 'alpha')).toBe(true)
  expect(s.heavy.queue.rows()).toEqual([])
})
it('qualifies idempotency and status/cancel/artifacts by agent, not session text or job id', async () => {
  const s = await scene(), a = await s.submit(), b = await s.submit('beta')
  expect(a.job_id).not.toBe(b.job_id)
  expect((await s.submit()).job_id).toBe(a.job_id)
  for (const action of ['status', 'cancel', 'artifacts']) {
    await expect(s.heavy.handleAgent(await s.req('beta'), path(action), { session_id: 'shared', job_id: a.job_id })).rejects.toMatchObject({ status: 404 })
    await expect(s.heavy.handleAgent(await s.req('alpha'), path(action), { session_id: 'shared', job_id: 'missing' })).rejects.toMatchObject({ status: 404 })
  }
  expect((await s.heavy.handleAgent(await s.req(), path('cancel'), { session_id: 'shared', job_id: a.job_id })).cancel_requested).toBe(true)
  expect(s.heavy.queue.get(b.job_id).cancel_requested).toBe(false)
  // The host token cannot fetch an agent job through the unchanged host surface.
  await expect(s.heavy.handle(await s.req('', false, token), '/wizard/internal/heavy/status', { session_id: 'shared', job_id: b.job_id })).rejects.toMatchObject({ status: 404 })
})
it('confines cwd to the agent staging root and validates lanes and plugin timeout limits', async () => {
  const s = await scene(), base = s.spec().cwd
  for (const cwd of ['/escape', 'relative', base + '/../other', base + '/./x', base.replace('/alpha/', '/beta/'), base + '/%2e%2e', base + '/\\escape', base + '//x', base + '/$HOME', base + '/\0x']) {
    await expect(s.submit('alpha', { spec: { ...s.spec(), cwd } })).rejects.toMatchObject({ status: 400 })
  }
  for (const spec of [{ ...s.spec(), lane: 'invalid' }, { ...s.spec(), lane: 'light', timeout_seconds: 901 }, { ...s.spec(), timeout_seconds: 86401 }, { ...s.spec(), timeout_seconds: 1.5 }, { ...s.spec(), env: { ANY: 'value' } }]) {
    await expect(s.submit('alpha', { spec })).rejects.toMatchObject({ status: 400 })
  }
  expect((await s.submit('alpha', { spec: { ...s.spec(), lane: 'light', timeout_seconds: 900 } })).state).toBe('queued')
})
it('caps active jobs at two per agent without blocking retries or another agent', async () => {
  const s = await scene(), first = await s.submit()
  await s.submit('alpha', { key: 'second' })
  await expect(s.submit('alpha', { key: 'third' })).rejects.toMatchObject({ status: 429 })
  expect((await s.submit()).job_id).toBe(first.job_id)
  expect((await s.submit('beta')).state).toBe('queued')
})
it('resumes only the submitting agent-qualified thread using fake transport, once after completion', async () => {
  const s = await scene(), job = await s.submit()
  expect(s.remote).toEqual([])
  expect((await s.heavy.handleAgent(await s.req(), path('status'), { session_id: 'shared', job_id: job.job_id })).state).toBe('queued')
  s.states.workerDone = true
  await s.heavy.queue.tick()
  expect(s.posts).toEqual([]) // origin still owns mutation slot
  s.states.originDone = true
  await s.heavy.queue.tick(); await s.heavy.queue.tick()
  expect(s.posts).toHaveLength(1)
  expect(s.posts[0].id).toBe('alpha')
  expect(s.posts[0].body).toMatchObject({ session_id: 'shared', model: 'model-a', provider: 'fixture', require_model_lock: true })
  expect(s.posts[0].headers.get('authorization')).toBe('Bearer runtime-alpha-fixture')
  expect(s.posts[0].headers.get('idempotency-key')).toBe(`wizard-heavy-${job.job_id}`)
  expect(s.heavy.queue.get(job.job_id).resume).toBe('alpha-run-1')
  expect(s.registry.runThread('alpha', 'alpha-run-1').session_id).toBe('shared')
  expect(s.reads.some(row => row.id === 'hermes')).toBe(false)
})
it('suppresses continuation on a newer human instruction', async () => {
  const s = await scene(), job = await s.submit()
  s.states.workerDone = true; s.states.originDone = true; s.states.human = 'Stop now'; s.states.humanId = 2
  await s.heavy.queue.tick()
  expect(s.heavy.queue.get(job.job_id).resume).toBe('superseded')
  expect(s.posts).toEqual([])
})
it('keeps Hermes receipt/idempotency behavior and migrated legacy job bytes unchanged', async () => {
  const s = await scene()
  const req = await s.req('', false, token)
  const body = { session_id: 'shared', key: 'host', spec: { ...s.spec(), cwd: join(s.root, 'staging', 'host-project') } }
  const one = await s.heavy.handle(req, '/wizard/internal/heavy/submit', body)
  expect(one.agent_id).toBe('hermes')
  expect((await s.heavy.handle(req, '/wizard/internal/heavy/submit', body)).job_id).toBe(one.job_id)
  expect((await s.heavy.handle(req, '/wizard/internal/heavy/cancel', { session_id: 'shared', job_id: one.job_id })).cancel_requested).toBe(true)
  const statePath = join(s.root, 'legacy.db'), db = new DatabaseSync(statePath)
  const legacy = { job_id: 'old-id', sessionId: 'shared', agent_id: 'hermes', session_id: 'shared', state: 'queued' }
  db.exec('CREATE TABLE heavy_jobs(id TEXT PRIMARY KEY, session TEXT, origin TEXT, key TEXT, hash TEXT, data TEXT, agent_id TEXT DEFAULT \'hermes\', UNIQUE(session,origin,key))')
  const bytes = JSON.stringify(legacy)
  db.prepare('INSERT INTO heavy_jobs VALUES(?,?,?,?,?,?,?)').run('old-id', 'shared', 'origin', 'key', 'unchanged-hash', bytes, 'hermes'); db.close()
  const migrated = new DurableHeavyQueue({ statePath, transport: async () => null, current: async () => false, continuation: async () => null })
  clean.push(() => migrated.close())
  expect(migrated.db.prepare('SELECT data,hash FROM heavy_jobs').get()).toMatchObject({ data: bytes, hash: 'unchanged-hash' })
})
it('wires the real Service agent-only listener and keeps host bearer/key routes separated', async () => {
  const root = home(); records(root); const fake = fakeRuntime()
  const service = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:47130', hermesKey: 'fixture-main-key', fetchImpl: fake.fetchImpl,
    wizardOsHome: root, appsJsonPath: join(root, 'apps.json'), settingsPath: join(root, 'settings.json'),
    ownerProof: proof, requireAccess: false, agentBridge: false, joinedDelegation: 'off', followThrough: false,
    runQueueStatePath: join(root, 'runs.db'), heavyStatePath: join(root, 'heavy.db'), heavyToken: token,
    heavyTransport: fake.transport, heavyPollIntervalMs: 10, agentHeavy: 'on' })
  const ingress = createAgentIngress(service)
  clean.push(async () => { for (const server of [ingress, service]) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) } })
  const addr = await listen(service) as any, edge = await listen(ingress) as any
  const base = `http://127.0.0.1:${addr.port}`, agent = `http://127.0.0.1:${edge.port}`
  const post = (origin: string, url: string, credential: string, body: any, owner = false) => fetch(origin + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-wizard-owner-proof': proof } : { Authorization: `Bearer ${credential}` }) }, body: JSON.stringify(body) })
  const body = { session_id: 'shared', key: 'http', spec: { cwd: join(root, 'staging', 'agents', 'alpha'), argv: ['true'], timeout_seconds: 10 } }
  expect((await post(agent, path('submit'), token, body)).status).toBe(401)
  expect((await post(base, path('submit'), gateway('alpha'), body)).status).toBe(403)
  expect((await post(agent, '/wizard/internal/heavy/submit', gateway('alpha'), body)).status).toBe(403)
  expect((await post(base, '/wizard/hermes/v1/runs?agent=alpha', '', { session_id: 'shared', input: 'run checks' }, true)).status).toBe(202)
  const submitted = await post(agent, path('submit'), gateway('alpha'), body)
  expect(submitted.status).toBe(200)
  const job = await submitted.json()
  expect(job.agent_id).toBe('alpha')
  expect((await post(base, path('status'), '', { job_id: job.job_id }, true)).status).toBe(200)
  expect((await post(agent, path('status'), gateway('beta'), { session_id: 'shared', job_id: job.job_id })).status).toBe(404)
  fake.states.workerDone = true; fake.states.originDone = true
  await vi.waitFor(() => expect(fake.posts.filter(row => row.body.input?.startsWith('[Wizard heavy-work completion]'))).toHaveLength(1))
  expect(fake.posts.at(-1).id).toBe('alpha')
  const status = await post(agent, path('status'), gateway('alpha'), { session_id: 'shared', job_id: job.job_id })
  expect((await status.json()).state).toBe('completed')
})
