// Round 10: the sealed private runtime's scoped app gateway (synthetic Mizel), wizard-os spec/AGENTS.md 5-6.
// The sealed agent reaches /wizard/mcp only through its own Unix socket (edge sidecar); its token is refused on TCP.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { RESTRICTED_GATEWAY_URL, hermesConfigYaml, sealedGateway } from '../server/agents.mjs'

const servers: Server[] = []
const exec = promisify(execFile)
const dockerGateways = new Map<string, string>()
const dockerCleanup: string[][] = []
const fixtureDirs: string[] = []
afterEach(async () => {
  dockerGateways.clear()
  for (const args of dockerCleanup.splice(0).reverse()) await exec('docker', args).catch(() => {})
})
async function containerGateway(socket: string, token: string, dir: string) {
  if (process.env.R11_DOCKER_GATEWAY !== '1') return
  // Docker -v silently creates a missing source directory. Never turn a failed
  // Service bootstrap into an edge 502 by mounting that empty directory.
  expect(Buffer.byteLength(socket), 'host Unix socket path exceeds Service limit').toBeLessThanOrEqual(103)
  expect(lstatSync(socket).isSocket(), 'Service must bind before the edge starts').toBe(true)
  const name = `r11-gateway-${process.pid}`
  const image = process.env.R11_GATEWAY_IMAGE || 'restricted-agent-sidecars:round11'
  const owner = `wizard.qa.round11=${(process.env.R11_SOURCE_HEAD || 'local').slice(0, 12)}`
  await exec('docker', ['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.inhibit_ipv4=true', '--label', owner, name])
  dockerCleanup.push(['network', 'rm', name])
  // Same synthetic owner uid: Unix inode permissions remain part of the test.
  const uid = process.getuid!(), gid = process.getgid!()
  await exec('docker', ['run', '-d', '--name', name, '--label', owner, '--network', name, '--network-alias', 'edge',
    '--user', `${uid}:${gid}`, '--read-only', '--tmpfs', '/tmp', '--log-driver', 'none',
    '--tmpfs', `/run/edge-ingress:uid=${uid},gid=${gid},mode=0700`,
    '-v', `${dirname(socket)}:/run/agent-gateway:rw`,
    '-e', 'EDGE_INGRESS_SOCKET=/run/edge-ingress/ingress.sock',
    '-e', `EDGE_TOKEN_SHA256=${createHash('sha256').update(token).digest('hex')}`, image, 'python3', '/srv/edge.py'])
  dockerCleanup.push(['rm', '-f', name])
  const client = `${name}-client`
  await exec('docker', ['run', '-d', '--name', client, '--label', owner, '--network', name,
    '--read-only', '--log-driver', 'none', 'python:3.12-slim', 'python3', '-c', 'import time;time.sleep(1200)'])
  dockerCleanup.push(['rm', '-f', client])
  dockerGateways.set(socket, client)
}
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r(undefined))) }
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
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
  const client = dockerGateways.get(path)
  if (client) return (async () => {
    const code = `import urllib.request,urllib.error,json,time
v=json.loads(${JSON.stringify(JSON.stringify({ token, body, session }))})
r=urllib.request.Request('http://edge:8923/wizard/mcp',json.dumps(v['body']).encode(),{'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':'Bearer '+v['token'],**({'Mcp-Session-Id':v['session']} if v['session'] else {})})
for i in range(30):
 try:
  try: h=urllib.request.urlopen(r,timeout=10)
  except urllib.error.HTTPError as e: h=e
  raw=h.read();print(json.dumps({'status':h.status,'json':json.loads(raw) if raw else None,'session':h.headers.get('mcp-session-id','')}));break
 except (OSError,ValueError):
  if i==29:raise
  time.sleep(.2)
`
    const result = await exec('docker', ['exec', client, 'python3', '-c', code])
    return JSON.parse(result.stdout)
  })()
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

describe('sealed private agent scoped gateway (synthetic Mizel + Recorder)', () => {
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

  it('Mizel and Recorder tools reach the sealed agent only on its socket; other apps and TCP are refused', async () => {
    const mizel = await fakeApp('search_meetings', 'SYNTHETIC-MIZEL-R10')
    const notes = await fakeApp('note_add', 'SYNTHETIC-NOTES')
    const recorder = await fakeApp('search_recordings', 'SYNTHETIC-RECORDER-R10')
    const dir = mkdtempSync(join(tmpdir(), 'r10-sealed-gw-'))
    fixtureDirs.push(dir)
    expect(Buffer.byteLength(join(dir, 'agents', 'sealed', 'gateway', 'gateway.sock')), 'short TMPDIR required').toBeLessThanOrEqual(103)
    mkdirSync(join(dir, 'agents'), { recursive: true })
    writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [appEntry('mizel', mizel.url), appEntry('notes', notes.url), appEntry('recorder', recorder.url)] }))
    const upstream = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url === '/api/model/options' ? { providers: [] } : { data: [] })) })
    servers.push(upstream)
    const up = await listen(upstream) as import('node:net').AddressInfo
    const applied: string[] = []
    const runtime = { apply: async (id: string) => { applied.push(id); return { ok: true } }, start: async () => ({ ok: true }), stop: async () => ({ ok: true }) }
    const svc = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${up.port}`, hermesKey: 'fixture-key', requireAccess: false,
      appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir, agentRuntime: runtime,
      followThrough: false, agentBasePort: 47850, mcpToken: 'main-gw-fixture', bridgeWatchMs: 0, bridgeWriteSkills: false,
      agentGatewayUrl: 'http://wizard-agent-service:8923/wizard/mcp', bridgeLog: () => {} })
    servers.push(svc)
    await svc.agentSocketsReady
    const address = await listen(svc) as import('node:net').AddressInfo
    const base = `http://127.0.0.1:${address.port}`
    const json = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const created = await (await fetch(`${base}/wizard/v1/agents`, json({ label: 'Sealed', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }))).json()
    const id = created.agent.id
    const file = join(dir, 'agents', id, 'agent.json')
    const stored = JSON.parse(readFileSync(file, 'utf8')); stored.runtime = { ...stored.runtime, ...SEALED }; writeFileSync(file, JSON.stringify(stored))
    const appliesBeforePatch = applied.length
    // The owner ticks Mizel for this agent; the update rewrites the harness and prepares its socket.
    const ticked = await fetch(`${base}/wizard/v1/agents/${id}`, json({ permissions: { wizard_apps: ['mizel', 'recorder'] } }, 'PATCH'))
    expect(ticked.status).toBe(200)
    const updated = await ticked.json()
    expect(applied.length, `socket bootstrap prevented runtime.apply: ${JSON.stringify(updated)}`).toBe(appliesBeforePatch + 1)
    const home = join(dir, 'agents', id, 'home')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('http://edge:8923/wizard/mcp')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('wizard-agent-service')
    expect(readFileSync(join(home, '.env'), 'utf8')).not.toMatch(/TINFOIL_API_KEY/)
    const token = readFileSync(join(dir, 'agents', id, 'gateway.key'), 'utf8').trim()
    const socket = join(dir, 'agents', id, 'gateway', 'gateway.sock')
    expect(lstatSync(socket).isSocket()).toBe(true)
    expect(lstatSync(socket).uid).toBe(process.getuid!())
    expect(lstatSync(socket).mode & 0o777).toBe(0o600)
    await containerGateway(socket, token, dir)
    const listed = await socketMcp(socket, token, 'tools/list')
    expect(listed.status).toBe(200)
    expect(listed.json.result.tools.map((t: any) => t.name).sort()).toEqual(['mizel__search_meetings', 'recorder__search_recordings', 'wizard_apps'])
    const called = await socketMcp(socket, token, 'tools/call', { name: 'mizel__search_meetings', arguments: {} })
    expect(called.json.result.content[0].text).toBe('SYNTHETIC-MIZEL-R10')
    const rec = await socketMcp(socket, token, 'tools/call', { name: 'recorder__search_recordings', arguments: {} })
    expect(rec.json.result.content[0].text).toBe('SYNTHETIC-RECORDER-R10')
    const refused = await socketMcp(socket, token, 'tools/call', { name: 'notes__note_add', arguments: {} })
    expect(refused.json.result.isError).toBe(true)
    expect(notes.calls).toEqual([])
    // The same credential over TCP (any generic Service route) is not an agent principal.
    const tcp = await fetch(`${base}/wizard/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) })
    expect(tcp.status).not.toBe(200)
    expect(mizel.calls).toEqual(['search_meetings'])
    expect(recorder.calls).toEqual(['search_recordings'])
    // A session admitted before revocation is not a cached capability.
    const stale = await viaSocket(socket, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect((await fetch(`${base}/wizard/v1/agents/${id}`, json({ permissions: { wizard_apps: [] } }, 'PATCH'))).status).toBe(200)
    const revoked = await viaSocket(socket, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mizel__search_meetings', arguments: {} } }, stale.session)
    expect(revoked.status !== 200 || !!revoked.json?.error || revoked.json?.result?.isError === true).toBe(true)
    expect(mizel.calls).toEqual(['search_meetings'])
  }, 120000)
})
