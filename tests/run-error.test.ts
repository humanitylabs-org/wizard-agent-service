// wizard-ux issue 166: an expired ChatGPT plan, a usage limit and a dropped connection all ended as the same
// "Error: <your message>" row and Hermes' generic "Your request was not processed". The run's own error says
// which one it was; the Agent Service now names it on the thread row as wizard_last_run_error.
// All provider texts below are synthetic.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyRunError, runErrorOf } from '../server/run-error.mjs'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { listRow } from '../server/session-list-view.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const codex = { provider: 'openai-codex', model: 'gpt-6-sol' }
const failed = (over: any) => ({ object: 'hermes.run', run_id: 'run_x', status: 'failed', runtime: codex, ...over })
// Hermes' exhausted/non-retryable copy as it rides in `output` (agent/turn_failure_copy.py).
const said = (lead: string, summary: string) => `${lead}\n\nProvider said: ${summary}`

const PLAN_ENDED = 'HTTP 402: Your ChatGPT subscription has ended. Renew your plan to keep using Codex.'
const USAGE_LIMIT = "HTTP 429: You've hit your usage limit. Try again in 3 hours."
const NETWORK = 'APIConnectionError: Connection error. (ECONNRESET)'

describe('classifyRunError', () => {
  it('an ended ChatGPT plan is provider_billing, with the route and the provider words', () => {
    expect(classifyRunError(failed({ error: PLAN_ENDED }))).toEqual({ code: 'provider_billing', provider: 'openai-codex', message: PLAN_ENDED })
  })
  it('billing wording without a status (insufficient_quota, deactivated account)', () => {
    expect(classifyRunError(failed({ error: 'Error code: 429 - {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}' }))?.code).toBe('provider_billing')
    expect(classifyRunError(failed({ error: 'Your account is deactivated.' }))?.code).toBe('provider_billing')
  })
  it('a usage limit is provider_quota, read from Hermes copy in output too', () => {
    expect(classifyRunError(failed({ error: USAGE_LIMIT }))?.code).toBe('provider_quota')
    const run = failed({ error: undefined, output: said('ChatGPT hit its limit after 3 attempts — its usage limit resets in 3h.', 'usage_limit_reached') })
    expect(classifyRunError(run)).toMatchObject({ code: 'provider_quota', message: 'usage_limit_reached' })
  })
  it('a refused sign-in or key is provider_auth', () => {
    expect(classifyRunError(failed({ error: 'Codex token refresh failed (codex_auth_expired)' }))).toMatchObject({ code: 'provider_auth', provider: 'openai-codex' })
    expect(classifyRunError({ status: 'failed', error: 'HTTP 401: invalid_api_key' }, { provider: 'anthropic' })).toMatchObject({ code: 'provider_auth', provider: 'anthropic' })
  })
  it('a dropped connection is network', () => {
    expect(classifyRunError(failed({ error: NETWORK }))?.code).toBe('network')
    expect(classifyRunError(failed({ error: 'getaddrinfo EAI_AGAIN chatgpt.com' }))?.code).toBe('network')
  })
  it('another provider HTTP error is unknown', () => {
    expect(classifyRunError(failed({ error: 'HTTP 500: Internal server error' }))?.code).toBe('unknown')
  })
  it('no field without provider evidence, for Wizard own failures, or for runs that did not fail', () => {
    for (const run of [
      failed({ error: 'agent run failed' }),
      failed({ error: undefined, output: 'Here is a partial answer about rate limits and quota planning' }),
      failed({ error: { type: 'provider_recovery_failed', message: 'HTTP 401' } }),
      failed({ status: 'completed', error: PLAN_ENDED }),
      { status: 'failed' },
      null,
    ]) expect(classifyRunError(run as any)).toBeNull()
  })
  it('keeps the message short and never carries a token', () => {
    const run = failed({ error: `HTTP 401: Incorrect API key provided: sk-proj-abcdefghijklmnop ${'x'.repeat(400)}` })
    const value = classifyRunError(run)!
    expect(value.message.length).toBeLessThanOrEqual(200)
    expect(value.message).not.toMatch(/abcdefghijklmnop/)
    // Keys without a known prefix, as other providers echo them. Built at runtime so the secret scan never
    // reads a fake key as a real one.
    const fake = (prefix: string, n: number) => prefix + Array.from({ length: n }, (_, i) => 'a1B2c3D4e5'[i % 10]).join('')
    for (const key of [fake('AI' + 'za', 35), fake('gh' + 'p_', 36), [fake('ey' + 'J', 20), fake('ey' + 'J', 20), fake('', 16)].join('.')]) {
      const msg = classifyRunError(failed({ error: `HTTP 401: Incorrect API key ${key} was refused` }))!.message
      expect(msg).not.toContain(key.slice(0, 12))
      expect(msg).toMatch(/^HTTP 401: Incorrect API key/)
    }
    expect(classifyRunError(failed({ error: 'HTTP 401: Incorrect API key provided: abc_def_ghi_jkl_mno.' }))!.message).toBe('HTTP 401: Incorrect API key provided: [redacted]')
  })
  it('runErrorOf drops unknown codes and clips fields', () => {
    expect(runErrorOf({ code: 'evil', provider: 'x' })).toBeNull()
    expect(runErrorOf({ code: 'network', provider: 'p'.repeat(90), message: 3 })).toEqual({ code: 'network', provider: 'p'.repeat(60), message: '' })
  })
})

describe('run queue projection and compact rows', () => {
  const dirs: string[] = [], queues: DurableRunQueue[] = []
  afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
  async function failedQueue(payload: any) {
    const dir = await mkdtemp(join(tmpdir(), 'wizard-run-error-')); dirs.push(dir)
    const q = new DurableRunQueue({ statePath: join(dir, 'q.sqlite3'), pollIntervalMs: 0, canDispatch: () => true, activeSessionIds: async () => [],
      launch: async () => ({ upstreamRunId: 'run_x', payload: { status: 'running' } }), lookup: async () => ({ capacityStatus: payload.status, payload }) })
    queues.push(q)
    const body = JSON.stringify({ session_id: 'wizard_s', input: 'How is your day', model: 'gpt-6-sol', provider: 'openai-codex' })
    await q.admit({ runtime: 'direct', sessionId: 'wizard_s', idempotencyKey: 'send-1', requestHash: queueRequestHash('direct', body), body })
    await q.tick(true)
    return q
  }
  it('an ended plan projects runError on both readers', async () => {
    const q = await failedQueue({ status: 'failed', error: PLAN_ENDED })
    for (const row of [q.latestProjections(['wizard_s'])[0], q.latestProjections()[0]])
      expect(row).toMatchObject({ status: 'failed', runError: { code: 'provider_billing', provider: 'openai-codex' } })
  })
  it('the request route names the provider when Hermes omits runtime', async () => {
    const q = await failedQueue({ status: 'failed', error: NETWORK })
    expect(q.latestProjections(['wizard_s'])[0].runError).toMatchObject({ code: 'network', provider: 'openai-codex' })
  })
  it('Hermes copy only in final_response still names the reason (same as routed runs)', async () => {
    const q = await failedQueue({ status: 'failed', output: '', final_response: said('ChatGPT hit its limit.', "HTTP 429: You've hit your usage limit.") })
    expect(q.latestProjections(['wizard_s'])[0].runError).toMatchObject({ code: 'provider_quota', message: "HTTP 429: You've hit your usage limit." })
  })
  it('an ordinary failure projects no runError', async () => {
    const q = await failedQueue({ status: 'failed', error: 'agent run failed', safe_error: 'Try again later.' })
    expect(q.latestProjections(['wizard_s'])[0].runError).toBeUndefined()
  })
  it('compact list rows carry runError, validated; absent when there is none', () => {
    const value = { code: 'provider_quota', provider: 'openai-codex', message: 'usage_limit_reached' }
    expect(listRow({ id: 's', status: 'failed', title: 'T', wizard_last_run_error: value })).toMatchObject({ runError: value })
    expect(listRow({ id: 's', status: 'failed', title: 'T', wizard_last_run_error: { code: 'evil' } })).not.toHaveProperty('runError')
    expect(listRow({ id: 's', status: 'failed', title: 'T' })).not.toHaveProperty('runError')
  })
})

// End to end through the real service, as in the bug: ChatGPT fails the run with a plan-ended error and Hermes
// closes the transcript with its generic failed_turn row.
describe('Chats list over HTTP', () => {
  const servers: ReturnType<typeof createServer>[] = [], dirs: string[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections?.(); s.close(() => done()) })))
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })
  async function boot(failure: object) {
    const sessions = [{ id: 'wizard_jan', source: 'api_server', title: 'How is your day', status: 'failed', message_count: 2, hidden: false, archived: false, updated_at: new Date().toISOString() }]
    let status = 'running'
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (req.method === 'POST' && url.pathname === '/v1/runs') { for await (const _ of req) { /* drain */ } json(202, { run_id: 'run_j', session_id: 'wizard_jan', status: 'running' }); return }
      if (req.method === 'GET' && url.pathname === '/v1/runs/run_j') { json(200, status === 'running' ? { run_id: 'run_j', status } : { run_id: 'run_j', session_id: 'wizard_jan', ...failure }); return }
      if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) { json(200, { object: 'list', data: [] }); return }
      if (req.method === 'GET' && url.pathname === '/api/sessions') { json(200, { object: 'list', data: sessions }); return }
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') { json(200, {}); return }
      res.writeHead(404); res.end()
    })
    servers.push(upstream)
    const port = (await listen(upstream)).port
    const dir = await mkdtemp(join(tmpdir(), 'wizard-run-error-http-')); dirs.push(dir)
    const statePath = join(dir, 'state.db')
    const db = new DatabaseSync(statePath)
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
      INSERT INTO sessions VALUES ('wizard_jan', 1);`)
    db.close()
    await writeFile(join(dir, 'apps.json'), JSON.stringify({ apps: [] }))
    const wizard = createWizardServer({
      requireJoinedDelegationCapability: false, upstreamOrigin: `http://127.0.0.1:${port}`, hermesKey: 'fixture-key', requireAccess: false,
      hermesStatePath: statePath, canonicalSessionReader: () => sessions, runQueueStatePath: join(dir, 'queue.sqlite3'),
      runQueueMaxActive: 4, runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
      appsJsonPath: join(dir, 'apps.json'), aiUsageReader: { read: async () => ({ providers: [] }) },
    })
    servers.push(wizard)
    const origin = `http://127.0.0.1:${(await listen(wizard)).port}`
    const call = async (path: string, init: RequestInit = {}) => { const r = await fetch(origin + path, init); const t = await r.text(); return t ? JSON.parse(t) : null }
    const admitted = await call('/wizard/hermes/v1/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'jan-1' },
      body: JSON.stringify({ session_id: 'wizard_jan', input: 'How is your day', model: 'gpt-6-sol', provider: 'openai-codex' }) })
    const w = new DatabaseSync(statePath)
    w.prepare("INSERT INTO messages VALUES ('wizard_jan','user',NULL,'How is your day','',?,1)").run(Date.now() / 1000)
    w.prepare("INSERT INTO messages VALUES ('wizard_jan','assistant',NULL,'Your request was not processed. Send it again if you still want me to carry it out.','failed_turn',?,1)").run(Date.now() / 1000 + 1)
    w.close()
    status = 'failed'
    return async (view = '') => {
      for (let i = 0; i < 30; i++) {
        await call(`/wizard/hermes/v1/runs/${encodeURIComponent(admitted.run_id)}`)
        const found = (await call(`/wizard/hermes/api/sessions?limit=20&offset=0&include_children=false${view}`)).data.find((r: any) => r.id === 'wizard_jan')
        if (found?.status === 'failed') return found
        await new Promise((done) => setTimeout(done, 25))
      }
      return null
    }
  }

  it('an ended ChatGPT plan: wizard_last_run_error on the full row, runError on the list row', async () => {
    const row = await boot({ status: 'failed', error: PLAN_ENDED, runtime: codex })
    expect(await row()).toMatchObject({ status: 'failed', wizard_last_run_error: { code: 'provider_billing', provider: 'openai-codex', message: PLAN_ENDED } })
    expect(await row('&view=list')).toMatchObject({ runError: { code: 'provider_billing', provider: 'openai-codex' } })
  })
  it('a network failure says network', async () => {
    const row = await boot({ status: 'failed', error: NETWORK })
    expect((await row()).wizard_last_run_error).toMatchObject({ code: 'network', provider: 'openai-codex' })
  })
  it('an ordinary failure gets no field (negative control)', async () => {
    const row = await boot({ status: 'failed', error: 'agent run failed' })
    const r = await row()
    expect(r.status).toBe('failed')
    expect(r.wizard_last_run_error).toBeUndefined()
  })
})
