// Scoped content tickets (wizard-os ADAPTER-SKETCH §6), default-off. A ticket is an unguessable bearer capability
// for ONE resource of ONE installation, GET/HEAD (+Range) only, with an absolute 60 s expiry that use never
// extends. Every request (and every chunk of a response) re-checks the binding, installation identity and grant,
// so revocation, reinstall, update and uninstall stop it before expiry. Served on a dedicated listener that has no
// owner authentication semantics at all: no shell token, cookie, owner proof or Tailscale identity is read or
// needed, and no owner route exists on it. Ticket values never reach a log, a Referer or a redirect.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const TICKET = /^\/t\/([A-Za-z0-9_-]{43})$/
const CHUNK = 64 * 1024
const tag = ticket => createHash('sha256').update(ticket).digest('hex').slice(0, 12)   // log-safe reference

/** One parsed single range, or null for the whole body, or 'bad' (RFC 9110 §14). Multipart ranges are refused. */
export function parseRange(header, size) {
  if (header === undefined) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'bad'
  let start, end
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'bad'; start = Math.max(0, size - n); end = size - 1 }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'bad'
  return { start, end }
}

/**
 * tickets.mint({handle, generation, appId, identity, operation, mime, bytes, sha256, filename, fetchBytes})
 *   fetchBytes(): fresh bytes from the app for THIS resource (the adapter's own credentialed upstream call).
 * admit(entry) (set by the adapter layer): true only while the binding is live and the grant is current.
 */
export function createContentTickets({ publicBase = '', ttlMs = 60_000, maxTickets = 1024, connectionMs = 300_000, now = () => Date.now(), log = () => {} } = {}) {
  const base = String(publicBase || '').replace(/\/+$/, '')
  if (base && !/^https?:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(base)) throw new Error('content publicBase must be an http(s) origin')
  const tickets = new Map(), active = new Map()   // ticket -> entry ; handle -> Set(response)
  let admit = () => false
  const sweep = () => { const t = now(); for (const [k, e] of tickets) if (e.expiresAt <= t) tickets.delete(k) }
  function revokeBinding(handle) {
    for (const [k, e] of tickets) if (e.handle === handle) tickets.delete(k)
    for (const res of active.get(handle) || []) res.destroy()   // long responses close now, not at the next Range
    active.delete(handle)
  }
  function mint(entry) {
    if (!base) throw Object.assign(new Error('unsupported_capability'), { code: 'unsupported_capability' })
    sweep()
    if (tickets.size >= maxTickets) throw Object.assign(new Error('busy'), { code: 'busy' })
    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = now() + ttlMs   // absolute; never extended by use
    tickets.set(ticket, { ...entry, expiresAt })
    return { url: `${base}/t/${ticket}`, expiresAt: new Date(expiresAt).toISOString() }
  }
  const plain = (res, status, text, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...extra })
    res.end(text)
  }
  async function serve(req, res) {
    const path = String(req.url || '').split('?')[0]
    const m = TICKET.exec(path)
    if (!m) return plain(res, 404, 'not found')
    const ticket = m[1], ref = tag(ticket)
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'method not allowed', { Allow: 'GET, HEAD' })
    const e = tickets.get(ticket)
    if (!e || e.expiresAt <= now()) { if (e) tickets.delete(ticket); log({ ref, status: 410, why: 'expired_or_unknown' }); return plain(res, 410, 'ticket expired') }
    if (!admit(e)) { tickets.delete(ticket); log({ ref, status: 403, why: 'revoked' }); return plain(res, 403, 'ticket revoked') }
    if (e.stream) return streamed(req, res, e, ticket, ref)
    let body
    try { body = await e.fetchBytes() } catch { log({ ref, status: 502, why: 'app' }); return plain(res, 502, 'content unavailable') }
    if (createHash('sha256').update(body).digest('hex') !== e.sha256) { tickets.delete(ticket); log({ ref, status: 410, why: 'changed' }); return plain(res, 410, 'content changed') }
    if (!admit(e)) { tickets.delete(ticket); return plain(res, 403, 'ticket revoked') }   // re-check after the fetch
    const range = parseRange(req.headers.range, body.length)
    if (range === 'bad') return plain(res, 416, 'bad range', { 'Content-Range': `bytes */${body.length}` })
    const { start, end } = range || { start: 0, end: body.length - 1 }
    res.writeHead(range ? 206 : 200, {
      'Content-Type': e.mime, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}),
      'Content-Disposition': `inline; filename="${e.filename}"`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      // Anonymous only: the ticket is the whole authority. Never credentials, never an echoed Origin.
      'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
    })
    log({ ref, status: range ? 206 : 200, method: req.method, bytes: end - start + 1 })
    if (req.method === 'HEAD') return res.end()
    const set = active.get(e.handle) || new Set(); set.add(res); active.set(e.handle, set)
    const deadline = setTimeout(() => res.destroy(), connectionMs); deadline.unref?.()
    res.on('close', () => { clearTimeout(deadline); set.delete(res) })
    for (let at = start; at <= end; at += CHUNK) {
      if (!admit(e)) { log({ ref, status: 'aborted', why: 'revoked' }); return res.destroy() }
      const ok = res.write(body.subarray(at, Math.min(end + 1, at + CHUNK)))
      if (res.destroyed) return
      if (!ok) await new Promise(r => { res.once('drain', r); res.once('close', r) })
    }
    res.end()
  }
  // Large files (Files view: video seek, downloads): never held whole. The entry's stream({start, end, method}) asks the
  // app for exactly the requested range with the installation's CURRENT upstream and credential; a changed file ends
  // the ticket. The listener still re-checks admission before the head and between every forwarded chunk.
  async function streamed(req, res, e, ticket, ref) {
    const range = parseRange(req.headers.range, e.bytes)
    if (range === 'bad') return plain(res, 416, 'bad range', { 'Content-Range': `bytes */${e.bytes}` })
    const { start, end } = range || { start: 0, end: e.bytes - 1 }
    let up = { body: null }
    if (e.bytes > 0) {
      try { up = await e.stream({ start, end, method: req.method }) } catch { log({ ref, status: 502, why: 'app' }); return plain(res, 502, 'content unavailable') }
      if (up.changed) { tickets.delete(ticket); log({ ref, status: 410, why: 'changed' }); return plain(res, 410, 'content changed') }
    }
    if (!admit(e)) { tickets.delete(ticket); up.body?.cancel?.().catch?.(() => {}); return plain(res, 403, 'ticket revoked') }
    const length = e.bytes > 0 ? end - start + 1 : 0
    const name = String(e.filename || 'file').replace(/[\u0000-\u001f\u007f"\\]/g, '_').slice(0, 200)
    res.writeHead(range ? 206 : 200, {
      'Content-Type': e.mime, 'Content-Length': String(length), 'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${e.bytes}` } : {}),
      'Content-Disposition': `${e.disposition === 'attachment' ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
    })
    log({ ref, status: range ? 206 : 200, method: req.method, bytes: length })
    if (req.method === 'HEAD' || !up.body) { up.body?.cancel?.().catch?.(() => {}); return res.end() }
    const set = active.get(e.handle) || new Set(); set.add(res); active.set(e.handle, set)
    const deadline = setTimeout(() => res.destroy(), connectionMs); deadline.unref?.()
    res.on('close', () => { clearTimeout(deadline); set.delete(res); up.body?.cancel?.().catch?.(() => {}) })
    let sent = 0
    try {
      for await (const part of up.body) {
        if (!admit(e)) { log({ ref, status: 'aborted', why: 'revoked' }); return res.destroy() }
        const chunk = Buffer.from(part).subarray(0, Math.max(0, length - sent))
        sent += chunk.length
        const ok = res.write(chunk)
        if (res.destroyed) return
        if (!ok) await new Promise(r => { res.once('drain', r); res.once('close', r) })
        if (sent >= length) break
      }
    } catch { return res.destroy() }
    if (sent !== length) return res.destroy()   // short app reply: never a silently truncated file
    res.end()
  }
  return Object.freeze({
    mint, revokeBinding, serve,
    setAdmission(fn) { admit = fn },
    get size() { sweep(); return tickets.size },
    /** The dedicated content listener (no owner routes, no owner authentication semantics). */
    createServer() {
      const server = createServer((req, res) => { serve(req, res).catch(() => { if (!res.headersSent) plain(res, 500, 'error'); else res.destroy() }) })
      server.on('connection', s => s.setTimeout(connectionMs + 5000, () => s.destroy()))
      return server
    },
  })
}
