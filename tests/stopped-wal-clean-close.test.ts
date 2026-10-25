// Regression (review round 5, R5-B1/R5-S1): a cleanly closed WAL-mode Hermes home must seal without
// creating files, so a stopped secondary keeps legacy chosen-id creation identical to archived main.
import { afterEach, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer } from '../server/service.mjs'
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
async function scene({ queued = false, factory = createWizardServer, driver = '', wal = false } = {}) {
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
        const db = new DatabaseSync(join(home, 'state.db')); if (wal) db.exec('PRAGMA journal_mode=WAL'); db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY)'); db.close()
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
    agentUpstreamMode: 'localhost', agentTinfoilUrl: 'http://127.0.0.1:9/v1', settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
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


it.skipIf(!archivedMainDir()).each(['runtipi', 'restricted'])('R5_WAL_CLEAN_STOPPED: %s Hermes WAL home after clean close versus archived main', async driver => {
  const base = archivedMainDir()!
  const baseline = (await import(/* @vite-ignore */ `${base}/server/service.mjs`)).createWizardServer
  const rows: any[] = []
  for (const [label, factory] of [['main', baseline], ['current', createWizardServer]] as const) {
    const s = await scene({ factory, driver, wal: true }), secondary = await s.create('Offline')
    const home = join(s.agentsDir, secondary.id, 'home')
    const filesBeforeStop = readdirSync(home).sort()
    const stop = await s.call(`/wizard/v1/agents/${secondary.id}/stop`, 'POST', {})
    const chosen = await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_client_fresh', source: 'wizard-mobile' })
    const body = await chosen.json()
    let catalog: any = null
    try { catalog = JSON.parse(readFileSync(join(s.agentsDir, '.session-catalog.json'), 'utf8')).agents[secondary.id] } catch {}
    rows.push({ label, stop: stop.status, chosen: chosen.status, error: body.error, hermesHas: s.histories.get('hermes')!.has('wizard_client_fresh'),
      sealed: Boolean(catalog?.seal), filesBeforeStop, filesAfter: readdirSync(home).sort() })
  }
  console.log('R5_WAL_CLEAN_STOPPED', driver, JSON.stringify(rows))
  expect(rows[1].chosen).toBe(rows[0].chosen)
  expect(rows[1].sealed).toBe(true)
  expect(rows[1].filesAfter).toEqual(rows[1].filesBeforeStop)
})
it.each(['runtipi', 'restricted'])('R5_DELETE_JOURNAL_CONTROL: %s rollback-journal home seals', async driver => {
  const s = await scene({ driver }), secondary = await s.create('Offline')
  await s.call(`/wizard/v1/agents/${secondary.id}/stop`, 'POST', {})
  const chosen = await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_client_fresh', source: 'wizard-mobile' })
  console.log('R5_DELETE_JOURNAL_CONTROL', driver, chosen.status)
  expect(chosen.status).toBe(201)
})

// Regression (review round 6, R6-B1): a hot rollback journal must never yield a seal.
it.each(['runtipi', 'restricted'])('R6_HOT_JOURNAL: %s crashed rollback-journal secondary -> census fails closed (review R6-B1)', async driver => {
  const rows: any[] = []
  for (const mode of ['clean', 'hot']) {
    const s = await scene({ driver }), secondary = await s.create('Offline')
    const home = join(s.agentsDir, secondary.id, 'home')
    await execFileAsync('python3', [join(process.cwd(), 'tests/fixtures/hot-rollback-journal.py'), home, mode, (process.env.TMPDIR || tmpdir())], { encoding: 'utf8' })
    const filesBeforeStop = readdirSync(home).sort()
    const stop = await s.call(`/wizard/v1/agents/${secondary.id}/stop`, 'POST', {})
    let catalog: any = null
    try { catalog = JSON.parse(readFileSync(join(s.agentsDir, '.session-catalog.json'), 'utf8')).agents[secondary.id] } catch {}
    const chosen = await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_secondary_committed', source: 'wizard-mobile' })
    // What the secondary will have when it restarts (SQLite rolls the hot journal back on first open with write access).
    const recovered = (await execFileAsync('python3', ['-c', `import sqlite3,shutil,tempfile,os,sys
d=tempfile.mkdtemp(dir=sys.argv[2])
[shutil.copy2(os.path.join(sys.argv[1],n), d) for n in os.listdir(sys.argv[1])]
print(sqlite3.connect(os.path.join(d,'state.db')).execute("select count(*) from sessions where id='wizard_secondary_committed'").fetchone()[0])`, home, (process.env.TMPDIR || tmpdir())], { encoding: 'utf8' })).stdout.trim()
    rows.push({ mode, filesBeforeStop, stop: stop.status, sealed: Boolean(catalog?.seal), sealHasId: Boolean(catalog?.ids?.includes('wizard_secondary_committed')),
      sealIds: catalog?.ids?.length ?? null, chosen: chosen.status, mainCreated: s.histories.get('hermes')!.has('wizard_secondary_committed'),
      secondaryHasAfterRecovery: recovered === '1', filesAfter: readdirSync(home).sort() })
  }
  console.log('R6_HOT_JOURNAL', driver, JSON.stringify(rows))
  expect(rows[0].chosen).not.toBe(201)
  expect(rows[0].mainCreated).toBe(false)
  expect(rows[1].secondaryHasAfterRecovery).toBe(true)
  // Hot journal: no seal, so the claim fails closed and main never mints the secondary's id.
  expect(rows[1].sealed).toBe(false)
  expect(rows[1].chosen).not.toBe(201)
  expect(rows[1].mainCreated).toBe(false)
  expect(rows[1].filesAfter).toEqual(rows[1].filesBeforeStop)
}, 60000)
