// Local app routes (wizard-app-manager issue 629, switch wizard/local-app-routes): on a box that is not on Tailscale,
// an installed app's page opens at its Wizard path on the box's own loopback address, through this service.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createWizardServer, listen } from '../server/service.mjs'
import { routeOf, loopbackRequest, LOCAL_APP_ROUTES_SWITCH } from '../server/local-app-routes.mjs'

const servers: any[] = [], dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const home = () => { const d = mkdtempSync(join(tmpdir(), 'local-app-routes-')); dirs.push(d); return d }
const setLook = (d: string, on: boolean) => {
  mkdirSync(join(d, 'Pages', 'wizard-look'), { recursive: true })
  writeFileSync(join(d, 'Pages', 'wizard-look', 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { [LOCAL_APP_ROUTES_SWITCH]: { on, at: 1 } } }))
}

// A stand-in app on its own loopback port: echoes what it got, and answers a WebSocket handshake with one frame.
async function fakeApp() {
  const seen: any[] = []
  const app = createServer((q, r) => { seen.push({ url: q.url, headers: q.headers }); r.writeHead(200, { 'content-type': 'text/plain', 'x-app': 'yes' }); r.end(`app:${q.url}`) })
  app.on('upgrade', (q, socket) => {
    const accept = createHash('sha1').update(String(q.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.end(Buffer.from([0x81, 0x02, 0x68, 0x69])) // text frame "hi"
  })
  servers.push(app)
  await new Promise<void>(r => app.listen(0, '127.0.0.1', () => r()))
  return { port: (app.address() as any).port, seen }
}

async function start(d: string, appPort: number, extra: Record<string, unknown> = {}) {
  writeFileSync(join(d, 'apps.json'), JSON.stringify({ schema: 1, apps: [
    { id: 'wizard-search', name: 'Search', type: 'service', category: 'app', status: 'running', provides: [], view: { url: `http://127.0.0.1:${appPort}/` } },
    { id: 'files', name: 'Files', type: 'view', category: 'system', status: 'running', provides: ['files'], view: { url: `http://127.0.0.1:${appPort}/files/` } },
    { id: 'notes', name: 'Notes', type: 'view', category: 'app', status: 'running', provides: [], owner_proof: { version: 1 }, view: { url: `http://127.0.0.1:${appPort}/` } },
  ] }))
  const s = createWizardServer({
    wizardOsHome: d, requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false,
    runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, appsJsonPath: join(d, 'apps.json'),
    pagesRoot: join(d, 'Pages'), pagesGitDir: join(d, 'pages-history.git'), pagesWatch: false, localAppRoutesTtlMs: 0,
    ...extra,
  })
  servers.push(s); const a: any = await listen(s); return a.port as number
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number, body: string, headers: any }> {
  return new Promise((resolve, reject) => {
    const q = request({ hostname: '127.0.0.1', port, path, method, headers }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode!, body: b, headers: r.headers })) })
    q.on('error', reject); q.end()
  })
}
const appsList = async (port: number, headers: Record<string, string> = {}) => JSON.parse((await get(port, '/wizard/v1/apps', headers)).body).apps.map((a: any) => [a.id, a.url])

describe('local app routes: which apps get one', () => {
  const row = (extra: any = {}) => ({ id: 'wizard-search', status: 'running', provides: [], view: { url: 'http://127.0.0.1:8930/', internal: 'http://wizard-search:8080/' }, ...extra })
  it('a page at / gets /<id>/ (prefix stripped); a page with its own path keeps it', () => {
    expect(routeOf(row())).toEqual({ id: 'wizard-search', path: '/wizard-search/', strip: true, target: 'http://127.0.0.1:8930' })
    expect(routeOf(row({ id: 'files', view: { url: 'http://127.0.0.1:8794/files/' } }))).toEqual({ id: 'files', path: '/files/', strip: false, target: 'http://127.0.0.1:8794' })
    expect(routeOf(row({ view: { url: 'http://[::1]:8930/' } }))?.target).toBe('http://[::1]:8930')
    expect(routeOf(row({ view: { url: 'http://localhost:8930/' } }))?.target).toBe('http://localhost:8930')
    // Published through Serve before: the loopback address stays in view.local.
    expect(routeOf(row({ view: { url: '/wizard-search/', local: 'http://127.0.0.1:8930/' } }))?.path).toBe('/wizard-search/')
  })
  it('a container Agent Service uses the in-network address, and none without it', () => {
    expect(routeOf(row(), 'internal')?.target).toBe('http://wizard-search:8080')
    expect(routeOf(row({ view: { url: 'http://127.0.0.1:8930/' } }), 'internal')).toBe(null)
    expect(routeOf(row({ view: { url: 'http://127.0.0.1:8930/', internal: 'http://evil.example.com:80/' } }), 'internal')).toBe(null)
  })
  it('without view.internal, the MCP address behind the same published port (what apps.json has on every box today)', () => {
    // Files as the App Manager writes it: page and MCP on published 8794, MCP inside the network on files:8080.
    const files = { id: 'files', status: 'running', provides: ['files'], view: { url: 'http://127.0.0.1:8794/files/' },
      mcp: { url: 'http://127.0.0.1:8794/mcp', internal: 'http://files:8080/mcp', transport: 'streamable-http' } }
    expect(routeOf(files, 'internal')).toEqual({ id: 'files', path: '/files/', strip: false, target: 'http://files:8080' })
    // Published through Serve already: view.url is the path, view.local keeps the port.
    expect(routeOf({ ...files, view: { url: '/files/', local: 'http://127.0.0.1:8794/files/' } }, 'internal')?.target).toBe('http://files:8080')
    // An MCP on another published port says nothing about the page.
    expect(routeOf({ ...files, mcp: { url: 'http://127.0.0.1:9999/mcp', internal: 'http://files:8080/mcp' } }, 'internal')).toBe(null)
    expect(routeOf({ ...files, mcp: { url: 'http://127.0.0.1:8794/mcp', internal: 'http://evil.example:80/mcp' } }, 'internal')).toBe(null)
  })
  it('never the shell, agents, owner-proof apps, the shell\'s own paths or non-loopback pages', () => {
    expect(routeOf(row({ provides: ['shell'] }))).toBe(null)
    expect(routeOf(row({ category: 'agent' }))).toBe(null)
    expect(routeOf(row({ owner_proof: { version: 1 } }))).toBe(null)
    expect(routeOf(row({ view: { url: 'http://127.0.0.1:8930/wizard-os-home/' } }))).toBe(null)
    expect(routeOf(row({ view: { url: 'http://127.0.0.1:8930/api/' } }))).toBe(null)
    expect(routeOf(row({ view: { url: 'http://10.0.0.5:8930/' } }))).toBe(null)
    expect(routeOf(row({ view: { url: 'https://box.example.ts.net:8930/' } }))).toBe(null)
  })
  it('only a request straight to the loopback address counts', () => {
    expect(loopbackRequest({ headers: { host: '127.0.0.1:8796' } })).toBe(true)
    expect(loopbackRequest({ headers: { host: 'localhost:48023' } })).toBe(true)
    expect(loopbackRequest({ headers: { host: 'box.example.ts.net:8444' } })).toBe(false)
    expect(loopbackRequest({ headers: { host: '127.0.0.1:8796', 'tailscale-user-login': 'a@b.c' } })).toBe(false)
    expect(loopbackRequest({ headers: { host: '127.0.0.1:8796', 'cf-connecting-ip': '1.2.3.4' } })).toBe(false)
    expect(loopbackRequest({ headers: { host: '127.0.0.1:8796' } }, { tailnetIngress: true })).toBe(false)
  })
})

describe('local app routes over HTTP', () => {
  it('switch off: nothing changes (backend-only, the path is not served)', async () => {
    const d = home(); setLook(d, false); const app = await fakeApp(); const port = await start(d, app.port)
    expect(await appsList(port)).toEqual([['wizard-search', ''], ['files', ''], ['notes', '']])
    expect((await get(port, '/wizard-search/')).status).toBe(404)
    expect(app.seen).toEqual([])
  })
  it('switch on: the launcher gets the Wizard path and the page is served from the app, as a box-local caller', async () => {
    const d = home(); setLook(d, true); const app = await fakeApp(); const port = await start(d, app.port)
    expect(await appsList(port)).toEqual([['wizard-search', '/wizard-search/'], ['files', '/files/'], ['notes', '']])
    const page = await get(port, '/wizard-search/q/x?term=wizards', { 'x-forwarded-for': '172.18.0.1', 'x-forwarded-host': '127.0.0.1', forwarded: 'for=x', 'x-wizard-owner-proof': 'secret', cookie: 'a=1' })
    expect([page.status, page.body, page.headers['x-app']]).toEqual([200, 'app:/q/x?term=wizards', 'yes'])
    const files = await get(port, '/files/api/resources/')
    expect([files.status, files.body]).toEqual([200, 'app:/files/api/resources/'])
    const h = app.seen[0].headers
    expect([h['x-forwarded-for'], h['x-forwarded-host'], h.forwarded, h['x-wizard-owner-proof'], h.cookie, h.host]).toEqual([undefined, undefined, undefined, undefined, 'a=1', `127.0.0.1:${port}`])
    // The bare path moves to the folder, like Serve.
    expect((await get(port, '/wizard-search?x=1')).headers.location).toBe('/wizard-search/?x=1')
    // An owner-proof app keeps needing its owner edge.
    expect((await get(port, '/notes/')).status).toBe(404)
  })
  it('switch on: overlapping paths go to the most specific app', async () => {
    const d = home(); setLook(d, true); const a = await fakeApp(), b = await fakeApp()
    await start(d, a.port)
    writeFileSync(join(d, 'apps.json'), JSON.stringify({ schema: 1, apps: [
      { id: 'foo', status: 'running', provides: [], view: { url: `http://127.0.0.1:${a.port}/foo/` } },
      { id: 'foo-bar', status: 'running', provides: [], view: { url: `http://127.0.0.1:${b.port}/foo/bar/` } }] }))
    const port = (servers.at(-1) as any).address().port
    expect((await get(port, '/foo/bar/x')).body).toBe('app:/foo/bar/x')
    expect((await get(port, '/foo/x')).body).toBe('app:/foo/x')
    expect([a.seen.map((r: any) => r.url), b.seen.map((r: any) => r.url)]).toEqual([['/foo/x'], ['/foo/bar/x']])
  })
  it('switch on: refused through Tailscale Serve, from any other Host, and cross-site', async () => {
    const d = home(); setLook(d, true); const app = await fakeApp(); const port = await start(d, app.port)
    expect((await get(port, '/wizard-search/', { host: 'box.example.ts.net:8444', 'tailscale-user-login': 'owner@example.com' })).status).toBe(403)
    expect((await get(port, '/wizard-search/', { host: 'attacker.example' })).status).toBe(403)
    expect((await get(port, '/wizard-search/', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await get(port, '/wizard-search/api', { origin: 'http://attacker.example' }, 'POST')).status).toBe(403)
    expect((await get(port, '/wizard-search/api', { origin: `http://127.0.0.1:${port}` }, 'POST')).status).toBe(200)
    // The launcher list from Serve keeps the backend-only answer.
    expect(await appsList(port, { host: 'box.example.ts.net:8444', 'tailscale-user-login': 'owner@example.com' })).toEqual([['wizard-search', ''], ['files', ''], ['notes', '']])
    expect(app.seen.length).toBe(1)
  })
  it('switch on: an app\'s WebSocket goes through too; off it is closed', async () => {
    const d = home(); setLook(d, true); const app = await fakeApp(); const port = await start(d, app.port)
    const ws = (p: number) => new Promise<string>((resolve) => {
      const q = request({ hostname: '127.0.0.1', port: p, path: '/wizard-search/socket', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') } })
      q.on('upgrade', (res, socket, head) => { let b: Buffer = Buffer.from(head); socket.on('data', (c: Buffer) => { b = Buffer.concat([b, c]) }); socket.on('end', () => resolve(`${res.statusCode}:${b.subarray(2).toString()}`)) })
      q.on('response', r => resolve(`http ${r.statusCode}`)); q.on('error', () => resolve('closed')); q.end()
    })
    expect(await ws(port)).toBe('101:hi')
    setLook(d, false)
    expect(await ws(port)).toBe('closed')
  })
})
