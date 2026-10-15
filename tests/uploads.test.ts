// Resumable uploads (/wizard/v1/uploads) and shares (/wizard/v1/shares): wizard-os spec/AGENT_SERVICE_API.md.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { createUploadStore } from '../server/uploads.mjs'
import { createMediaFiles } from '../server/media-files.mjs'

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }
const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve) => server.close(() => resolve()))

afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }) })

type Hermes = { origin: string, sessions: Map<string, { title?: string }>, runs: { key: string, body: any }[], sessionCreates: any[] }
async function fakeHermes(): Promise<Hermes> {
  const state: Hermes = { origin: '', sessions: new Map([['existing-thread', {}]]), runs: [], sessionCreates: [] }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const part of req) chunks.push(part as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    const url = new URL(req.url ?? '/', 'http://hermes')
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && url.pathname === '/v1/capabilities') return json(200, { features: { response_rendering: { modes: ['markdown'] } } })
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      state.sessionCreates.push(body)
      if (state.sessions.has(body.id)) return json(409, { error: 'session_exists' })
      state.sessions.set(body.id, { title: body.title })
      return json(201, { session: { id: body.id, title: body.title ?? null } })
    }
    const session = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && session) return state.sessions.has(session[1]) ? json(200, { session: { id: session[1] } }) : json(404, { error: 'not_found' })
    if (req.method === 'POST' && url.pathname === '/v1/runs') {
      state.runs.push({ key: String(req.headers['idempotency-key'] ?? ''), body })
      return json(202, { run_id: `run_${state.runs.length}`, status: 'running' })
    }
    const run = url.pathname.match(/^\/v1\/runs\/([^/]+)$/)
    if (req.method === 'GET' && run) return json(200, { id: run[1], run_id: run[1], status: 'completed' })
    json(404, { error: 'not_found' })
  })
  servers.push(server)
  const address = await listen(server)
  state.origin = `http://127.0.0.1:${address.port}`
  return state
}

type Box = { base: string, hermes: Hermes, dir: string, server: ReturnType<typeof createWizardServer> }
async function box(extra: Record<string, unknown> = {}, hermes?: Hermes): Promise<Box> {
  hermes ??= await fakeHermes()
  const dir = tmp('wizard-uploads-')
  const server = createWizardServer({
    requireJoinedDelegationCapability: false,
    upstreamOrigin: hermes.origin,
    hermesKey: 'fixture-key',
    requireAccess: false,
    followThrough: false,
    mediaRoot: join(dir, 'media'),
    mediaAgentRoot: '/files',
    mediaIndexPath: join(dir, 'state', 'media-files.json'),
    uploadStatePath: join(dir, 'state', 'uploads.sqlite3'),
    uploadReserveBytes: 0,
    runQueueStatePath: join(dir, 'state', 'queue.sqlite3'),
    runQueuePollIntervalMs: 0,
    activeSessionReader: async () => [],
    dispatchHealthReader: () => true,
    ...extra,
  })
  servers.push(server)
  const address = await listen(server)
  return { base: `http://127.0.0.1:${address.port}`, hermes, dir, server }
}

const post = (base: string, path: string, value: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
const patch = (base: string, id: string, offset: number, data: Buffer) => fetch(`${base}/wizard/v1/uploads/${id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) }, body: data,
})
async function sendAll(base: string, id: string, data: Buffer, chunk = 8 * 1024 * 1024, from = 0) {
  let offset = from
  while (offset < data.length) {
    const response = await patch(base, id, offset, data.subarray(offset, Math.min(data.length, offset + chunk)))
    expect(response.status).toBe(204)
    offset = Number(response.headers.get('upload-offset'))
  }
  return offset
}
const waitFor = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error('timed out')
}

afterEach(async () => { await Promise.all(servers.splice(0).map(close)) })

describe('bootstrap', () => {
  it('advertises resumable uploads and their endpoints', async () => {
    const { base } = await box()
    const payload = await (await fetch(`${base}/wizard/v1/bootstrap`)).json()
    expect(payload.capabilities.resumable_uploads).toBe(true)
    expect(payload.endpoints.uploads).toBe('/wizard/v1/uploads')
    expect(payload.endpoints.shares).toBe('/wizard/v1/shares')
    expect(payload.endpoints.upload).toBe('/wizard/files/upload')
  })

  it('does not advertise them without a files store', async () => {
    const { base } = await box({ mediaRoot: '' })
    const payload = await (await fetch(`${base}/wizard/v1/bootstrap`)).json()
    expect(payload.capabilities.resumable_uploads).toBe(false)
    expect(payload.endpoints.uploads).toBe('')
    expect((await post(base, '/wizard/v1/uploads', {})).status).toBe(503)
  })

  it('keeps the service up without resumable uploads when its state folder is not writable', async () => {
    const { base } = await box({ uploadStatePath: '/dev/null/uploads.sqlite3' })
    const payload = await (await fetch(`${base}/wizard/v1/bootstrap`)).json()
    expect(payload.capabilities.resumable_uploads).toBe(false)
    expect(payload.endpoints.uploads).toBe('')
    expect((await fetch(`${base}/wizard/files/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' })).status).toBe(201)
  })
})

describe('uploads', () => {
  it('uploads in chunks into Wizard Files and the file id works in a chat send', async () => {
    const { base, hermes, dir } = await box()
    const data = randomBytes(3 * 1024 * 1024 + 17)
    const created = await post(base, '/wizard/v1/uploads', { client_upload_id: 'c-1', filename: 'clip.mp4', mime: 'video/mp4', bytes: data.length, sha256: sha(data) })
    expect(created.status).toBe(201)
    const upload = await created.json()
    expect(upload).toMatchObject({ offset: 0, bytes: data.length, chunk_bytes: 8 * 1024 * 1024, status: 'uploading' })
    expect(upload.upload_id).toMatch(/^up_[0-9a-f]{32}$/)
    expect(await sendAll(base, upload.upload_id, data, 1024 * 1024)).toBe(data.length)
    const done = await post(base, `/wizard/v1/uploads/${upload.upload_id}/complete`, {})
    expect(done.status).toBe(200)
    const { file } = await done.json()
    expect(file).toMatchObject({ filename: 'clip.mp4', mime: 'video/mp4', bytes: data.length, sha256: sha(data), status: 'ready' })
    expect(file.id).toMatch(/^wf_[0-9a-f]{32}$/)
    expect(Object.keys(file).sort()).toEqual(['bytes', 'created_at', 'duplicate_of', 'filename', 'id', 'mime', 'note', 'sha256', 'source', 'status'])
    const day = new Date().toISOString().slice(0, 10)
    expect(sha(readFileSync(join(dir, 'media', 'Inbox', day, 'clip.mp4')))).toBe(sha(data))
    expect(readdirSync(join(dir, 'media', '.wizard-uploads'))).toEqual([])
    // complete is idempotent; GET reports the file
    expect((await (await post(base, `/wizard/v1/uploads/${upload.upload_id}/complete`, {})).json()).file.id).toBe(file.id)
    expect(await (await fetch(`${base}/wizard/v1/uploads/${upload.upload_id}`)).json()).toMatchObject({ offset: data.length, status: 'complete', file: { id: file.id } })
    // the same file id is a wizard_file_id in a normal chat send
    const sent = await fetch(`${base}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'send-1' }, body: JSON.stringify({ session_id: 'existing-thread', input: 'look', wizard_file_ids: [file.id] }) })
    expect(sent.status).toBe(202)
    await waitFor(() => hermes.runs.length === 1)
    expect(hermes.runs[0].body.input).toContain('[WIZARD_FILES_V1]')
    expect(hermes.runs[0].body.input).toContain(`/files/Inbox/${day}/clip.mp4`)
  })

  it('has no 64 MB cap: a 70 MB file goes through (more than the old route allowed)', async () => {
    const { base } = await box()
    const data = Buffer.alloc(70 * 1024 * 1024, 3)
    const upload = await (await post(base, '/wizard/v1/uploads', { client_upload_id: 'big-70', filename: 'big.bin', bytes: data.length })).json()
    await sendAll(base, upload.upload_id, data)
    const { file } = await (await post(base, `/wizard/v1/uploads/${upload.upload_id}/complete`, {})).json()
    expect(file.bytes).toBe(data.length)
    expect(file.sha256).toBe(sha(data))
  })

  it('is idempotent on client_upload_id and returns the current offset', async () => {
    const { base } = await box()
    const data = randomBytes(1000)
    const first = await (await post(base, '/wizard/v1/uploads', { client_upload_id: 'same', filename: 'a.txt', bytes: 1000 })).json()
    await patch(base, first.upload_id, 0, data.subarray(0, 400))
    const again = await post(base, '/wizard/v1/uploads', { client_upload_id: 'same', filename: 'a.txt', bytes: 1000 })
    expect(again.status).toBe(201)
    expect(await again.json()).toMatchObject({ upload_id: first.upload_id, offset: 400, status: 'uploading' })
    expect((await post(base, '/wizard/v1/uploads', { client_upload_id: 'same', filename: 'a.txt', bytes: 999 })).status).toBe(409)
  })

  it('answers an offset mismatch with 409 and the server offset', async () => {
    const { base } = await box()
    const upload = await (await post(base, '/wizard/v1/uploads', { client_upload_id: 'mm', filename: 'a.bin', bytes: 100 })).json()
    expect((await patch(base, upload.upload_id, 0, Buffer.alloc(30))).status).toBe(204)
    const wrong = await patch(base, upload.upload_id, 10, Buffer.alloc(30))
    expect(wrong.status).toBe(409)
    expect(wrong.headers.get('upload-offset')).toBe('30')
    expect(await wrong.json()).toEqual({ error: 'offset_mismatch', offset: 30 })
    const early = await post(base, `/wizard/v1/uploads/${upload.upload_id}/complete`, {})
    expect(early.status).toBe(409)
    expect(await early.json()).toEqual({ error: 'upload_incomplete', offset: 30 })
  })

  it('resumes after a connection killed mid-chunk from the last durable byte', async () => {
    const { base } = await box()
    const data = randomBytes(6 * 1024 * 1024)
    const upload = await (await post(base, '/wizard/v1/uploads', { client_upload_id: 'killed', filename: 'k.bin', bytes: data.length, sha256: sha(data) })).json()
    const url = new URL(`${base}/wizard/v1/uploads/${upload.upload_id}`)
    // Declare a 4 MiB chunk, send 1.5 MiB of it, then kill the socket.
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', 'Content-Length': String(4 * 1024 * 1024) } })
      req.on('error', () => resolve())
      req.write(data.subarray(0, 1536 * 1024), () => setTimeout(() => { req.destroy(); resolve() }, 150))
    })
    let offset = 0
    await waitFor(async () => { offset = (await (await fetch(url)).json()).offset; return offset > 0 })
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThanOrEqual(1536 * 1024)
    // A client that thinks it is further along is told where the server is.
    const stale = await patch(base, upload.upload_id, 4 * 1024 * 1024, data.subarray(4 * 1024 * 1024))
    expect(stale.status).toBe(409)
    expect((await stale.json()).offset).toBe(offset)
    await sendAll(base, upload.upload_id, data, 2 * 1024 * 1024, offset)
    const { file } = await (await post(base, `/wizard/v1/uploads/${upload.upload_id}/complete`, {})).json()
    expect(file.sha256).toBe(sha(data))
  })

  it('fails a sha256 mismatch and keeps nothing', async () => {
    const { base, dir } = await box()
    const data = randomBytes(2048)
    const upload = await (await post(base, '/wizard/v1/uploads', { client_upload_id: 'bad-sha', filename: 'x.bin', bytes: 2048, sha256: sha(Buffer.alloc(2048)) })).json()
    await sendAll(base, upload.upload_id, data)
    const done = await post(base, `/wizard/v1/uploads/${upload.upload_id}/complete`, {})
    expect(done.status).toBe(422)
    expect(await done.json()).toEqual({ error: 'sha256_mismatch' })
    expect(await (await fetch(`${base}/wizard/v1/uploads/${upload.upload_id}`)).json()).toMatchObject({ status: 'failed', error: 'sha256_mismatch' })
    expect(existsSync(join(dir, 'media', 'Inbox'))).toBe(false)
    expect(readdirSync(join(dir, 'media', '.wizard-uploads'))).toEqual([])
  })

  it('refuses with 507 when the file would not fit (free − reserve), and honours the box cap', async () => {
    const tight = await box({ uploadReserveBytes: 1000, uploadStatfs: () => ({ bavail: 3, bsize: 1024 }) })
    const no = await post(tight.base, '/wizard/v1/uploads', { client_upload_id: 'nofit', filename: 'a', bytes: 3000 })
    expect(no.status).toBe(507)
    expect(await no.json()).toEqual({ error: 'insufficient_storage' })
    expect((await post(tight.base, '/wizard/v1/uploads', { client_upload_id: 'fits', filename: 'a', bytes: 2000 })).status).toBe(201)
    // the 2000 bytes still owed to the open upload are counted against the next one
    expect((await post(tight.base, '/wizard/v1/uploads', { client_upload_id: 'fits-2', filename: 'a', bytes: 100 })).status).toBe(507)
    const capped = await box({ uploadMaxBytes: 500 })
    expect((await post(capped.base, '/wizard/v1/uploads', { client_upload_id: 'cap', filename: 'a', bytes: 501 })).status).toBe(507)
    expect((await post(capped.base, '/wizard/v1/uploads', { client_upload_id: 'cap2', filename: 'a', bytes: 500 })).status).toBe(201)
  })

  it('rejects oversized chunks, bad offsets and the wrong content type', async () => {
    const { base } = await box()
    const upload = await (await post(base, '/wizard/v1/uploads', { client_upload_id: 'rules', filename: 'a', bytes: 10 })).json()
    expect((await patch(base, upload.upload_id, 0, Buffer.alloc(11))).status).toBe(413)
    expect((await fetch(`${base}/wizard/v1/uploads/${upload.upload_id}`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain', 'Upload-Offset': '0' }, body: 'x' })).status).toBe(415)
    expect((await fetch(`${base}/wizard/v1/uploads/${upload.upload_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '-1' }, body: 'x' })).status).toBe(400)
    expect((await fetch(`${base}/wizard/v1/uploads/up_${'0'.repeat(32)}`)).status).toBe(404)
  })

  it('keeps the old /wizard/files/upload route working', async () => {
    const { base } = await box()
    const response = await fetch(`${base}/wizard/files/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Wizard-Filename': 'old.txt', 'X-Wizard-Mime': 'text/plain' }, body: 'hello' })
    expect(response.status).toBe(201)
    expect((await response.json()).file).toMatchObject({ filename: 'old.txt', bytes: 5, mime: 'text/plain' })
  })
})

describe('shares', () => {
  const files = (a: Buffer, b: Buffer) => [{ filename: 'one.pdf', mime: 'application/pdf', bytes: a.length, sha256: sha(a) }, { filename: 'two.jpg', mime: 'image/jpeg', bytes: b.length }]

  it('delivers exactly once to a new thread on the default agent, even with concurrent and replayed completes', async () => {
    const { base, hermes } = await box()
    const a = randomBytes(5000), b = randomBytes(7000)
    const created = await post(base, '/wizard/v1/shares', { client_share_id: 'share-1', note: 'Please file these', files: files(a, b) })
    expect(created.status).toBe(201)
    const share = await created.json()
    expect(share).toMatchObject({ agent: 'hermes', status: 'uploading' })
    expect(share.share_id).toMatch(/^sh_[0-9a-f]{32}$/)
    expect(share.thread_id).toMatch(/^wizard_\d+_[0-9a-f]{12}$/)
    expect(share.uploads).toHaveLength(2)
    expect(share.uploads[0]).toMatchObject({ offset: 0, bytes: 5000, chunk_bytes: 8 * 1024 * 1024 })
    // replayed create → the same share
    const replay = await (await post(base, '/wizard/v1/shares', { client_share_id: 'share-1', note: 'Please file these', files: files(a, b) })).json()
    expect(replay.share_id).toBe(share.share_id)
    expect(replay.uploads.map((u: any) => u.upload_id)).toEqual(share.uploads.map((u: any) => u.upload_id))
    await sendAll(base, share.uploads[0].upload_id, a)
    await sendAll(base, share.uploads[1].upload_id, b)
    expect(hermes.runs).toHaveLength(0)
    const completes = await Promise.all([0, 1, 0, 1, 1, 0].map((i) => post(base, `/wizard/v1/uploads/${share.uploads[i].upload_id}/complete`, {})))
    expect(completes.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    await waitFor(async () => (await (await fetch(`${base}/wizard/v1/shares/${share.share_id}`)).json()).status === 'delivered')
    for (let i = 0; i < 3; i += 1) await post(base, `/wizard/v1/uploads/${share.uploads[i % 2].upload_id}/complete`, {})
    await post(base, '/wizard/v1/shares', { client_share_id: 'share-1', note: 'Please file these', files: files(a, b) })
    await new Promise((r) => setTimeout(r, 200))
    expect(hermes.runs).toHaveLength(1)
    expect(hermes.sessionCreates.filter((s) => s.id === share.thread_id)).toHaveLength(1)
    expect(hermes.sessionCreates[0]).toMatchObject({ source: 'wizard-mobile', id: share.thread_id, title: 'one.pdf' })
    const run = hermes.runs[0]
    expect(run.key).toMatch(/^wizardq_|^share-/)
    expect(run.body.session_id).toBe(share.thread_id)
    expect(run.body.input.startsWith('Please file these')).toBe(true)
    expect(run.body.input).toContain('one.pdf')
    expect(run.body.input).toContain('two.jpg')
    const status = await (await fetch(`${base}/wizard/v1/shares/${share.share_id}`)).json()
    expect(status).toMatchObject({ share_id: share.share_id, status: 'delivered', thread_id: share.thread_id, agent: 'hermes' })
  })

  it('delivers behind Cloudflare Access with its in-process token, which a client cannot forge', async () => {
    const accessVerifier = async (token: string) => { if (token !== 'good-jwt') throw new Error('denied'); return { email: 'owner@example.com' } }
    const { base, hermes } = await box({ requireAccess: true, accessVerifier })
    const A = { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'good-jwt' }
    expect((await post(base, '/wizard/v1/shares', { client_share_id: 'acc', files: [{ filename: 'a', bytes: 3 }] })).status).toBe(403)
    const share = await (await fetch(`${base}/wizard/v1/shares`, { method: 'POST', headers: A, body: JSON.stringify({ client_share_id: 'acc', files: [{ filename: 'a', bytes: 3 }] }) })).json()
    const up = share.uploads[0].upload_id
    expect((await fetch(`${base}/wizard/v1/uploads/${up}`, { method: 'PATCH', headers: { ...A, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: Buffer.from('abc') })).status).toBe(204)
    expect((await fetch(`${base}/wizard/v1/uploads/${up}/complete`, { method: 'POST', headers: A, body: '{}' })).status).toBe(200)
    await waitFor(() => hermes.runs.length === 1)
    const forged = await fetch(`${base}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'x', 'X-Wizard-Internal-Token': 'a'.repeat(64) }, body: JSON.stringify({ session_id: 'existing-thread', input: 'hi' }) })
    expect(forged.status).toBe(403)
  })

  it('uses a neutral line for an empty note and delivers into a given thread', async () => {
    const { base, hermes } = await box()
    const a = randomBytes(10)
    const share = await (await post(base, '/wizard/v1/shares', { client_share_id: 'share-2', thread: 'existing-thread', files: [{ filename: 'n.txt', bytes: 10 }] })).json()
    expect(share.thread_id).toBe('existing-thread')
    await sendAll(base, share.uploads[0].upload_id, a)
    await post(base, `/wizard/v1/uploads/${share.uploads[0].upload_id}/complete`, {})
    await waitFor(() => hermes.runs.length === 1)
    expect(hermes.sessionCreates).toHaveLength(0)
    expect(hermes.runs[0].body.input.startsWith('Shared 1 file')).toBe(true)
  })

  it('refuses an unknown agent with 409 (no fallback) and an unknown thread with 404', async () => {
    const { base, hermes } = await box()
    const unknown = await post(base, '/wizard/v1/shares', { client_share_id: 'share-3', agent: 'private', files: [{ filename: 'a', bytes: 1 }] })
    expect(unknown.status).toBe(409)
    expect(await unknown.json()).toMatchObject({ error: 'agent_unavailable' })
    const thread = await post(base, '/wizard/v1/shares', { client_share_id: 'share-4', thread: 'nope', files: [{ filename: 'a', bytes: 1 }] })
    expect(thread.status).toBe(404)
    expect(await thread.json()).toEqual({ error: 'thread_not_found' })
    expect((await post(base, '/wizard/v1/shares', { client_share_id: 'share-5', agent: 'hermes', files: [{ filename: 'a', bytes: 1 }] })).status).toBe(201)
    expect(hermes.runs).toHaveLength(0)
  })

  it('fails the share on a sha256 mismatch without delivering', async () => {
    const { base, hermes } = await box()
    const a = randomBytes(100)
    const share = await (await post(base, '/wizard/v1/shares', { client_share_id: 'share-6', files: [{ filename: 'a', bytes: 100, sha256: sha(Buffer.alloc(100)) }] })).json()
    await sendAll(base, share.uploads[0].upload_id, a)
    expect((await post(base, `/wizard/v1/uploads/${share.uploads[0].upload_id}/complete`, {})).status).toBe(422)
    const status = await (await fetch(`${base}/wizard/v1/shares/${share.share_id}`)).json()
    expect(status).toMatchObject({ status: 'failed', error: 'sha256_mismatch' })
    await new Promise((r) => setTimeout(r, 100))
    expect(hermes.runs).toHaveLength(0)
    expect(hermes.sessionCreates).toHaveLength(0)
  })

  it('refuses a share that does not fit with 507 and records nothing', async () => {
    const { base } = await box({ uploadReserveBytes: 0, uploadStatfs: () => ({ bavail: 10, bsize: 1024 }) })
    const response = await post(base, '/wizard/v1/shares', { client_share_id: 'share-7', files: [{ filename: 'a', bytes: 6000 }, { filename: 'b', bytes: 6000 }] })
    expect(response.status).toBe(507)
    expect(await response.json()).toEqual({ error: 'insufficient_storage' })
    expect((await post(base, '/wizard/v1/shares', { client_share_id: 'share-7', files: [{ filename: 'a', bytes: 6000 }] })).status).toBe(201)
  })
})

describe('upload store', () => {
  const localTarget = (dir: string, finalized: string[]) => () => ({
    kind: 'local', stagingDir: join(dir, 'staging'),
    finalize: async (path: string, meta: any) => { finalized.push(path); rmSync(path); return { id: `wf_${meta.key.slice(3)}`, filename: meta.filename, mime: meta.mime, bytes: meta.bytes, sha256: meta.sha256 } },
  })
  const body = (data: Buffer) => Object.assign((async function* () { yield data })(), { headers: { 'content-length': String(data.length) }, destroy() {} })

  it('expires incomplete uploads after 7 days and removes their bytes', async () => {
    const dir = tmp('wizard-upload-store-')
    let clock = Date.parse('2026-10-01T00:00:00Z')
    const store = createUploadStore({ statePath: join(dir, 'u.sqlite3'), target: localTarget(dir, []), deliverShare: async () => ({}), reserveBytes: 0, now: () => clock, log: () => {} })
    const { record } = await store.createUpload({ client_upload_id: 'old', filename: 'a', bytes: 10 })
    await store.patchUpload(record.id, 0, body(Buffer.alloc(4)))
    const { record: fresh } = await store.createUpload({ client_upload_id: 'fresh', filename: 'a', bytes: 10 })
    expect(existsSync(join(dir, 'staging', `${record.id}.part`))).toBe(true)
    clock += 6 * 86400_000
    await store.patchUpload(fresh.id, 0, body(Buffer.alloc(1)))
    clock += 1 * 86400_000 + 1000
    expect(store.sweep()).toBe(1)
    expect(store.upload(record.id)).toMatchObject({ status: 'failed', error: 'expired' })
    expect(store.upload(fresh.id)).toMatchObject({ status: 'uploading' })
    expect(existsSync(join(dir, 'staging', `${record.id}.part`))).toBe(false)
    await expect(store.patchUpload(record.id, 4, body(Buffer.alloc(1)))).rejects.toMatchObject({ status: 410 })
    store.close()
  })

  it('recovers a file the store already took when the service died before recording completion', async () => {
    const dir = tmp('wizard-upload-store-')
    const media = createMediaFiles({ mediaRoot: join(dir, 'media'), agentRoot: '/files', indexPath: join(dir, 'idx.json') })
    const target = () => ({ kind: 'local', stagingDir: media.stagingDir, finalize: async (path: string, meta: any) => media.adopt(path, meta), recover: async (key: string) => media.adopted(key) })
    const store = createUploadStore({ statePath: join(dir, 'u.sqlite3'), target, deliverShare: async () => ({}), reserveBytes: 0, log: () => {} })
    const { record } = await store.createUpload({ client_upload_id: 'crash', filename: 'c.txt', bytes: 3 })
    await store.patchUpload(record!.id, 0, body(Buffer.from('abc')))
    // the hand-over happened, then the process died before the upload record was marked complete
    const taken = media.adopt(join(media.stagingDir, `${record!.id}.part`), { filename: 'c.txt', mime: 'text/plain', bytes: 3, sha256: sha(Buffer.from('abc')), key: record!.id })
    const done = await store.completeUpload(record!.id)
    expect(JSON.parse(done.file_json).id).toBe(taken.id)
    expect(media.list().length).toBe(1)
    store.close()
  })

  it('retries a failed delivery and re-drives an interrupted one after a restart, delivering once', async () => {
    const dir = tmp('wizard-upload-store-')
    const deliveries: string[] = []
    let fail = true
    const deliverShare = async (share: any) => {
      deliveries.push(share.id)
      if (fail) { fail = false; throw Object.assign(new Error('down'), { status: 503 }) }
      return { run_id: 'run-1' }
    }
    const store = createUploadStore({ statePath: join(dir, 'u.sqlite3'), target: localTarget(dir, []), deliverShare, reserveBytes: 0, log: () => {} })
    const { share } = await store.createShare({ client_share_id: 's', note: '', files: [{ filename: 'a', bytes: 3 }] }, { agent: 'hermes', thread_id: 't', thread_new: true, target: 'files' })
    const upload = store.publicShare(share).uploads[0]
    await store.patchUpload(upload.upload_id, 0, body(Buffer.from('abc')))
    await store.completeUpload(upload.upload_id)
    await waitFor(() => store.getShare(share.id).attempts === 1)
    expect(store.getShare(share.id).status).toBe('delivering')
    store.close()
    // restart: the share is still 'delivering' and is re-driven
    const again = createUploadStore({ statePath: join(dir, 'u.sqlite3'), target: localTarget(dir, []), deliverShare, reserveBytes: 0, log: () => {} })
    await waitFor(() => again.getShare(share.id).status === 'delivered')
    expect(again.getShare(share.id).run_id).toBe('run-1')
    await again.maybeDeliver(share.id)
    expect(deliveries).toEqual([share.id, share.id])
    again.close()
  })
})

describe('Wizard Inbox drop backend (James\'s box)', () => {
  async function fakeInbox() {
    const uploads = new Map<string, { bytes: number, sha256: string, data: Buffer[], offset: number, status: string, drop: string }>()
    const files = new Map<string, any>()
    const chunkSizes: number[] = []
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://inbox')
      const parts: Buffer[] = []
      for await (const part of req) parts.push(part as Buffer)
      const raw = Buffer.concat(parts)
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
      if (req.headers.authorization !== 'Bearer inbox-token') return json(401, {})
      if (req.method === 'POST' && url.pathname === '/v1/drop/uploads') {
        const body = JSON.parse(raw.toString())
        if (body.bytes > 2 * 1024 * 1024 * 1024) return json(413, { error: 'size-rejected' })
        const id = `upl_${randomBytes(16).toString('hex')}`
        uploads.set(id, { bytes: body.bytes, sha256: body.sha256, data: [], offset: 0, status: 'UPLOADING', drop: '' })
        return json(201, { upload_id: id, offset: 0, status: 'UPLOADING', drop_id: null })
      }
      let m = url.pathname.match(/^\/v1\/drop\/uploads\/(upl_[0-9a-f]{32})\/chunks$/)
      if (req.method === 'POST' && m) {
        const upload = uploads.get(m[1])!
        if (Number(req.headers['upload-offset']) !== upload.offset) return json(409, { error: 'offset-mismatch' }, { 'Upload-Offset': String(upload.offset) })
        chunkSizes.push(raw.length)
        upload.data.push(raw); upload.offset += raw.length
        res.writeHead(204, { 'Upload-Offset': String(upload.offset) }); res.end(); return
      }
      m = url.pathname.match(/^\/v1\/drop\/uploads\/(upl_[0-9a-f]{32})\/complete$/)
      if (req.method === 'POST' && m) {
        const upload = uploads.get(m[1])!
        const body = JSON.parse(raw.toString())
        const data = Buffer.concat(upload.data)
        if (body.sha256 !== upload.sha256 || sha(data) !== upload.sha256) return json(422, { error: 'integrity-check-failed' })
        if (!upload.drop) {
          upload.drop = `drop_${randomBytes(16).toString('hex')}`
          files.set(upload.drop, { id: upload.drop, filename: 'from-inbox', mime: 'application/octet-stream', bytes: data.length, sha256: sha(data), created_at: '', source: 'Wizard app', status: 'ready', trusted_path: `/inbox/blobs/${sha(data)}` })
        }
        return json(200, { upload_id: m[1], drop_id: upload.drop, status: 'RECEIVED' })
      }
      m = url.pathname.match(/^\/v1\/drop\/uploads\/(upl_[0-9a-f]{32})$/)
      if (req.method === 'GET' && m) return json(200, { upload_id: m[1], offset: uploads.get(m[1])!.offset, status: 'UPLOADING' })
      m = url.pathname.match(/^\/v1\/internal\/files\/(drop_[0-9a-f]{32})$/)
      if (req.method === 'GET' && m) return files.has(m[1]) ? json(200, { file: files.get(m[1]) }) : json(404, {})
      json(404, {})
    })
    servers.push(server)
    const address = await listen(server)
    return { origin: `http://127.0.0.1:${address.port}`, uploads, chunkSizes }
  }

  it('streams chunks straight through when sha256 is declared, staging them otherwise', async () => {
    const inbox = await fakeInbox()
    const dir = tmp('wizard-drop-')
    const { base } = await box({ mediaRoot: '', inboxOrigin: inbox.origin, inboxToken: 'inbox-token', inboxTrustedRoot: '/inbox', uploadStagingDir: join(dir, 'staging') })
    const data = randomBytes(9 * 1024 * 1024 + 5)
    const streamed = await (await post(base, '/wizard/v1/uploads', { client_upload_id: 'drop-1', filename: 'v.mov', bytes: data.length, sha256: sha(data) })).json()
    expect(inbox.uploads.size).toBe(1)
    await sendAll(base, streamed.upload_id, data)
    expect(Math.max(...inbox.chunkSizes)).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(existsSync(join(dir, 'staging', `${streamed.upload_id}.part`))).toBe(false)
    const one = await (await post(base, `/wizard/v1/uploads/${streamed.upload_id}/complete`, {})).json()
    expect(one.file).toMatchObject({ bytes: data.length, sha256: sha(data) })
    expect(one.file.id).toMatch(/^drop_/)
    // no sha256: staged locally, pushed to the drop service at completion
    const other = randomBytes(5 * 1024 * 1024)
    const staged = await (await post(base, '/wizard/v1/uploads', { client_upload_id: 'drop-2', filename: 'w.bin', bytes: other.length })).json()
    await sendAll(base, staged.upload_id, other)
    expect(existsSync(join(dir, 'staging', `${staged.upload_id}.part`))).toBe(true)
    const two = await (await post(base, `/wizard/v1/uploads/${staged.upload_id}/complete`, {})).json()
    expect(two.file).toMatchObject({ bytes: other.length, sha256: sha(other) })
    expect(existsSync(join(dir, 'staging', `${staged.upload_id}.part`))).toBe(false)
  })

  it('maps the drop service size boundary and a streamed sha256 mismatch', async () => {
    const inbox = await fakeInbox()
    const dir = tmp('wizard-drop-')
    const { base } = await box({ mediaRoot: '', inboxOrigin: inbox.origin, inboxToken: 'inbox-token', inboxTrustedRoot: '/inbox', uploadStagingDir: join(dir, 'staging'), uploadStatfs: () => ({ bavail: 1e9, bsize: 4096 }) })
    const huge = await post(base, '/wizard/v1/uploads', { client_upload_id: 'drop-big', filename: 'x', bytes: 3 * 1024 * 1024 * 1024, sha256: 'a'.repeat(64) })
    expect(huge.status).toBe(413)
    expect(await huge.json()).toEqual({ error: 'file_too_large' })
    const data = randomBytes(1000)
    const bad = await (await post(base, '/wizard/v1/uploads', { client_upload_id: 'drop-bad', filename: 'x', bytes: 1000, sha256: sha(Buffer.alloc(1000)) })).json()
    await sendAll(base, bad.upload_id, data)
    expect((await post(base, `/wizard/v1/uploads/${bad.upload_id}/complete`, {})).status).toBe(422)
  })
})
