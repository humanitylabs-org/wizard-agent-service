// Owner vs agent authentication: who may open a private agent, and what an agent credential reaches.
// Fixtures only: synthetic agents, a synthetic canary thread, fake Hermes APIs, temporary homes.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentIngress, createWizardServer, listen } from '../server/service.mjs'
import { createPrincipalResolver, markAgentIngress, sameSecret } from '../server/principals.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

const PROOF = 'owner-proof-fixture-0123456789abcdef0123456789'
const OWNER = { 'X-Wizard-Owner-Proof': PROOF }
const CANARY = 'wizard_canary_private_thread'
const CANARY_TEXT = 'CANARY-PRIVATE-CONTENT-7f3a'

type Seen = { method: string, path: string }

async function fakeHermes(name: string, sessions: string[] = []) {
  const seen: Seen[] = []
  const known = new Set(sessions)
  const runs = new Set<string>()
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : undefined
    seen.push({ method: req.method ?? '', path: url.pathname + url.search })
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/v1/capabilities') return json(200, { features: {} })
    if (url.pathname === '/api/model/options') return json(200, { provider: 'anthropic', model: 'claude-opus-5-5', providers: [
      { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5'] },
    ] })
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, { data: [...known].map((id) => ({ id, title: `${name} ${id}`, source: 'api_server' })) })
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && sessionMatch) return known.has(decodeURIComponent(sessionMatch[1])) ? json(200, { session: { id: decodeURIComponent(sessionMatch[1]), title: name } }) : json(404, { error: 'not found' })
    const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'GET' && messagesMatch) return known.has(decodeURIComponent(messagesMatch[1])) ? json(200, { data: [{ role: 'assistant', content: name === 'private' ? CANARY_TEXT : `${name} says hi` }] }) : json(404, { error: 'not found' })
    if (req.method === 'POST' && url.pathname === '/api/sessions') { known.add(body?.id ?? 'generated_1'); return json(201, { session: { id: body?.id ?? 'generated_1' } }) }
    if (req.method === 'POST' && url.pathname === '/v1/runs') { known.add(body.session_id); runs.add(`${name}-run-1`); return json(202, { run_id: `${name}-run-1`, status: 'started' }) }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)/)
    if (runMatch && !runs.has(runMatch[1])) return json(404, { error: 'no such run' })
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) return json(200, { run_id: url.pathname.split('/').at(-1), status: 'completed', output: `${name} done` })
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`event: message.delta\ndata: {"delta":"${name}"}\n\n`); return }
    if (req.method === 'POST' && /^\/v1\/runs\/[^/]+\/(stop|steer|approval)$/.test(url.pathname)) return json(202, { ok: true })
    json(404, { error: 'nope' })
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { port: address.port, origin: `http://127.0.0.1:${address.port}`, seen, known }
}

function box() {
  const dir = mkdtempSync(join(tmpdir(), 'principals-'))
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [
    { id: 'meeting-recorder', name: 'Meeting Recorder', status: 'running', view: { url: '/apps/meeting-recorder/' }, agent_binding: { required: true, purpose: 'Where recaps go' } },
    { id: 'meditate', name: 'Meditate', status: 'running', view: { url: '/meditate/' }, mcp: { url: 'http://127.0.0.1:1/mcp' } },
  ] }))
  return dir
}

async function start(dir: string, main: { origin: string }, extra: Record<string, unknown> = {}) {
  const deliveries: { id: string, payload: any }[] = []
  const runtime = {
    apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }),
    deliver: async (id: string, payload: any) => { deliveries.push({ id, payload }); return { verified: true, already_delivered: false, session_id: payload.session_id, message_id: 7 } },
  }
  const svc = createWizardServer({
    upstreamOrigin: main.origin, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false, ownerProof: PROOF,
    appsJsonPath: join(dir, 'apps.json'), launcherPath: join(dir, 'launcher.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: runtime, agentDeliveryToken: 'delivery-token-0123456789abcdef', followThrough: false, agentBasePort: 47750, joinedDelegation: 'off',
    threadDispositionStatePath: join(dir, 'dispositions.json'), threadSeenStatePath: join(dir, 'seen.json'), ...extra,
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  return { base: `http://127.0.0.1:${address.port}`, deliveries }
}

const send = (method: string, body: unknown, headers: Record<string, string> = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

async function agent(dir: string, base: string, body: Record<string, unknown>, port: number) {
  const created = await fetch(`${base}/wizard/v1/agents`, send('POST', body, OWNER))
  expect(created.status).toBe(201)
  const id = (await created.json()).agent.id as string
  const file = join(dir, 'agents', id, 'agent.json')
  const value = JSON.parse(readFileSync(file, 'utf8'))
  value.runtime.port = port
  writeFileSync(file, JSON.stringify(value))
  await fetch(`${base}/wizard/v1/agents/${id}/start`, send('POST', {}, OWNER))
  return id
}

// A box with the main agent, a private agent holding one canary thread, and a standard agent with its own credential.
async function scene(extra: (dir: string) => Record<string, unknown> = () => ({})) {
  const dir = box()
  const main = await fakeHermes('main', ['wizard_main_1'])
  const priv = await fakeHermes('private', [CANARY])
  const helper = await fakeHermes('helper', ['wizard_helper_1'])
  const svc = await start(dir, main, extra(dir))
  const privateId = await agent(dir, svc.base, { label: 'Private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }, priv.port)
  const helperId = await agent(dir, svc.base, { label: 'Helper', harness: 'hermes', model: { provider: 'anthropic', model: 'claude-opus-5-5' }, permissions: { preset: 'standard' } }, helper.port)
  const helperKey = 'helper-gateway-key-0123456789abcdefghijklmnop'
  const privateKey = 'private-gateway-key-0123456789abcdefghijklmno'
  writeFileSync(join(dir, 'agents', helperId, 'gateway.key'), `${helperKey}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'agents', privateId, 'gateway.key'), `${privateKey}\n`, { mode: 0o600 })
  // The owner opens the canary thread once: that pins it to the private agent, as the real Chats do.
  const opened = await fetch(`${svc.base}/wizard/hermes/api/sessions?agent=${privateId}`, { headers: OWNER })
  expect(opened.status).toBe(200)
  await fetch(`${svc.base}/wizard/hermes/api/sessions?agent=${helperId}`, { headers: OWNER })
  // The owner runs the private agent once, so its run id is known to belong there.
  const run = await fetch(`${svc.base}/wizard/hermes/v1/runs`, send('POST', { input: 'hi', session_id: CANARY, agent: privateId }, OWNER))
  expect(run.status).toBe(202)
  return { dir, main, priv, helper, ...svc, privateId, helperId, helperKey, privateKey }
}

const privateIdOf = (s: { privateId: string }) => s.privateId

// Every way a non-owner might name, guess or reach the private agent's work.
function privateProbes(privateId: string) {
  const runBody = (extra: Record<string, unknown>) => ({ input: 'hello', session_id: CANARY, ...extra })
  return [
    ['list by query', 'GET', `/wizard/hermes/api/sessions?agent=${privateId}`, undefined],
    ['detail by query', 'GET', `/wizard/hermes/api/sessions/${CANARY}?agent=${privateId}`, undefined],
    ['messages by query', 'GET', `/wizard/hermes/api/sessions/${CANARY}/messages?agent=${privateId}`, undefined],
    ['messages by id only', 'GET', `/wizard/hermes/api/sessions/${CANARY}/messages`, undefined],
    ['detail by id only', 'GET', `/wizard/hermes/api/sessions/${CANARY}`, undefined],
    ['rename by id only', 'PATCH', `/wizard/hermes/api/sessions/${CANARY}`, { title: 'x' }],
    ['model change by id', 'POST', `/wizard/hermes/api/sessions/${CANARY}/model`, { model: 'glm-5-3' }],
    ['run by body agent', 'POST', '/wizard/hermes/v1/runs', runBody({ agent: privateId })],
    ['run by pinned session', 'POST', '/wizard/hermes/v1/runs', runBody({})],
    ['run claiming main agent', 'POST', '/wizard/hermes/v1/runs', runBody({ agent: 'hermes' })],
    ['new chat on the private model', 'POST', '/wizard/hermes/api/sessions', { id: 'wizard_new_by_model', model: 'glm-5-3', provider: 'tinfoil' }],
    ['run on the private model', 'POST', '/wizard/hermes/v1/runs', { input: 'x', session_id: 'wizard_new_by_model_2', model: 'glm-5-3', provider: 'tinfoil' }],
    ['run status', 'GET', '/wizard/hermes/v1/runs/private-run-1', undefined],
    ['run events', 'GET', '/wizard/hermes/v1/runs/private-run-1/events', undefined],
    ['run stop', 'POST', '/wizard/hermes/v1/runs/private-run-1/stop', undefined],
    ['run steer', 'POST', '/wizard/hermes/v1/runs/private-run-1/steer', { text: 'x' }],
    ['run approval', 'POST', '/wizard/hermes/v1/runs/private-run-1/approval', { approved: true }],
    ['model options', 'GET', `/wizard/hermes/api/model/options?agent=${privateId}`, undefined],
    ['share into it', 'POST', '/wizard/v1/shares', { agent: privateId, text: 'x', files: [] }],
    ['phone setup summary', 'GET', '/wizard/v1/setup', undefined],
    ['phone setup status', 'GET', '/wizard/v1/setup/phone', undefined],
    ['phone enrollment', 'POST', '/wizard/v1/setup/phone/start', {}],
    ['phone reset', 'POST', '/wizard/v1/setup/phone/reset', {}],
    ['agent detail', 'GET', `/wizard/v1/agents/${privateId}`, undefined],
    ['agent edit', 'PATCH', `/wizard/v1/agents/${privateId}`, { label: 'Not private' }],
    ['agent stop', 'POST', `/wizard/v1/agents/${privateId}/stop`, {}],
    ['recap delivery with the host token', 'POST', `/wizard/v1/agents/${privateId}/deliveries`, { session_id: CANARY, delivery_key: 'k', title: 't', body: 'b' }],
    ['grants for it', 'GET', `/wizard/v1/agent-grants?reader=${privateId}`, undefined],
    ['grant to it', 'POST', '/wizard/v1/agent-grants', { reader: privateId, source: 'hermes', level: 'read' }],
    ['bind an app to it', 'PUT', '/wizard/v1/apps/meeting-recorder/binding', { agent: privateId }],
    ['give it an app', 'PUT', '/wizard/v1/apps/meditate/agents', { agents: [privateId] }],
  ] as const
}

async function call(base: string, [, method, path, body]: readonly [string, string, string, unknown], headers: Record<string, string>) {
  const init: RequestInit = { method, headers: { ...headers } }
  if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as Record<string, string>)['Content-Type'] = 'application/json' }
  if (path.includes('/deliveries')) (init.headers as Record<string, string>).Authorization = 'Bearer delivery-token-0123456789abcdef'
  const response = await fetch(`${base}${path}`, init)
  return { status: response.status, text: await response.text(), agent: response.headers.get('x-wizard-agent') ?? '' }
}

describe('owner vs agent authentication', () => {
  it('test 1: the owner opens and runs the private agent through the proxy proof', async () => {
    const s = await scene()
    const list = await fetch(`${s.base}/wizard/hermes/api/sessions?agent=${s.privateId}`, { headers: OWNER })
    expect(list.status).toBe(200)
    expect(JSON.stringify(await list.json())).toContain(CANARY)
    const messages = await fetch(`${s.base}/wizard/hermes/api/sessions/${CANARY}/messages?agent=${s.privateId}`, { headers: OWNER })
    expect(messages.status).toBe(200)
    expect(await messages.text()).toContain(CANARY_TEXT)
    const run = await fetch(`${s.base}/wizard/hermes/v1/runs`, send('POST', { input: 'hi', session_id: CANARY, agent: s.privateId }, OWNER))
    expect(run.status).toBe(202)
    const agents = await (await fetch(`${s.base}/wizard/v1/agents`, { headers: OWNER })).json()
    expect(agents.agents.map((a: any) => a.id)).toContain(s.privateId)
  })

  it('test 2: spoofed identity headers, wrong proofs, query flags and loopback get nothing from the private agent', async () => {
    const s = await scene()
    const before = s.priv.seen.length
    const disguises: Record<string, string>[] = [
      {},
      { 'Tailscale-User-Login': 'owner@example.com', 'Tailscale-User-Name': 'Owner', 'X-Private-Peer': '100.64.0.1' },
      { 'X-Forwarded-For': '100.64.0.1', Forwarded: 'for=100.64.0.1', 'Cf-Access-Authenticated-User-Email': 'owner@example.com' },
      { 'X-Wizard-Owner-Proof': `${PROOF}x` },
      { 'X-Wizard-Owner-Proof': PROOF.slice(0, -1) },
      { 'X-Wizard-Owner-Proof': '' },
      { 'X-Wizard-Internal-Token': 'f'.repeat(64) },
      { Origin: 'https://wizard.example.ts.net', Host: 'wizard.example.ts.net', 'Sec-Fetch-Site': 'same-origin' },
      { Authorization: 'Bearer fixture-key' },
    ]
    const leaks: string[] = []
    for (const headers of disguises) {
      for (const probe of privateProbes(s.privateId)) {
        const result = await call(s.base, probe, headers)
        // A new chat that merely names the private agent's model may land on the main agent (where model routing
        // is absent); what must never happen is that the private agent serves it.
        const mainMayServe = probe[0].endsWith('on the private model')
        if ((result.status < 400 && !mainMayServe) || result.agent === privateIdOf(s) || result.text.includes(CANARY_TEXT)) leaks.push(`${probe[0]} with ${Object.keys(headers).join('+') || 'no headers'}: ${result.status}`)
      }
    }
    expect(leaks).toEqual([])
    // Nothing reached the private agent's own Hermes on any of those requests.
    expect(s.priv.seen.slice(before)).toEqual([])
    // A query flag is not an identity either.
    const flagged = await fetch(`${s.base}/wizard/hermes/api/sessions?agent=${s.privateId}&owner=1`)
    expect(flagged.status).toBeGreaterThanOrEqual(400)
  })

  it('test 2: denials look exactly like a missing agent or thread and never echo it', async () => {
    const s = await scene()
    const denied = await fetch(`${s.base}/wizard/hermes/api/sessions/${CANARY}/messages?agent=${s.privateId}`)
    const missing = await fetch(`${s.base}/wizard/hermes/api/sessions/${CANARY}/messages?agent=nobody`)
    expect([denied.status, await denied.json()]).toEqual([missing.status, await missing.json()])
    // By id alone, the private thread answers like an id nobody has.
    const idOnly = await fetch(`${s.base}/wizard/hermes/api/sessions/${CANARY}/messages`)
    const unknown = await fetch(`${s.base}/wizard/hermes/api/sessions/wizard_never_existed/messages`)
    expect([idOnly.status, await idOnly.text()]).toEqual([unknown.status, await unknown.text()])
    // Admin listings simply do not show the private agent to a non-owner.
    const agents = await (await fetch(`${s.base}/wizard/v1/agents`)).json()
    expect(agents.agents.map((a: any) => a.id)).not.toContain(s.privateId)
    expect((await fetch(`${s.base}/wizard/v1/agents/${s.privateId}`)).status).toBe(404)
  })

  it('test 3: an agent credential cannot open or run the main (system) agent or the owner surface', async () => {
    const s = await scene()
    const bearer = { Authorization: `Bearer ${s.helperKey}` }
    const before = s.main.seen.length
    const refused = [
      ['GET', '/wizard/hermes/api/sessions'],
      ['GET', '/wizard/hermes/api/sessions?agent=hermes'],
      ['GET', '/wizard/hermes/api/sessions/wizard_main_1/messages'],
      ['POST', '/wizard/hermes/v1/runs'],
      ['GET', '/wizard/operator/api/sessions'],
      ['GET', '/wizard/v1/agents'],
      ['PATCH', `/wizard/v1/agents/${s.helperId}`],
      ['GET', '/wizard/v1/agent-grants'],
      ['GET', '/wizard/v1/app-bindings'],
      ['GET', '/wizard/v1/bootstrap'],
      ['GET', '/wizard/thread-dispositions'],
      ['GET', '/wizard/background-results'],
      ['GET', '/wizard/v1/user-files'],
    ] as const
    for (const [method, path] of refused) {
      const init: RequestInit = { method, headers: { ...bearer, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) }, ...(method === 'GET' ? {} : { body: JSON.stringify({ input: 'x', session_id: 'wizard_main_1' }) }) }
      const response = await fetch(`${s.base}${path}`, init)
      expect([path, response.status]).toEqual([path, 403])
      expect((await response.json()).error).toBe('agent_scope')
    }
    expect(s.main.seen.slice(before)).toEqual([])
  })

  it('test 4: an agent credential lists and runs only its own threads', async () => {
    const s = await scene()
    const bearer = { Authorization: `Bearer ${s.helperKey}` }
    const own = await fetch(`${s.base}/wizard/hermes/api/sessions?agent=${s.helperId}`, { headers: bearer })
    expect(own.status).toBe(200)
    const listed = JSON.stringify(await own.json())
    expect(listed).toContain('wizard_helper_1')
    expect(listed).not.toContain(CANARY)
    expect(listed).not.toContain('wizard_main_1')
    const run = await fetch(`${s.base}/wizard/hermes/v1/runs`, send('POST', { input: 'x', session_id: 'wizard_helper_1', agent: s.helperId }, bearer))
    expect(run.status).toBe(202)
    // Another agent's work: refused, by explicit name or by its pinned thread.
    for (const path of [`/wizard/hermes/api/sessions?agent=${s.privateId}`, `/wizard/hermes/api/sessions/${CANARY}/messages?agent=${s.privateId}`, `/wizard/hermes/api/sessions/${CANARY}/messages`]) {
      const refused = await fetch(`${s.base}${path}`, { headers: bearer })
      expect(refused.status).toBeGreaterThanOrEqual(403)
      expect(await refused.text()).not.toContain(CANARY_TEXT)
    }
    const pinned = await fetch(`${s.base}/wizard/hermes/v1/runs`, send('POST', { input: 'x', session_id: CANARY }, bearer))
    expect(pinned.status).toBe(404)
    // The private agent's own credential reaches its own threads (its own runtime), and nothing else.
    const self = await fetch(`${s.base}/wizard/hermes/api/sessions?agent=${s.privateId}`, { headers: { Authorization: `Bearer ${s.privateKey}` } })
    expect(self.status).toBe(200)
    const other = await fetch(`${s.base}/wizard/hermes/api/sessions?agent=${s.helperId}`, { headers: { Authorization: `Bearer ${s.privateKey}` } })
    expect(other.status).toBe(403)
  })

  it('test 5: non-private routes keep working for local automations, and a bound app still delivers into the private agent', async () => {
    const s = await scene()
    const list = await fetch(`${s.base}/wizard/hermes/api/sessions`)
    expect(list.status).toBe(200)
    expect(JSON.stringify(await list.json())).toContain('wizard_main_1')
    const run = await fetch(`${s.base}/wizard/hermes/v1/runs`, send('POST', { input: 'x', session_id: 'wizard_main_1' }))
    expect(run.status).toBe(202)
    const helperList = await fetch(`${s.base}/wizard/hermes/api/sessions?agent=${s.helperId}`)
    expect(helperList.status).toBe(200)
    // The owner binds the recorder app to the private agent; the app's own token still delivers there, write-only.
    expect((await fetch(`${s.base}/wizard/v1/apps/meeting-recorder/binding`, send('PUT', { agent: s.privateId }, OWNER))).status).toBe(200)
    const appToken = readFileSync(join(s.dir, 'app-tokens', 'meeting-recorder'), 'utf8').trim()
    const delivered = await fetch(`${s.base}/wizard/v1/apps/meeting-recorder/deliveries`, send('POST', { delivery_key: 'm-1', title: 'Recap', body: 'Body' }, { Authorization: `Bearer ${appToken}` }))
    expect(delivered.status).toBe(200)
    expect(s.deliveries.at(-1)?.id).toBe(s.privateId)
    // A non-owner cannot see that binding, nor move the app off the private agent.
    const bindings = await (await fetch(`${s.base}/wizard/v1/app-bindings`)).json()
    expect(bindings.bindings.map((b: any) => b.agent)).not.toContain(s.privateId)
    expect((await fetch(`${s.base}/wizard/v1/apps/meeting-recorder/binding`, send('PUT', { agent: 'hermes' }))).status).toBe(404)
  })

  it('owner-only side lists omit private sessions for other callers', async () => {
    const s = await scene()
    const put = (sessionId: string) => fetch(`${s.base}/wizard/thread-dispositions`, send('PUT', { runtime: 'direct', sessionId, deferred: true }, OWNER))
    expect((await put(CANARY)).status).toBe(200)
    expect((await put('wizard_main_1')).status).toBe(200)
    const owner = await (await fetch(`${s.base}/wizard/thread-dispositions`, { headers: OWNER })).json()
    expect(Object.keys(owner.state)).toEqual(expect.arrayContaining([`agent/${s.privateId}/direct:${CANARY}`, 'direct:wizard_main_1']))
    const other = await (await fetch(`${s.base}/wizard/thread-dispositions`)).json()
    expect(Object.keys(other.state)).toEqual(['direct:wizard_main_1'])
  })
})

// Attacks raised by the security review of this change, each pinned as a regression test.
describe('review regressions', () => {
  const withUploads = (dir: string) => ({
    mediaRoot: join(dir, 'media'), mediaAgentRoot: '/files', mediaIndexPath: join(dir, 'state', 'media-files.json'),
    uploadStatePath: join(dir, 'state', 'uploads.sqlite3'), uploadReserveBytes: 0,
  })

  it('a replayed private share and its upload ids give a non-owner nothing to read or write', async () => {
    const s = await scene(withUploads)
    const body = { client_share_id: 'owner-share-1', agent: s.privateId, files: [{ filename: 'a.txt', bytes: 5 }] }
    const created = await fetch(`${s.base}/wizard/v1/shares`, send('POST', body, OWNER))
    expect(created.status).toBe(201)
    const share = await created.json()
    const upload = share.uploads[0].upload_id as string
    const attempts = [
      ['replay', await fetch(`${s.base}/wizard/v1/shares`, send('POST', body))],
      ['replay without the agent', await fetch(`${s.base}/wizard/v1/shares`, send('POST', { ...body, agent: undefined }))],
      ['share status', await fetch(`${s.base}/wizard/v1/shares/${share.share_id}`)],
      ['upload status', await fetch(`${s.base}/wizard/v1/uploads/${upload}`)],
      ['upload bytes', await fetch(`${s.base}/wizard/v1/uploads/${upload}`, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: 'evil!' })],
      ['upload complete', await fetch(`${s.base}/wizard/v1/uploads/${upload}/complete`, send('POST', {}))],
    ] as const
    for (const [name, response] of attempts) {
      const text = await response.text()
      expect([name, response.status >= 400, text.includes(upload)]).toEqual([name, true, false])
    }
    // The owner's own upload is untouched and still accepts its bytes.
    const status = await (await fetch(`${s.base}/wizard/v1/uploads/${upload}`, { headers: OWNER })).json()
    expect(status.offset).toBe(0)
    const bytes = await fetch(`${s.base}/wizard/v1/uploads/${upload}`, { method: 'PATCH', headers: { ...OWNER, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: 'hello' })
    expect(bytes.status).toBe(204)
  })

  it('grant ids must be plain strings, so an array cannot slip a private reader past the check', async () => {
    const s = await scene()
    for (const reader of [[s.privateId], { id: s.privateId }]) {
      const response = await fetch(`${s.base}/wizard/v1/agent-grants`, send('POST', { reader, source: 'hermes', scope: 'titles' }))
      expect(response.status).toBe(400)
    }
    const grants = await (await fetch(`${s.base}/wizard/v1/agent-grants`, { headers: OWNER })).json()
    expect(grants.grants.filter((g: any) => g.reader === s.privateId)).toEqual([])
  })

  it('replaying an agent-creation key does not reveal a private agent; only the owner creates one', async () => {
    const s = await scene()
    const body = { label: 'Second private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }
    const key = { 'Idempotency-Key': 'create-second-private' }
    expect((await fetch(`${s.base}/wizard/v1/agents`, send('POST', body, { ...OWNER, ...key }))).status).toBe(201)
    const replay = await fetch(`${s.base}/wizard/v1/agents`, send('POST', body, key))
    expect(replay.status).toBeGreaterThanOrEqual(400)
    expect(await replay.text()).not.toContain('second-private')
    expect((await fetch(`${s.base}/wizard/v1/agents`, send('POST', { ...body, label: 'Sneaky' }))).status).toBe(403)
  })

  it('app membership for standard agents still works for local callers while a private agent exists', async () => {
    const s = await scene()
    expect((await fetch(`${s.base}/wizard/v1/apps/meditate/agents`, send('PUT', { agents: [s.privateId] }, OWNER))).status).toBe(200)
    const put = await fetch(`${s.base}/wizard/v1/apps/meditate/agents`, send('PUT', { agents: ['hermes', s.helperId] }))
    expect(put.status).toBe(200)
    expect(JSON.stringify(await put.json())).not.toContain(s.privateId)
    // The hidden private membership stayed as the owner set it.
    const owner = await (await fetch(`${s.base}/wizard/v1/apps/meditate/agents`, { headers: OWNER })).json()
    expect(owner.agents.find((a: any) => a.id === s.privateId).enabled).toBe(true)
    expect(owner.agents.find((a: any) => a.id === s.helperId).enabled).toBe(true)
    // Changing the private membership itself is the owner's.
    expect((await fetch(`${s.base}/wizard/v1/apps/meditate/agents`, send('PUT', { agents: [] }))).status).toBe(200)
    const after = await (await fetch(`${s.base}/wizard/v1/apps/meditate/agents`, { headers: OWNER })).json()
    expect(after.agents.find((a: any) => a.id === s.privateId).enabled).toBe(true)
  })

  it('side state for private threads cannot be written by others, and a thread read by the owner is hidden from then on', async () => {
    const s = await scene()
    const write = await fetch(`${s.base}/wizard/thread-dispositions`, send('PUT', { runtime: 'direct', sessionId: CANARY, deferred: true }))
    expect(write.status).toBe(404)
    const owner = await (await fetch(`${s.base}/wizard/thread-dispositions`, { headers: OWNER })).json()
    expect(Object.keys(owner.state)).not.toContain(`direct:${CANARY}`)
    // A private thread the owner opens directly (never listed) is pinned by that read and hidden afterwards.
    s.priv.known.add('wizard_private_direct')
    expect((await fetch(`${s.base}/wizard/hermes/api/sessions/wizard_private_direct?agent=${s.privateId}`, { headers: OWNER })).status).toBe(200)
    expect((await fetch(`${s.base}/wizard/thread-dispositions`, send('PUT', { runtime: 'direct', sessionId: 'wizard_private_direct', deferred: true }))).status).toBe(404)
  })

  it('second review: a hidden agent answers exactly like a missing one on shares, grants and app membership', async () => {
    const s = await scene(withUploads)
    const same = async (make: (id: string) => Promise<Response>) => {
      const hidden = await make(s.privateId)
      const missing = await make('no-such-agent')
      const hiddenText = (await hidden.text()).replaceAll(s.privateId, 'ID')
      const missingText = (await missing.text()).replaceAll('no-such-agent', 'ID')
      expect([hidden.status, hiddenText]).toEqual([missing.status, missingText])
    }
    await same((id) => fetch(`${s.base}/wizard/v1/shares`, send('POST', { client_share_id: `probe-${id}`, agent: id, files: [{ filename: 'a.txt', bytes: 1 }] })))
    await same((id) => fetch(`${s.base}/wizard/v1/agent-grants`, send('POST', { reader: id, source: 'hermes', scope: 'titles' })))
    await same((id) => fetch(`${s.base}/wizard/v1/agent-grants`, send('POST', { reader: s.helperId, source: id, scope: 'titles' })))
    await same((id) => fetch(`${s.base}/wizard/v1/apps/meditate/agents`, send('PUT', { agents: ['hermes', id] })))
    // A known private thread id answers a share like an unknown one.
    const known = await fetch(`${s.base}/wizard/v1/shares`, send('POST', { client_share_id: 'probe-thread-1', thread: CANARY, files: [{ filename: 'a.txt', bytes: 1 }] }))
    const unknown = await fetch(`${s.base}/wizard/v1/shares`, send('POST', { client_share_id: 'probe-thread-2', thread: 'wizard_never_existed', files: [{ filename: 'a.txt', bytes: 1 }] }))
    expect([known.status, await known.text()]).toEqual([unknown.status, await unknown.text()])
  })

  it('third review: malformed and multi-id requests answer the same for a hidden agent and a missing one', async () => {
    const s = await scene()
    const same = async (make: (id: string) => Promise<Response>) => {
      const hidden = await make(s.privateId)
      const missing = await make('no-such-agent')
      const hiddenText = (await hidden.text()).replaceAll(s.privateId, 'ID')
      const missingText = (await missing.text()).replaceAll('no-such-agent', 'ID')
      expect([hidden.status, hiddenText]).toEqual([missing.status, missingText])
    }
    await same((id) => fetch(`${s.base}/wizard/v1/agent-grants`, send('POST', { kind: 'bogus', reader: id, source: 'hermes' })))
    await same((id) => fetch(`${s.base}/wizard/v1/agent-grants`, send('POST', { reader: 'nobody', source: id })))
    await same((id) => fetch(`${s.base}/wizard/v1/apps/meditate/agents`, send('PUT', { agents: [id, 0] })))
    await same((id) => fetch(`${s.base}/wizard/v1/apps/meditate/agents`, send('PUT', { agents: ['nobody', id] })))
  })

  it('drops private and ambiguous seen records without blocking a visible mark or changing owner marks', async () => {
    const s = await scene()
    const record = (seenAt: number, agent_id?: string, session_id?: string) => ({ updatedAt: new Date(seenAt).toISOString(), previewFingerprint: 'abc', seenAt, ...(agent_id ? { agent_id, session_id } : {}) })
    const privateKey = `agent/${s.privateId}/direct:${CANARY}`
    expect((await fetch(`${s.base}/wizard/thread-seen`, send('PUT', { initializedAt: 1000, threads: {
      [privateKey]: record(2000, s.privateId, CANARY),
    } }, OWNER))).status).toBe(200)
    // The same unqualified id is pinned to two visible agents by real list reads.
    s.main.known.add('wizard_ambiguous_seen')
    s.helper.known.add('wizard_ambiguous_seen')
    for (const id of ['hermes', s.helperId]) expect((await fetch(`${s.base}/wizard/hermes/api/sessions?agent=${id}`, { headers: OWNER })).status).toBe(200)
    const response = await fetch(`${s.base}/wizard/thread-seen`, send('PUT', { initializedAt: 0, threads: {
      [privateKey]: record(9000, s.privateId, CANARY),
      'agent/no-such-agent/direct:retired': record(9000, 'no-such-agent', 'retired'),
      'direct:wizard_ambiguous_seen': record(9000),
      'direct:wizard_main_1': record(4000, 'hermes', 'wizard_main_1'),
    } }))
    expect(response.status).toBe(200)
    const visible = (await response.json()).state
    expect(Object.keys(visible.threads)).toEqual(['direct:wizard_main_1'])
    const saved = (await (await fetch(`${s.base}/wizard/thread-seen`, { headers: OWNER })).json()).state
    expect(saved.initializedAt).toBe(1000)
    expect(saved.threads[privateKey].seenAt).toBe(2000)
    expect(Object.keys(saved.threads).sort()).toEqual([privateKey, 'direct:wizard_main_1'].sort())
    // A non-owner cannot create a private mark either, including one not already pinned.
    const hiddenOnly = await fetch(`${s.base}/wizard/thread-seen`, send('PUT', { threads: {
      [`agent/${s.privateId}/direct:unlisted-private`]: record(9000, s.privateId, 'unlisted-private'),
    } }))
    expect(hiddenOnly.status).toBe(200)
    const after = (await (await fetch(`${s.base}/wizard/thread-seen`, { headers: OWNER })).json()).state
    expect(after).toEqual(saved)
  })

  it('third review: the number of visible seen marks a caller can store does not depend on hidden ones', async () => {
    const s = await scene()
    const record = (seenAt: number) => ({ updatedAt: new Date(seenAt).toISOString(), previewFingerprint: 'abc', seenAt })
    const flood = { initializedAt: 0, threads: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`direct:wizard_flood_${i}`, record(10_000 + i)])) }
    const count = async () => Object.keys((await (await fetch(`${s.base}/wizard/thread-seen`, send('PUT', flood))).json()).state.threads).length
    const before = await count()
    expect((await fetch(`${s.base}/wizard/thread-seen`, send('PUT', { initializedAt: 1000, threads: { [`direct:${CANARY}`]: record(1_000_000) } }, OWNER))).status).toBe(200)
    expect(await count()).toBe(before)
    const own = (await (await fetch(`${s.base}/wizard/thread-seen`, { headers: OWNER })).json()).state
    expect(Object.keys(own.threads)).toContain(`agent/${s.privateId}/direct:${CANARY}`)
    // A caller still cannot send more than 500 marks at once.
    const tooMany = { initializedAt: 0, threads: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`direct:wizard_many_${i}`, record(i + 1)])) }
    expect((await fetch(`${s.base}/wizard/thread-seen`, send('PUT', tooMany))).status).toBe(400)
  })

  it('S2c: an unlisted private thread cannot be claimed by another caller, and its owner can still list it', async () => {
    const s = await scene()
    s.priv.known.add('wizard_private_unlisted')
    const claimed = await fetch(`${s.base}/wizard/hermes/v1/runs`, send('POST', { input: 'x', session_id: 'wizard_private_unlisted', agent: s.helperId }))
    expect(claimed.status).toBe(404)
    expect(s.helper.seen.filter(row => row.method === 'POST' && row.path === '/v1/runs')).toEqual([])
    const list = await fetch(`${s.base}/wizard/hermes/api/sessions?agent=${s.privateId}`, { headers: OWNER })
    expect(list.status).toBe(200)
    expect(await list.text()).toContain(CANARY)
  })

  it('second review: a non-owner cannot push out or reset the owner\'s private seen marks', async () => {
    const s = await scene()
    const record = (seenAt: number) => ({ updatedAt: new Date(seenAt).toISOString(), previewFingerprint: 'abc', seenAt })
    const ownerPut = await fetch(`${s.base}/wizard/thread-seen`, send('PUT', { initializedAt: 1000, threads: { [`direct:${CANARY}`]: record(2000) } }, OWNER))
    expect(ownerPut.status).toBe(200)
    const flood = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`direct:wizard_flood_${i}`, record(10_000 + i)]))
    expect((await fetch(`${s.base}/wizard/thread-seen`, send('PUT', { initializedAt: 0, threads: flood }))).status).toBe(200)
    const state = (await (await fetch(`${s.base}/wizard/thread-seen`, { headers: OWNER })).json()).state
    expect(state.initializedAt).toBe(1000)
    expect(Object.keys(state.threads)).toContain(`agent/${s.privateId}/direct:${CANARY}`)
    // Visible marks keep their cap of 500; the owner's hidden marks sit beside them.
    expect(Object.keys(state.threads).filter((key) => key !== `agent/${s.privateId}/direct:${CANARY}`).length).toBeLessThanOrEqual(500)
  })

  it('the agent-only listener needs an agent credential on every request and never honours the owner proof', async () => {
    const s = await scene()
    const svc = servers.find((server) => `http://127.0.0.1:${(server.address() as any)?.port}` === s.base)!
    // The helper runs in the restricted runtime: its edge connects from its own uplink /28.
    const recordPath = join(s.dir, 'agents', s.helperId, 'agent.json')
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    record.runtime = { ...record.runtime, isolation: 'restricted', network: { uplink: '127.0.0.0/28', sandbox: '127.0.1.0/28' } }
    writeFileSync(recordPath, JSON.stringify(record))
    const ingress = createAgentIngress(svc, s.helperId)
    servers.push(ingress)
    const socketPath = join(s.dir, 'test-gateway.sock')
    await new Promise<void>(resolve => ingress.listen(socketPath, resolve))
    const call = (path: string, headers: Record<string, string>, { method = 'GET' } = {}) => new Promise<{ status: number, body: string }>((resolvePromise, reject) => {
      const req = httpRequest({ socketPath, path, method, headers }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
    for (const headers of [{}, OWNER, { Authorization: 'Bearer fixture-key' }, { Authorization: 'Bearer not-a-key' }]) {
      for (const path of ['/wizard/hermes/api/sessions', `/wizard/hermes/api/sessions?agent=${s.privateId}`, '/wizard/v1/agents', '/wizard/health', '/wizard/v1/agent-context', '/wizard/mcp']) {
        const response = await call(path, headers)
        expect([path, Object.keys(headers).join(), response.status]).toEqual([path, Object.keys(headers).join(), 401])
      }
    }
    const helper = { Authorization: `Bearer ${s.helperKey}` }
    // Passes the listener (this scene runs without the app bridge, so the route itself answers 404).
    const allowed = await call('/wizard/v1/agent-context', helper)
    expect([401, 403]).not.toContain(allowed.status)
    expect(allowed.body).not.toContain('principal.')
    // Only the app gateway and the agent's own context are served here.
    for (const path of [`/wizard/hermes/api/sessions?agent=${s.helperId}`, '/wizard/hermes/api/sessions', '/wizard/v1/agents', '/wizard/health']) {
      const response = await call(path, helper)
      expect([path, response.status, JSON.parse(response.body).check]).toEqual([path, 403, 'principal.agent_scope'])
    }
    expect((await call('/wizard/v1/agent-context', helper, { method: 'POST' })).status).toBe(403)
    // Network data is no longer authority. A token is accepted only on its own receiving socket.
    const main = await fetch(`${s.base}/wizard/v1/agent-context`, { headers: helper })
    expect([main.status, (await main.json()).check]).toEqual([403, 'principal.agent_socket'])
    writeFileSync(recordPath, JSON.stringify({ ...record, runtime: { ...record.runtime, network: { uplink: 'not-a-subnet' } } }))
    expect((await call('/wizard/v1/agent-context', helper)).status).not.toBe(403)
    const broken = await fetch(`${s.base}/wizard/v1/agent-context`, { headers: helper })
    expect([broken.status, (await broken.json()).check]).toEqual([403, 'principal.agent_socket'])
    const other = await call('/wizard/v1/agent-context', { Authorization: `Bearer ${s.privateKey}` })
    expect([other.status, JSON.parse(other.body).check]).toEqual([403, 'principal.agent_socket'])
  })

})

describe('principal resolver', () => {
  it('compares secrets in constant time regardless of length and rejects empties', () => {
    expect(sameSecret(PROOF, PROOF)).toBe(true)
    expect(sameSecret(`${PROOF}x`, PROOF)).toBe(false)
    expect(sameSecret('', PROOF)).toBe(false)
    expect(sameSecret(PROOF, '')).toBe(false)
  })

  it('strict once a proof is configured; a box-only install without one keeps the box as owner', async () => {
    const request = (headers: Record<string, string>) => ({ headers }) as any
    const strict = createPrincipalResolver({ ownerProof: PROOF, requireAccess: false })
    expect((await strict.resolve(request({}))).kind).toBe('anonymous')
    expect((await strict.resolve(request({ 'tailscale-user-login': 'owner@example.com' }))).kind).toBe('anonymous')
    expect((await strict.resolve(request({ 'x-wizard-owner-proof': PROOF }))).kind).toBe('owner')
    const boxOnly = createPrincipalResolver({ requireAccess: false, agentForToken: (t: string) => (t === 'k'.repeat(40) ? 'helper' : '') })
    expect((await boxOnly.resolve(request({}))).kind).toBe('owner')
    expect(await boxOnly.resolve(request({ authorization: `Bearer ${'k'.repeat(40)}` }))).toEqual({ kind: 'agent', agentId: 'helper' })
    expect(() => createPrincipalResolver({ ownerProof: 'short' })).toThrow()
  })

  it('with a proof configured, header-based access verifiers never make the owner', async () => {
    const request = (headers: Record<string, string>) => ({ headers }) as any
    const resolver = createPrincipalResolver({ ownerProof: PROOF, requireAccess: true, accessVerified: async () => true })
    expect((await resolver.resolve(request({ 'tailscale-user-login': 'owner@example.com' }))).kind).toBe('anonymous')
    expect((await resolver.resolve(request({ 'x-wizard-owner-proof': PROOF }))).kind).toBe('owner')
    expect((await resolver.resolve(markAgentIngress(request({ 'x-wizard-owner-proof': PROOF })))).kind).toBe('refused')
  })
})
