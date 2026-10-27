import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { createWizardServer, listen } from '../server/service.mjs'
import { createRoutedQueues } from '../server/routed-run-queue.mjs'
import { normalizeProviderPreflightFailure, providerSignInNotice, projectProviderSignInHistory, providerSignInEvents } from '../server/run-provider-failure.mjs'

// Exact 27 Oct incident: Hermes returns these words in an HTTP 200 final_response.
const INCIDENT = "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY."
const failure = (output = INCIDENT) => ({ run_id: 'upstream', session_id: 'wizard_signin', status: 'completed', completed: true, output,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } })
const dirs: string[] = [], cleanups: (() => any)[] = []
afterEach(async () => { for (const f of cleanups.splice(0)) await f(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'provider-notice-')); dirs.push(dir); return dir }
const body = JSON.stringify({ session_id: 'wizard_signin', input: 'Keep this complete original request. '.repeat(40).trim(), provider: 'anthropic', model: 'claude-opus-5-5' })
const request = { runtime: 'direct', sessionId: 'wizard_signin', idempotencyKey: 'saved', body, requestHash: queueRequestHash('direct', body) }

it('a diagnosed sign-in failure exposes the shared Sign in state, not an assistant Retry notice', async () => {
  let launches = 0
  const q = new DurableRunQueue({ statePath: join(await temp(), 'queue.db'), pollIntervalMs: 0,
    activeSessionIds: async () => [], launch: async () => { launches++; return { upstreamRunId: 'upstream', payload: failure() } }, lookup: async () => ({ payload: failure() }) })
  cleanups.push(() => q.close())
  const first = await q.admit(request)
  const result = q.publicPayload(first.record)
  expect(result).toMatchObject({ status: 'failed', completed: false, error: { type: 'provider_sign_in_expired' } })
  expect(result.output).toBe('')
  expect(result.wizard_reconnect).toMatchObject({provider:'claude'})
  expect(JSON.stringify(result)).not.toContain('hermes auth')
  expect(first.record!.body).toBe(body)
  const history = JSON.parse(projectProviderSignInHistory(Buffer.from('{"data":[]}'), first.record).toString())
  expect(history.data).toHaveLength(0)
  expect(result.wizard_provider_auth.provider).toBe('Claude')
  for (let i = 0; i < 3; i++) { await q.tick(true); await q.admit(request); await q.initialize() }
  expect(launches).toBe(1)
  expect(q.latestProjections()[0]).toMatchObject({ status: 'failed' })
  expect(q.latestForSession('wizard_signin')!.body).toBe(body)
})

it('shows the sign-in explanation exactly once, without a duplicate Reply not sent card', async () => {
  const q = new DurableRunQueue({ statePath: join(await temp(), 'queue.db'), pollIntervalMs: 0,
    activeSessionIds: async () => [], launch: async () => ({ upstreamRunId: 'upstream', payload: failure() }), lookup: async () => ({ payload: failure() }) })
  cleanups.push(() => q.close())
  const { record } = await q.admit(request)
  const result = q.publicPayload(record)
  const history = JSON.parse(projectProviderSignInHistory(Buffer.from('{"data":[]}'), record).toString())
  const explanation = "Claude's sign-in has expired"
  expect(history.data).toHaveLength(0)
  expect(result.wizard_reconnect.provider).toBe('claude')
  expect(result.safe_error).toBe('')
  expect(result.error.message).not.toContain(explanation)
  expect(q.latestProjections()[0].safeError).toBe('')
  expect(record!.body).toBe(body)
})

it.each(['completed', 'failed'])('repairs old %s receipts without replaying their original request', async status => {
  let launches = 0
  const q = new DurableRunQueue({ statePath: join(await temp(), 'queue.db'), pollIntervalMs: 0,
    activeSessionIds: async () => [], launch: async () => { launches++; return { upstreamRunId: 'upstream', payload: failure('ok') } }, lookup: async () => ({ payload: failure() }) })
  cleanups.push(() => q.close())
  const first = await q.admit(request)
  q._update(first.record!.publicRunId, { status, payload: { ...failure(), status }, updatedAt: 123 })
  await q.initialize(); await q.initialize()
  expect(q.get(first.record!.publicRunId)).toMatchObject({ status: 'failed', updatedAt: 123, body })
  expect(q.publicPayload(first.record!.publicRunId).wizard_reconnect.provider).toBe('claude')
  expect(launches).toBe(1)
})

it.each([
  'No Codex credentials stored. Run `hermes auth add openai-codex --type oauth` to authenticate.',
  'Codex auth is missing access_token. Run `hermes auth add openai-codex --type oauth` to re-authenticate. Run `hermes model` to re-authenticate.',
  'Codex auth is missing refresh_token. Run `hermes -p test auth add openai-codex --type oauth` to re-authenticate. Run `hermes -p test model` to re-authenticate.',
  'Codex auth state is missing tokens. Run `hermes auth add openai-codex --type oauth` to re-authenticate.',
  'Codex token refresh failed with status 401. Run `hermes model` to re-authenticate.',
  'Codex token refresh failed: Your refresh token has expired. Run `hermes model` to re-authenticate.',
  'Codex refresh token was already consumed by another client (e.g. Codex CLI or VS Code extension). Run `codex` in your terminal to generate fresh tokens, then run `hermes auth add openai-codex --type oauth` to re-authenticate. Run `hermes model` to re-authenticate.',
])('names ChatGPT for controlled Codex auth text: %s', output => {
  const mapped = normalizeProviderPreflightFailure(failure(output))
  expect(mapped.wizard_provider_auth.provider).toBe('ChatGPT')
  expect(mapped.output).toBe('')
  expect(JSON.stringify(mapped)).not.toContain('hermes auth')
})

it('accepts the controlled warning prefix and final_response field', () => {
  expect(normalizeProviderPreflightFailure({ status: 'completed', final_response: `⚠️ Provider authentication failed: ${INCIDENT}` })).toMatchObject({
    status: 'failed', wizard_provider_auth: { provider: 'Claude', href: '/troubleshoot/?provider=claude' } })
})
it.each(['A normal answer', `The error was: ${INCIDENT}`, `\`${INCIDENT}\``, 'HTTP 401', 'invalid_grant',
  'Codex token refresh failed with status 500.', 'Codex provider quota exhausted (429). Credentials are still valid;',
  'Anthropic credentials are rate-limited for claude-opus-5-5; other Claude models remain available.'])('does not claim a sign-out for %s', text => {
  expect(providerSignInNotice(text)).toBeNull()
  const payload = failure(text)
  expect(normalizeProviderPreflightFailure(payload)).toBe(payload)
})

it('never rewrites owner/tool quotations; does not duplicate or paginate an old notice', () => {
  const record = { status: 'failed', payload: normalizeProviderPreflightFailure(failure()), publicRunId: 'q', sessionId: 'wizard_signin', updatedAt: 100 }
  const input = Buffer.from(JSON.stringify({ data: [{ role: 'user', content: INCIDENT }, { role: 'tool', content: INCIDENT }] }))
  const projected = projectProviderSignInHistory(input, record)
  const rows = JSON.parse(projected.toString()).data
  expect(rows.slice(0, 2)).toEqual(JSON.parse(input.toString()).data)
  expect(rows).toHaveLength(2)
  expect(JSON.parse(projectProviderSignInHistory(projected, record).toString()).data).toHaveLength(2)
  expect(JSON.parse(projectProviderSignInHistory(input, record, new URLSearchParams('offset=100&order=latest')).toString()).data).toHaveLength(2)
  expect(JSON.parse(projectProviderSignInHistory(Buffer.from('{"data":[{"role":"assistant","content":"fixed","timestamp":101}]}'), record).toString()).data).toHaveLength(1)
})
it('maps fragmented UTF-8 network frames, preserving unrelated SSE bytes', async () => {
  const delta = `event: message.delta\ndata: ${JSON.stringify({ delta: `⚠️ Provider authentication failed: ${INCIDENT}` })}\n\n`
  const terminal = `event: run.completed\ndata: ${JSON.stringify(failure())}\n\n`
  const progress = 'event: tool.call\ndata: {"name":"test"}\n\n'
  const bytes = Buffer.from(progress + delta + terminal), chunks: Buffer[] = []
  const stream = Readable.from([...bytes].map(b => Buffer.from([b]))).pipe(providerSignInEvents())
  for await (const chunk of stream) chunks.push(chunk)
  const output = Buffer.concat(chunks).toString()
  expect(output.startsWith(progress)).toBe(true)
  expect(output).toContain('event: run.failed')
  expect(output).toContain('wizard_reconnect')
  expect(output).not.toContain('hermes auth')
})

it('main HTTP chat history, failed receipt and full Retry input agree without a real login', async () => {
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://fixture').pathname
    for await (const _ of req) { /* drain */ }
    res.setHeader('Content-Type', 'application/json')
    if (path === '/v1/runs' && req.method === 'POST') { res.statusCode = 202; res.end(JSON.stringify(failure())); return }
    if (path === '/api/sessions/wizard_signin/messages') { res.end('{"data":[],"has_more":false}'); return }
    if (path === '/api/sessions/wizard_signin') { res.end('{"id":"wizard_signin","title":"Sign-in example"}'); return }
    if (path === '/api/sessions') { res.end('{"data":[]}'); return }
    if (path === '/v1/capabilities') { res.end('{}'); return }
    res.end(JSON.stringify(failure()))
  })
  const port = (await listen(upstream)).port
  cleanups.push(() => new Promise<void>(done => { upstream.closeAllConnections(); upstream.close(() => done()) }))
  const server = createWizardServer({ requireJoinedDelegationCapability: false, requireAccess: false, upstreamOrigin: `http://127.0.0.1:${port}`, hermesKey: 'fixture-only-key',
    runQueueStatePath: join(await temp(), 'queue.db'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true })
  const origin = `http://127.0.0.1:${(await listen(server)).port}`
  cleanups.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) }))
  const admission = await (await fetch(origin + '/wizard/hermes/v1/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'saved' }, body })).json()
  const run = await (await fetch(origin + `/wizard/hermes/v1/runs/${admission.run_id}`)).json()
  expect(run.status).toBe('failed')
  const history = await (await fetch(origin + '/wizard/hermes/api/sessions/wizard_signin/messages?view=wizard&order=latest')).json()
  expect(history.data).toHaveLength(0)
  const detail = await (await fetch(origin + '/wizard/hermes/api/sessions/wizard_signin?view=detail')).json()
  expect(detail.wizard_retry_input).toBe(JSON.parse(body).input)
})

it('routed agents share normalization, assistant notice and complete saved Retry input', async () => {
  const agent = { id: 'sample', model: { model: 'claude-opus-5-5' } }
  const registry = { agentsDir: await temp(), list: () => [], apiKey: () => 'fixture-only-key', fetchAgent: async (_agent: any, path: string, init: any = {}) => {
    const parsed = new URL(path, 'http://fixture')
    return new Response(JSON.stringify(parsed.pathname.endsWith('/messages') ? { data: [] }
      : parsed.pathname.startsWith('/api/sessions/') ? { id: 'wizard_signin' } : failure()), { status: init.method === 'POST' ? 202 : 200 })
  } }
  const routed = createRoutedQueues({ registry, own: (f: any) => cleanups.push(f), pollIntervalMs: 0, maxActive: 8, onStatus: undefined })
  await routed.ready
  const run = await (await routed.fetch(agent, '/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': 'saved' }, body })).json()
  expect(run.status).toBe('failed')
  const history = await (await routed.fetch(agent, '/api/sessions/wizard_signin/messages?view=wizard&order=latest')).json()
  expect(history.data).toHaveLength(0)
  const detail = await (await routed.fetch(agent, '/api/sessions/wizard_signin?view=detail')).json()
  expect(detail.wizard_retry_input).toBe(JSON.parse(body).input)
})
