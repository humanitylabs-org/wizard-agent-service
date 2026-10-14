import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'

// Integration boundaries: live locked routing + optional receipt DB + the candidate's app kernel.
// No real providers, credentials, host state, preview services or model inference are used.
const servers: Server[] = []
const dirs: string[] = []
const route = { model: 'fixture-model', provider: 'custom:fixture-private' }
const sessionId = 'wizard_merge_fixture'
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'wizard-live-merge-')); dirs.push(dir); return dir }
const originFor = async (server: Server) => {
  servers.push(server)
  const address = await listen(server)
  return `http://127.0.0.1:${address.port}`
}
function stateFixture(dir: string) {
  const path = join(dir, 'hermes.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, model TEXT, model_config TEXT, started_at REAL);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL,
      active INTEGER DEFAULT 1, tool_calls TEXT, display_kind TEXT, finish_reason TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
    CREATE TABLE async_delegations(delegation_id TEXT, origin_session_id TEXT, state TEXT,
      delivery_state TEXT, result_json TEXT, completed_at REAL);`)
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sessionId, route.model,
    JSON.stringify({ browser_model_lock: { ...route, confirmed: true, updated_at: 1234 } }), Date.now() / 1000 - 60)
  db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)')
    .run(sessionId, 'user', 'Finish the approved task', Date.now() / 1000 - 30)
  db.close()
  return path
}
async function upstreamFixture(reject = false, runStatus = 'completed') {
  const admissions: Array<{ path: string, body: any }> = []
  let statusReads = 0
  const completion = { pending: false, at: Date.now() / 1000 }
  const origin = await originFor(createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://fixture').pathname
    if (req.method === 'GET' && path === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ sessions: completion.pending ? [{ id: sessionId, last_active: completion.at }] : [] }))
    }
    if (req.method === 'GET' && path === `/api/sessions/${sessionId}/messages`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: completion.pending ? [{ id: 7, role: 'user', timestamp: completion.at,
        content: '[ASYNC DELEGATION BATCH COMPLETE fixture]', display_kind: 'async_delegation_complete' }] : [] }))
    }
    if (path === '/v1/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ features: { delegation_delivery: { supported: true, modes: ['background', 'join'] }, markdown_rendering: true, run_instructions: true } }))
    }
    if (req.method === 'GET' && path.startsWith('/v1/runs/')) {
      statusReads++
      res.writeHead(runStatus === 'unavailable' ? 503 : 200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: runStatus, runtime: { ...route, model_lock: 'confirmed' } }))
    }
    if (req.method === 'POST' && (path === '/v1/runs' || path.endsWith('/chat/stream'))) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      admissions.push({ path, body })
      if (reject) { res.writeHead(503); return res.end('fixture rejected') }
      const runtime = { model: body.model, provider: body.provider, model_lock: 'accepted' }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      return res.end(`event: run.started\ndata: ${JSON.stringify({ run_id: `fixture_${admissions.length}`, runtime })}\n\nevent: run.completed\ndata: ${JSON.stringify({ runtime: { ...runtime, model_lock: 'confirmed' } })}\n\n`)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.method === 'POST' && path.endsWith('/model')) return res.end(JSON.stringify({ runtime: route }))
    return res.end(JSON.stringify({ object: 'list', data: [], status: 'completed', runtime: { ...route, model_lock: 'confirmed' } }))
  }))
  return { origin, admissions, completion, get statusReads() { return statusReads } }
}
async function send(base: string, extra: object = {}) {
  return fetch(`${base}/wizard/hermes/v1/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-first-send' },
    body: JSON.stringify({ session_id: sessionId, input: 'Finish it', ...extra }),
  })
}

it('inherits live selector locks, keeps OS/view instructions, and recovers a dropped helper through the locked lane', async () => {
  const dir = temp(), state = stateFixture(dir), upstream = await upstreamFixture()
  const appsJsonPath = join(dir, 'apps.json')
  writeFileSync(appsJsonPath, JSON.stringify({ apps: [{ id: 'fixture-notes', name: 'Fixture Notes', status: 'running',
    provides: ['notes'], mcp: { url: `${upstream.origin}/mcp`, transport: 'streamable-http' } }] }))
  const base = await originFor(createWizardServer({
    requireAccess: false, hermesKey: 'fixture-only', upstreamOrigin: upstream.origin,
    hermesStatePath: state, joinedDelegation: 'require', appsJsonPath, mcpToken: 'fixture-mcp',
    bridgeWriteSkills: false, bridgeWatchMs: 0,
  }))
  const response = await send(base, { instructions: '[Wizard OS context] Current view: Fixture Notes' })
  expect(response.status).toBe(202)
  expect((await response.json()).runtime).toMatchObject({ ...route, model_lock: 'accepted' })
  expect(upstream.admissions[0].body.instructions).toContain('Fixture Notes')
  expect(upstream.admissions[0].body.instructions).toContain('[Wizard OS context]')
  expect(upstream.admissions[0].body.instructions).toContain('wizard')
  const db = new DatabaseSync(state)
  db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?)').run('deleg_merge', sessionId, 'completed', 'dropped',
    JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'MUST-FIX: keep the installed app contract' }] }), Date.now() / 1000)
  db.close()
  // Exercise real createWizardServer watcher wiring, not only the extracted finder.
  await expect.poll(() => upstream.admissions.length, { timeout: 7000, interval: 50 }).toBe(2)
  expect(upstream.admissions.map(a => a.path)).toEqual(Array(2).fill(`/api/sessions/${sessionId}/chat/stream`))
  expect(upstream.admissions[1].body).toMatchObject({ ...route, require_model_lock: true })
  expect(upstream.admissions[1].body.message).toContain('Recovered helper receipt deleg_merge')
  expect(upstream.admissions[1].body.message).toContain('MUST-FIX')
  expect(upstream.admissions[1].body.instructions).toContain('Fixture Notes')
  expect(upstream.admissions[1].body.instructions).toContain('wizard')
  const ack = await fetch(`${base}/wizard/hermes/api/sessions/${sessionId}/model`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(route),
  })
  expect(ack.status).toBe(200)
  expect((await ack.json()).runtime.selection_version).toBe(1234)
}, 12000)

it('a no-state locked send keeps the same provider on its detached HTTP follow-through', async () => {
  const upstream = await upstreamFixture()
  const base = await originFor(createWizardServer({
    requireAccess: false, hermesKey: 'fixture-only', upstreamOrigin: upstream.origin,
    hermesStatePath: '', joinedDelegation: 'require',
  }))
  const response = await send(base, { ...route, require_model_lock: true })
  expect(response.status).toBe(202)
  await response.json()
  upstream.completion.pending = true
  await expect.poll(() => upstream.admissions.length, { timeout: 7000, interval: 50 }).toBe(2)
  for (const admission of upstream.admissions) {
    expect(admission.path).toBe(`/api/sessions/${sessionId}/chat/stream`)
    expect(admission.body).toMatchObject({ ...route, require_model_lock: true })
  }
}, 12000)

it('an unavailable selected provider never falls back to an unlocked admission', async () => {
  const upstream = await upstreamFixture(true)
  const base = await originFor(createWizardServer({ requireAccess: false, hermesKey: 'fixture-only',
    upstreamOrigin: upstream.origin, hermesStatePath: '', joinedDelegation: 'require', followThrough: false }))
  const response = await send(base, { ...route, require_model_lock: true })
  expect(response.status).toBe(503)
  await response.json()
  expect(upstream.admissions).toHaveLength(1)
  expect(upstream.admissions[0].path).toBe(`/api/sessions/${sessionId}/chat/stream`)
})

it.each(['running', 'unknown', 'unavailable'])('does not clear a native active-run guard on %s liveness', async status => {
  const upstream = await upstreamFixture(false, status)
  const base = await originFor(createWizardServer({ requireAccess: false, hermesKey: 'fixture-only',
    upstreamOrigin: upstream.origin, hermesStatePath: '', joinedDelegation: 'require' }))
  const response = await send(base, { ...route, require_model_lock: true })
  expect(response.status).toBe(202)
  await response.json()
  upstream.completion.pending = true
  await new Promise(resolve => setTimeout(resolve, 6200)) // watcher has observed the completion
  expect(upstream.statusReads).toBeGreaterThan(0)
  expect(upstream.admissions).toHaveLength(1)
}, 10000)
