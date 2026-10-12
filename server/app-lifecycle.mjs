// Owner app lifecycle + installed-app routing for the Agent Service.
//
// Authority model (docs/app-installation-integration.md):
// - The control origin (the Wizard UX origin) carries the owner session. Lifecycle writes need that origin, an
//   HttpOnly SameSite=Strict session cookie, its CSRF token and a stable Idempotency-Key. The App Manager bearer
//   and Runtipi's CLI JWT never reach the browser or an app.
// - Installed app documents never run on the control origin. With an apps origin configured (a second Service
//   listener, e.g. Tailscale Serve on its own HTTPS port), /apps/<id>/ on the control origin redirects there and
//   that listener serves only app routes. Without one, app documents are served with a CSP sandbox (opaque
//   origin, no allow-same-origin), so an app script can't read the session/CSRF or drive lifecycle routes.
// - Every route checks the Host header against the configured trusted hosts first (DNS-rebinding fence).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const ID = '[a-z0-9][a-z0-9-]{0,63}'
const LIFE = new RegExp(`^/api/app-lifecycle/(${ID})(?::wizardapps)?/(install|start|stop|restart|update|uninstall)$`, 'u')
const READ = new RegExp(`^/api/(?:apps/installed|system/load|apps/${ID}(?::wizardapps)?|marketplace/apps/${ID}(?::wizardapps)?(?:/image)?)$`, 'u')
const APP = new RegExp(`^/apps/(${ID})(/.*)?$`, 'u')
const METHOD = { install: 'POST', start: 'POST', stop: 'POST', restart: 'POST', update: 'PATCH', uninstall: 'DELETE' }
const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,128}$/u
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]']
const SESSION_TTL_MS = 3600_000
const APP_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals'

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const loopbackIp = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)
const hostName = (host) => { try { return new URL(`http://${String(host || '')}`).hostname.toLowerCase() } catch { return '' } }

/** Direct loopback callers, or a loopback reverse proxy (Tailscale Serve) that names a tailnet principal.
 * The proxy must strip client-supplied identity headers; `owners` optionally pins the accepted logins. */
export function localOwnerAccess(request, owners = []) {
  if (!loopbackIp(request.socket?.remoteAddress)) return false
  const h = request.headers
  const forwarded = h.forwarded || h['x-forwarded-for'] || h['x-forwarded-host']
  const login = String(h['tailscale-user-login'] || '').trim().toLowerCase()
  if (!forwarded && !login) return true
  if (!login) return false
  return !owners.length || owners.includes(login)
}

/** Hostnames this Service answers to: loopback, plus every configured origin/host. */
export function trustedHostnames({ allowedHosts = [], origins = [] } = {}) {
  const set = new Set(LOOPBACK_HOSTS)
  for (const h of allowedHosts) { const n = hostName(h); if (n) set.add(n) }
  for (const o of origins) { try { if (o) set.add(new URL(o).hostname.toLowerCase()) } catch {} }
  return set
}

function decodePath(path) { try { return decodeURIComponent(path) } catch { return '' } }
function send(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
  res.end(body)
}
async function readBody(req, max) {
  const chunks = []; let n = 0
  for await (const c of req) { n += c.length; if (n > max) throw new Error('too_large'); chunks.push(c) }
  return Buffer.concat(chunks)
}
function sameOrigin(req, hosts) {
  // Browsers send Origin on every non-GET fetch; it must name this very host (already fenced) over a sane scheme.
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false
  const origin = req.headers.origin
  if (!origin) return false
  try {
    const u = new URL(origin)
    if (u.username || u.password || u.host !== String(req.headers.host || '').toLowerCase()) return false
    if (!hosts.has(u.hostname.toLowerCase())) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.includes(u.hostname))
  } catch { return false }
}

export function createAppLifecycleRoutes({
  managerUrl = '', managerToken = '', appsJsonPath = '', access = localOwnerAccess, fetchImpl = fetch,
  refresh = () => {}, now = Date.now, allowedHosts = [], controlOrigins = [], appsOrigin = '',
  upstreamHosts = [], role = 'control',
} = {}) {
  if (managerUrl) {
    const u = new URL(managerUrl)
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('App Manager bridge must be a loopback HTTP origin')
    managerUrl = u.origin
  }
  if (appsOrigin) {
    const u = new URL(appsOrigin)
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('apps origin must be a bare origin')
    appsOrigin = u.origin
  }
  const hosts = trustedHostnames({ allowedHosts, origins: [...controlOrigins, appsOrigin] })
  const upstreamOk = new Set([...LOOPBACK_HOSTS, ...upstreamHosts.map((h) => String(h).toLowerCase())])
  const sessions = new Map()
  const cookieName = 'wizard_lifecycle'
  const views = new Map()
  const session = (req) => {
    const sid = String(req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
    const s = sid && sessions.get(sid)
    if (!s) return null
    if (now() - s.at >= SESSION_TTL_MS) { sessions.delete(sid); return null }
    return s
  }

  async function managerJson(path, init = {}) {
    const r = await fetchImpl(managerUrl + path, { redirect: 'error', ...init, headers: { Authorization: `Bearer ${managerToken}`, Accept: 'application/json', ...(init.headers || {}) } })
    const raw = await r.text()
    if (raw.length > 4 * 1024 * 1024) throw new Error('too_large')
    let data; try { data = JSON.parse(raw) } catch { throw new Error('invalid_json') }
    return { r, data }
  }

  async function viewUpstream(id) {
    let running = false
    try { running = JSON.parse(readFileSync(appsJsonPath, 'utf8')).apps.some((a) => a?.id === id && a.status === 'running') } catch {}
    if (!running || !managerUrl || !managerToken) return null
    const hit = views.get(id)
    if (hit && now() - hit.at < 5000) return hit.url
    let url = null
    try {
      const { r, data } = await managerJson(`/api/internal/apps/${id}/view`, { signal: AbortSignal.timeout(5000) })
      if (r.ok && data?.path === `/apps/${id}/`) {
        const u = new URL(data.upstream)
        if (u.protocol === 'http:' && upstreamOk.has(u.hostname.toLowerCase()) && u.port && !u.username && !u.password && !u.search && !u.hash) url = u
      }
    } catch {}
    views.set(id, { url, at: now() })
    return url
  }

  async function proxyApp(req, res, url, id, rest, sandbox) {
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) { send(res, 405, { error: 'method_not_allowed' }); return }
    const write = !['GET', 'HEAD'].includes(req.method)
    // A sandboxed (opaque-origin) document can't write: writes need a real same-origin app document.
    if (write && (sandbox || !sameOrigin(req, hosts))) { send(res, 403, { error: 'same_origin_required' }); return }
    const path = decodePath(url.pathname)
    if (!path || path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) { send(res, 400, { error: 'invalid_app_path' }); return }
    const upstream = await viewUpstream(id)
    if (!upstream) { send(res, 404, { error: 'app_not_available' }); return }
    if (!rest) { res.writeHead(302, { Location: `/apps/${id}/${url.search}` }); res.end(); return }
    const root = upstream.pathname.endsWith('/') ? upstream.pathname : `${upstream.pathname}/`
    const target = new URL(root + url.pathname.slice(`/apps/${id}/`.length) + url.search, upstream.origin)
    if (target.origin !== upstream.origin || !target.pathname.startsWith(root)) { send(res, 400, { error: 'invalid_app_path' }); return }
    try {
      const headers = { Accept: String(req.headers.accept || '*/*') }
      let body
      if (write) {
        body = await readBody(req, 2 * 1024 * 1024)
        if (req.headers['content-type']) headers['Content-Type'] = String(req.headers['content-type'])
      }
      const r = await fetchImpl(target, { method: req.method, redirect: 'manual', signal: AbortSignal.timeout(15000), headers, ...(write ? { body } : {}) })
      if (r.status >= 300 && r.status < 400) {
        const loc = new URL(r.headers.get('location') || '/', target)
        if (loc.origin !== upstream.origin || !loc.pathname.startsWith(root)) { send(res, 502, { error: 'app_redirect_refused' }); return }
        res.writeHead(r.status, { Location: `/apps/${id}/${loc.pathname.slice(root.length)}${loc.search}${loc.hash}` }); res.end(); return
      }
      const bytes = req.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await r.arrayBuffer())
      if (bytes.length > 16 * 1024 * 1024) throw new Error('too_large')
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
        ...(sandbox ? { 'Content-Security-Policy': APP_SANDBOX } : {}),
      })
      res.end(bytes)
    } catch { send(res, 502, { error: 'app_unavailable' }) }
  }

  return async function handle(req, res, url) {
    const path = decodePath(url.pathname)
    const bootstrap = path === '/wizard/v1/app-lifecycle/session'
    const life = LIFE.exec(path)
    const read = READ.test(path)
    const app = APP.exec(path)
    // The apps listener answers app routes only, so nothing an app runs can reach the control plane there.
    if (role === 'apps') {
      if (!hosts.has(hostName(req.headers.host))) { send(res, 421, { error: 'untrusted_host' }); return true }
      if (!app) { send(res, 404, { error: 'not_found' }); return true }
      if (!await access(req)) { send(res, 403, { error: 'access_required' }); return true }
      await proxyApp(req, res, url, app[1], app[2], false)
      return true
    }
    const mine = bootstrap || path.startsWith('/api/app-lifecycle/') || read || app
    if (!mine) return false
    if (!hosts.has(hostName(req.headers.host))) { send(res, 421, { error: 'untrusted_host' }); return true }
    if (!await access(req)) { send(res, 403, { error: 'access_required' }); return true }

    if (app) {
      if (appsOrigin) {
        if (!['GET', 'HEAD'].includes(req.method)) { send(res, 405, { error: 'method_not_allowed' }); return true }
        res.writeHead(302, { Location: `${appsOrigin}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' }); res.end(); return true
      }
      await proxyApp(req, res, url, app[1], app[2], true)
      return true
    }

    if (bootstrap) {
      if (req.method !== 'GET') { send(res, 405, { error: 'method_not_allowed' }); return true }
      if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['sec-fetch-site'] === 'same-site' || (req.headers.origin && !sameOrigin(req, hosts))) { send(res, 403, { error: 'same_origin_required' }); return true }
      if (!managerUrl || !managerToken) { send(res, 503, { error: 'app_manager_not_configured' }); return true }
      for (const [id, s] of sessions) if (now() - s.at >= SESSION_TTL_MS) sessions.delete(id)
      let s = session(req)
      if (!s) {
        s = { id: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex'), at: now() }
        sessions.set(s.id, s)
        if (sessions.size > 500) sessions.delete(sessions.keys().next().value)
      }
      const left = Math.max(1, Math.floor((SESSION_TTL_MS - (now() - s.at)) / 1000))
      const secure = String(req.headers['x-forwarded-proto'] || '') === 'https' || String(req.headers.origin || '').startsWith('https:') || !LOOPBACK_HOSTS.includes(hostName(req.headers.host))
      send(res, 200, { csrf: s.csrf, expires_in: left }, { 'Set-Cookie': `${cookieName}=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${left}${secure ? '; Secure' : ''}` })
      return true
    }

    if (!managerUrl || !managerToken) { send(res, 503, { error: 'app_manager_not_configured' }); return true }
    if (!read && !life) { send(res, 404, { error: 'not_found' }); return true }
    const init = { method: req.method, headers: {}, signal: AbortSignal.timeout(life ? 900_000 : 15_000) }
    if (life) {
      if (req.method !== METHOD[life[2]]) { send(res, 405, { error: 'method_not_allowed' }); return true }
      const s = session(req)
      if (!sameOrigin(req, hosts) || !s || !same(s.csrf, String(req.headers['x-wizard-csrf'] || ''))) { send(res, 403, { error: 'owner_session_required' }); return true }
      const key = String(req.headers['idempotency-key'] || '')
      if (!IDEMPOTENCY.test(key)) { send(res, 400, { error: 'idempotency_key_required' }); return true }
      let payload
      try { payload = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}') } catch { send(res, 400, { error: 'invalid_request' }); return true }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { send(res, 400, { error: 'invalid_request' }); return true }
      init.headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key }
      init.body = JSON.stringify(payload)
    } else if (!['GET', 'HEAD'].includes(req.method)) { send(res, 405, { error: 'method_not_allowed' }); return true }
    try {
      if (read && path.endsWith('/image')) {
        const r = await fetchImpl(managerUrl + path, { ...init, redirect: 'error', headers: { Authorization: `Bearer ${managerToken}` } })
        const type = String(r.headers.get('content-type') || '').split(';')[0]
        if (!r.ok || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) { send(res, 404, { error: 'image_unavailable' }); return true }
        const bytes = Buffer.from(await r.arrayBuffer())
        if (bytes.length > 4 * 1024 * 1024) throw new Error('too_large')
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes)
        return true
      }
      const { r, data } = await managerJson(path, init)
      if (life) { views.delete(life[1]); await refresh() }
      if (!r.ok) {
        const error = typeof data?.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(data.error) ? data.error : 'app_operation_failed'
        send(res, r.status >= 400 && r.status < 500 ? r.status : 502, { success: false, error })
      } else send(res, r.status, data)
    } catch {
      if (life) { views.delete(life[1]); await refresh() }
      // A lost bridge response after submission is uncertain, never a definitive failure: same key retries replay.
      send(res, 502, { success: false, error: life ? 'operation_unconfirmed' : 'app_manager_unavailable' })
    }
    return true
  }
}
