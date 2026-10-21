// Run stream keeper: a tiny long-lived process that holds the model-locked reply streams.
//
// Hermes runs a model-locked Wizard turn inside the open POST /api/sessions/<id>/chat/stream
// response and interrupts the turn the moment that connection closes. When the Agent Service
// owned the connection, every Agent Service restart (deploy, crash) cut every reply in flight.
// The keeper owns the connection instead and relays it to the Agent Service. If the Agent
// Service goes away, the keeper keeps reading until Hermes finishes, so the turn completes and
// the restarted service picks the result up through GET /v1/runs/<id> as usual.
//
// The keeper is deliberately small and is not restarted by Agent Service deploys. A deliberate
// stop (protocol error, wrong model) still reaches Hermes through POST /abort.
import { createServer, request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const STREAM_PATH = /^\/api\/sessions\/[A-Za-z0-9._:-]{1,180}\/chat\/stream$/
const FORWARD_HEADERS = ['authorization', 'content-type', 'accept', 'idempotency-key', 'x-hermes-session-key', 'x-hermes-author']
const MAX_BODY = 64 * 1024 * 1024

export function createRunStreamKeeper({ origin, fetchImpl = fetch, maxStreams = 64, log = () => {} }) {
  const upstreamOrigin = new URL(origin).origin
  const streams = new Map()
  const server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      const url = new URL(req.url, 'http://keeper')
      if (req.method === 'GET' && url.pathname === '/health') {
        send(200, { ok: true, streams: streams.size, detached: [...streams.values()].filter(s => s.detached).length,
          pid: process.pid, uptime_s: Math.round(process.uptime()) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/abort') {
        const stream = streams.get(url.searchParams.get('id') || '')
        if (stream) { stream.aborted = true; stream.controller.abort() }
        send(200, { aborted: Boolean(stream) })
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/open') { send(404, { error: 'not_found' }); return }
      const chunks = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { send(413, { error: 'too_large' }); return } chunks.push(chunk) }
      let spec
      try { spec = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { send(400, { error: 'invalid_json' }); return }
      if (!STREAM_PATH.test(String(spec.path || '')) || typeof spec.body !== 'string') { send(400, { error: 'invalid_stream_request' }); return }
      if (streams.size >= maxStreams) { send(503, { error: 'keeper_full' }); return }
      const headers = new Headers()
      for (const name of FORWARD_HEADERS) if (typeof spec.headers?.[name] === 'string') headers.set(name, spec.headers[name])
      const id = randomUUID()
      const controller = new AbortController()
      const stream = { id, path: spec.path, openedAt: Date.now(), detached: false, aborted: false, controller }
      streams.set(id, stream)
      let upstream
      try {
        upstream = await fetchImpl(upstreamOrigin + spec.path, { method: 'POST', headers, body: spec.body, redirect: 'manual', signal: controller.signal })
      } catch (error) {
        streams.delete(id)
        // Tell the caller whether Hermes could have received the request at all.
        const code = [error, error?.cause].map(e => e?.code).find(Boolean) || ''
        send(502, { error: 'upstream_unreachable', code })
        return
      }
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'X-Keeper-Stream': id, 'Cache-Control': 'no-cache' })
      res.flushHeaders()
      const detach = () => {
        if (stream.detached || res.writableEnded) return
        stream.detached = true
        if (!stream.aborted) log(`[run-stream-keeper] caller left; holding ${spec.path} until Hermes finishes`)
      }
      res.on('close', detach)
      res.on('error', detach)
      try {
        if (upstream.body) for await (const chunk of upstream.body) {
          if (!stream.detached) res.write(chunk)
        }
      } catch (error) {
        if (!stream.aborted) log(`[run-stream-keeper] upstream stream ended early: ${error?.message || error}`)
      } finally {
        streams.delete(id)
        if (!stream.detached) res.end()
        else if (!stream.aborted) log(`[run-stream-keeper] Hermes finished ${spec.path} after the caller left`)
      }
    } catch (error) {
      if (!res.headersSent) send(500, { error: 'keeper_error' })
      else res.destroy()
      log(`[run-stream-keeper] ${error?.stack || error}`)
    }
  })
  return { server, streams }
}

// Client side, used by the Agent Service. Resolves like fetch(): a Response whose body is the
// relayed SSE stream. `keeperStream` carries the id for abortKeeperStream.
export function keeperFetch(socketPath, { path, headers, body }) {
  return new Promise((resolve, reject) => {
    const plain = {}
    for (const [name, value] of new Headers(headers)) plain[name] = value
    const payload = JSON.stringify({ path, headers: plain, body })
    const req = httpRequest({ socketPath, path: '/open', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      if (res.statusCode === 502 && res.headers['x-keeper-stream'] === undefined) {
        const parts = []
        res.on('data', c => parts.push(c)).on('end', () => {
          let info = {}
          try { info = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch {}
          // Same shape as a direct connect failure so the caller's "never sent" logic still applies.
          reject(Object.assign(new Error('Hermes unreachable via run stream keeper'), { cause: { code: info.code || 'ECONNREFUSED' } }))
        }).on('error', reject)
        return
      }
      const response = new Response(Readable.toWeb(res), { status: res.statusCode,
        headers: { 'content-type': String(res.headers['content-type'] || '') } })
      Object.defineProperty(response, 'keeperStream', { value: String(res.headers['x-keeper-stream'] || '') })
      resolve(response)
    })
    req.on('error', reject)
    req.end(payload)
  })
}

export function abortKeeperStream(socketPath, id) {
  if (!id) return Promise.resolve(false)
  return new Promise((resolve) => {
    const req = httpRequest({ socketPath, path: '/abort?id=' + encodeURIComponent(id), method: 'POST' }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode === 200))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(5_000, () => { req.destroy(); resolve(false) })
    req.end()
  })
}

// The keeper is unreachable (not installed, stopped): the caller falls back to a direct stream.
export function keeperUnavailable(error) {
  return ['ENOENT', 'ECONNREFUSED'].includes(error?.code) && error?.syscall === 'connect'
}

export function defaultKeeperSocket(env = process.env, home = env.HOME || '') {
  if (env.WIZARD_RUN_KEEPER_SOCKET !== undefined) return env.WIZARD_RUN_KEEPER_SOCKET
  const state = env.WIZARD_RUN_QUEUE_STATE_PATH ? dirname(env.WIZARD_RUN_QUEUE_STATE_PATH)
    : `${env.HERMES_HOME || `${home}/.hermes`}/state/wizard-mobile`
  return `${state}/run-stream-keeper.sock`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const socketPath = defaultKeeperSocket(process.env, homedir())
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  if (existsSync(socketPath)) rmSync(socketPath)
  const { server, streams } = createRunStreamKeeper({ origin: process.env.HERMES_ORIGIN || 'http://127.0.0.1:8642',
    log: (line) => process.stdout.write(line + '\n') })
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600)
    process.stdout.write(`[run-stream-keeper] listening on ${socketPath}\n`)
  })
  // Stopping the keeper waits for the streams it holds, so a keeper restart cuts no reply either:
  // it stops taking new streams at once (the Agent Service then streams directly) and exits
  // when Hermes has finished the held ones. A second signal exits immediately.
  let stopping = false
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (stopping) { process.stdout.write(`[run-stream-keeper] forced stop with ${streams.size} open stream(s)\n`); process.exit(0) }
    stopping = true
    process.stdout.write(`[run-stream-keeper] stopping; waiting for ${streams.size} open stream(s)\n`)
    server.close()
    const check = setInterval(() => { if (streams.size === 0) { clearInterval(check); process.exit(0) } }, 500)
  })
}
