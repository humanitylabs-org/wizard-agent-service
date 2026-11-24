// Local app routes (wizard-app-manager issue 629, switch wizard/local-app-routes, off by default): on a box that is not
// on Tailscale (yet), app screens open inside Wizard. Tailscale Serve is what normally puts an installed app's page on
// the Wizard origin (`/<app id>/`, or the app's own view path such as `/files/`); without it the launcher only has the
// app's raw loopback port, which the view-URL check rightly refuses, so the app shows as backend-only. With the switch
// on, this module serves the same paths on the box's own loopback Wizard address and nothing else:
//   - only a request that came straight to the box's loopback address (Host 127.0.0.1 / localhost / [::1]), never one
//     through Tailscale Serve or with any Tailscale or Cloudflare identity header, and only from the owner principal;
//   - never cross-site (Sec-Fetch-Site), and a write needs no Origin or this same loopback origin;
//   - the app gets no forwarding or Wizard credential headers, so it sees what it sees on its own loopback port today;
//   - left out: the shell, agents, apps with an owner proof (they need the owner edge) and the shell's own paths.
// The target is the app's loopback address from apps.json (`view.local` / `view.url`, alongside boxes, where the Agent
// Service shares the host network) or its address on the app's gateway network (fresh boxes, where the Agent Service
// runs in a container: `view.internal`, else the origin of `mcp.internal` behind the same published port), picked like
// MCP addresses (`appsMcpAddress`).
import { request as httpRequest } from 'node:http'
import { readFileSync, statSync } from 'node:fs'

export const LOCAL_APP_ROUTES_SWITCH = 'wizard/local-app-routes'

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/u
// Top-level paths the shell or this service answer itself; an app route never shadows them (WAM links.RESERVED_PATHS
// plus this service's own prefixes).
const RESERVED = new Set(['wizard-os-home', 'wizard-ux', 'wizard', 'api', 'mcp', 'v1', 'troubleshoot', 'login', 'logout',
  'assets', 'static', 'fonts', 'health', 'healthz', 'shell-health', 'pages', 'hermes', 'favicon.ico'])
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/iu
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(\/[^\s?#]*)?$/iu
const INTERNAL_URL = /^http:\/\/([a-z0-9][a-z0-9-]{0,62}):(\d{1,5})(\/[^\s?#]*)?$/u
// Never passed on to an app: hop-by-hop headers, proxy/identity marks and the owner's Wizard credentials.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'forwarded', 'x-real-ip', 'x-wizard-owner-proof', 'x-wizard-shell-token', 'authorization'])
const DROP_PREFIX = ['x-forwarded-', 'tailscale-', 'cf-']

function validPort(text) {
  const n = Number(text)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0
}

function pathOk(path) {
  if (!/^\/[a-z0-9][a-z0-9/-]*\/$/u.test(path) || path.includes('//')) return false
  return !RESERVED.has(path.split('/')[1])
}

/** One app's local route from its apps.json row, or null: {id, path, strip, target}. `address` 'internal' picks
 *  view.internal (Agent Service in a container), anything else the loopback address. */
export function routeOf(app, address = 'local') {
  if (!app || typeof app !== 'object' || !ID.test(String(app.id || ''))) return null
  const id = app.id
  if (Array.isArray(app.provides) && app.provides.includes('shell')) return null
  if (app.type === 'agent' || app.category === 'agent' || app.owner_proof) return null
  const view = app.view && typeof app.view === 'object' ? app.view : null
  if (!view) return null
  const local = [view.local, view.url].find(u => typeof u === 'string' && LOOPBACK_URL.test(u))
  if (!local) return null
  const [, host, port, rawPath = '/'] = local.match(LOOPBACK_URL)
  if (!validPort(port)) return null
  const lp = rawPath.endsWith('/') ? rawPath : `${rawPath}/`
  // Same rule as the App Manager's implicit gateway (wam/links.py): a page served at / gets /<id>/ with the prefix
  // stripped; a page with its own path (Files at /files/) keeps that path unchanged.
  const strip = lp === '/'
  const path = strip ? `/${id}/` : lp
  if (!pathOk(path)) return null
  // The registered loopback host as written (an app may listen on [::1] only).
  let origin = `http://${host.toLowerCase()}:${validPort(port)}`
  if (address === 'internal') {
    // The page's address inside the app network: `view.internal` when the App Manager writes one, else the app's own
    // `mcp.internal` when its MCP answers on the same published port as the page (apps.json gives both the one port,
    // so they reach the same container port, which mcp.internal names: Files publishes 8794 and serves both on 8080).
    const m = typeof view.internal === 'string' ? view.internal.match(INTERNAL_URL) : null
    const mcpLocal = typeof app.mcp?.url === 'string' ? app.mcp.url.match(LOOPBACK_URL) : null
    const mcpInternal = typeof app.mcp?.internal === 'string' ? app.mcp.internal.match(INTERNAL_URL) : null
    const hit = m && validPort(m[2]) ? m
      : mcpLocal && mcpInternal && validPort(mcpLocal[2]) === validPort(port) && validPort(mcpInternal[2]) ? mcpInternal : null
    if (!hit) return null
    origin = `http://${hit[1]}:${validPort(hit[2])}`
  }
  return { id, path, strip, target: origin }
}

/** Every local route in apps.json, re-read when the file changes. */
export function createRouteTable({ appsJsonPath, address = 'local' } = {}) {
  let sig = '', routes = []
  return () => {
    if (!appsJsonPath) return []
    let next = ''
    try { const st = statSync(appsJsonPath); next = `${st.mtimeMs}:${st.size}:${st.ino}` } catch { sig = ''; routes = []; return routes }
    if (next === sig) return routes
    try {
      const doc = JSON.parse(readFileSync(appsJsonPath, 'utf8'))
      const seen = new Set()
      // Longest path first, so /foo/bar/ wins over /foo/ for its own requests.
      routes = (Array.isArray(doc?.apps) ? doc.apps : []).map(a => routeOf(a, address)).filter(r => r && !seen.has(r.path) && seen.add(r.path))
        .sort((a, b) => b.path.length - a.path.length)
      sig = next
    } catch { routes = [] }
    return routes
  }
}

/** Did this request come straight to the box's own loopback Wizard address (not Serve, not a proxy with identity)? */
export function loopbackRequest(request, { tailnetIngress = false } = {}) {
  if (tailnetIngress) return false
  const headers = request?.headers || {}
  if (!LOOPBACK_HOST.test(String(headers.host || ''))) return false
  if (Object.keys(headers).some(k => k.startsWith('tailscale-') || k.startsWith('cf-'))) return false
  return true
}

function matchRoute(routes, pathname) {
  for (const r of routes) {
    if (pathname === r.path.slice(0, -1)) return { route: r, bare: true }
    if (pathname.startsWith(r.path)) return { route: r, bare: false }
  }
  return null
}

/** The path the launcher gets for an app with no openable view, or '' (switch on, loopback request only). */
export function launcherPath(routes, app) {
  return routes.find(r => r.id === app?.id)?.path || ''
}

function refused(request, response, status, text) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(request.method === 'HEAD' ? undefined : text)
  return true
}

function crossSite(request) {
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return true
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false
  const origin = request.headers.origin
  return origin !== undefined && origin !== `http://${request.headers.host}`
}

function upstreamHeaders(request, route, upgrade = false) {
  const out = {}
  for (const [k, v] of Object.entries(request.headers)) {
    if (HOP.has(k) || DROP_PREFIX.some(p => k.startsWith(p))) continue
    out[k] = v
  }
  if (upgrade) { out.connection = 'Upgrade'; out.upgrade = request.headers.upgrade }
  return out
}

function upstreamPath(route, rawUrl) {
  const q = rawUrl.indexOf('?')
  const pathname = q < 0 ? rawUrl : rawUrl.slice(0, q), search = q < 0 ? '' : rawUrl.slice(q)
  return (route.strip ? `/${pathname.slice(route.path.length)}` : pathname) + search
}

/**
 * Serve an installed app's page at its Wizard path when the switch is on. Returns true when it answered.
 * `on()` reads the switch, `routes()` the table, `owner` says the request's principal is the owner.
 */
export function serveLocalAppRoute(request, response, { on, routes, tailnetIngress = false, owner = false } = {}) {
  const rawUrl = String(request.url || '/')
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return false
  const pathname = rawUrl.split('?')[0]
  if (pathname === '/wizard' || pathname.startsWith('/wizard/')) return false
  let hit = null
  try {
    if (!on?.()) return false
    hit = matchRoute(routes?.() || [], pathname)
  } catch { return false }
  if (!hit) return false
  if (!loopbackRequest(request, { tailnetIngress }) || !owner) return refused(request, response, 403, 'This app opens here only on the box\'s own Wizard address.')
  if (/%2e|%2f|%5c|\\/iu.test(pathname)) return refused(request, response, 400, 'Bad path')
  if (crossSite(request)) return refused(request, response, 403, 'Cross-site request refused')
  if (hit.bare) {
    response.writeHead(308, { Location: hit.route.path + (rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : ''), 'Cache-Control': 'no-store' })
    response.end()
    return true
  }
  const target = new URL(hit.route.target)
  const up = httpRequest({ hostname: target.hostname.replace(/^\[|\]$/gu, ''), port: target.port, method: request.method, path: upstreamPath(hit.route, rawUrl),
    headers: upstreamHeaders(request, hit.route) }, res => {
    const headers = { ...res.headers }
    for (const k of ['connection', 'keep-alive', 'transfer-encoding']) delete headers[k]
    response.writeHead(res.statusCode || 502, headers)
    res.pipe(response)
  })
  up.on('error', () => {
    if (!response.headersSent) refused(request, response, 502, 'This app is not answering right now.')
    else response.destroy()
  })
  request.pipe(up)
  return true
}

/** The same route for a WebSocket upgrade (the shell's nginx passes Upgrade through). Returns true when handled. */
export function upgradeLocalAppRoute(request, socket, head, { on, routes, tailnetIngress = false, owner = false } = {}) {
  const rawUrl = String(request.url || '/')
  const pathname = rawUrl.split('?')[0]
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || pathname === '/wizard' || pathname.startsWith('/wizard/')) return false
  let hit = null
  try {
    if (!on?.()) return false
    hit = matchRoute(routes?.() || [], pathname)
  } catch { return false }
  if (!hit || hit.bare) return false
  if (!loopbackRequest(request, { tailnetIngress }) || !owner || crossSite(request) || /%2e|%2f|%5c|\\/iu.test(pathname)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return true
  }
  const target = new URL(hit.route.target)
  const up = httpRequest({ hostname: target.hostname.replace(/^\[|\]$/gu, ''), port: target.port, method: request.method, path: upstreamPath(hit.route, rawUrl),
    headers: upstreamHeaders(request, hit.route, true) })
  up.on('upgrade', (res, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage || 'Switching Protocols'}`]
    for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (upHead?.length) socket.write(upHead)
    if (head?.length) upSocket.write(head)
    upSocket.pipe(socket); socket.pipe(upSocket)
    const close = () => { upSocket.destroy(); socket.destroy() }
    upSocket.on('error', close); socket.on('error', close); upSocket.on('close', close); socket.on('close', close)
  })
  up.on('response', res => { socket.end(`HTTP/1.1 ${res.statusCode || 502} Bad Gateway\r\nConnection: close\r\n\r\n`); res.resume() })
  up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'))
  up.end()
  return true
}
