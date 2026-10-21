import { afterEach, expect, it, vi } from 'vitest'
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal(), execFile: (...args: any[]) => { const cb = args.at(-1); cb(null, 't-123456789abc\n', ''); return { stdin: {on() {}, end() {}}, on() {} } } }))
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer } from '../server/service.mjs'
import { createAgentRegistry } from '../server/agents.mjs'

import { threadKey } from '../server/thread-reference.mjs'

const proof = 'fixture-owner-proof-not-a-real-secret'
const owner = { 'X-Wizard-Owner-Proof': proof }
const cleanup: (() => any)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
async function scene({ queued = false, manifest = null as any } = {}) {
  // Run only the fresh-box snapshot against an archived contract base to prove byte compatibility.
  const makeServer = process.env.WAS_S2C_BASELINE ? (await import(/* @vite-ignore */ `${process.env.WAS_S2C_BASELINE}/server/service.mjs`)).createWizardServer : createWizardServer
  const dir = mkdtempSync(join(tmpdir(), 'default-agent-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const settingsPath = join(dir, 'settings.json'), agentsDir = join(dir, 'agents')
  const manifestPath = join(dir, 'voice-manifest.json')
  if (manifest) writeFileSync(manifestPath, JSON.stringify(manifest))
  const appsJsonPath = join(dir, 'apps.json')
  writeFileSync(appsJsonPath, JSON.stringify({ schema: 1, apps: [{ id: 'notes', name: 'Notes', agent_binding: true, status: 'running', view: { url: '/notes/' }, mcp: { url: 'http://127.0.0.1:9876/mcp' } }] }))
  const fixtureDbPath = join(dir, 'main.sqlite'); const fixtureDb = new DatabaseSync(fixtureDbPath); fixtureDb.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('wizard_old')"); fixtureDb.close()
  const calls: any[] = [], histories = new Map<string, Set<string>>([['hermes', new Set(['wizard_old'])]])
  const dispatch = { healthy: false }
  const ports = new Map<number, string>([[1, 'hermes']]), status = new Map<string, string>()
  const runtime = {
    inspect: async (id: string) => ({status: status.get(id) ?? 'running', generation: `${id}:${status.get(id) ?? 'running'}`}),
    census: async (id: string) => ({...await runtime.inspect(id), ids: [...histories.get(id)!]}),
    apply: async (id: string) => { const config = JSON.parse(readFileSync(join(agentsDir, id, 'agent.json'), 'utf8')); ports.set(config.runtime.port, id); histories.set(id, new Set()); status.set(id, 'running'); return {} },
    status: async (id: string) => ({ status: status.get(id) ?? 'running', status_detail: '' }),
    start: async (id: string) => { status.set(id, 'running'); return {} }, stop: async (id: string) => { status.set(id, 'stopped'); return {} },
  }
  const fetchImpl = async (url: any, init: any = {}) => {
    const u = new URL(String(url)), agent = ports.get(Number(u.port))
    if (u.host === "127.0.0.1:7") { if (u.pathname === "/helm/api/state") return json({archived_threads:[{id:"t-123456789abc",status:"processed"}],threads:[]}); throw new Error("unexpected fake helm path "+u.pathname) }; if (!agent) throw new Error("network forbidden: "+url)
    const method = init.method || 'GET', body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ agent, method, path: u.pathname, body })
    if (status.get(agent) === 'stopped') return json({ error: 'offline' }, 503)
    if (u.pathname === '/v1/capabilities') return json({ features: {} })
    if (u.pathname === '/health') return json({ status: 'ok' })
    if (u.pathname === '/api/sessions' && method === 'POST') { const id = body.id || 'wizard_generated'; histories.get(agent)!.add(id); return json({ session: { id, source: 'wizard-mobile', title: 'Chat' } }, 201) }
    if (u.pathname === '/api/sessions') return json({ data: [...histories.get(agent)!].map(id => ({ id, source: 'wizard-mobile', title: id, message_count: 1 })), has_more: false })
    if (u.pathname.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(u.pathname.split('/')[3])
      if (!histories.get(agent)!.has(id)) return json({ error: 'not_found' }, 404)
      if (u.pathname.endsWith('/messages')) return json({ data: [{ id: 'm1', session_id: id, role: 'assistant', content: agent }] })
      return json({ session: { id, source: 'wizard-mobile', title: agent } })
    }
    if (u.pathname === '/v1/runs' && method === 'POST') { histories.get(agent)!.add(body.session_id); return json({ run_id: `run_${agent}`, session_id: body.session_id, status: 'queued' }, 202) }
    return json({ error: 'not_found' }, 404)
  }
  const serverOptions: any = { upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture', fetchImpl, agentsDir, agentRuntime: runtime,
    agentUpstreamMode: 'localhost', agentTinfoilUrl: 'http://127.0.0.1:9/v1', settingsPath, appsJsonPath, wizardOsHome: dir,
    requireAccess: false, ownerProof: proof, agentBridge: false, followThrough: false, voiceRouting: false, mySkin: false, joinedDelegation: 'prefer',
    hermesStatePath: fixtureDbPath, voiceRecoveryManifestPath: manifestPath, helmOrigin: "http://127.0.0.1:7", helmThreadIdResolver: async () => "t-123456789abc",
    ...(queued ? { runQueueStatePath: join(dir, 'queue.sqlite'), runQueuePollIntervalMs: 0, dispatchHealthReader: () => dispatch.healthy, activeSessionReader: () => [] } : {}),
    threadSeenStatePath: join(dir, 'seen.json'), threadDispositionStatePath: join(dir, 'dispositions.json') }; const service = makeServer(serverOptions)
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { service.close(() => resolve()); service.closeAllConnections() }))
  const base = `http://127.0.0.1:${(service.address() as any).port}`
  const call = async (path: string, method = 'GET', body?: any, headers: any = owner) => fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const create = async (label: string, privacy = 'standard') => {
    const r = await call('/wizard/v1/agents', 'POST', { label, harness: 'hermes', permissions: { preset: privacy }, model: { provider: 'tinfoil', model: 'glm-5-3' } })
    const value = await r.json(); expect([r.status, value.error]).toEqual([201, undefined]); return value.agent
  }
  return { dir, settingsPath, agentsDir, base, call, create, calls, histories, status, dispatch, manifestPath, serverOptions, service }
}

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { migrateJson, qualifyRawThreadRecords } from '../server/thread-reference.mjs'
import { restoreStoreSet, INVENTORY_NAME, atomicStoreWrite, validateBackup, backupJson, backupSqlite, withSqliteMigration, acquireServiceLeases } from '../server/store-migration.mjs'
const restart = async (s:any) => {
  await new Promise<void>(resolve => { s.service.close(()=>resolve()); s.service.closeAllConnections() })
  const server=createWizardServer(s.serverOptions)
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  cleanup.push(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()}))
  const base=`http://127.0.0.1:${(server.address() as any).port}`
  return async(path:string, method='GET', body?:any, headers:any={})=>fetch(base+path,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})
}

it('PAIR_POISON: anonymous disposition never becomes authority after restart', async () => {
  const s = await scene(), hidden = await s.create('Hidden', 'private'), id = 'wizard_never_pinned'
  s.histories.get(hidden.id)!.add(id)
  expect((await s.call('/wizard/hermes/api/sessions?agent=hermes', 'POST', { id, source: 'wizard-mobile' }, {})).status).toBe(404)
  expect((await s.call('/wizard/thread-dispositions', 'PUT', { runtime: 'direct', sessionId: id, deferred: true, agent_id: 'hermes' }, {})).status).toBe(200)
  const call = await restart(s)
  expect(createAgentRegistry({ agentsDir: s.agentsDir }).pinnedAgent(id)).toBe('')
  expect((await call('/wizard/hermes/api/sessions?agent=hermes', 'POST', { id, source: 'wizard-mobile' })).status).toBe(404)
})

it('DEFAULT_GUESS: hidden, missing and hermes guesses have identical status and body', async () => {
  const s = await scene(), hidden = await s.create('Hidden', 'private')
  await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: hidden.id } })
  const responses = []
  for (const id of [hidden.id, 'missing', 'hermes']) {
    const r = await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: id } }, {})
    responses.push([r.status, await r.json()])
  }
  expect(responses[0][0]).toBe(200)
  expect(responses[1]).toEqual(responses[0]); expect(responses[2]).toEqual(responses[0])
  expect(JSON.stringify(responses)).not.toContain(hidden.id)
  expect(JSON.parse(readFileSync(s.settingsPath, 'utf8')).agents.default_agent_id).toBe(hidden.id)
})

it('DEFAULT_STOPPED_SNAPSHOT: no setting + stopped catalogued secondary preserves archived client creation', async () => {
  const rows = []
  for (const baseline of process.env.WAS_ROLLBACK_BASE_DIR ? [process.env.WAS_ROLLBACK_BASE_DIR, ''] : ['']) {
    if (baseline) process.env.WAS_S2C_BASELINE = baseline; else delete process.env.WAS_S2C_BASELINE
    try {
      const s = await scene(), secondary = await s.create('Offline')
      await s.call('/wizard/hermes/api/sessions?agent=' + secondary.id) // authenticated listing before stop
      await s.call('/wizard/v1/agents/' + secondary.id + '/stop', 'POST', {})
      const agents = await (await s.call('/wizard/v1/agents')).json()
      const binding = await (await s.call('/wizard/v1/apps/notes/binding')).json()
      const chosen = await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_client_fresh', source: 'wizard-mobile' })
      const offset = s.calls.length, minted = await s.call('/wizard/hermes/api/sessions', 'POST', { source: 'wizard-mobile' })
      rows.push({ agents, binding, chosen: chosen.status, minted: minted.status, mintedAgents: s.calls.slice(offset).filter(r => r.method === 'POST').map(r => r.agent) })
    } finally { delete process.env.WAS_S2C_BASELINE }
  }
  for (const row of rows) { expect(row.chosen).toBe(201); expect(row.minted).toBe(201); expect(row.mintedAgents).toEqual(['hermes']) }
  if (rows.length === 2) expect(rows[1]).toEqual(rows[0])
})

it('catalogued stopped private id is refused exactly like the online anti-claim response', async () => {
  const s = await scene(), hidden = await s.create('Hidden', 'private'), id = 'wizard_hidden_catalog'
  s.histories.get(hidden.id)!.add(id)
  const before = await s.call('/wizard/hermes/api/sessions?agent=hermes', 'POST', { id }, {})
  const expected = [before.status, await before.json()]
  await s.call('/wizard/hermes/api/sessions?agent=' + hidden.id)
  s.status.set(hidden.id, 'stopped')
  const call = await restart(s), after = await call('/wizard/hermes/api/sessions?agent=hermes', 'POST', { id })
  expect([after.status, await after.json()]).toEqual(expected); expect(after.status).toBe(404)
  const catalog = JSON.parse(readFileSync(join(s.agentsDir, '.session-catalog.json'), 'utf8'))
  expect(catalog.agents[hidden.id]).toMatchObject({ complete: false, ids: [id] })
  expect(catalog.agents[hidden.id].at).toBeGreaterThan(0)
  expect(JSON.parse(readFileSync(join(s.agentsDir, INVENTORY_NAME), 'utf8')).stores['.session-catalog.json'].disposition).toBe('created')
  expect(JSON.stringify(await (await call('/wizard/v1/agents')).json())).not.toContain(id)
})

it('never-seen unavailable secondary alone retains the explicit 503 fail-closed coupling', async () => {
  const s = await scene()
  s.serverOptions.agentRuntime.apply = async (id: string) => { s.status.set(id, 'stopped'); throw new Error('fixture_never_started') }
  await s.create('Never up')
  const r = await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_fresh' })
  expect([r.status, await r.json()]).toEqual([503, { error: 'agent_unavailable', check: 'agent.history' }])
})

it('stop captures latest history and start invalidates/rereads the stopped catalog before claims', async () => {
  const s = await scene(), secondary = await s.create('Secondary')
  s.histories.get(secondary.id)!.add('wizard_before_stop')
  expect((await s.call('/wizard/v1/agents/' + secondary.id + '/stop', 'POST', {})).status).toBe(202)
  let value = JSON.parse(readFileSync(join(s.agentsDir, '.session-catalog.json'), 'utf8')).agents[secondary.id]
  expect(value).toMatchObject({ complete: true, ids: ['wizard_before_stop'] })
  s.histories.get(secondary.id)!.add('wizard_after_start')
  expect((await s.call('/wizard/v1/agents/' + secondary.id + '/start', 'POST', {})).status).toBe(202)
  value = JSON.parse(readFileSync(join(s.agentsDir, '.session-catalog.json'), 'utf8')).agents[secondary.id]
  expect(value.ids).toContain('wizard_after_start')
})

// Every JSON source formerly crawled by the recursive startup seeder. The extra root object
// is retained by migration, so each would poison the old index regardless of display normalization.
it.each(['threadTitleStatePath', 'threadStatusBackfillPath', 'subjectsPath', 'threadSeenStatePath',
  'threadDispositionStatePath', 'dismissedFailureStatePath', 'operatorWorkerStatePath',
  'voiceRecoveryManifestPath', 'model-locked-admissions', 'run-index'])('side store %s cannot grant a pair bypass', async key => {
  const s = await scene(), hidden = await s.create('Hidden', 'private'), id = 'wizard_side_poison'
  s.histories.get(hidden.id)!.add(id)
  await new Promise<void>(resolve => { s.service.close(() => resolve()); s.service.closeAllConnections() })
  const poison = { agent_id: 'hermes', session_id: id }
  if (key === 'run-index') {
    writeFileSync(join(s.agentsDir, '.run-threads.json'), JSON.stringify({ schema: 1, runs: { fake: [{ run_id: 'fake', ...poison }] } }))
  } else if (key === 'model-locked-admissions') {
    const queue = join(s.dir, 'queue.sqlite'); s.serverOptions.runQueueStatePath = queue
    s.serverOptions.runQueuePollIntervalMs = 0; s.serverOptions.dispatchHealthReader = () => false; s.serverOptions.activeSessionReader = () => []
    writeFileSync(join(s.dir, 'model-locked-admissions.json'), JSON.stringify([['fake', poison]]))
  } else {
    const path = join(s.dir, key + '.json'); s.serverOptions[key] = path
    const base: any = key === 'operatorWorkerStatePath' ? [poison] : { schema: 1, scopes: {}, threads: {}, dismissals: {}, version: 1, entries: [], poison }
    writeFileSync(path, JSON.stringify(base))
  }
  const call = await restart(s)
  expect(createAgentRegistry({ agentsDir: s.agentsDir }).pinnedAgents(id)).not.toContain('hermes')
  expect((await call('/wizard/hermes/api/sessions?agent=hermes', 'POST', { id })).status).toBe(404)
})


it.each([['heavyStatePath', 'heavy_jobs', 'session'], ['uploadStatePath', 'shares', 'session_id'], ['runQueueStatePath', 'wizard_run_queue', 'session_id']])('SQLite projection %s cannot seed a trusted pair', async (option, table, column) => {
  const s = await scene(), hidden = await s.create('Hidden', 'private'), id = 'wizard_sqlite_poison'
  s.histories.get(hidden.id)!.add(id)
  await new Promise<void>(resolve => { s.service.close(() => resolve()); s.service.closeAllConnections() })
  const path = join(s.dir, table + '.sqlite')
  s.serverOptions[option] = path
  if (option === 'runQueueStatePath') {
    // Construct the actual queue schema, then add a completed client-side projection row.
    const { DurableRunQueue } = await import('../server/run-queue.mjs')
    const queue = new DurableRunQueue({ statePath: path, launch: async () => ({}), lookup: async () => ({}) }); await queue.close()
    const db = new DatabaseSync(path)
    db.prepare(`INSERT INTO wizard_run_queue(public_run_id,runtime,session_id,idempotency_key,request_hash,body,status,created_at,updated_at,agent_id) VALUES('fake','direct',?,'fake','fake','{}','completed',1,1,'hermes')`).run(id)
    db.close()
    s.serverOptions.runQueuePollIntervalMs = 0; s.serverOptions.dispatchHealthReader = () => false; s.serverOptions.activeSessionReader = () => []
  } else {
    // These optional paths are not active consumers in this fixture, but the old seeder read them.
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE ${table}(agent_id TEXT, ${column} TEXT)`)
    db.prepare(`INSERT INTO ${table} VALUES('hermes',?)`).run(id); db.close()
  }
  const call = await restart(s)
  expect(createAgentRegistry({ agentsDir: s.agentsDir }).pinnedAgents(id)).not.toContain('hermes')
  expect((await call('/wizard/hermes/api/sessions?agent=hermes', 'POST', { id })).status).toBe(404)
})

it('pre-provenance qualified pins are not grandfathered from the removed side-store seeder', async () => {
  const s = await scene(), hidden = await s.create('Hidden', 'private'), id = 'wizard_old_poison'
  s.histories.get(hidden.id)!.add(id)
  await new Promise<void>(resolve => { s.service.close(() => resolve()); s.service.closeAllConnections() })
  writeFileSync(join(s.agentsDir, '.threads.json'), JSON.stringify({ schema: 2, threads: { [threadKey('hermes', id)]: { agent_id: 'hermes', session_id: id } } }))
  const call = await restart(s)
  expect(createAgentRegistry({ agentsDir: s.agentsDir }).pinnedAgent(id)).toBe('')
  expect((await call('/wizard/hermes/api/sessions?agent=hermes', 'POST', { id })).status).toBe(404)
})

it('SQLite backed_up retry never overwrites its validated baseline after a legacy writer changes data', () => {
  const d = mkdtempSync(join(tmpdir(), 'sqlite-baseline-')); cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  const path = join(d, 'state.sqlite'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE old(id TEXT); INSERT INTO old VALUES(\'before\')')
  backupSqlite(db, path)
  const backup = readFileSync(validateBackup(path))
  db.exec('INSERT INTO old VALUES(\'later\')')
  const source = readFileSync(path)
  expect(() => withSqliteMigration(db, path, true, () => db.exec('ALTER TABLE old ADD COLUMN agent_id TEXT'))).toThrow(/keep source, keep backup; operator chooses/)
  expect(readFileSync(path)).toEqual(source); expect(readFileSync(validateBackup(path))).toEqual(backup)
  db.close()
})

it('failed start refresh never trusts the previous stopped negative catalog', async () => {
  const s = await scene(), secondary = await s.create('Secondary')
  await s.call('/wizard/v1/agents/' + secondary.id + '/stop', 'POST', {})
  s.serverOptions.agentRuntime.start = async () => { throw new Error('fixture_start_failed') }
  await s.call('/wizard/v1/agents/' + secondary.id + '/start', 'POST', {})
  const catalog = JSON.parse(readFileSync(join(s.agentsDir, '.session-catalog.json'), 'utf8'))
  expect(catalog.agents[secondary.id].complete).toBe(false)
  expect((await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_fresh' })).status).toBe(503)
})


it('catalog census follows clamped short pages and validates every cursor', async () => {
  const s = await scene(), secondary = await s.create('Secondary'), offsets: number[] = []
  const registry = createAgentRegistry({ agentsDir: s.agentsDir, upstreamHost: 'fixture', fetchImpl: async (raw: string) => {
    const offset = Number(new URL(raw).searchParams.get('offset')); offsets.push(offset)
    return Response.json({ data: offset < 2 ? [{ id: 'wizard_page_' + offset }] : [], pagination: { offset } })
  } })
  await registry.refreshCatalog(secondary.id)
  expect(offsets).toEqual([0, 1, 2])
  expect(await registry.catalogContains(secondary.id, 'wizard_page_1')).toBe(true)
  expect(await registry.catalogContains(secondary.id, 'wizard_absent')).toBeUndefined()
})

it('old in-flight census cannot restore negative authority across a start transition', async () => {
  const s = await scene(), secondary = await s.create('Secondary')
  let finish: (value: Response) => void = () => {}; let reads = 0
  const registry = createAgentRegistry({ agentsDir: s.agentsDir, upstreamHost: 'fixture', runtime: s.serverOptions.agentRuntime,
    fetchImpl: async () => ++reads === 1 ? await new Promise<Response>(resolve => { finish = resolve }) : Response.json({ error: 'unavailable' }, { status: 503 }) })
  const old = registry.refreshCatalog(secondary.id)
  await registry.setRunning(secondary.id, true)
  finish(Response.json({ data: [], has_more: false }))
  await expect(old).rejects.toThrow(/lifecycle changed/)
  expect(await registry.catalogContains(secondary.id, 'wizard_absent')).toBeUndefined()
})

it('service lease stays exclusive to restore until the last same-process listener closes', async () => {
  const s = await scene(), second = createWizardServer(s.serverOptions)
  await new Promise<void>(resolve => second.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => second.close(() => resolve())))
  expect(() => restoreStoreSet([s.agentsDir], { serviceStopped: true })).toThrow(/exclusive writer ownership/)
  await new Promise<void>(resolve => { s.service.close(() => resolve()); s.service.closeAllConnections() })
  expect(() => restoreStoreSet([s.agentsDir], { serviceStopped: true })).toThrow(/exclusive writer ownership/)
  await new Promise<void>(resolve => second.close(() => resolve()))
  await Promise.all([(s.service as any).drained, (second as any).drained])
  expect(() => restoreStoreSet([s.agentsDir], { serviceStopped: true })).not.toThrow()
})

it('only authority provenance grants a pair bypass and it survives reopen', async () => {
  const s = await scene(), id = 'wizard_verified'
  const registry = createAgentRegistry({ agentsDir: s.agentsDir })
  registry.pin(id, 'hermes', 'client_metadata')
  expect(registry.pinnedAgent(id)).toBe('')
  registry.observeSessions('hermes', [id])
  const row = JSON.parse(readFileSync(join(s.agentsDir, '.threads.json'), 'utf8')).threads[threadKey('hermes', id)]
  expect(row.provenance).toBe('runtime_verified')
  expect(createAgentRegistry({ agentsDir: s.agentsDir }).pinnedAgent(id)).toBe('hermes')
})

it('LIVE_FIXTURE_RESTORE: CLI refuses a listening service with exit 2 and zero store mutation', async () => {
  const s = await scene()
  await s.call('/wizard/hermes/api/sessions', 'POST', { source: 'wizard-mobile' })
  const p = join(s.agentsDir, '.threads.json'), before = readFileSync(p)
  let status = 0
  try { execFileSync(process.execPath, [join(process.cwd(), 'scripts/restore-agent-pairs.mjs'), '--service-stopped', s.agentsDir], { stdio: 'pipe' }) } catch (e: any) { status = e.status }
  expect(status).toBe(2); expect(readFileSync(p)).toEqual(before)
  expect((await s.call('/wizard/v1/agents')).status).toBe(200)
  await new Promise<void>(resolve => { s.service.close(() => resolve()); s.service.closeAllConnections() })
  await (s.service as any).drained
  const out = execFileSync(process.execPath, [join(process.cwd(), 'scripts/restore-agent-pairs.mjs'), '--service-stopped', s.agentsDir], { encoding: 'utf8' })
  expect(JSON.parse(out).restored_stores).toBeGreaterThan(0)
  expect(existsSync(p)).toBe(false)
})

it('PARTIAL_RESTORE: invalid later disposition leaves the earlier store untouched', () => {
  const d = mkdtempSync(join(tmpdir(), 'restore-preflight-')); cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  const p = join(d, 'a.json'); writeFileSync(p, '{"threads":{"x":{}}}')
  migrateJson(p, (v: any) => ({ ...v, threads: qualifyRawThreadRecords(v.threads) }))
  const before = readFileSync(p), manifest = join(d, INVENTORY_NAME), value = JSON.parse(readFileSync(manifest, 'utf8'))
  value.stores['z.json'] = { store: 'z.json', kind: 'json', phase: 'complete', disposition: 'migrateX' }
  writeFileSync(manifest, JSON.stringify(value))
  expect(() => restoreStoreSet([d], { serviceStopped: true })).toThrow(/invalid inventory entry/)
  expect(readFileSync(p)).toEqual(before)
})

it.each([
  { store: '..' }, { store: '.' }, { store: '' }, { store: '../out' }, { store: 'a/b' }, { store: 'a\\b' },
  { kind: 'bogus' }, { phase: 'backed_up' }, { source_generation: '' }, { source_generation: 'changed' },
  { backup: 'extra' }, { disposition: 'bogus' }, { store: 'different.json' },
])('created inventory validation rejects %j before removing valid earlier data', invalid => {
  const d = mkdtempSync(join(tmpdir(), 'restore-created-')); cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  const p = join(d, 'a.json'); atomicStoreWrite(p, '{"intact":true}')
  const manifest = join(d, INVENTORY_NAME), value = JSON.parse(readFileSync(manifest, 'utf8'))
  value.stores['z.json'] = { store: 'z.json', kind: 'json', disposition: 'created', phase: 'complete', source_generation: 'absent', ...invalid }
  writeFileSync(manifest, JSON.stringify(value))
  expect(() => restoreStoreSet([d], { serviceStopped: true })).toThrow(/invalid/)
  expect(readFileSync(p, 'utf8')).toBe('{"intact":true}')
})

it('BACKED_UP_RETRY: changed legacy generation preserves both source and original backup', () => {
  const d = mkdtempSync(join(tmpdir(), 'backed-up-retry-')); cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  const p = join(d, 'state.json'), old = '{"threads":{"x":{}}}', later = '{"threads":{"x":{},"later":{}}}'
  writeFileSync(p, old); backupJson(p); writeFileSync(p, later)
  expect(() => migrateJson(p, (v: any) => ({ ...v, threads: qualifyRawThreadRecords(v.threads) }))).toThrow(/keep source, keep backup; operator chooses/)
  expect(readFileSync(p, 'utf8')).toBe(later); expect(readFileSync(validateBackup(p), 'utf8')).toBe(old)
})

it('SIGKILL releases store/inventory locks and resumes unchanged backed-up migration automatically', () => {
  const d = mkdtempSync(join(tmpdir(), 'kill-backup-')); cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  const p = join(d, 'state.json'), old = '{"threads":{"x":{}}}'
  writeFileSync(p, old)
  try { execFileSync(process.execPath, ['--input-type=module', '-e', `import {withStoreLock,backupJson} from ${JSON.stringify(join(process.cwd(), 'server/store-migration.mjs'))};withStoreLock(process.argv[1],()=>{backupJson(process.argv[1]);process.kill(process.pid,'SIGKILL')})`, p], { stdio: 'pipe' }) } catch { /* actual killed holder */ }
  expect(readFileSync(p, 'utf8')).toBe(old)
  migrateJson(p, (v: any) => ({ ...v, threads: qualifyRawThreadRecords(v.threads) }))
  expect(JSON.parse(readFileSync(p, 'utf8')).threads.x.agent_id).toBe('hermes')
  expect(readFileSync(validateBackup(p), 'utf8')).toBe(old)
})

it('live OS lease is never stolen and killed service/restore holders release it', () => {
  const d = mkdtempSync(join(tmpdir(), 'lease-proof-')); cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  const module = JSON.stringify(join(process.cwd(), 'server/store-migration.mjs'))
  const release = acquireServiceLeases([d])
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', `import {acquireServiceLeases} from ${module};acquireServiceLeases([process.argv[1]])`, d], { stdio: 'pipe' })).toThrow()
  expect(() => restoreStoreSet([d], { serviceStopped: true })).toThrow(/exclusive writer ownership/)
  release()
  try { execFileSync(process.execPath, ['--input-type=module', '-e', `import {acquireServiceLeases,acquireLease} from ${module};acquireServiceLeases([process.argv[1]]);acquireLease(process.argv[1]+'/.agent-pairs.restore-lock.sqlite');process.kill(process.pid,'SIGKILL')`, d], { stdio: 'pipe' }) } catch {}
  expect(restoreStoreSet([d], { serviceStopped: true })).toEqual([])
})
