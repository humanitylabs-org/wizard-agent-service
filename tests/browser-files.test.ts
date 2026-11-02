// First-party Files view under the browser boundary (server/browser-files.mjs; wizard-os #385/#386, ADAPTER-SKETCH §4/§6),
// default-off. The real Service with its real resumable upload store and owner-files root, a WAM-shaped apps.json entry
// for wizard-files (cloned from the WAM-generated media-granted golden, operations swapped to files.*), and a gated stub
// of the wizard-files listener that serves a real directory and answers only the installation's credential.
// Synthetic bytes only.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWizardServer, listen } from '../server/service.mjs'
import { OPERATIONS } from '../server/browser-operations.mjs'
import { safeMime } from '../server/browser-files.mjs'

const TOKEN = randomBytes(32).toString('hex')
const PROOF = 'owner-proof-synthetic-'.repeat(3)
const FIXTURES = new URL('./fixtures/browser-trust/wam/', import.meta.url)
const FILES_OPS = ['files.list', 'files.index', 'files.thumbnail', 'files.content', 'files.upload']
const AMBIENT = ['cookie', 'authorization', 'x-wizard-shell-token', 'x-wizard-owner-proof', 'tailscale-user-login', 'origin', 'referer', 'x-forwarded-for', 'sec-fetch-site', 'sec-fetch-dest']
const resources: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(600), Buffer.from([0xff, 0xd9])])

/** Stub wizard-files listener over a real directory: same routes and row shape as wizard-files server.py. */
async function filesApp(root: string) {
  const state = { key: '', refused: 0, seen: [] as Record<string, any>[], appData: [] as string[], uploadAllowed: true }
  const identity = (p: string) => { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` }
  const kind = (n: string) => /\.(mp4|webm|mov)$/i.test(n) ? 'video' : /\.(png|jpe?g|gif|webp)$/i.test(n) ? 'photo' : 'document'
  const server = createServer((req, res) => {
    state.seen.push({ ...req.headers })
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (AMBIENT.some(h => req.headers[h] !== undefined) || req.headers['x-wizard-app-credential'] !== state.key) { state.refused++; json(401, { error: 'adapter_credential_required' }); return }
    const u = new URL(req.url!, 'http://app')
    const rel = (v: string | null) => String(v || '').split('/').filter(Boolean)
    if (u.pathname === '/api/files') {
      const folder = rel(u.searchParams.get('folder')).join('/'), dir = join(root, folder)
      if (!existsSync(dir)) { json(404, { error: 'not_found' }); return }
      const entries = readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.')).map(e => {
        const full = join(dir, e.name), path = folder ? `${folder}/${e.name}` : e.name
        return e.isDirectory() ? { name: e.name, path, is_dir: true, size: 0, mtime: '', type: 'document' }
          : { name: e.name, path, is_dir: false, size: statSync(full).size, mtime: '2026-11-02T00:00:00Z', type: kind(e.name), identity: identity(full), owner_only: 'never-forwarded' }
      })
      json(200, { entries, truncated: false, upload_allowed: state.uploadAllowed, app_data_prefixes: state.appData }); return
    }
    const file = join(root, ...rel(u.searchParams.get('path')))
    if (u.pathname === '/api/files/thumbnail') { res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length) }); res.end(JPEG); return }
    if (u.pathname === '/api/files/content' && existsSync(file)) {
      const body = readFileSync(file), etag = `"${sha(Buffer.from(u.searchParams.get('path') + '|' + identity(file)))}"`
      const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''))
      const [s, e] = m ? [Number(m[1]), Math.min(Number(m[2]), body.length - 1)] : [0, body.length - 1]
      res.writeHead(m ? 206 : 200, { 'content-type': 'application/octet-stream', etag, 'content-length': String(e - s + 1), ...(m ? { 'content-range': `bytes ${s}-${e}/${body.length}` } : {}) })
      res.end(req.method === 'HEAD' ? undefined : body.subarray(s, e + 1)); return
    }
    json(404, { error: 'not_found' })
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => { server.closeAllConnections?.(); server.close(r) }))
  return { state, port: address.port }
}

async function box({ granted = FILES_OPS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bt-files-'))
  resources.push(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'media'); mkdirSync(join(root, 'Documents'), { recursive: true }); mkdirSync(join(root, 'AppData'), { recursive: true })
  const clip = randomBytes(300_000); writeFileSync(join(root, 'Documents', 'synthetic-clip.mp4'), clip)
  writeFileSync(join(root, 'Documents', 'synthetic-photo.jpg'), JPEG)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ clock: { timezone: 'Asia/Bangkok' } }))
  const up = await filesApp(root)
  const appsJsonPath = join(dir, 'apps.json')
  const key = randomBytes(32).toString('hex')   // WAM's credential file; generated at runtime, never a literal
  const write = (ops: string[]) => {
    const doc = JSON.parse(readFileSync(new URL('media-granted.json', FIXTURES), 'utf8'))
    const app = doc.apps.find((a: any) => a.id === 'notifications')
    app.id = 'wizard-files'; app.name = 'Wizard Files'; app.view = { url: `http://127.0.0.1:${up.port}/` }
    app.browser = { ...app.browser, installation_id: 'inst-' + 'f'.repeat(32), source_id: 'standard:humanitylabs-org/wizard-files', upstream: `http://127.0.0.1:${up.port}`,
      contract: { ...app.browser.contract, operations: [...FILES_OPS] }, granted: ops,
      listener_credential: { ...app.browser.listener_credential, ref: `browser-app-credentials/inst-${'f'.repeat(32)}.key` } }
    doc.apps = [app]
    writeFileSync(appsJsonPath, JSON.stringify(doc))
    return app.browser
  }
  const b = write(granted)
  mkdirSync(join(dir, 'browser-app-credentials'), { recursive: true })
  writeFileSync(join(dir, 'browser-app-credentials', `${b.installation_id}.key`), key + '\n', { mode: 0o600 })
  up.state.key = key
  const probe = createServer(); const cp = (await listen(probe)).port; await new Promise(r => probe.close(r))
  const server = createWizardServer({
    requireAccess: false, upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture-key', ownerProof: PROOF,
    browserBoundary: { enabled: true, token: TOKEN },
    browserAdapterWam: { receiptsPath: join(dir, 'receipts.json'), content: { publicBase: `http://127.0.0.1:${cp}`, ttlMs: 60_000 } },
    hermesHome: join(dir, 'synthetic-hermes'), wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath,
    launcherPath: join(dir, 'launcher.json'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
    mediaRoot: join(dir, 'attachments'), mediaIndexPath: join(dir, 'state', 'media-files.json'),
    uploadStatePath: join(dir, 'state', 'uploads.sqlite3'), uploadReserveBytes: 0, userFilesRoot: root,
    runQueueStatePath: join(dir, 'state', 'queue.sqlite3'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
  } as any)
  const address = await listen(server)
  resources.push(() => new Promise(r => { server.closeAllConnections?.(); server.close(r) }))
  const cs = (server as any).browserContent.createServer()
  await new Promise<void>(r => cs.listen(cp, '127.0.0.1', () => r()))
  resources.push(() => new Promise(r => { cs.closeAllConnections?.(); cs.close(r) }))
  const shell = { 'X-Wizard-Shell-Token': TOKEN, 'X-Wizard-Owner-Proof': PROOF, cookie: 'wos=ambient' }
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/wizard/v1/browser-adapters/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...shell }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  const chunk = async (ticket: string, offset: number, bytes: Buffer, hash = sha(bytes)) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/wizard/v1/browser-adapters/upload-chunk`, { method: 'POST', body: bytes,
      headers: { ...shell, 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset), 'x-wizard-upload-ticket': ticket, 'x-wizard-chunk-sha256': hash } })
    return { status: r.status, body: await r.json() }
  }
  let n = 0
  const bind = async () => {
    const generation = randomUUID()
    const r = await post('bindings', { appId: 'wizard-files', generation })
    expect(r.status).toBe(200)
    const call = (operation: string, args: unknown) => post('call', { handle: r.body.handle, generation, requestId: 'wbs-' + (++n), operation, args })
    return Object.assign(call, { handle: r.body.handle as string })
  }
  const raw = (url: string, headers: Record<string, string> = {}) => new Promise<{ status: number, headers: Record<string, any>, body: Buffer }>((resolve, reject) => {
    const req = httpRequest(url, { headers }, res => { const parts: Buffer[] = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) })); res.on('error', reject) })
    req.on('error', reject); req.end()
  })
  return { up, bind, post, chunk, raw, write, root, clip, contentPort: cp }
}

describe('files.*: the Files view reads and uploads only through typed, granted operations (default-off)', () => {
  it('declares five reviewed operations; inline content types are a closed allow-list', () => {
    expect(Object.fromEntries(FILES_OPS.map(k => [k, OPERATIONS[k]]))).toEqual({
      'files.list': { kind: 'read' }, 'files.index': { kind: 'read' }, 'files.thumbnail': { kind: 'read' }, 'files.content': { kind: 'media' }, 'files.upload': { kind: 'upload' } })
    expect(safeMime('a.mp4')).toBe('video/mp4')
    for (const n of ['page.html', 'x.svg', 'run.js', 'noext']) expect(safeMime(n), n).toBe('application/octet-stream')
  })

  it('files.list returns exact rows with opaque per-binding resource ids; the app sees only its credential, never ambient authority', async () => {
    const t = await box()
    const call = await t.bind()
    const r = await call('files.list', { folder: 'Documents', scope: 'personal' })
    expect(r.status).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual(['app_data_prefixes', 'entries', 'folder', 'scope', 'truncated', 'upload_allowed'])
    const clip = r.body.entries.find((e: any) => e.name === 'synthetic-clip.mp4')
    expect(Object.keys(clip).sort()).toEqual(['is_dir', 'mtime', 'name', 'path', 'resource', 'size', 'type'])
    expect(clip.resource).toMatch(/^fr_[A-Za-z0-9_-]{22}$/)
    expect(JSON.stringify(r.body)).not.toContain('never-forwarded')
    // Another binding cannot use this binding's resource id.
    const other = await t.bind()
    expect((await other('files.content', { resourceId: clip.resource, purpose: 'read' })).body.error).toBe('not_found')
    expect(t.up.state.refused).toBe(0)
    for (const h of t.up.state.seen) { expect(h['x-wizard-app-credential']).toBe(t.up.state.key); for (const a of AMBIENT) expect(h[a]).toBeUndefined() }
  })

  it('refuses traversal, unknown arguments and ungranted operations before reaching the app', async () => {
    const t = await box({ granted: ['files.list'] })
    const call = await t.bind()
    const before = t.up.state.seen.length
    for (const folder of ['../outside', 'Documents/../..', '.wizard-uploads', 'a\\b', 'C:x']) expect((await call('files.list', { folder, scope: 'personal' })).body.error, folder).toBe('bad_request')
    expect((await call('files.list', { folder: '', scope: 'personal', path: '/etc' })).body.error).toBe('bad_request')
    expect(t.up.state.seen.length).toBe(before)
    for (const [op, args] of [['files.index', { q: '', type: '', scope: 'personal', sender: '', offset: 0, limit: 10, snapshot: '' }], ['files.upload.create', { folder: 'Documents', filename: 'x.txt', mime: 'text/plain', bytes: 1, clientUploadId: 'client-0001' }]] as const) {
      const r = await call(op, args)
      expect([r.status, r.body.error], op).toEqual([403, 'not_allowed'])
    }
  })

  it('files.content mints a Range ticket on the content origin that streams exact bytes; a changed file ends it', async () => {
    const t = await box()
    const call = await t.bind()
    const clip = (await call('files.list', { folder: 'Documents', scope: 'personal' })).body.entries.find((e: any) => e.name === 'synthetic-clip.mp4')
    const r = await call('files.content', { resourceId: clip.resource, purpose: 'play' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ kind: 'ticket', mime: 'video/mp4', bytes: t.clip.length, methods: ['GET', 'HEAD'], range: true })
    expect(r.body.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${t.contentPort}/t/[A-Za-z0-9_-]{43}$`))
    expect(r.body.url).not.toContain('synthetic')
    const part = await t.raw(r.body.url, { range: 'bytes=200000-200999', cookie: 'wos=owner' })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe(`bytes 200000-200999/${t.clip.length}`)
    expect(part.body.equals(t.clip.subarray(200000, 201000))).toBe(true)
    expect(part.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" })
    const whole = await t.raw(r.body.url)
    expect(whole.status).toBe(200); expect(sha(whole.body)).toBe(sha(t.clip))
    writeFileSync(join(t.root, 'Documents', 'synthetic-clip.mp4'), randomBytes(t.clip.length))   // same size, new identity
    expect((await t.raw(r.body.url, { range: 'bytes=0-9' })).status).toBe(410)
    const thumb = await call('files.thumbnail', { resourceId: clip.resource })
    expect(thumb.body).toMatchObject({ mime: 'image/jpeg', bytes: JPEG.length }); expect(Buffer.from(thumb.body.data, 'base64').equals(JPEG)).toBe(true)
  })

  it('uploads through the port: per-chunk hash/offset, sha256 commit, readback through the app; byte-identical on disk', async () => {
    const t = await box()
    const call = await t.bind()
    const bytes = Buffer.concat([randomBytes(1024 * 1024), randomBytes(12345)])
    const c = await call('files.upload.create', { folder: 'Documents', filename: 'synthetic-upload.bin', mime: 'application/octet-stream', bytes: bytes.length, clientUploadId: 'client-' + randomUUID() })
    expect(c.status).toBe(200)
    expect(c.body).toMatchObject({ offset: 0, bytes: bytes.length, status: 'open', chunkBytes: 1024 * 1024 })
    expect(c.body.uploadId).toMatch(/^up_[0-9a-f]{32}$/); expect(c.body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const first = bytes.subarray(0, 1024 * 1024), rest = bytes.subarray(1024 * 1024)
    expect(await t.chunk(c.body.ticket, 0, first, sha(rest))).toMatchObject({ status: 422, body: { error: 'integrity' } })
    expect((await t.chunk(c.body.ticket, 0, Buffer.concat([first, Buffer.from('x')]))).status).toBe(413)
    expect((await t.chunk(c.body.ticket, 0, first)).body).toEqual({ offset: first.length })
    expect(await t.chunk(c.body.ticket, 0, rest)).toMatchObject({ status: 409, body: { error: 'offset_mismatch', offset: first.length } })
    expect((await t.chunk(c.body.ticket, first.length, rest)).body).toEqual({ offset: bytes.length })
    expect((await call('files.upload.status', { uploadId: c.body.uploadId })).body).toEqual({ uploadId: c.body.uploadId, offset: bytes.length, bytes: bytes.length, status: 'open' })
    expect((await call('files.upload.commit', { uploadId: c.body.uploadId, sha256: sha(randomBytes(8)), operationKey: randomUUID() })).body.error).toBe('integrity')
  })

  it('commit with the right hash lands the file and reads it back; a revoked grant refuses the very next chunk', async () => {
    const t = await box()
    const call = await t.bind()
    const bytes = randomBytes(5000)
    const create = (name: string, n: number) => call('files.upload.create', { folder: 'Documents', filename: name, mime: 'application/octet-stream', bytes: n, clientUploadId: 'client-' + randomUUID() })
    const c = await create('synthetic-landed.bin', bytes.length)
    expect((await t.chunk(c.body.ticket, 0, bytes)).body).toEqual({ offset: bytes.length })
    const key = randomUUID()
    const done = await call('files.upload.commit', { uploadId: c.body.uploadId, sha256: sha(bytes), operationKey: key })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ path: 'Documents/synthetic-landed.bin', folder: 'Documents', bytes: bytes.length, sha256: sha(bytes), operationKey: key })
    expect(done.body.resourceId).toMatch(/^fr_/)
    expect(sha(readFileSync(join(t.root, 'Documents', 'synthetic-landed.bin')))).toBe(sha(bytes))
    // Revoke files.upload in WAM state between two chunks of another upload: the next chunk is refused.
    const two = randomBytes(4000), c2 = await create('synthetic-revoked.bin', two.length)
    expect((await t.chunk(c2.body.ticket, 0, two.subarray(0, 2000))).body).toEqual({ offset: 2000 })
    t.write(FILES_OPS.filter(x => x !== 'files.upload'))
    expect(await t.chunk(c2.body.ticket, 2000, two.subarray(2000))).toMatchObject({ status: 403, body: { error: 'not_allowed' } })
    expect(existsSync(join(t.root, 'Documents', 'synthetic-revoked.bin'))).toBe(false)
    // Refused BEFORE the bytes were written: after a re-grant the upload still stands at 2000.
    t.write(FILES_OPS)
    expect((await call('files.upload.status', { uploadId: c2.body.uploadId })).body).toMatchObject({ offset: 2000, status: 'open' })
  })

  it('app-data folders refuse uploads; tickets are unknown to other bindings and die with a revoked binding; abort drops the upload', async () => {
    const t = await box()
    t.up.state.appData = ['AppData']
    const call = await t.bind()
    const args = (folder: string) => ({ folder, filename: 'x.bin', mime: 'application/octet-stream', bytes: 10, clientUploadId: 'client-' + randomUUID() })
    expect((await call('files.upload.create', args('AppData'))).body.error).toBe('not_allowed')
    const c = await call('files.upload.create', args('Documents'))
    const other = await t.bind()
    expect((await other('files.upload.status', { uploadId: c.body.uploadId })).status).toBe(200)   // same installation: visible status
    expect((await call('files.upload.abort', { uploadId: c.body.uploadId })).body).toEqual({ status: 'aborted' })
    expect((await t.chunk(c.body.ticket, 0, randomBytes(10))).body.error).toBe('expired')
    const c2 = await call('files.upload.create', args('Documents'))
    expect((await t.post('revoke', { handle: call.handle })).status).toBe(200)
    expect((await t.chunk(c2.body.ticket, 0, randomBytes(10))).body.error).toBe('expired')
    expect((await t.chunk('A'.repeat(43), 0, randomBytes(10))).body.error).toBe('expired')
  })
})
