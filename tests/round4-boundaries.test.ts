import { afterEach, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer } from './helpers/private-provider-fixture.mjs'
import { createAgentRegistry } from '../server/agents.mjs'
import { threadKey } from '../server/thread-reference.mjs'
import { archivedMainDir } from './support/archived-main'
// These compare against archived main and spawn helpers; under CI load they exceed the 5 s default.
vi.setConfig({ testTimeout: 60_000 })
const execFileAsync = promisify(execFile)

const proof = 'fixture-owner-proof-not-a-real-secret'
const owner = { 'X-Wizard-Owner-Proof': proof }
const cleanup: (() => any)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn() })
const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
async function scene({ queued = false, factory = createWizardServer, driver = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'round4-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const agentsDir = join(dir, 'agents')
  const histories = new Map<string, Set<string>>([['hermes', new Set(['wizard_old'])]])
  const ports = new Map<number, string>([[1, 'hermes']]), statuses = new Map<string, string>(), generations = new Map<string, number>()
  // Async so the in-process service keeps serving while the helper runs (a blocked event loop races keep-alive sockets).
  const helper = async (id: string, action: string) => JSON.parse((await execFileAsync('python3', [join(process.cwd(), 'tests/fixtures/stopped-runtime-helper.py'), agentsDir, id, driver, action], { encoding: 'utf8', timeout: 30000 })).stdout)
  const runtime = {
    inspect: async (id: string) => driver ? helper(id, 'inspect') : ({ status: statuses.get(id), generation: `${id}:${generations.get(id) ?? 0}:${statuses.get(id)}` }),
    apply: async (id: string) => {
      const config = JSON.parse(readFileSync(join(agentsDir, id, 'agent.json'), 'utf8'))
      ports.set(config.runtime.port, id); histories.set(id, new Set()); statuses.set(id, 'running')
      if (driver) {
        const home = join(agentsDir, id, 'home'); mkdirSync(home, { recursive: true })
        const db = new DatabaseSync(join(home, 'state.db')); db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY)'); db.close()
        writeFileSync(join(agentsDir, id, 'fixture-lifecycle.json'), JSON.stringify({ status: 'running', container: 'running' }))
      }
      return { ok: true }
    },
    start: async (id: string) => { generations.set(id, (generations.get(id) ?? 0) + 1); statuses.set(id, 'running'); return { ok: true } },
    stop: async (id: string) => {
      statuses.set(id, 'stopped')
      if (driver) return helper(id, 'stop')
      return { ok: true, census: { ...await runtime.inspect(id), ids: [...histories.get(id)!] } }
    },
  }
  const calls: any[] = []
  const fetchImpl = async (url: any, init: any = {}) => {
    const u = new URL(String(url)), agent = ports.get(Number(u.port))
    if (!agent) throw new Error('unexpected fixture network')
    const method = init.method || 'GET', body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ agent, method, path: u.pathname, body })
    if (statuses.get(agent) === 'stopped') return json({ error: 'offline' }, 503)
    if (u.pathname === '/health') return json({ status: 'ok' })
    if (u.pathname === '/v1/capabilities') return json({ version: 'v1', hermes_version: 'fixture', state_backend: 'sqlite', auth: { mode: 'api_key' }, features: { run_streaming: true, run_blocking: true, sessions: true, cancellation: true, tools: true, system_prompt: true, files: true, artifacts: true, reasoning: false } })
    if (u.pathname === '/api/sessions' && method === 'POST') {
      histories.get(agent)!.add(body.id); return json({ session: { id: body.id, source: 'wizard-mobile' } }, 201)
    }
    if (u.pathname === '/api/sessions') return json({ data: [...histories.get(agent)!].map(id => ({ id, source: 'wizard-mobile', title: id })), has_more: false })
    const id = decodeURIComponent(u.pathname.split('/')[3] ?? '')
    if (u.pathname.startsWith('/api/sessions/')) return histories.get(agent)!.has(id) ? json({ session: { id } }) : json({ error: 'not_found' }, 404)
    return json({ error: 'not_found' }, 404)
  }
  const serverOptions: any = {
    upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture', fetchImpl, agentsDir, agentRuntime: runtime,
    agentUpstreamMode: 'localhost', agentTinfoilUrl: 'http://127.0.0.1:9/v1', settingsPath: join(dir, 'settings.json'), appsJsonPath: join(dir, 'apps.json'), wizardOsHome: dir,
    requireAccess: false, ownerProof: proof, joinedDelegation: 'off', agentBridge: false, followThrough: false, voiceRouting: false, mySkin: false,
    ...(queued ? { runQueueStatePath: join(dir, 'queue.sqlite'), runQueuePollIntervalMs: 0, dispatchHealthReader: () => false, activeSessionReader: () => [] } : {}),
    threadSeenStatePath: join(dir, 'seen.json'), threadDispositionStatePath: join(dir, 'dispositions.json'),
  }
  const service = factory(serverOptions)
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { await new Promise<void>(resolve => { service.close(() => resolve()); service.closeAllConnections() }); await (service as any).drained })
  const base = `http://127.0.0.1:${(service.address() as any).port}`
  const call = (path: string, method = 'GET', body?: any, headers: any = owner) => fetch(base + path, { method, headers: { ...headers, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const create = async (label: string, privacy = 'standard') => {
    const r = await call('/wizard/v1/agents', 'POST', { label, permissions: { preset: privacy }, model: { provider: 'tinfoil', model: 'glm-5-3' } })
    const body = await r.json(); expect(r.status).toBe(201); return body.agent
  }
  return { dir, agentsDir, call, create, histories, runtime, generations, statuses, calls }
}

it('R4_INFLIGHT_SEAL_INVALIDATION: a full lifecycle round during inspect cannot create on Hermes', async () => {
  const s = await scene(), hidden = await s.create('Hidden', 'private'), id = 'wizard_inflight_seal'
  await s.call(`/wizard/v1/agents/${hidden.id}/stop`, 'POST', {})
  // Deliberately reuse the same driver token after a full lifecycle round: the
  // service epoch must fence an in-flight answer even if the seal token repeats.
  s.runtime.start = async id => { s.statuses.set(id, 'running'); return { ok: true } }
  const original = s.runtime.inspect
  let entered!: () => void, release!: () => void, block = true
  const began = new Promise<void>(resolve => { entered = resolve }), pending = new Promise<void>(resolve => { release = resolve })
  s.runtime.inspect = async agentId => {
    const snapshot = await original(agentId)
    if (block && agentId === hidden.id) { block = false; entered(); await pending }
    return snapshot
  }
  const claim = s.call('/wizard/hermes/api/sessions?agent=hermes', 'POST', { id }, {})
  await began
  try {
    expect((await s.call(`/wizard/v1/agents/${hidden.id}/start`, 'POST', {})).status).toBe(202)
    s.histories.get(hidden.id)!.add(id)
    expect((await s.call(`/wizard/v1/agents/${hidden.id}/stop`, 'POST', {})).status).toBe(202)
  } finally { release() }
  expect([404, 503]).toContain((await claim).status) // private positive may be rechecked after the stale answer
  expect(s.histories.get('hermes')!.has(id)).toBe(false)
  expect(s.histories.get(hidden.id)!.has(id)).toBe(true)
})

it.skipIf(!archivedMainDir()).each(['runtipi', 'restricted'])('R4_UNSEALABLE_STOPPED: %s real helper stop semantics preserve archived-main 201', async driver => {
  const base = archivedMainDir()!
  const baseline = (await import(/* @vite-ignore */ `${base}/server/service.mjs`)).createWizardServer
  const rows = []
  for (const factory of [baseline, createWizardServer]) {
    const s = await scene({ factory, driver }), secondary = await s.create('Offline')
    expect((await s.call(`/wizard/v1/agents/${secondary.id}/stop`, 'POST', {})).status).toBe(202)
    const chosen = await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_client_fresh', source: 'wizard-mobile' })
    const body = await chosen.json()
    rows.push({ status: chosen.status, body: { session: { id: body.session?.id, source: body.session?.source } }, hermesHas: s.histories.get('hermes')!.has('wizard_client_fresh') })
    if (factory === createWizardServer) {
      const catalog = JSON.parse(readFileSync(join(s.agentsDir, '.session-catalog.json'), 'utf8')).agents[secondary.id]
      expect(catalog.complete).toBe(true); expect(catalog.seal).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.parse(readFileSync(join(s.agentsDir, secondary.id, 'fixture-lifecycle.json'), 'utf8')).container).toBe(driver === 'runtipi' ? 'absent' : 'exited')
    }
  }
  expect(rows[0].status).toBe(201); expect(rows[1]).toEqual(rows[0])
})

it('a genuinely unsealable stopped runtime still gives 503 and never creates on Hermes', async () => {
  const s = await scene(), secondary = await s.create('Offline')
  s.runtime.stop = async id => { s.statuses.set(id, 'stopped'); return { ok: true, census: null, census_error: 'offline_census_unavailable' } as any }
  await s.call(`/wizard/v1/agents/${secondary.id}/stop`, 'POST', {})
  expect((await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_unseen' })).status).toBe(503)
  expect(s.histories.get('hermes')!.has('wizard_unseen')).toBe(false)
})

it.each([true, false])('R4_ASYNC_PIN: queued admission pins runtime-verified catalog positives only (%s)', async positive => {
  // Force a positive catalog without a pre-existing pin through the real
  // registry factory seam; queue admission itself must never be authority.
  const contains = vi.spyOn((await import('../server/agents.mjs')), 'createAgentRegistry').mockImplementation((options: any) => {
    const registry = createAgentRegistryOriginal(options)
    registry.observeSessions('hermes', positive ? ['wizard_queue_known'] : [], { index: false })
    return registry
  })
  const s = await scene({ queued: true })
  contains.mockRestore()
  const r = await s.call('/wizard/hermes/v1/runs', 'POST', { session_id: 'wizard_queue_known', input: 'fixture question' }, { ...owner, 'Idempotency-Key': 'fixture-queued-admission' })
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(202)
  const registry = createAgentRegistry({ agentsDir: s.agentsDir })
  expect(registry.pinnedAgents('wizard_queue_known')).toEqual(positive ? ['hermes'] : [])
  if (positive) expect(JSON.parse(readFileSync(join(s.agentsDir, '.threads.json'), 'utf8')).threads[threadKey('hermes', 'wizard_queue_known')].provenance).toBe('runtime_verified')
  expect(s.calls.some(c => c.method === 'POST' && c.path === '/v1/runs')).toBe(false)
})
const createAgentRegistryOriginal = createAgentRegistry

it('R4_N1: catalogContains snapshots epoch and seal even when a driver reuses its generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'epoch-bound-seal-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let state = 'running', blocked = false, entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), pending = new Promise<void>(resolve => { release = resolve })
  const runtime = {
    apply: async () => ({}),
    inspect: async () => { const result = { status: state, generation: 'reused-token' }; if (blocked) { blocked = false; entered(); await pending }; return result },
    stop: async () => { state = 'stopped'; return { ok: true, census: { status: state, generation: 'reused-token', ids: [] } } },
    start: async () => { state = 'running'; return {} },
  }
  const registry = createAgentRegistry({ agentsDir: join(dir, 'agents'), runtime, tinfoilUrl: 'http://127.0.0.1:9/v1', fetchImpl: async () => json({ data: [], has_more: false }) })
  const { agent } = await registry.create({ label: 'Private', permissions: { preset: 'private' }, model: { provider: 'tinfoil', model: 'glm-5-3' } })
  await registry.setRunning(agent.id, false)
  expect(await registry.catalogContains(agent.id, 'wizard_unseen')).toBe(false)
  blocked = true
  const answer = registry.catalogContains(agent.id, 'wizard_unseen')
  await began
  try { await registry.setRunning(agent.id, true); await registry.setRunning(agent.id, false) } finally { release() }
  expect(await answer).toBeUndefined()
  expect(await registry.catalogContains(agent.id, 'wizard_unseen')).toBe(false)
})
