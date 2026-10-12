// Same-origin owner lifecycle adapter. Manager credentials never leave this process.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
const ID = '[a-z0-9][a-z0-9-]{0,63}'
const LIFE = new RegExp(`^/api/app-lifecycle/(${ID}):wizardapps/(install|start|stop|restart|update|uninstall)$`, 'u')
const READ = new RegExp(`^/api/(?:apps/installed|system/load|apps/${ID}:wizardapps|marketplace/apps/${ID}:wizardapps(?:/image)?)$`, 'u')
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const loopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)
export function localOwnerAccess(request) {
  if (!loopback(request.socket?.remoteAddress)) return false
  // A local Tailscale Serve/verified private gateway supplies this principal.
  const h = request.headers
  const forwarded = h.forwarded || h['x-forwarded-for'] || h['x-forwarded-host']
  return !forwarded || Boolean(h['tailscale-user-login'])
}
function decodePath(path) { try { return decodeURIComponent(path) } catch { return '' } }
function originAllowed(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  if (!req.headers.origin) return false
  try {
    const u = new URL(req.headers.origin)
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.host === req.headers.host
  } catch { return false }
}
function send(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(body)
}
async function body(req, max = 65536) {
  const chunks = []; let n = 0
  for await (const c of req) { n += c.length; if (n > max) throw new Error('too_large'); chunks.push(c) }
  const raw = Buffer.concat(chunks).toString('utf8')
  const value = JSON.parse(raw || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body')
  return value
}
export function createAppLifecycleRoutes({ managerUrl = '', managerToken = '', appsJsonPath = '', access = localOwnerAccess, fetchImpl = fetch, refresh = () => {}, now = Date.now } = {}) {
  if (managerUrl) {
    const u = new URL(managerUrl)
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('App Manager bridge must be a loopback HTTP origin')
    managerUrl = u.origin
  }
  const sessions = new Map()
  const cookieName = 'wizard_lifecycle'
  const session = (req) => {
    const sid = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
    const s = sessions.get(sid)
    return s && now() - s.at < 3600000 ? s : null
  }
  return async function handle(req, res, url) {
    const path = decodePath(url.pathname)
    const bootstrap = path === '/wizard/v1/app-lifecycle/session'
    const life = LIFE.exec(path)
    const read = READ.test(path)
    const app = new RegExp(`^/apps/(${ID})(/.*)?$`, 'u').exec(path)
    const mine = bootstrap || path.startsWith('/api/app-lifecycle/') || read || app
    if (!mine) return false
    if (!await access(req)) { send(res, 403, { error: 'access_required' }); return true }
    if (bootstrap) {
      if (req.method !== 'GET') { send(res, 405, { error: 'method_not_allowed' }); return true }
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originAllowed(req))) { send(res, 403, { error: 'same_origin_required' }); return true }
      if (!managerUrl || !managerToken) { send(res, 503, { error: 'app_manager_not_configured' }); return true }
      for (const [id, s] of sessions) if (now() - s.at >= 3600000) sessions.delete(id)
      let s = session(req)
      if (!s) {
        s = { id: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex'), at: now() }
        sessions.set(s.id, s)
        if (sessions.size > 500) sessions.delete(sessions.keys().next().value)
      }
      const secure = req.headers.origin?.startsWith('https:') || req.headers['x-forwarded-proto'] === 'https'
      send(res, 200, { csrf: s.csrf, expires_in: 3600 }, { 'Set-Cookie': `${cookieName}=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${secure ? '; Secure' : ''}` }); return true
    }
    if (app) {
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) { send(res, 405, { error: 'method_not_allowed' }); return true }
      const appWrite = !['GET', 'HEAD'].includes(req.method)
      if (appWrite && !originAllowed(req)) { send(res, 403, { error: 'same_origin_required' }); return true }
      if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) { send(res, 400, { error: 'invalid_app_path' }); return true }
      let entry
      try { entry = JSON.parse(readFileSync(appsJsonPath, 'utf8')).apps.find(a => a.id === app[1] && a.status === 'running') } catch {}
      let upstream
      try {
        upstream = new URL(entry?.view?.upstream)
        if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname) || !upstream.port || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error()
      } catch { send(res, 404, { error: 'app_not_available' }); return true }
      if (!app[2]) { res.writeHead(302, { Location: `/apps/${app[1]}/` }); res.end(); return true }
      const suffix = app[2].slice(1)
      const root = upstream.pathname.endsWith('/') ? upstream.pathname : upstream.pathname + '/'
      const target = new URL(root + suffix + url.search, upstream.origin)
      if (target.origin !== upstream.origin || !target.pathname.startsWith(root)) { send(res, 400, { error: 'invalid_app_path' }); return true }
      try {
        const appHeaders = { Accept: String(req.headers.accept || '*/*') }
        let appBody
        if (appWrite) {
          const pieces = []; let total = 0
          for await (const piece of req) { total += piece.length; if (total > 2 * 1024 * 1024) throw new Error('too_large'); pieces.push(piece) }
          appBody = Buffer.concat(pieces)
          if (req.headers['content-type']) appHeaders['Content-Type'] = String(req.headers['content-type'])
        }
        const r = await fetchImpl(target, { method: req.method, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: appHeaders, ...(appWrite ? { body: appBody } : {}) })
        if (r.status >= 300 && r.status < 400) {
          const loc = new URL(r.headers.get('location') || '/', target)
          if (loc.origin !== upstream.origin || !loc.pathname.startsWith(root)) { send(res, 502, { error: 'app_redirect_refused' }); return true }
          res.writeHead(r.status, { Location: `/apps/${app[1]}/` + loc.pathname.slice(root.length) + loc.search + loc.hash }); res.end(); return true
        }
        const b = req.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await r.arrayBuffer())
        if (b.length > 16 * 1024 * 1024) throw new Error('too_large')
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(b)
      } catch { send(res, 502, { error: 'app_unavailable' }) }
      return true
    }
    if (!managerUrl || !managerToken) { send(res, 503, { error: 'app_manager_not_configured' }); return true }
    if (!read && !life) { send(res, 404, { error: 'not_found' }); return true }
    let payload
    const headers = { Authorization: `Bearer ${managerToken}`, Accept: 'application/json' }
    if (life) {
      const method = life[2] === 'uninstall' ? 'DELETE' : life[2] === 'update' ? 'PATCH' : 'POST'
      if (req.method !== method) { send(res, 405, { error: 'method_not_allowed' }); return true }
      const s = session(req)
      if (!originAllowed(req) || !s || !same(s.csrf, String(req.headers['x-wizard-csrf'] || ''))) { send(res, 403, { error: 'owner_session_required' }); return true }
      const key = String(req.headers['idempotency-key'] || '')
      if (!/^[A-Za-z0-9._-]{8,128}$/u.test(key)) { send(res, 400, { error: 'idempotency_key_required' }); return true }
      try { payload = await body(req) } catch { send(res, 400, { error: 'invalid_request' }); return true }
      headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = key
    } else if (!['GET', 'HEAD'].includes(req.method)) { send(res, 405, { error: 'method_not_allowed' }); return true }
    try {
      const r = await fetchImpl(managerUrl + path, { method: req.method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: 'error', signal: AbortSignal.timeout(life ? 180000 : 15000) })
      if (read && path.endsWith('/image')) {
        const type = String(r.headers.get('content-type') || '').split(';')[0]
        if (!r.ok || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) { send(res, 404, { error: 'image_unavailable' }); return true }
        const bytes = Buffer.from(await r.arrayBuffer())
        if (bytes.length > 2 * 1024 * 1024) throw new Error('too_large')
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes); return true
      }
      const raw = await r.text()
      if (raw.length > 2 * 1024 * 1024) throw new Error('too_large')
      // Bridge JSON is already a positive allowlist projection; never relay arbitrary upstream errors.
      let data; try { data = JSON.parse(raw) } catch { throw new Error('invalid_json') }
      if (life) await refresh()
      if (!r.ok) send(res, r.status >= 400 && r.status < 500 ? r.status : 502, { error: typeof data.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(data.error) ? data.error : 'app_operation_failed', ...(data.operation_id ? { operation_id: data.operation_id } : {}) })
      else send(res, r.status, data)
    } catch { if (life) await refresh(); send(res, 502, { error: 'app_manager_unavailable' }) }
    return true
  }
}
