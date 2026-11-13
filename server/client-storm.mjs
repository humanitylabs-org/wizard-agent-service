// One looping device must only slow itself (issue 513). On 13 Nov a phone sent PUT /wizard/thread-seen (117 KB)
// up to ~8 times a second; 230 requests sat in flight and Chats froze on every device. This guard sits in
// front of every owner state write (PUT and PATCH under /wizard/):
//   1. identical concurrent writes from one device to one route (same body hash) share one in-flight result;
//   2. per device + route, writes in flight and writes per minute are capped; over the cap is a 429 with
//      Retry-After, never queued;
//   3. while it trips, one `[client-storm]` line per device + route per minute, and `summary()` for /wizard/health.
// A device is the forwarded-for chain, the socket address and the user agent, hashed: only a label for a bucket,
// never an identity, so it never grants or widens anything.
import { createHash } from 'node:crypto'
import { routeTemplate } from './speed-meter.mjs'

export const BUFFERED_BODY = Symbol('wizard.clientStorm.body')
export const CLIENT_STORM_IN_FLIGHT = 4
export const CLIENT_STORM_PER_MINUTE = 60
export const CLIENT_STORM_BODY_LIMIT = 1024 * 1024
const WINDOW_MS = 60_000
const SHOWN_MS = 2 * WINDOW_MS
const MAX_LANES = 2000
const WRITES = new Set(['PUT', 'PATCH'])
// Routes whose handler reads its body through readBoundedBody (which honours BUFFERED_BODY) and whose PUT replaces
// state, so a repeat of the same body has the same result. Other writes are capped but never shared.
export const COALESCED_ROUTES = new Set(['/wizard/thread-seen', '/wizard/thread-dispositions', '/wizard/v1/ui-preferences', '/wizard/v1/workspaces'])
// Everything that decides who the caller is or what it may see is part of the shared-result key.
const IDENTITY = ['authorization', 'cookie', 'tailscale-user-login', 'tailscale-user-name', 'cf-access-jwt-assertion', 'x-wizard-owner-proof', 'x-wizard-shell-token', 'origin', 'host', 'x-forwarded-host', 'content-type', 'sec-fetch-site']

export function deviceOf(request) {
  const hash = createHash('sha256')
  for (const part of [request.headers?.['x-forwarded-for'], request.socket?.remoteAddress, request.headers?.['user-agent']]) hash.update(String(part ?? '')).update('\0')
  return `d-${hash.digest('hex').slice(0, 10)}`
}

async function readExact(request, size) {
  const parts = []
  let total = 0
  for await (const part of request) {
    total += part.length
    if (total > size) throw Object.assign(new Error('too large'), { status: 413 })
    parts.push(part)
  }
  return Buffer.concat(parts)
}

// Records what the leading request answers so identical followers can be given the same bytes.
function capture(response) {
  const out = { status: 0, headers: null, chunks: [], ended: false, shareable: true }
  const { writeHead, write, end } = response
  const keep = (chunk, encoding) => {
    if (chunk == null || typeof chunk === 'function') return
    out.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined))
  }
  response.writeHead = function (status, ...rest) {
    out.status = status
    const headers = rest.find(value => value && typeof value === 'object')
    if (Array.isArray(headers)) out.shareable = false
    else if (headers) out.headers = { ...headers }
    return writeHead.call(this, status, ...rest)
  }
  response.write = function (chunk, encoding, callback) { keep(chunk, encoding); return write.call(this, chunk, encoding, callback) }
  response.end = function (chunk, encoding, callback) { keep(chunk, encoding); out.ended = true; return end.call(this, chunk, encoding, callback) }
  return () => {
    if (!out.ended || !out.shareable) return null
    const headers = { ...response.getHeaders(), ...(out.headers ?? {}) }
    for (const name of Object.keys(headers)) if (['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date'].includes(name.toLowerCase())) delete headers[name]
    return { status: out.status || response.statusCode, headers, body: Buffer.concat(out.chunks) }
  }
}

export function replay(response, result) {
  response.writeHead(result.status, { ...result.headers, 'Content-Length': result.body.length })
  response.end(result.body)
}

export function createClientStormGuard({ inFlight = CLIENT_STORM_IN_FLIGHT, perMinute = CLIENT_STORM_PER_MINUTE, now = Date.now, log = line => console.warn(line) } = {}) {
  const lanes = new Map()
  const shared = new Map()

  function laneFor(device, path, at) {
    const id = `${device}\0${path}`
    let lane = lanes.get(id)
    if (!lane) {
      if (lanes.size >= MAX_LANES) {
        for (const [key, old] of lanes) if (old.inFlight === 0 && at - old.windowAt >= WINDOW_MS && at - old.trippedAt >= SHOWN_MS) lanes.delete(key)
      }
      lane = { device, route: COALESCED_ROUTES.has(path) ? path : routeTemplate(path), windowAt: at, count: 0, inFlight: 0, refused: 0, bodyBytes: 0, trippedAt: -Infinity, sinceAt: 0, loggedAt: -Infinity }
      lanes.set(id, lane)
    }
    if (at - lane.windowAt >= WINDOW_MS) { lane.windowAt = at; lane.count = 0 }
    return lane
  }

  function trip(lane, at, retryAfter) {
    if (at - lane.trippedAt >= SHOWN_MS) lane.sinceAt = at
    lane.refused += 1
    lane.trippedAt = at
    if (at - lane.loggedAt >= WINDOW_MS) {
      lane.loggedAt = at
      log(`[client-storm] ${JSON.stringify({ device: lane.device, route: lane.route, rate: lane.count, in_flight: lane.inFlight, body_bytes: lane.bodyBytes, refused: lane.refused })}`)
    }
    return { status: 'refused', retryAfter: Math.max(1, Math.ceil(retryAfter / 1000)) }
  }

  /**
   * Returns null (not a guarded write), {status:'refused', retryAfter}, {status:'joined', result} (answer with
   * replay) or {status:'lead', release} (run the handler, then call release(); always, also on errors).
   */
  async function admit(request, pathname, search = '') {
    if (!WRITES.has(request.method) || !pathname.startsWith('/wizard/')) return null
    const device = deviceOf(request)
    const lane = laneFor(device, pathname, now())
    lane.count += 1
    const declared = Number(request.headers['content-length'] ?? NaN)
    if (Number.isSafeInteger(declared) && declared >= 0) lane.bodyBytes = Math.max(lane.bodyBytes, declared)
    if (lane.count > perMinute) return trip(lane, now(), lane.windowAt + WINDOW_MS - now())
    let key = ''
    if (request.method === 'PUT' && COALESCED_ROUTES.has(pathname) && Number.isSafeInteger(declared) && declared >= 0 && declared <= CLIENT_STORM_BODY_LIMIT) {
      const body = await readExact(request, declared)
      request[BUFFERED_BODY] = body
      const hash = createHash('sha256').update(device).update('\0').update(pathname).update('\0').update(search)
      for (const name of IDENTITY) hash.update('\0').update(String(request.headers[name] ?? ''))
      key = hash.update('\0').update(body).digest('hex')
      const running = shared.get(key)
      if (running) {
        const result = await running
        return result ? { status: 'joined', result } : trip(lane, now(), 1000)
      }
    }
    if (lane.inFlight >= inFlight) return trip(lane, now(), 1000)
    lane.inFlight += 1
    let settle = () => {}
    if (key) shared.set(key, new Promise(resolve => { settle = resolve }))
    let released = false
    return {
      status: 'lead',
      watch: (response) => { const read = capture(response); return () => read() },
      release(read) {
        if (released) return
        released = true
        lane.inFlight -= 1
        if (key) { shared.delete(key); let result = null; try { result = read?.() ?? null } catch { result = null }; settle(result) }
      },
    }
  }

  function summary() {
    const at = now()
    const tripping = [...lanes.values()].filter(lane => at - lane.trippedAt < SHOWN_MS)
      .sort((a, b) => b.refused - a.refused)
      .slice(0, 10)
      .map(lane => ({ device: lane.device, route: lane.route, rate: lane.count, in_flight: lane.inFlight, body_bytes: lane.bodyBytes, refused: lane.refused, since: new Date(lane.sinceAt).toISOString() }))
    return tripping.length ? { tripping, limits: { in_flight: inFlight, per_minute: perMinute } } : null
  }

  return { admit, summary }
}
