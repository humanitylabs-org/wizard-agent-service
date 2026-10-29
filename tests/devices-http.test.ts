import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWizardServer, createTailnetIngress } from '../server/service.mjs'

const session = { manufacturer: 'Google', model: 'Pixel 10 Pro XL', sdk: 37, appVersion: '0.10.18', versionCode: 82, webviewPackage: 'app.vanadium.webview', webviewVersion: '156.0.8078.47.0', id: 'discard', accessibilityServices: ['discard'] }
const owner = { 'x-wizard-owner-proof': 'fixture-owner-proof-for-devices-32chars' }
const servers: any[] = []
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devices-'))
  for (const name of ['HOME', 'HERMES_HOME', 'WIZARD_OS_HOME']) { const dir = join(root, name); mkdirSync(dir); vi.stubEnv(name, dir) }
})
afterEach(async () => {
  for (const s of servers.splice(0).reverse()) await new Promise<void>(resolve => s.close(() => resolve()))
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
async function listen(server: any) {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
async function stack(extra = {}) {
  const seen: any[] = []
  const upstream = await listen(createServer(async (req, res) => {
    const parts = []; for await (const p of req) parts.push(p)
    seen.push({ url: req.url, body: Buffer.concat(parts).toString(), headers: req.headers })
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('existing diagnostics response')
  }))
  const appsJsonPath = join(root, 'apps.json'); writeFileSync(appsJsonPath, '{"apps":[]}')
  const verifier = Object.assign(async (req: any) => req.headers['x-fixture-owner'] === 'yes' ? { email: 'owner@example.test' } : null, { fromRequest: true })
  const server = createWizardServer({ requireAccess: false, ownerProof: owner['x-wizard-owner-proof'], upstreamOrigin: 'http://127.0.0.1:9',
    tailnetVerifier: verifier, tailnetShellOrigin: upstream, appsJsonPath, wizardOsHome: root, mcpToken: 'fixture-devices-gateway', bridgeWriteSkills: false,
    devicesStatePath: join(root, 'devices.json'), requireJoinedDelegationCapability: false, followThrough: false, ...extra })
  const base = await listen(server)
  const tailnet = await listen(createTailnetIngress(server))
  return { base, tailnet, seen }
}
const post = (body: string, headers: Record<string, string> = owner) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body })

it('intercept records owner session metadata and still forwards the exact body and upstream 404', async () => {
  const s = await stack({ uxPrefix: 'custom-shell' })
  const body = JSON.stringify({ session, events: [{ secret: 'must-not-store' }] })
  for (const prefix of ['wizard-os-home', 'wizard-ux', 'custom-shell']) {
    const response = await fetch(`${s.base}/${prefix}/api/diagnostics/scroll-capture?fixture=1`, post(body))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('existing diagnostics response')
    expect(s.seen.at(-1).body).toBe(body)
    expect(s.seen.at(-1).headers['content-type']).toBe('application/json')
    expect(s.seen.at(-1).headers['x-wizard-owner-proof']).toBeUndefined()
  }
  const response = await fetch(`${s.base}/wizard/v1/devices`, { headers: owner })
  expect(response.status).toBe(200)
  expect((await response.json()).devices).toEqual([expect.objectContaining({ model: session.model, report_count: 3 })])
  const stored = readFileSync(join(root, 'devices.json'), 'utf8')
  for (const omitted of ['events', 'accessibilityServices', 'must-not-store', 'discard']) expect(stored).not.toContain(omitted)
})

it('rejects unauthenticated requests, and records verified tailnet owners', async () => {
  const s = await stack()
  const path = '/wizard-os-home/api/diagnostics/scroll-capture'
  expect((await fetch(`${s.base}${path}`, post(JSON.stringify({ session }), {}))).status).toBe(403)
  expect((await fetch(`${s.tailnet}${path}`, post(JSON.stringify({ session }), {}))).status).toBe(403)
  expect((await fetch(`${s.base}/wizard/v1/devices`)).status).toBe(403)
  expect(s.seen).toHaveLength(0)
  expect((await (await fetch(`${s.base}/wizard/v1/devices`, { headers: owner })).json()).devices).toEqual([])
  const res = await fetch(`${s.tailnet}${path}`, post(JSON.stringify({ session }), { 'x-fixture-owner': 'yes' } as any))
  expect(res.status).toBe(404)
  expect(s.seen).toHaveLength(1)
  expect((await (await fetch(`${s.base}/wizard/v1/devices`, { headers: owner })).json()).devices).toHaveLength(1)
})

it('keeps forwarding malformed reports and tolerates recording failure; bounds the body', async () => {
  const s = await stack({ devicesStatePath: join(root, 'apps.json', 'impossible.json') })
  const path = `${s.base}/wizard-os-home/api/diagnostics/scroll-capture`
  for (const body of ['not-json', JSON.stringify({ session })]) {
    const res = await fetch(path, post(body)); expect(res.status).toBe(404)
    expect(await res.text()).toBe('existing diagnostics response')
    expect(s.seen.at(-1).body).toBe(body)
  }
  expect((await fetch(path, post('x'.repeat(256 * 1024 + 1)))).status).toBe(413)
  expect(s.seen).toHaveLength(2)
})

it('lets a container agent read the builtin but never count its requests as phone check-ins', async () => {
  const s = await stack({
    fetchImpl: async () => new Response(JSON.stringify({ providers: [{ slug: 'anthropic', models: ['claude-opus-5-5'], authenticated: true }] }), { headers: { 'content-type': 'application/json' } }),
    agentRuntime: { apply: async () => ({ ok: true }) },
  })
  const created = await fetch(`${s.base}/wizard/v1/agents`, post(JSON.stringify({ label: 'Helper', harness: 'hermes', model: { provider: 'anthropic', model: 'claude-opus-5-5' }, permissions: { preset: 'standard' } })))
  expect(created.status).toBe(201)
  const id = (await created.json()).agent.id
  const token = readFileSync(join(root, 'agents', id, 'gateway.key'), 'utf8').trim()
  const auth = { authorization: `Bearer ${token}` }
  expect((await fetch(`${s.base}/wizard-os-home/api/diagnostics/scroll-capture`, post(JSON.stringify({ session }), auth))).status).toBe(403)
  expect((await fetch(`${s.base}/wizard/v1/devices`, { headers: auth })).status).toBe(403)
  expect(s.seen).toHaveLength(0)
  const rpc = async (method: string, params = {}) => (await (await fetch(`${s.base}/wizard/mcp`, post(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), auth))).json()).result
  expect((await rpc('tools/list')).tools.map((t: any) => t.name)).toContain('wizard_devices')
  expect((await rpc('tools/call', { name: 'wizard_devices' })).content[0].text).toContain('No phones have checked in yet.')
  await fetch(`${s.base}/wizard-os-home/api/diagnostics/scroll-capture`, post(JSON.stringify({ session })))
  expect((await rpc('tools/call', { name: 'wizard_devices' })).content[0].text).toContain('Google Pixel 10 Pro XL')
})

it('lists and calls wizard_devices through the main gateway without adding it to the kernel', async () => {
  const s = await stack()
  const rpc = async (method: string, params = {}) => (await (await fetch(`${s.base}/wizard/mcp`, post(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), { authorization: 'Bearer fixture-devices-gateway' } as any))).json()).result
  expect((await rpc('tools/list')).tools.map((t: any) => t.name)).toContain('wizard_devices')
  expect((await rpc('tools/call', { name: 'wizard_devices' })).content[0].text).toContain('No phones have checked in yet.')
  await fetch(`${s.base}/wizard-os-home/api/diagnostics/scroll-capture`, post(JSON.stringify({ session })))
  expect((await rpc('tools/call', { name: 'wizard_devices', arguments: {} })).content[0].text).toContain('Google Pixel 10 Pro XL (Android SDK 37): Wizard OS 0.10.18 (code 82), WebView app.vanadium.webview 156.0.8078.47.0')
})
