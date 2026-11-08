// Large-file acceptance for resumable uploads, run on Thales (never on Telos):
//   node scripts/upload-large-acceptance.mjs <work dir on ThalesMedia> [bytes]
// Starts a fixture Hermes and the Agent Service (Wizard OS box mode, media root inside <work dir>) in a
// child process, then:
//   1. streams a <bytes> file (default 2 GiB) in 8 MiB PATCH chunks from disk, killing the connection
//      mid-chunk at ~40% and resuming from GET offset / the 409 offset, sampling the server's RSS;
//   2. shares it to a new thread and checks exactly one delivery under replayed completes;
//   3. sets the reserve so the file no longer fits and expects 507.
// Prints one JSON receipt. Generated files are removed at the end.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, rmSync, statfsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'

const work = resolve(process.argv[2] || '')
if (!process.argv[2]) { console.error('usage: upload-large-acceptance.mjs <work dir> [bytes]'); process.exit(2) }
const BYTES = Number(process.argv[3] || 2 * 1024 * 1024 * 1024)
const CHUNK = 8 * 1024 * 1024
mkdirSync(work, { recursive: true })
const source = join(work, 'source.bin')

async function makeSource() {
  const hash = createHash('sha256')
  const out = createWriteStream(source)
  const block = randomBytes(CHUNK)
  for (let written = 0; written < BYTES;) {
    const n = Math.min(CHUNK, BYTES - written)
    block[0] = written & 0xff; block[1] = (written >>> 8) & 0xff; block[2] = (written >>> 16) & 0xff; block[3] = (written >>> 24) & 0xff
    const piece = block.subarray(0, n)
    hash.update(piece)
    if (!out.write(Buffer.from(piece))) await once(out, 'drain')
    written += n
  }
  out.end(); await once(out, 'finish')
  return hash.digest('hex')
}

async function fakeHermes() {
  const runs = []
  const sessions = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url === '/v1/capabilities') return json(200, {})
    if (req.method === 'POST' && req.url === '/api/sessions') { sessions.push(JSON.parse(raw)); return json(201, { session: { id: JSON.parse(raw).id } }) }
    if (req.method === 'POST' && req.url === '/v1/runs') { runs.push(JSON.parse(raw)); return json(202, { run_id: `run_${runs.length}`, status: 'running' }) }
    if (req.method === 'GET' && req.url.startsWith('/v1/runs/')) return json(200, { status: 'completed' })
    json(404, {})
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { server, runs, sessions, origin: `http://127.0.0.1:${server.address().port}` }
}

async function startService(hermesOrigin, extraEnv = {}) {
  const env = {
    ...process.env, HOME: join(work, 'home'), HERMES_HOME: join(work, 'hermes'), WIZARD_OS_HOME: join(work, 'os'), TMPDIR: join(work, 'tmp'),
    WIZARD_HERMES_API_KEY: 'fixture-key', HERMES_ORIGIN: hermesOrigin, WIZARD_REQUIRE_CF_ACCESS: '0', WIZARD_PORT: '0',
    WIZARD_MEDIA_ROOT: join(work, 'media'), WIZARD_MEDIA_AGENT_ROOT: '/files', WIZARD_UPLOAD_STATE_PATH: join(work, 'state', 'uploads.sqlite3'),
    WIZARD_JOINED_DELEGATION: 'off', WIZARD_FOLLOW_THROUGH: 'off', WIZARD_STT_ENABLED: '0', WIZARD_AGENT_BRIDGE: 'off', ...extraEnv,
  }
  for (const dir of ['home', 'hermes', 'os', 'tmp']) mkdirSync(join(work, dir), { recursive: true })
  const child = spawn(process.execPath, ['scripts/upload-large-service.mjs'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  let buffer = ''
  const port = await new Promise((resolvePort, reject) => {
    child.stdout.on('data', (part) => {
      buffer += part
      const match = buffer.match(/LISTENING (\d+)/)
      if (match) resolvePort(Number(match[1]))
    })
    child.once('exit', (code) => reject(new Error(`service exited ${code}`)))
  })
  return { child, base: `http://127.0.0.1:${port}` }
}

const rssKb = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim())
const post = async (base, path, value) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); return { status: r.status, json: await r.json().catch(() => ({})) } }

function patchFromFile(base, id, offset, length, { killAfter = 0 } = {}) {
  return new Promise((resolveResult) => {
    const url = new URL(`${base}/wizard/v1/uploads/${id}`)
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset), 'Content-Length': String(length) } })
    req.on('response', (res) => { res.resume(); res.on('end', () => resolveResult({ status: res.statusCode, offset: Number(res.headers['upload-offset']) })) })
    req.on('error', () => resolveResult({ status: 0 }))
    const stream = createReadStream(source, { start: offset, end: offset + (killAfter || length) - 1, highWaterMark: 1024 * 1024 })
    stream.on('data', (part) => { if (!req.write(part)) { stream.pause(); req.once('drain', () => stream.resume()) } })
    stream.on('end', () => {
      if (killAfter) setTimeout(() => { req.destroy(); resolveResult({ status: 0, killed: true }) }, 200)
      else req.end()
    })
  })
}

async function upload(base, id, pid, samples, { killAt = -1 } = {}) {
  let offset = 0
  let killed = false
  let resumedFrom = -1
  let conflict = null
  while (offset < BYTES) {
    const length = Math.min(CHUNK, BYTES - offset)
    if (!killed && killAt >= 0 && offset >= killAt) {
      killed = true
      await patchFromFile(base, id, offset, length, { killAfter: Math.floor(length / 2) + 12345 })
      await new Promise((r) => setTimeout(r, 300))
      // A client that kept its pre-kill offset is told where the server is (409), then GET agrees.
      const stale = await fetch(`${base}/wizard/v1/uploads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset + length) }, body: Buffer.alloc(1) })
      conflict = { status: stale.status, body: await stale.json() }
      const status = await (await fetch(`${base}/wizard/v1/uploads/${id}`)).json()
      resumedFrom = status.offset
      offset = status.offset
      continue
    }
    const result = await patchFromFile(base, id, offset, length)
    if (result.status !== 204) throw new Error(`PATCH ${offset} → ${result.status}`)
    offset = result.offset
    if (samples.length < 100000) samples.push(rssKb(pid))
  }
  return { killed, resumedFrom, conflict }
}

const receipt = { host: execFileSync('hostname').toString().trim(), node: process.version, bytes: BYTES, work }
try {
  const t0 = Date.now()
  const digest = await makeSource()
  receipt.generate_ms = Date.now() - t0
  const hermes = await fakeHermes()
  let service = await startService(hermes.origin)
  receipt.rss_idle_kb = rssKb(service.child.pid)

  // 1. chat-attachment style upload with a killed connection at ~40%
  const samples = []
  const created = await post(service.base, '/wizard/v1/uploads', { client_upload_id: 'large-1', filename: 'large.bin', mime: 'application/octet-stream', bytes: BYTES, sha256: digest })
  receipt.create_status = created.status
  const t1 = Date.now()
  const killAt = Math.floor((BYTES * 0.4) / CHUNK) * CHUNK
  const run = await upload(service.base, created.json.upload_id, service.child.pid, samples, { killAt })
  const done = await post(service.base, `/wizard/v1/uploads/${created.json.upload_id}/complete`, {})
  receipt.upload = { ms: Date.now() - t1, killed_at: killAt, resumed_from: run.resumedFrom, stale_patch: run.conflict, complete_status: done.status, sha256_ok: done.json.file?.sha256 === digest, bytes_ok: done.json.file?.bytes === BYTES }
  receipt.rss_kb = { idle: receipt.rss_idle_kb, max: Math.max(...samples), min: Math.min(...samples), last: samples.at(-1), samples: samples.length, after_complete: rssKb(service.child.pid) }
  rmSync(join(work, 'media', 'Inbox'), { recursive: true, force: true })

  // 2. share of the same file to a new thread; replayed create + concurrent completes → one delivery
  const share = await post(service.base, '/wizard/v1/shares', { client_share_id: 'large-share-1', note: '', files: [{ filename: 'large.bin', bytes: BYTES, sha256: digest }] })
  const replay = await post(service.base, '/wizard/v1/shares', { client_share_id: 'large-share-1', note: '', files: [{ filename: 'large.bin', bytes: BYTES, sha256: digest }] })
  const shareUpload = share.json.uploads[0].upload_id
  const samples2 = []
  await upload(service.base, shareUpload, service.child.pid, samples2)
  const completes = await Promise.all([1, 2, 3].map(() => post(service.base, `/wizard/v1/uploads/${shareUpload}/complete`, {})))
  let status = null
  for (let i = 0; i < 600; i += 1) { status = (await (await fetch(`${service.base}/wizard/v1/shares/${share.json.share_id}`)).json()); if (status.status === 'delivered' || status.status === 'failed') break; await new Promise((r) => setTimeout(r, 100)) }
  await post(service.base, '/wizard/v1/shares', { client_share_id: 'large-share-1', note: '', files: [{ filename: 'large.bin', bytes: BYTES, sha256: digest }] })
  await new Promise((r) => setTimeout(r, 1500))
  receipt.share = { create: share.status, replay_same_id: replay.json.share_id === share.json.share_id, completes: completes.map((c) => c.status), status: status?.status, runs: hermes.runs.length, sessions_created: hermes.sessions.length, rss_max_kb: Math.max(...samples2) }
  service.child.kill('SIGTERM'); await once(service.child, 'exit')
  rmSync(join(work, 'media', 'Inbox'), { recursive: true, force: true })

  // 3. disk reserve: free − reserve < bytes → 507
  const info = statfsSync(work)
  const free = Number(info.bavail) * Number(info.bsize)
  service = await startService(hermes.origin, { WIZARD_UPLOAD_RESERVE_BYTES: String(free - Math.floor(BYTES / 2)), WIZARD_UPLOAD_STATE_PATH: join(work, 'state', 'uploads-2.sqlite3') })
  const refused = await post(service.base, '/wizard/v1/uploads', { client_upload_id: 'large-507', filename: 'large.bin', bytes: BYTES })
  const sharedRefused = await post(service.base, '/wizard/v1/shares', { client_share_id: 'large-507-share', files: [{ filename: 'large.bin', bytes: BYTES }] })
  receipt.reserve = { free_bytes: free, reserve_bytes: free - Math.floor(BYTES / 2), upload_status: refused.status, upload_body: refused.json, share_status: sharedRefused.status, runs_after: hermes.runs.length }
  service.child.kill('SIGTERM'); await once(service.child, 'exit')
  hermes.server.close()
} catch (error) {
  receipt.error = String(error?.stack || error)
} finally {
  rmSync(work, { recursive: true, force: true })
  receipt.cleaned = true
  console.log(JSON.stringify(receipt, null, 2))
}
