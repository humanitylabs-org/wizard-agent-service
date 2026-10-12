import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppLifecycleRoutes, localOwnerAccess } from '../server/app-lifecycle.mjs'

const KEY = 'install-0123456789abcdef'

// A Service-like listener in front of a fake WAM bridge: apps.json says which apps run, and the bridge's
// /api/internal/apps/<id>/view answers each app's server-only upstream.
async function fixture(t, extra = {}) {
  const p = join(mkdtempSync(join(tmpdir(), 'lifecycle-')), 'apps.json')
  writeFileSync(p, JSON.stringify({ apps: [
    { id: 'hello', status: 'running', view: { url: '/apps/hello/' } },
    { id: 'evil', status: 'running', view: { url: '/apps/evil/' } },
    { id: 'stopped', status: 'stopped', view: { url: '/apps/stopped/' } },
    { id: 'strict', status: 'running', view: { url: '/apps/strict/' } },
    { id: 'self', status: 'running', view: { url: '/apps/self/' } },
  ] }))
  const upstreams = { hello: 'http://127.0.0.1:12345/ui/', evil: 'http://169.254.169.254/', stopped: 'http://127.0.0.1:12346/', strict: 'http://127.0.0.1:12347/', self: 'http://127.0.0.1:8787/' }
  const calls = []; let refresh = 0; let clock = extra.clock || { t: 1_000_000 }
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    const u = new URL(String(url))
    const view = /^\/api\/internal\/apps\/([a-z0-9-]+)\/view$/u.exec(u.pathname)
    if (u.port === '9876' && view) {
      return upstreams[view[1]] ? Response.json({ upstream: upstreams[view[1]], path: `/apps/${view[1]}/` }) : Response.json({ error: 'view_not_found' }, { status: 404 })
    }
    if (u.port === '12345') return new Response('<h1>Hello</h1>', { headers: { 'content-type': 'text/html' } })
    // A FastAPI-like app server: GET routes answer HEAD with 405.
    if (u.port === '12347') return opts.method === 'HEAD' ? new Response('', { status: 405 }) : new Response('<h1>Strict</h1>', { headers: { 'content-type': 'text/html' } })
    if (extra.lifecycleFails && u.pathname.startsWith('/api/app-lifecycle/')) throw new Error('bridge dropped')
    if (extra.bridgeError) return Response.json({ success: false, error: extra.bridgeError }, { status: 409 })
    return Response.json({ success: true, installed: [] })
  }
  const options = { managerUrl: 'http://127.0.0.1:9876', managerToken: 'internal-fixture', appsJsonPath: p, refresh: () => { refresh++; if (extra.refreshThrows) throw new Error('read failed') }, fetchImpl, now: () => clock.t, reservedPorts: [8787], ...extra.options }
  const handler = createAppLifecycleRoutes(options)
  const s = createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end() } })
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => s.close(r)))
  const base = `http://127.0.0.1:${s.address().port}`
  let appsBase = ''
  if (extra.appsListener) {
    const appsOnly = createAppLifecycleRoutes({ ...options, role: 'apps' })
    const a = createServer(async (req, res) => { await appsOnly(req, res, new URL(req.url, 'http://localhost')) })
    await new Promise((r) => a.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => a.close(r)))
    appsBase = `http://127.0.0.1:${a.address().port}`
  }
  return { base, appsBase, clock, calls, refresh: () => refresh, lifeCalls: () => calls.filter((c) => c.url.includes('/api/app-lifecycle/')) }
}
async function owner(base) {
  const boot = await fetch(`${base}/wizard/v1/app-lifecycle/session`)
  assert.equal(boot.status, 200)
  const cookie = boot.headers.get('set-cookie').split(';')[0]
  const { csrf, expires_in } = await boot.json()
  return { cookie, csrf, expires_in, headers: { Origin: base, Cookie: cookie, 'X-Wizard-CSRF': csrf, 'Idempotency-Key': KEY, 'Content-Type': 'application/json' } }
}

test('owner session + same origin + CSRF are required, manager key stays server-side', async (t) => {
  const { base, calls, refresh, lifeCalls } = await fixture(t)
  const path = `${base}/api/app-lifecycle/hello%3Awizardapps/install`
  const no = await fetch(path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'Idempotency-Key': KEY }, body: '{}' })
  assert.equal(no.status, 403); assert.equal(calls.length, 0)
  const o = await owner(base)
  assert.ok(o.csrf); assert.ok(o.expires_in > 3500 && o.expires_in <= 3600)
  assert.equal((await fetch(path, { method: 'POST', headers: { ...o.headers, Origin: 'https://evil.test' }, body: '{}' })).status, 403)
  assert.equal((await fetch(path, { method: 'POST', headers: { ...o.headers, 'X-Wizard-CSRF': 'bad' }, body: '{}' })).status, 403)
  assert.equal((await fetch(path, { method: 'POST', headers: { ...o.headers, 'Sec-Fetch-Site': 'same-site' }, body: '{}' })).status, 403)
  assert.equal((await fetch(path, { method: 'POST', headers: { ...o.headers, 'Idempotency-Key': 'short' }, body: '{}' })).status, 400)
  const good = await fetch(path, { method: 'POST', headers: o.headers, body: '{}' })
  assert.equal(good.status, 200); assert.equal(refresh(), 1)
  assert.equal(lifeCalls().length, 1)
  assert.equal(lifeCalls()[0].opts.headers.Authorization, 'Bearer internal-fixture')
  assert.equal(lifeCalls()[0].opts.headers['Idempotency-Key'], KEY)
  assert.equal(JSON.stringify(await good.json()).includes('internal-fixture'), false)
})

test('DNS-rebinding fence: an untrusted Host never reaches session, reads, lifecycle or apps', async (t) => {
  const { base, calls } = await fixture(t, { options: { allowedHosts: ['wizard.example.ts.net'] } })
  const port = new URL(base).port
  for (const path of ['/wizard/v1/app-lifecycle/session', '/api/apps/installed', '/apps/hello/']) {
    // Node fetch can't override Host, so use a raw request through the same listener.
    const r = await new Promise((resolve) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port, path, headers: { Host: `rebound.attacker.test:${port}` } }, (res) => { res.resume(); resolve(res.statusCode) })
        req.end()
      })
    })
    assert.equal(r, 421, path)
  }
  assert.equal(calls.length, 0)
})

test('a definitive bridge rejection keeps its symbolic code; a lost response is uncertain, not failed', async (t) => {
  const rejected = await fixture(t, { bridgeError: 'install_already_running' })
  const o = await owner(rejected.base)
  const r = await fetch(`${rejected.base}/api/app-lifecycle/hello/install`, { method: 'POST', headers: o.headers, body: '{}' })
  assert.equal(r.status, 409); assert.deepEqual(await r.json(), { success: false, error: 'install_already_running' })
  const lost = await fixture(t, { lifecycleFails: true })
  const o2 = await owner(lost.base)
  const u = await fetch(`${lost.base}/api/app-lifecycle/hello/stop`, { method: 'POST', headers: o2.headers, body: '{}' })
  assert.equal(u.status, 502); assert.deepEqual(await u.json(), { success: false, error: 'operation_unconfirmed' })
  assert.equal(lost.refresh(), 1)
})

test('rejects forwarded unauthenticated request, unknown lifecycle and wrong methods', async (t) => {
  const { base, calls } = await fixture(t)
  assert.equal((await fetch(`${base}/api/apps/installed`, { headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 403)
  assert.equal((await fetch(`${base}/api/app-lifecycle/hello%3Awizardapps/reset`, { method: 'POST' })).status, 404)
  assert.equal((await fetch(`${base}/api/app-lifecycle/start-all`, { method: 'POST' })).status, 404)
  assert.equal((await fetch(`${base}/api/app-lifecycle/hello%3Awizardapps/install`)).status, 405)
  assert.equal((await fetch(`${base}/api/apps/installed`, { method: 'POST' })).status, 405)
  assert.equal(calls.length, 0)
})

test('without an apps origin, app documents are sandboxed: opaque origin, no writes, no owner credentials upstream', async (t) => {
  const { base, calls } = await fixture(t)
  const r = await fetch(`${base}/apps/hello/`, { headers: { Authorization: 'Bearer OWNER', Cookie: 'wizard_lifecycle=owner' } })
  assert.equal(r.status, 200); assert.match(await r.text(), /Hello/)
  const csp = r.headers.get('content-security-policy')
  assert.match(csp, /^sandbox /u); assert.doesNotMatch(csp, /allow-same-origin/u)
  const app = calls.find((c) => c.url.startsWith('http://127.0.0.1:12345'))
  assert.equal(app.url, 'http://127.0.0.1:12345/ui/')
  assert.equal(app.opts.headers.Authorization, undefined); assert.equal(app.opts.headers.Cookie, undefined)
  // The non-loopback upstream, a stopped app and an unknown app never get proxied.
  assert.equal((await fetch(`${base}/apps/evil/`)).status, 404)
  assert.equal((await fetch(`${base}/apps/stopped/`)).status, 404)
  assert.equal((await fetch(`${base}/apps/missing/`)).status, 404)
  assert.equal(calls.filter((c) => !c.url.includes('/api/internal/')).length, 1)
  // A sandboxed document's writes are refused even when the Origin header claims the control origin.
  assert.equal((await fetch(`${base}/apps/hello/create`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
})

test('with an apps origin, the control origin only redirects; the apps listener serves apps and nothing else', async (t) => {
  // Both listeners are 127.0.0.1 in this fixture; the apps origin is a distinct port (a distinct browser origin).
  const f0 = await fixture(t, { appsListener: true })
  const appsOrigin = f0.appsBase
  const f = await fixture(t, { appsListener: true, options: { appsOrigin } })
  const redirect = await fetch(`${f.base}/apps/hello/x?y=1`, { redirect: 'manual' })
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), `${appsOrigin}/apps/hello/x?y=1`)
  const page = await fetch(`${f.appsBase}/apps/hello/`)
  assert.equal(page.status, 200); assert.equal(page.headers.get('content-security-policy'), null)
  for (const path of ['/wizard/v1/app-lifecycle/session', '/api/apps/installed', '/api/app-lifecycle/hello/install', '/wizard/v1/bootstrap']) {
    assert.equal((await fetch(`${f.appsBase}${path}`)).status, 404, path)
  }
  const write = await fetch(`${f.appsBase}/apps/hello/create`, { method: 'POST', headers: { Origin: f.appsBase, 'Content-Type': 'application/json', Authorization: 'Bearer OWNER' }, body: '{"name":"test"}' })
  assert.equal(write.status, 200)
  const sent = f.calls.filter((c) => c.url === 'http://127.0.0.1:12345/ui/create')
  assert.equal(sent.length, 1); assert.equal(sent[0].opts.body.toString(), '{"name":"test"}'); assert.equal(sent[0].opts.headers.Authorization, undefined)
  assert.equal((await fetch(`${f.appsBase}/apps/hello/create`, { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' })).status, 403)
})

test('trusts direct loopback or a pinned Tailscale owner; a trusted gateway peer is never the owner by itself', () => {
  const req = (ip, h = {}) => ({ socket: { remoteAddress: ip }, headers: h })
  const ts = (login) => ({ 'x-forwarded-for': '100.1.2.3', 'tailscale-user-login': login })
  assert.equal(localOwnerAccess(req('127.0.0.1')), true);
  assert.equal(localOwnerAccess(req('172.18.0.1')), false);
  // Hairpinned container traffic also arrives from the gateway: no headers, a forged login or an unpinned login fail.
  assert.equal(localOwnerAccess(req('172.18.0.1'), [], ['172.18.0.1']), false);
  assert.equal(localOwnerAccess(req('172.18.0.1'), ['owner@x'], ['172.18.0.1']), false);
  assert.equal(localOwnerAccess(req('172.18.0.1', ts('owner@x')), [], ['172.18.0.1']), false);
  assert.equal(localOwnerAccess(req('172.18.0.1', ts('guest@x')), ['owner@x'], ['172.18.0.1']), false);
  assert.equal(localOwnerAccess(req('::ffff:172.18.0.1', ts('Owner@X')), ['owner@x'], ['172.18.0.1']), true);
  assert.equal(localOwnerAccess(req('172.18.0.2', ts('owner@x')), ['owner@x'], ['172.18.0.1']), false);
  assert.equal(localOwnerAccess(req('8.8.8.8', { 'tailscale-user-login': 'owner@x' }), ['owner@x']), false)
  assert.equal(localOwnerAccess(req('127.0.0.1', { 'x-forwarded-for': '100.1.2.3' })), false)
  // A forwarded identity needs an explicit owner list, never "any tailnet login".
  assert.equal(localOwnerAccess(req('127.0.0.1', ts('owner@x'))), false)
  assert.equal(localOwnerAccess(req('127.0.0.1', ts('guest@x')), ['owner@x']), false)
  assert.equal(localOwnerAccess(req('127.0.0.1', ts('Owner@X')), ['owner@x']), true)
})

test('HEAD confirmation is answered from an upstream GET without a body; a HEAD-405 app still confirms', async (t) => {
  const { base, calls } = await fixture(t)
  const r = await fetch(`${base}/apps/strict/`, { method: 'HEAD' })
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/u)
  assert.match(r.headers.get('content-security-policy'), /^sandbox /u)
  assert.equal((await r.arrayBuffer()).byteLength, 0)
  const sent = calls.filter((c) => c.url.startsWith('http://127.0.0.1:12347'))
  assert.equal(sent.length, 1); assert.equal(sent[0].opts.method, 'GET'); assert.equal(sent[0].opts.body, undefined)
  assert.equal((await fetch(`${base}/apps/strict/`)).status, 200)
})

test('an app upstream on the Service\'s own or the bridge\'s loopback port is refused', async (t) => {
  const { base, calls } = await fixture(t)
  assert.equal((await fetch(`${base}/apps/self/`)).status, 404)
  assert.equal(calls.filter((c) => c.url.startsWith('http://127.0.0.1:8787')).length, 0)
})

test('the session rotates in its last two minutes; any valid cookie of that name counts', async (t) => {
  const f = await fixture(t)
  const a = await owner(f.base)
  f.clock.t += 3600_000 - 100_000
  const same = await fetch(`${f.base}/wizard/v1/app-lifecycle/session`, { headers: { Cookie: a.cookie } })
  const b = await same.json()
  assert.notEqual(b.csrf, a.csrf); assert.ok(b.expires_in > 3500)
  const cookie = same.headers.get('set-cookie').split(';')[0]
  // A planted cookie of the same name first (an app on another port of this host) doesn't lock the owner out.
  const r = await fetch(`${f.base}/api/app-lifecycle/hello/install`, { method: 'POST', headers: { ...a.headers, Cookie: `wizard_lifecycle=planted; ${cookie}`, 'X-Wizard-CSRF': b.csrf }, body: '{}' })
  assert.equal(r.status, 200)
})

test('a projection refresh that throws after a successful mutation does not report the mutation as failed', async (t) => {
  const f = await fixture(t, { refreshThrows: true })
  const o = await owner(f.base)
  const r = await fetch(`${f.base}/api/app-lifecycle/hello/install`, { method: 'POST', headers: o.headers, body: '{}' })
  assert.equal(r.status, 200); assert.equal((await r.json()).success, true); assert.equal(f.refresh(), 1)
})
