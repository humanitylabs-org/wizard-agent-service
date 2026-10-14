import { afterEach, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { createTailnetAccessVerifier } from '../server/tailnet-access.mjs'

const origin = 'https://fixture.tail1234.ts.net:8445'
const host = 'fixture.tail1234.ts.net:8445'
const login = 'fixture-owner@example.invalid'
const owner = { host, 'tailscale-user-login': login }
const children: ChildProcess[] = [], dirs: string[] = [], servers: Server[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    await new Promise<void>(done => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.once('exit', () => { clearTimeout(timer); done() })
      child.kill('SIGTERM')
    })
  }
  await Promise.all(servers.splice(0).map(s => new Promise<void>(done => s.close(() => done()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function start(env: Record<string, string> = {}, failure = false) {
  // Real index.mjs process, with no inherited HOME, secrets or production origins.
  const dir = mkdtempSync(join(tmpdir(), 'auth-runtime-')); dirs.push(dir)
  const probe = createServer()
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done))
  const port = (probe.address() as any).port
  await new Promise<void>(done => probe.close(() => done()))
  const child = spawn(process.execPath, [resolve('server/index.mjs')], {
    env: { PATH: process.env.PATH!, HOME: dir, TMPDIR: dir, CI: '1',
      WIZARD_HERMES_API_KEY: 'fixture-only-not-a-secret', WIZARD_HOST: '127.0.0.1', WIZARD_PORT: String(port),
      HERMES_ORIGIN: 'http://127.0.0.1:9', WIZARD_HELM_ORIGIN: 'http://127.0.0.1:9',
      WIZARD_STT_ORIGIN: 'http://127.0.0.1:9', WIZARD_INBOX_ORIGIN: 'http://127.0.0.1:9',
      WIZARD_FOLLOW_THROUGH: 'off', WIZARD_AGENT_BRIDGE: 'off', WIZARD_UX_API_COMPAT: '1',
      WIZARD_ACCESS_TEAM_DOMAIN: 'fixture.cloudflareaccess.com', WIZARD_ACCESS_AUDIENCE: 'fixture-audience', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout!.on('data', b => { output += b }); child.stderr!.on('data', b => { output += b })
  await expect.poll(() => output.includes('Wizard listening') || child.exitCode !== null, { timeout: 5000 }).toBe(true)
  if (env.WIZARD_TAILNET_PORT && !failure) await expect.poll(() => output.includes('Wizard tailnet listener'), { timeout: 5000 }).toBe(true)
  if (failure) {
    expect(output).not.toContain('Wizard listening')
    expect(child.exitCode).not.toBe(0)
  } else {
    expect(output).toContain('Wizard listening')
    expect(child.exitCode).toBeNull()
  }
  return { port, output }
}
function call(port: number, path = '/wizard/v1/apps', headers: Record<string, string> = {}, method = 'GET', body = '') {
  return new Promise<{ status: number, body: string }>((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      let data = ''; res.on('data', b => { data += b }); res.on('end', () => done({ status: res.statusCode!, body: data }))
    })
    req.on('error', reject); req.end(body)
  })
}
it.each([
  [{}, 403], [{ WIZARD_REQUIRE_CF_ACCESS: '1' }, 403], [{ WIZARD_REQUIRE_CF_ACCESS: '0' }, 200],
  [{ WIZARD_AUTH_MODE: 'none', WIZARD_REQUIRE_CF_ACCESS: '1', WIZARD_TAILNET_ORIGIN: 'invalid-unused' }, 200],
  [{ WIZARD_AUTH_MODE: 'cloudflare', WIZARD_REQUIRE_CF_ACCESS: '0', WIZARD_TAILNET_ORIGIN: origin }, 403],
])('preserves default/legacy/explicit environment precedence: %j', async (env, status) => {
  const { port } = await start(env as Record<string, string>)
  expect((await call(port, '/wizard/v1/apps', owner)).status).toBe(status)
})
it.each(['explicit', 'origin-opt-in'])('enforces Tailscale through the real entry point (%s)', async mode => {
  const { port } = await start({ ...(mode === 'explicit' ? { WIZARD_AUTH_MODE: 'tailscale' } : {}),
    WIZARD_REQUIRE_CF_ACCESS: '0', WIZARD_TAILNET_ORIGIN: origin, WIZARD_TAILNET_LOGIN: login })
  expect((await call(port, '/wizard/v1/apps', owner)).status).toBe(200)
  for (const headers of [{ host }, { ...owner, 'tailscale-user-login': 'nonowner@example.invalid' },
    { ...owner, host: 'attacker.example' }, { ...owner, origin: 'https://attacker.example' },
    { ...owner, 'sec-fetch-site': 'cross-site' }, { host, 'cf-access-jwt-assertion': 'invented' }]) {
    expect((await call(port, '/wizard/v1/apps', headers)).status).toBe(403)
  }
  // No internal-header exemption. Browser/native mutations must meet the same auth boundary.
  for (const path of ['/wizard/hermes/v1/runs', '/wizard/helper-continue', '/wizard/v1/route',
    '/wizard-os-home/api/route', '/wizard-os-home/api/transcribe']) {
    for (const headers of [owner, { ...owner, origin: 'https://attacker.example' },
      { host, origin, 'x-wizard-internal': 'follow-through' }]) {
      expect((await call(port, path, { ...headers, 'content-type': 'application/json' }, 'POST', '{}')).status).toBe(403)
    }
  }
  const allowed = await call(port, '/wizard-os-home/api/route', { ...owner, origin, 'content-type': 'application/json' }, 'POST', '{}')
  expect(allowed.status).toBe(404)
  expect(allowed.body).toContain('router_not_configured')
})
it.each([
  { WIZARD_AUTH_MODE: 'invalid' },
  { WIZARD_AUTH_MODE: 'tailscale', WIZARD_TAILNET_ORIGIN: origin },
  { WIZARD_AUTH_MODE: 'tailscale', WIZARD_TAILNET_LOGIN: login },
  { WIZARD_TAILNET_PORT: 'abc' }, { WIZARD_TAILNET_PORT: '0' },
  { WIZARD_AUTH_MODE: 'tailscale', WIZARD_TAILNET_ORIGIN: 'http://fixture.tail1234.ts.net', WIZARD_TAILNET_LOGIN: login },
])('fails startup closed for invalid auth configuration: %j', async env => {
  await start(env, true)
})
it('rejects a real untrusted socket peer despite forged forwarding headers', async () => {
  const accessVerifier = createTailnetAccessVerifier({ origin, logins: login, proxyPeers: ['192.0.2.44'] })
  const server = createWizardServer({ requireAccess: true, accessVerifier, agentBridge: false, followThrough: false })
  servers.push(server); const address = await listen(server)
  const result = await call(address.port, '/wizard/v1/apps', { ...owner, 'x-forwarded-for': '192.0.2.44',
    forwarded: 'for=192.0.2.44', 'x-real-ip': '192.0.2.44', 'x-wizard-internal': 'follow-through' })
  expect(result.status).toBe(403)
})
it('preserves the authenticated box-only MCP route but never exposes it through tailnet identity', async () => {
  const accessVerifier = createTailnetAccessVerifier({ origin, logins: login })
  const dir = mkdtempSync(join(tmpdir(), 'auth-mcp-')); dirs.push(dir)
  const server = createWizardServer({ requireAccess: true, accessVerifier, mcpToken: 'fixture-mcp', wizardOsHome: dir,
    appsJsonPath: join(dir, 'apps.json'),
    bridgeWriteSkills: false, bridgeWatchMs: 0, followThrough: false })
  servers.push(server); const address = await listen(server)
  const headers = { authorization: 'Bearer fixture-mcp', 'content-type': 'application/json' }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } })
  expect((await call(address.port, '/wizard/mcp', headers, 'POST', body)).status).toBe(200)
  expect((await call(address.port, '/wizard/mcp', { ...headers, ...owner }, 'POST', body)).status).toBe(403)
})

async function freePort() {
  const probe = createServer()
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done))
  const port = (probe.address() as any).port
  await new Promise<void>(done => probe.close(() => done()))
  return port
}
it('tailscale mode without env names reads settings per request and refuses until enrollment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-settings-')); dirs.push(dir)
  const settings = join(dir, 'settings.json')
  const { port } = await start({ WIZARD_AUTH_MODE: 'tailscale', WIZARD_SETTINGS_PATH: settings, WIZARD_PRIVATE_ACCESS_SOCKET: join(dir, 'none.sock') })
  expect((await call(port, '/wizard/v1/apps', owner)).status).toBe(403)
  writeFileSync(settings, JSON.stringify({ access: { tailscale: { origin, owner_logins: [login] } } }))
  expect((await call(port, '/wizard/v1/apps', owner)).status).toBe(200)
  expect((await call(port, '/wizard/v1/apps', { ...owner, 'tailscale-user-login': 'nonowner@example.invalid' })).status).toBe(403)
  expect((await call(port, '/wizard/v1/apps', { ...owner, host: 'attacker.example' })).status).toBe(403)
  expect((await call(port, '/wizard/v1/setup/seen', { ...owner, origin: 'https://attacker.example', 'content-type': 'application/json' }, 'POST', '{}')).status).toBe(403)
  expect((await call(port, '/wizard/v1/setup/seen', { ...owner, origin, 'content-type': 'application/json' }, 'POST', '{}')).status).toBe(200)
})
it('the Serve listener (WIZARD_TAILNET_PORT) verifies the owner while the box-local listener stays open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-tailnet-')); dirs.push(dir)
  const settings = join(dir, 'settings.json')
  const tailnetPort = await freePort()
  const ux = join(dir, 'ux'); mkdirSync(ux); writeFileSync(join(ux, 'index.html'), '<html>shell</html>')
  const { port } = await start({ WIZARD_AUTH_MODE: 'none', WIZARD_TAILNET_PORT: String(tailnetPort), WIZARD_SETTINGS_PATH: settings,
    WIZARD_PRIVATE_ACCESS_SOCKET: join(dir, 'none.sock'), WIZARD_UX_DIR: ux })
  // Box-local (Mac app / local proxy) path: unchanged, owner implied.
  expect((await call(port, '/wizard/v1/apps')).status).toBe(200)
  expect((await call(port, '/wizard/v1/setup')).status).toBe(200)
  expect((await call(port, '/wizard/v1/setup/phone')).body).toContain('"step":"unavailable"')
  // Serve listener: nothing before enrollment, not even the owner, and never the local proxy's fake identity.
  expect((await call(tailnetPort, '/wizard/v1/apps', owner)).status).toBe(403)
  expect((await call(tailnetPort, '/wizard/v1/apps', { host: '127.0.0.1', 'tailscale-user-login': 'owner@wizard.local' })).status).toBe(403)
  writeFileSync(settings, JSON.stringify({ access: { tailscale: { origin, owner_logins: [login] } } }))
  expect((await call(tailnetPort, '/wizard/v1/apps', owner)).status).toBe(200)
  for (const headers of [{ host }, { ...owner, 'tailscale-user-login': 'nonowner@example.invalid' }, { ...owner, host: 'attacker.example' },
    { ...owner, origin: 'https://attacker.example' }, { host: '127.0.0.1', 'tailscale-user-login': 'owner@wizard.local' }]) {
    expect((await call(tailnetPort, '/wizard/v1/apps', headers)).status).toBe(403)
  }
  for (const path of ['/wizard/v1/setup/phone/reset', '/wizard/hermes/v1/runs', '/wizard/v1/route']) {
    expect((await call(tailnetPort, path, { ...owner, 'content-type': 'application/json' }, 'POST', '{}')).status).toBe(403)
    expect((await call(tailnetPort, path, { ...owner, origin: 'https://attacker.example', 'content-type': 'application/json' }, 'POST', '{}')).status).toBe(403)
  }
  expect((await call(port, '/wizard/v1/apps')).status).toBe(200)
  // Opening the shared address from another app: a top-level document navigation to an entry page only.
  const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  expect((await call(tailnetPort, '/', { ...owner, ...nav })).status).toBe(302)
  const entry = await call(tailnetPort, '/wizard-os-home/', { ...owner, ...nav })
  expect(entry.status).toBe(200)
  expect(entry.body).toContain('<html>shell</html>')
  expect((await call(tailnetPort, '/wizard/v1/apps', { ...owner, ...nav })).status).toBe(403)
  expect((await call(tailnetPort, '/', { ...owner, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status).toBe(403)
})
