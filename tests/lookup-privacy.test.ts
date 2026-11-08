// AI Look up privacy follows the SESSION's pinned agent on the server, whatever agent the caller claims.
// Helpers copied from tests/agents.test.ts (a stock-shaped fake Hermes + a registry-backed service).
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { standardChatRpc, searchHistory, readHistory } from '../server/standard-chats.mjs'
import { privateChatMatches } from '../server/private-chat-search.mjs'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { agentVisionHelper, createAgentRegistry, claudeModelId, hermesConfigYaml, normalizeMemory, parseAgentFile } from '../server/agents.mjs'
import { readApps } from '../server/wizard-os-settings.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

type Seen = { method: string, path: string, auth: string, body: any }

async function readBody(req: IncomingMessage) {
  let raw = ''
  for await (const c of req) raw += c
  return raw ? JSON.parse(raw) : undefined
}

// A stock-shaped Hermes API: sessions, runs, model options, health. Records every request.
async function fakeHermes(name: string, sessions: string[] = [], messages?: unknown[], socketPath?: string) {
  const seen: Seen[] = []
  const known = new Set(sessions)
  const rows = new Map(sessions.map(id => [id, { id, title: `${name} ${id}`, source: 'api_server', archived: false }]))
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = await readBody(req)
    seen.push({ method: req.method ?? '', path: url.pathname + url.search, auth: String(req.headers.authorization ?? ''), body })
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/v1/capabilities') return json(200, { features: {} })
    if (url.pathname === '/api/model/options') return json(200, { provider: 'anthropic', model: 'claude-opus-5-5', providers: [
      { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5', 'claude-fable-5'] },
      { slug: 'openai-codex', name: 'Codex', authenticated: true, models: ['gpt-6.1-sol'] },
      { slug: 'nous', name: 'Nous', authenticated: false, models: [] },
    ] })
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, { data: [...known].map((id) => rows.get(id)) })
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'DELETE' && sessionMatch) { const id = decodeURIComponent(sessionMatch[1]); rows.delete(id); return known.delete(id) ? json(200,{ok:true}) : json(404,{error:'not found'}) }
    if (req.method === 'GET' && sessionMatch) { const row = rows.get(decodeURIComponent(sessionMatch[1])); return row ? json(200, { session: row }) : json(404, { error: 'not found' }) }
    if (req.method === 'PATCH' && sessionMatch) { const row = rows.get(decodeURIComponent(sessionMatch[1])); if (!row) return json(404, { error: 'not found' }); Object.assign(row, body); return json(200, { session: row }) }
    if (req.method === 'GET' && /\/messages$/.test(url.pathname)) return json(200, { data: messages ?? [{ role: 'assistant', content: `${name} says hi` }] })
    if (req.method === 'POST' && url.pathname === '/api/sessions') { const id = body?.id ?? 'generated_1'; known.add(id); rows.set(id, { ...body, id, archived: false }); return json(201, { session: rows.get(id) }) }
    if (req.method === 'POST' && url.pathname === '/v1/runs') { known.add(body.session_id); const row = rows.get(body.session_id) ?? { id: body.session_id, title: name, source: 'api_server', archived: false }; row.archived = false; rows.set(body.session_id, row); return json(202, { run_id: `${name}-run-1`, status: 'started' }) }
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) return json(200, { run_id: url.pathname.split('/').at(-1), status: 'completed', output: `${name} done` })
    json(404, { error: 'nope' })
  })
  servers.push(server)
  if (socketPath) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    chmodSync(socketPath, 0o600)
    return { port: 0, origin: '', seen, known, rows }
  }
  const address = await listen(server) as import('node:net').AddressInfo
  return { port: address.port, origin: `http://127.0.0.1:${address.port}`, seen, known, rows }
}

function box() {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'))
  mkdirSync(join(dir, 'agents', 'claude-explore', 'home'), { recursive: true })   // unrelated experiment folder
  writeFileSync(join(dir, 'agents', 'claude-explore', 'notes.json'), '{"x":1}')
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [
    { id: 'meditate', name: 'Meditate', status: 'running', view: { url: '/meditate/' }, mcp: { url: 'http://127.0.0.1:1/mcp' }, summary: 'm' },
    { id: 'transcriber', name: 'Transcriber', status: 'running', mcp: { url: 'http://127.0.0.1:2/mcp' } },
    { id: 'agent-old', name: 'Old (agent)', type: 'agent', category: 'agent', status: 'running' },
  ] }))
  return dir
}

async function start(dir: string, main: { origin: string }, extra: Record<string, unknown> = {}) {
  const calls: string[] = []
  const deliveries: any[] = []
  const runtime = {
    apply: async (id: string) => {
      if (extra.agentIsolation === 'restricted') {
        const gateway = join(dir, 'agents', id, 'gateway', 'gateway.sock')
        expect(lstatSync(gateway).isSocket()).toBe(true) // transport exists before Docker sees the request
        expect(lstatSync(gateway).mode & 0o777).toBe(0o600)
      }
      calls.push(`apply ${id}`); return { ok: true }
    },
    start: async (id: string) => { calls.push(`start ${id}`); return { ok: true } },
    stop: async (id: string) => { calls.push(`stop ${id}`); return { ok: true } },
    deliver: async (id: string, payload: any) => { deliveries.push({ id, payload }); return { verified: true, already_delivered: false, session_id: payload.session_id, message_id: 3 } },
    ...(extra.runtimeFetch ? { fetch: extra.runtimeFetch } : {}),
  }
  const svc = createWizardServer({
    upstreamOrigin: main.origin, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: runtime, agentDeliveryToken: 'delivery-token-0123456789abcdef', followThrough: false,
    // Away from the default 18650, which a real agent on the test machine may hold.
    agentBasePort: 47650, ...extra,
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  return { base: `http://127.0.0.1:${address.port}`, calls, deliveries, server: svc }
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
// Explicitly off: these tests switch standard-chat reading themselves (the default-on rule has its own test).
const PRIVATE = { label: 'Private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private', read_standard_chats: false } }

// Create the private agent and point it at a fake Hermes on the port the registry assigned.
async function withPrivate(dir: string, base: string, privatePort?: number) {
  const created = await fetch(`${base}/wizard/v1/agents`, json(PRIVATE, { 'Idempotency-Key': 'create-private-1' }))
  const payload = await created.json()
  if (privatePort) {
    const file = join(dir, 'agents', payload.agent.id, 'agent.json')
    const agent = JSON.parse(readFileSync(file, 'utf8'))
    agent.runtime.port = privatePort
    writeFileSync(file, JSON.stringify(agent))
  }
  return { status: created.status, agent: payload.agent }
}


const TOKEN = 'fixture-token-not-a-secret-0123456789'
async function fakeBroker() {
  const calls: any[] = []
  const server = createServer(async (req, res) => { calls.push({ path: req.url, body: await readBody(req) }); res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end(JSON.stringify({ type: 'done', text: 'Plato describes a divine craftsman shaping the world from chaos.', model: 'claude-haiku-4-5' }) + '\n') })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, calls }
}
const body = (extra: Record<string, unknown>) => json({ text: "Plato's Timaeus", before: 'The demiurge in ', after: ' is a craftsman.', ...extra })

describe('AI Look up privacy follows the session, not the caller', () => {
  it('a private agent\'s thread is refused even with agent omitted or spoofed as main; standard threads are explained', async () => {
    const dir = box()
    const main = await fakeHermes('main', ['wizard_main_1'])
    const priv = await fakeHermes('private', ['wizard_private_9'])
    const broker = await fakeBroker()
    const { base } = await start(dir, main, { lookupEnv: { WIZARD_LOOKUP_URL: broker.url, WIZARD_LOOKUP_TOKEN: TOKEN } })
    await withPrivate(dir, base, priv.port)
    await fetch(`${base}/wizard/hermes/api/sessions?agent=private`)   // lists (and pins) the private agent's thread
    await fetch(`${base}/wizard/hermes/api/sessions`)
    const url = `${base}/wizard/v1/lookup/stream`
    for (const extra of [{ session: 'wizard_private_9' }, { session: 'wizard_private_9', agent: 'hermes' }, { session: 'wizard_private_9', agent: 'main' }, { agent: 'private' }]) {
      const r = await fetch(url, body(extra))
      expect(r.status, JSON.stringify(extra)).toBe(403); expect((await r.json()).error).toBe('private_thread')
    }
    expect(broker.calls.length).toBe(0)   // nothing left for a cloud model
    const ok = await fetch(url, body({ session: 'wizard_main_1' }))
    expect(ok.status).toBe(200); expect(await ok.text()).toContain('claude-haiku-4-5'); expect(broker.calls.length).toBe(1)
  })
})
