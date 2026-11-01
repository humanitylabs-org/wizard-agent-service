// 20 Oct 2026, Nolan's box: Opus failed because the Claude sign-in had expired, and the chat only showed
// Hermes' generic "Your request was not processed." The real reason was in the run's error. Wizard now names
// the connection app that fixes it (Open Claude / Open ChatGPT) instead of a Retry that can't work.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { annotateProviderSignOut, classifyProviderSignOut, decorateReconnect } from '../server/provider-reconnect.mjs'
import { listRow } from '../server/session-list-view.mjs'

const CLAUDE_ROUTE = 'claude-subscription-directsdk-experimental'
// The exact strings from Nolan's gateway log (ClaudeCodeLoggedOut, non-retryable).
const CLAUDE_LOGGED_OUT = 'HTTP 401: Claude Code is installed but has no usable login in the environment Hermes runs it in. Run `claude auth login` in that environment, then retry. (native: Failed to authenticate: OAuth session expired and could not be refreshed)'
const claudeRun = (over: any = {}) => ({ object: 'hermes.run', run_id: 'run_x', status: 'failed', last_event: 'run.failed',
  completed: false, partial: false, interrupted: false, error: CLAUDE_LOGGED_OUT, ...over })
// Hermes' own auth copy as it rides in `output` (agent/turn_failure_copy.py _AUTH_COPY['oauth']).
const hermesAuthCopy = (label: string, summary: string) => `${label} rejected your sign-in, so the model can't be reached. Sign in again: \`hermes auth add x --type oauth\`.\n\nProvider said: ${summary}`

describe('classifyProviderSignOut', () => {
  it('names Claude for the DirectSDK logged-out error in `error`', () => {
    expect(classifyProviderSignOut(claudeRun())).toMatchObject({ provider: 'claude', appId: 'wizard-claude' })
  })
  it('names Claude when only the OAuth expiry reached `output`', () => {
    expect(classifyProviderSignOut(claudeRun({ error: undefined, output: hermesAuthCopy('Claude subscription', 'HTTP 401: Failed to authenticate: OAuth session expired and could not be refreshed') }))?.appId).toBe('wizard-claude')
  })
  it.each(['codex_auth_expired', 'codex_auth_refresh_failed', 'codex_auth_missing_refresh_token'])('names ChatGPT for %s', (code) => {
    expect(classifyProviderSignOut({ status: 'failed', error: `Codex token refresh failed (${code})` })?.appId).toBe('wizard-chatgpt')
  })
  it('names ChatGPT for invalid_grant on the openai-codex route', () => {
    const run = { status: 'failed', output: hermesAuthCopy('OpenAI Codex', 'HTTP 401: {"error":"invalid_grant"}'), runtime: { provider: 'openai-codex', model: 'gpt-6-astra' } }
    expect(classifyProviderSignOut(run)?.appId).toBe('wizard-chatgpt')
  })
  it('uses the queued request route when Hermes omits runtime', () => {
    expect(classifyProviderSignOut({ status: 'failed', error: 'HTTP 401: invalid_grant' }, { provider: CLAUDE_ROUTE })?.appId).toBe('wizard-claude')
  })
  it('leaves everything else alone', () => {
    const tinfoil = { status: 'failed', output: 'custom rejected this request as malformed, so the model didn\'t answer.\n\nProvider said: HTTP 400: {"error": "Invalid request"}', runtime: { provider: 'custom' } }
    for (const run of [
      tinfoil,
      claudeRun({ status: 'completed' }),
      { status: 'failed', error: 'HTTP 401: invalid_grant', runtime: { provider: 'custom' } }, // unknown route: generic 401 is not ours
      { status: 'failed', output: hermesAuthCopy('Anthropic', 'HTTP 401 rate-limit exceeded'), runtime: { provider: 'anthropic' } },
      { status: 'failed', output: 'Anthropic rejected your API key, so the model can\'t be reached. HTTP 401', runtime: { provider: 'anthropic' } },
      { status: 'failed', error: 'agent run failed' },
      null,
    ]) expect(classifyProviderSignOut(run as any)).toBeNull()
  })
  it('annotates a plain message and a structured field', () => {
    expect(annotateProviderSignOut(claudeRun())).toMatchObject({
      safe_error: 'Claude sign-in expired',
      wizard_reconnect: { kind: 'provider_signed_out', provider: 'claude', app_id: 'wizard-claude' },
    })
    const other = { status: 'failed', error: 'boom' }
    expect(annotateProviderSignOut(other)).toBe(other)
  })
})

describe('run queue projection', () => {
  const dirs: string[] = [], queues: DurableRunQueue[] = []
  afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
  const request = (provider = CLAUDE_ROUTE) => {
    const body = JSON.stringify({ session_id: 'wizard_nolan', input: 'Plan my week', model: 'claude-opus-5-5', provider, require_model_lock: true })
    return { runtime: 'direct', sessionId: 'wizard_nolan', idempotencyKey: 'send-1', requestHash: queueRequestHash('direct', body), body }
  }
  async function make(payload: any) {
    const dir = await mkdtemp(join(tmpdir(), 'wizard-reconnect-')); dirs.push(dir)
    const q = new DurableRunQueue({ statePath: join(dir, 'q.sqlite3'), pollIntervalMs: 0, canDispatch: () => true, activeSessionIds: async () => [],
      launch: async () => ({ upstreamRunId: 'run_x', payload: { status: 'running' } }), lookup: async () => ({ capacityStatus: payload.status, payload }) })
    queues.push(q); return q
  }
  it('a run that failed on an expired Claude sign-in projects reconnect (both readers)', async () => {
    const q = await make(claudeRun())
    await q.admit(request()); await q.tick(true)
    for (const row of [q.latestProjections(['wizard_nolan'])[0], q.latestProjections()[0]]) {
      expect(row).toMatchObject({ status: 'failed', safeError: '',
        reconnect: { kind: 'provider_signed_out', provider: 'claude', app_id: 'wizard-claude' } })
    }
  })
  it('an ordinary failure projects no reconnect and keeps its own safe error', async () => {
    const q = await make({ status: 'failed', error: 'Model overloaded', safe_error: 'Try again later.' })
    await q.admit(request()); await q.tick(true)
    const row = q.latestProjections(['wizard_nolan'])[0]
    expect(row.reconnect).toBeUndefined()
    expect(row.safeError).toBe('Try again later.')
  })
})

describe('decorateReconnect + list view', () => {
  const field = { kind: 'provider_signed_out', provider: 'claude', app_id: 'wizard-claude' }
  const installed = [{ id: 'wizard-claude', status: 'running' }]
  const usage = (code: string | null) => ({ providers: [{ id: 'claude', status: code ? 'unavailable' : 'ok', error: code ? { code } : null }] })
  it('installed app: Open message, app status from /api/connection', () => {
    const [row] = decorateReconnect([{ id: 's', status: 'failed', wizard_reconnect: { ...field } }], { installedApps: installed, usage: usage('expired') })
    expect(row.wizard_reconnect).toMatchObject({ installed: true, app_status: 'expired', app_name: 'Claude' })
    expect(row.wizard_safe_error).toBe('Claude sign-in expired')
  })
  it('missing app: Get message, still shown', () => {
    const [row] = decorateReconnect([{ id: 's', status: 'failed', wizard_reconnect: { ...field } }], { installedApps: [], usage: null })
    expect(row.wizard_reconnect).toMatchObject({ installed: false, app_status: 'unknown' })
    expect(row.wizard_safe_error).toContain('Claude sign-in expired')
  })
  it('the run stays authoritative when the app reads a different sign-in as connected', () => {
    const [row] = decorateReconnect([{ id: 's', status: 'failed', wizard_reconnect: { ...field } }], { installedApps: installed, usage: usage(null) })
    expect(row.wizard_reconnect).toMatchObject({ app_status: 'connected', app_id: 'wizard-claude' })
  })
  it('drops forged shapes', () => {
    const [row] = decorateReconnect([{ id: 's', wizard_reconnect: { kind: 'provider_signed_out', provider: 'claude', app_id: 'evil' } }], {})
    expect(row.wizard_reconnect).toBeUndefined()
  })
  it('compact list rows carry reconnect', () => {
    const [item] = decorateReconnect([{ id: 's', status: 'failed', title: 'T', wizard_reconnect: { ...field } }], { installedApps: installed })
    expect(listRow(item)).toMatchObject({ reconnect: { provider: 'claude', appId: 'wizard-claude', name: 'Claude', installed: true } })
    expect(listRow({ id: 'n', status: 'failed', title: 'T' })).not.toHaveProperty('reconnect')
  })
})

// End to end through the real service: Hermes fails the run exactly as on Nolan's box (and closes the
// transcript with its generic failed_turn row); Chats gets the plain message and the app to open.
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'

describe('Chats list over HTTP', () => {
  const servers: ReturnType<typeof createServer>[] = [], dirs: string[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections?.(); s.close(() => done()) })))
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })
  async function boot(apps: object[], failure: object) {
    const sessions = [{ id: 'wizard_nolan', source: 'api_server', title: 'Plan my week', status: 'failed', message_count: 2, hidden: false, archived: false, updated_at: new Date().toISOString() }]
    let status = 'running'
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (req.method === 'POST' && url.pathname === '/v1/runs') { for await (const _ of req) { /* drain */ } json(202, { run_id: 'run_n', session_id: 'wizard_nolan', status: 'running' }); return }
      if (req.method === 'GET' && url.pathname === '/v1/runs/run_n') { json(200, status === 'running' ? { run_id: 'run_n', status } : { run_id: 'run_n', session_id: 'wizard_nolan', ...failure }); return }
      if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) { json(200, { object: 'list', data: [] }); return }
      if (req.method === 'GET' && url.pathname === '/api/sessions') { json(200, { object: 'list', data: sessions }); return }
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') { json(200, {}); return }
      res.writeHead(404); res.end()
    })
    servers.push(upstream)
    const port = (await listen(upstream)).port
    const dir = await mkdtemp(join(tmpdir(), 'wizard-reconnect-http-')); dirs.push(dir)
    const statePath = join(dir, 'state.db')
    const db = new DatabaseSync(statePath)
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
      INSERT INTO sessions VALUES ('wizard_nolan', 1);`)
    db.close()
    await writeFile(join(dir, 'apps.json'), JSON.stringify({ apps }))
    const wizard = createWizardServer({
      requireJoinedDelegationCapability: false, upstreamOrigin: `http://127.0.0.1:${port}`, hermesKey: 'fixture-key', requireAccess: false,
      hermesStatePath: statePath, canonicalSessionReader: () => sessions, runQueueStatePath: join(dir, 'queue.sqlite3'),
      runQueueMaxActive: 4, runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
      appsJsonPath: join(dir, 'apps.json'),
      aiUsageReader: { read: async () => ({ providers: [{ id: 'claude', status: 'unavailable', error: { code: 'expired' } }] }) },
    })
    servers.push(wizard)
    const origin = `http://127.0.0.1:${(await listen(wizard)).port}`
    const call = async (path: string, init: RequestInit = {}) => { const r = await fetch(origin + path, init); const t = await r.text(); return t ? JSON.parse(t) : null }
    const admitted = await call('/wizard/hermes/v1/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'nolan-1' },
      body: JSON.stringify({ session_id: 'wizard_nolan', input: 'Plan my week', model: 'claude-opus-5-5', provider: CLAUDE_ROUTE }) })
    // Hermes stamps the failed_turn boundary row; it is not a reply.
    const w = new DatabaseSync(statePath)
    w.prepare("INSERT INTO messages VALUES ('wizard_nolan','user',NULL,'Plan my week','',?,1)").run(Date.now() / 1000)
    w.prepare("INSERT INTO messages VALUES ('wizard_nolan','assistant',NULL,'Your request was not processed. Send it again if you still want me to carry it out.','failed_turn',?,1)").run(Date.now() / 1000 + 1)
    w.close()
    status = 'failed'
    const row = async (view = '') => {
      for (let i = 0; i < 30; i++) {
        await call(`/wizard/hermes/v1/runs/${encodeURIComponent(admitted.run_id)}`)
        const found = (await call(`/wizard/hermes/api/sessions?limit=20&offset=0&include_children=false${view}`)).data.find((r: any) => r.id === 'wizard_nolan')
        if (found?.status === 'failed') return found
        await new Promise((done) => setTimeout(done, 25))
      }
      return null
    }
    return { row }
  }
  const claudeApp = { id: 'wizard-claude', name: 'Claude', status: 'running', provides: ['ai-connection', 'claude-subscription'], view: { url: '/wizard-claude/', local: 'http://127.0.0.1:8799/' } }

  it('Claude installed: Open Claude message + reconnect field (full and list views)', async () => {
    const h = await boot([claudeApp], claudeRun())
    expect(await h.row()).toMatchObject({ status: 'failed',
      wizard_safe_error: 'Claude sign-in expired',
      wizard_reconnect: { kind: 'provider_signed_out', provider: 'claude', app_id: 'wizard-claude', installed: true, app_status: 'expired' } })
    expect(await h.row('&view=list')).toMatchObject({ safeError: 'Claude sign-in expired',
      reconnect: { appId: 'wizard-claude', installed: true, appStatus: 'expired' } })
  })
  it('Claude not installed: Get message, installed false', async () => {
    const h = await boot([], claudeRun())
    expect(await h.row()).toMatchObject({ wizard_safe_error: 'Claude sign-in expired',
      wizard_reconnect: { app_id: 'wizard-claude', installed: false } })
  })
  it('an unrelated failure gets no reconnect (negative control)', async () => {
    const h = await boot([claudeApp], { status: 'failed', error: 'Model overloaded' })
    const r = await h.row()
    expect(r.status).toBe('failed')
    expect(r.wizard_reconnect).toBeUndefined()
  })
})
