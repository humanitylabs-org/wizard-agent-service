// Scoped content tickets (wizard-os ADAPTER-SKETCH §6) for Notifications pictures, default-off. Real WAM-written
// apps.json (media-granted / media-revoked / card2-granted goldens), a gated stub app listener that answers only the
// installation's credential, the real Service and its dedicated content listener. Synthetic bytes only.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { createWizardServer, listen } from '../server/service.mjs'
import { mediaPath, OPERATIONS } from '../server/browser-operations.mjs'
import { parseRange } from '../server/browser-content.mjs'

const TOKEN = randomBytes(32).toString('hex')
const PROOF = 'owner-proof-synthetic-'.repeat(3)
const FIXTURES = new URL('./fixtures/browser-trust/wam/', import.meta.url)
const resources: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })
const AMBIENT = ['cookie', 'authorization', 'x-wizard-shell-token', 'x-wizard-owner-proof', 'tailscale-user-login', 'origin', 'referer', 'x-forwarded-for', 'sec-fetch-site', 'sec-fetch-dest']
const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(n)])

async function gatedApp() {
  const pic = '/media/synthetic/chart.png'
  const state = {
    key: '', refused: 0, seen: [] as Record<string, string | string[] | undefined>[], bytes: png(200_000), slow: false,
    items: [
      { id: 'pic1', title: 'Synthetic chart', message: `Chart ready.\nMEDIA:${pic}\nMEDIA:/media/synthetic/missing.png`, time: 1761955200, read: false, flag: false, archived: false },
      { id: 'text1', title: 'No picture', message: 'Just text. MEDIA:/not/a/line.png inline', time: 1761955100, read: false, flag: false, archived: false },
    ],
  }
  const server = createServer((req, res) => {
    state.seen.push({ ...req.headers })
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (AMBIENT.some(h => req.headers[h] !== undefined) || req.headers['x-wizard-app-credential'] !== state.key) { state.refused++; json(401, { error: 'adapter_credential_required' }); return }
    if (req.method === 'GET' && req.url?.startsWith('/notifications/api/items?')) { json(200, { items: state.items, counts: {} }); return }
    if (req.method === 'GET' && req.url === '/notifications/media' + pic) { res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(state.bytes.length) }); res.end(state.bytes); return }
    json(404, { error: 'not found' })
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => { server.closeAllConnections?.(); server.close(r) }))
  return { state, port: address.port }
}

async function box({ scenario = 'media-granted', content = true, ttlMs = 60_000 } = {}) {
  const up = await gatedApp()
  const dir = mkdtempSync(join(tmpdir(), 'bt-media-'))
  resources.push(() => rmSync(dir, { recursive: true, force: true }))
  const appsJsonPath = join(dir, 'apps.json')
  const load = (name: string) => {
    const doc = JSON.parse(readFileSync(new URL(name + '.json', FIXTURES), 'utf8'))
    for (const a of doc.apps) if (a.browser?.upstream) a.browser.upstream = `http://127.0.0.1:${up.port}`
    writeFileSync(appsJsonPath, JSON.stringify(doc))
    return doc.apps.find((a: any) => a.id === 'notifications')?.browser
  }
  const notif = load(scenario)
  const key = randomBytes(32).toString('hex')   // WAM's file; generated at runtime, never a literal
  mkdirSync(join(dir, 'browser-app-credentials'), { recursive: true })
  if (notif.listener_credential) writeFileSync(join(dir, 'browser-app-credentials', `${notif.installation_id}.key`), key + '\n', { mode: 0o600 })
  up.state.key = notif.listener_credential ? key : (undefined as unknown as string)
  // The content origin is a different port than the Service: it is published as its own origin on a box.
  const probe = createServer(); const cp = (await listen(probe)).port; await new Promise(r => probe.close(r))
  const server = createWizardServer({
    requireAccess: false, upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture-key', ownerProof: PROOF,
    browserBoundary: { enabled: true, token: TOKEN },
    browserAdapterWam: { receiptsPath: join(dir, 'receipts.json'), ...(content ? { content: { publicBase: `http://127.0.0.1:${cp}`, ttlMs } } : {}) },
    hermesHome: join(dir, 'synthetic-hermes'), wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath,
    launcherPath: join(dir, 'launcher.json'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => { server.closeAllConnections?.(); server.close(r) }))
  if (content) {
    const cs = (server as any).browserContent.createServer()
    await new Promise<void>(r => cs.listen(cp, '127.0.0.1', () => r()))
    resources.push(() => new Promise(r => { cs.closeAllConnections?.(); cs.close(r) }))
  }
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/wizard/v1/browser-adapters/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Wizard-Shell-Token': TOKEN, 'X-Wizard-Owner-Proof': PROOF, cookie: 'wos=ambient' }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  let n = 0
  const bind = async () => {
    const generation = randomUUID()
    const r = await post('bindings', { appId: 'notifications', generation })
    expect(r.status).toBe(200)
    const call = (operation: string, args: unknown) => post('call', { handle: r.body.handle, generation, requestId: 'wbs-' + (++n), operation, args })
    return Object.assign(call, { handle: r.body.handle as string })
  }
  const raw = (url: string, { method = 'GET', headers = {} as Record<string, string> } = {}) => new Promise<{ status: number, headers: Record<string, any>, body: Buffer }>((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, res => { const parts: Buffer[] = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) })); res.on('error', reject) })
    req.on('error', reject); req.end()
  })
  return { up, bind, post, raw, load, servicePort: address.port, contentPort: cp, notif }
}

describe('notifications.media: 60 s scoped picture tickets on a non-owner content listener', () => {
  it('is a reviewed media operation of its own; the frame names a notification and picture number, never a path', () => {
    expect(OPERATIONS['notifications.media']).toEqual({ kind: 'media', slot: 'notifications' })
    expect(mediaPath('a\nMEDIA:/x/one.png\r\ntext\n  MEDIA:/y/two.jpg  ', 2)).toBe('/y/two.jpg')
    expect(mediaPath('inline MEDIA:/x.png is not a line', 1)).toBeNull()
  })

  it('mints a ticket, serves the exact bytes with inert, no-store, anonymous-only headers, and sends no ambient authority upstream', async () => {
    const t = await box()
    const call = await t.bind()
    const r = await call('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })
    expect(r.status).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual(['bytes', 'expiresAt', 'kind', 'methods', 'mime', 'range', 'url'])
    expect(r.body).toMatchObject({ kind: 'ticket', mime: 'image/png', bytes: t.up.state.bytes.length, methods: ['GET', 'HEAD'], range: true })
    expect(r.body.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${t.contentPort}/t/[A-Za-z0-9_-]{43}$`))
    expect(Date.parse(r.body.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000)
    expect(r.body.url).not.toContain('chart')   // no path, name or owner route in the capability URL
    const got = await t.raw(r.body.url, { headers: { cookie: 'wos=owner-session', origin: 'null' } })
    expect(got.status).toBe(200)
    expect(got.body.equals(t.up.state.bytes)).toBe(true)
    expect(got.headers).toMatchObject({ 'content-type': 'image/png', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'access-control-allow-origin': '*', 'accept-ranges': 'bytes', 'content-disposition': 'inline; filename="picture.png"' })
    expect(got.headers['access-control-allow-credentials']).toBeUndefined()
    expect(got.headers['set-cookie']).toBeUndefined()
    expect(t.up.state.refused).toBe(0)
    for (const h of t.up.state.seen) { expect(h['x-wizard-app-credential']).toBe(t.up.state.key); for (const a of AMBIENT) expect(h[a]).toBeUndefined() }
  })

  it('HEAD and Range (start-end, open, suffix) work repeatedly inside the window; bad or multi ranges are 416; other methods 405', async () => {
    const t = await box()
    const call = await t.bind()
    const { body: { url } } = await call('notifications.media', { resourceId: 'n:pic1:1', purpose: 'read' })
    const size = t.up.state.bytes.length
    const head = await t.raw(url, { method: 'HEAD' })
    expect(head.status).toBe(200); expect(head.headers['content-length']).toBe(String(size)); expect(head.body.length).toBe(0)
    const part = await t.raw(url, { headers: { range: 'bytes=10-19' } })
    expect(part.status).toBe(206); expect(part.headers['content-range']).toBe(`bytes 10-19/${size}`); expect(part.body.equals(t.up.state.bytes.subarray(10, 20))).toBe(true)
    expect((await t.raw(url, { headers: { range: 'bytes=100-' } })).body.equals(t.up.state.bytes.subarray(100))).toBe(true)
    expect((await t.raw(url, { headers: { range: 'bytes=-8' } })).body.equals(t.up.state.bytes.subarray(size - 8))).toBe(true)
    for (const range of ['bytes=0-1,4-5', `bytes=${size}-`, 'bytes=9-3', 'items=0-1']) expect((await t.raw(url, { headers: { range } })).status, range).toBe(416)
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const r = await t.raw(url, { method, headers: { origin: 'null', 'access-control-request-method': 'GET' } })
      expect(r.status, method).toBe(405); expect(r.headers['access-control-allow-origin']).toBeUndefined()
    }
    expect(parseRange(undefined, 10)).toBeNull()
  })

  it('the 60 s expiry is absolute: use never extends it', async () => {
    const t = await box({ ttlMs: 400 })
    const call = await t.bind()
    const { body: { url } } = await call('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })
    expect((await t.raw(url)).status).toBe(200)
    await new Promise(r => setTimeout(r, 200)); expect((await t.raw(url, { method: 'HEAD' })).status).toBe(200)
    await new Promise(r => setTimeout(r, 250)); expect((await t.raw(url)).status).toBe(410)
  })

  it('revocation before expiry: closing the binding, a WAM grant revoke, a reinstall and an uninstall all stop the ticket', async () => {
    const t = await box()
    const open = async () => { const call = await t.bind(); return { call, url: (await call('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })).body.url as string } }
    let o = await open()
    expect((await t.raw(o.url)).status).toBe(200)
    await t.post('revoke', { handle: o.call.handle })
    expect([403, 410]).toContain((await t.raw(o.url)).status)
    o = await open(); t.load('media-revoked')            // owner revoked notifications.media in WAM
    expect((await t.raw(o.url)).status).toBe(403)
    t.load('media-granted'); o = await open(); t.load('card2-granted')   // another installation now owns the id
    expect((await t.raw(o.url)).status).toBe(403)
    t.load('media-granted'); o = await open(); t.load('uninstalled')
    expect((await t.raw(o.url)).status).toBe(403)
  })

  it('a revoke interrupts a response already streaming, not only the next Range request', async () => {
    const t = await box()
    t.up.state.bytes = png(6 * 1024 * 1024)
    const call = await t.bind()
    const { body: { url } } = await call('notifications.media', { resourceId: 'n:pic1:1', purpose: 'read' })
    const received = await new Promise<{ bytes: number, complete: boolean }>(resolve => {
      let bytes = 0, revoked = false
      const req = httpRequest(url, res => {
        res.on('data', c => { bytes += c.length; if (!revoked) { revoked = true; res.pause(); t.post('revoke', { handle: call.handle }).then(() => setTimeout(() => res.resume(), 50)) } })
        res.on('end', () => resolve({ bytes, complete: res.complete }))
        res.on('aborted', () => resolve({ bytes, complete: false })); res.on('error', () => resolve({ bytes, complete: false }))
      })
      req.on('error', () => resolve({ bytes, complete: false })); req.end()
    })
    expect(received.complete).toBe(false)
    expect(received.bytes).toBeLessThan(t.up.state.bytes.length)
  })

  it('refuses paths, URLs, other shapes, missing pictures, an ungranted media read and changed bytes', async () => {
    const t = await box()
    const call = await t.bind()
    for (const resourceId of ['/media/synthetic/chart.png', 'http://127.0.0.1/x.png', 'n:pic1:0', 'n:pic1:1/../2', 'n:../x:1', 'files:pic1:1'])
      expect((await call('notifications.media', { resourceId, purpose: 'thumbnail' })).status, resourceId).toBe(400)
    const call2 = await t.bind()   // every open counts toward the per-binding renewal bound, refused ones too
    expect((await call2('notifications.media', { resourceId: 'n:pic1:1', purpose: 'download' })).status).toBe(400)
    expect((await call2('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail', path: '/etc' })).status).toBe(400)
    expect((await call2('notifications.media', { resourceId: 'n:text1:1', purpose: 'thumbnail' })).body.error).toBe('not_found')   // inline text is not a picture
    expect((await call2('notifications.media', { resourceId: 'n:nope:1', purpose: 'thumbnail' })).body.error).toBe('not_found')
    expect((await call2('notifications.media', { resourceId: 'n:pic1:2', purpose: 'thumbnail' })).body.error).toBe('not_found')  // app 404
    const { body: { url } } = await call2('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })
    t.up.state.bytes = png(1000)
    expect((await t.raw(url)).status).toBe(410)
    const denied = await box({ scenario: 'media-revoked' })
    expect((await (await denied.bind())('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })).body.error).toBe('not_allowed')
  })

  it('renewal is bounded: ten opens a minute per binding', async () => {
    const t = await box()
    const call = await t.bind()
    for (let i = 0; i < 10; i++) expect((await call('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })).status).toBe(200)
    expect((await call('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })).body.error).toBe('quota_exceeded')
    expect((await (await t.bind())('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })).status).toBe(200)
  })

  it('the content listener has no owner routes, and the owner listener serves no tickets', async () => {
    const t = await box()
    const call = await t.bind()
    const { body: { url } } = await call('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })
    const ticketPath = new URL(url).pathname
    for (const p of ['/wizard/v1/browser-adapters/bindings', '/notifications/api/items', '/t/', '/t/short', ticketPath + '/x', '/'])
      expect((await t.raw(`http://127.0.0.1:${t.contentPort}${p}`)).status, p).toBe(404)
    expect((await t.raw(`http://127.0.0.1:${t.servicePort}${ticketPath}`)).status).not.toBe(200)
  })

  it('without a content origin, or with the credential missing, nothing is minted', async () => {
    const off = await box({ content: false })
    expect((await (await off.bind())('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })).body.error).toBe('unsupported_capability')
    const t = await box()
    t.up.state.key = 'rotated-' + randomBytes(8).toString('hex')   // app expects another key: upstream refuses
    expect((await (await t.bind())('notifications.media', { resourceId: 'n:pic1:1', purpose: 'thumbnail' })).body.error).toBe('backend_failed')
  })
})
