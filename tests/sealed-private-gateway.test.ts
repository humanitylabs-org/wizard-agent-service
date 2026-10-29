// Round 10: the sealed private runtime's scoped app gateway (synthetic Mizel), wizard-os spec/AGENTS.md 5-6.
// The sealed agent reaches /wizard/mcp only through its own Unix socket (edge sidecar); its token is refused on TCP.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { RESTRICTED_GATEWAY_URL, hermesConfigYaml, sealedGateway } from '../server/agents.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r(undefined))) } })
async function readBody(req: IncomingMessage) { let raw = ''; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : undefined }

async function fakeApp(tool: string, marker: string) {
  const calls: string[] = []
  const server = createServer(async (req, res) => {
    const msg = (await readBody(req)) ?? {}
    const send = (result: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
    if (msg.id === undefined) { res.writeHead(202); res.end(); return }
    if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: tool } })
    if (msg.method === 'tools/list') return send({ tools: [{ name: tool, description: `${tool}.`, inputSchema: { type: 'object', properties: {} } }] })
    if (msg.method === 'tools/call') { calls.push(msg.params.name); return send({ content: [{ type: 'text', text: marker }] }) }
    send({})
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls }
}
const appEntry = (id: string, url: string) => ({ id, name: id, status: 'running', provides: [`${id}-job`], mcp: { url } })

function viaSocket(path: string, token: string, body: unknown, session = '') {
  return new Promise<{ status: number, json: any, session: string }>((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request({ socketPath: path, path: '/wizard/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token, 'Content-Length': Buffer.byteLength(payload), ...(session ? { 'Mcp-Session-Id': session } : {}) } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c }); res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null, session: String(res.headers['mcp-session-id'] ?? '') }))
    })
    req.on('error', reject); req.end(payload)
  })
}
async function socketMcp(path: string, token: string, method: string, params: unknown = {}) {
  const init = await viaSocket(path, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  if (init.status !== 200) return init
  return viaSocket(path, token, { jsonrpc: '2.0', id: 2, method, params }, init.session)
}

const SEALED = { network_policy: 'tinfoil-sealed-v1', sealed_gateway: true, provider_key_location: 'provider' }

describe('sealed private agent scoped gateway (synthetic Mizel)', () => {
  it('opt-in predicate is exact and the rendered config uses the socket edge URL', () => {
    const base = { privacy: 'private', runtime: SEALED }
    expect(sealedGateway(base)).toBe(true)
    for (const bad of [{ ...base, privacy: 'standard' }, { ...base, runtime: { ...SEALED, sealed_gateway: 'true' } }, { ...base, runtime: { ...SEALED, network_policy: 'typo' } }, { privacy: 'private', runtime: {} }])
      expect(sealedGateway(bad)).toBe(false)
    const agent = { id: 'sealed', privacy: 'private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3'], fallback: false }, permissions: { preset: 'private', outside_tools: [], files: 'own', wizard_apps: ['mizel'], agent_apps: [], other_agents: 'none' }, runtime: SEALED }
    const yaml = hermesConfigYaml(agent, { gatewayUrl: RESTRICTED_GATEWAY_URL })
    expect(yaml).toContain('url: "http://edge:8923/wizard/mcp"')
    expect(yaml).toContain('fallback_providers: []')
  })

  it('Mizel tools reach the sealed agent only on its socket; other apps and TCP are refused', async () => {
    const mizel = await fakeApp('search_meetings', 'SYNTHETIC-MIZEL-R10')
    const notes = await fakeApp('note_add', 'SYNTHETIC-NOTES')
    const dir = mkdtempSync(join(tmpdir(), 'r10-sealed-gw-'))
    mkdirSync(join(dir, 'agents'), { recursive: true })
    writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [appEntry('mizel', mizel.url), appEntry('notes', notes.url)] }))
    const upstream = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url === '/api/model/options' ? { providers: [] } : { data: [] })) })
    servers.push(upstream)
    const up = await listen(upstream) as import('node:net').AddressInfo
    const runtime = { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }) }
    const svc = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${up.port}`, hermesKey: 'fixture-key', requireAccess: false,
      appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir, agentRuntime: runtime,
      followThrough: false, agentBasePort: 47850, mcpToken: 'main-gw-fixture', bridgeWatchMs: 0, bridgeWriteSkills: false,
      agentGatewayUrl: 'http://wizard-agent-service:8923/wizard/mcp', bridgeLog: () => {} })
    servers.push(svc)
    const address = await listen(svc) as import('node:net').AddressInfo
    const base = `http://127.0.0.1:${address.port}`
    const json = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const created = await (await fetch(`${base}/wizard/v1/agents`, json({ label: 'Sealed', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }))).json()
    const id = created.agent.id
    const file = join(dir, 'agents', id, 'agent.json')
    const stored = JSON.parse(readFileSync(file, 'utf8')); stored.runtime = { ...stored.runtime, ...SEALED }; writeFileSync(file, JSON.stringify(stored))
    // The owner ticks Mizel for this agent; the update rewrites the harness and prepares its socket.
    const ticked = await fetch(`${base}/wizard/v1/agents/${id}`, json({ permissions: { wizard_apps: ['mizel'] } }, 'PATCH'))
    expect(ticked.status).toBe(200)
    const home = join(dir, 'agents', id, 'home')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('http://edge:8923/wizard/mcp')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('wizard-agent-service')
    expect(readFileSync(join(home, '.env'), 'utf8')).not.toMatch(/TINFOIL_API_KEY/)
    const token = readFileSync(join(dir, 'agents', id, 'gateway.key'), 'utf8').trim()
    const socket = join(dir, 'agents', id, 'gateway', 'gateway.sock')
    for (let i = 0; i < 50; i++) { try { readFileSync(socket); } catch (e: any) { if (e.code !== 'ENOENT') break } await new Promise((r) => setTimeout(r, 20)) }
    const listed = await socketMcp(socket, token, 'tools/list')
    expect(listed.status).toBe(200)
    expect(listed.json.result.tools.map((t: any) => t.name).sort()).toEqual(['mizel__search_meetings', 'wizard_apps'])
    const called = await socketMcp(socket, token, 'tools/call', { name: 'mizel__search_meetings', arguments: {} })
    expect(called.json.result.content[0].text).toBe('SYNTHETIC-MIZEL-R10')
    const refused = await socketMcp(socket, token, 'tools/call', { name: 'notes__note_add', arguments: {} })
    expect(refused.json.result.isError).toBe(true)
    expect(notes.calls).toEqual([])
    // The same credential over TCP (any generic Service route) is not an agent principal.
    const tcp = await fetch(`${base}/wizard/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) })
    expect(tcp.status).not.toBe(200)
    expect(mizel.calls).toEqual(['search_meetings'])
  })
})
