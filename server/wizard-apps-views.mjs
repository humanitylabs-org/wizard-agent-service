// Read-only data for the App Manager views in Wizard UX (My Apps, App Store, Resources).
//
//   GET /wizard/v1/wizard-apps   the installed apps from the App Manager's apps.json: id, name, type, category,
//                                uses, provides, view, summary, status. MCP addresses, health URLs, repos, commits
//                                and skill paths stay on the box.
//   GET /wizard/v1/index/*       a same-origin proxy of the public App Index (https://apps.aiwizards.com/v1), so the
//                                shell's CSP keeps connect-src 'self'. Only /search, /tags and /apps/<owner>/<repo>;
//                                every other method or path is refused. Answers are cached for 60 s.
//
// Credit: the views and the data contract are Oscar's (humanitylabs-org/wizard-app-manager wizard-views/, 10 Oct 2026).
import { existsSync, readFileSync, statSync } from 'node:fs'

export const APP_INDEX_URL = 'https://apps.aiwizards.com/v1'
const INDEX_PATH = /^\/(?:search|tags|apps\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/u
const INDEX_QUERY = new Set(['q', 'tag', 'sort', 'limit', 'offset', 'type', 'category'])
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const SAFE_VIEW = /^(?:\/[^\s]*|https:\/\/[^\s]+)$/u
const TTL_MS = 60_000
const INDEX_LIMIT = 2 * 1024 * 1024

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max) : '')
const ids = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === 'string' && ID.test(x)).slice(0, 32) : [])

function readJson(path) {
  if (!path || !existsSync(path)) return null
  try {
    if (statSync(path).size > 2 * 1024 * 1024) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch { return null }
}

/** apps.json → what the views draw. view: null means "no screen" (Oscar's dashed ring). */
export function readWizardApps(appsJsonPath) {
  const doc = readJson(appsJsonPath)
  const apps = []
  const seen = new Set()
  for (const app of Array.isArray(doc?.apps) ? doc.apps : []) {
    const id = text(app?.id, 64)
    if (!ID.test(id) || seen.has(id)) continue
    seen.add(id)
    let view = null
    if (typeof app.view === 'string' && SAFE_VIEW.test(app.view)) view = { open: app.view }
    else if (app.view && typeof app.view === 'object') {
      const open = [app.view.open, app.view.url].find((u) => typeof u === 'string' && SAFE_VIEW.test(u))
      view = open ? { open } : null
    }
    apps.push({
      id, name: text(app.name, 60) || id, summary: text(app.summary, 200),
      type: text(app.type, 24), category: text(app.category, 24), version: text(app.version, 32), status: text(app.status, 24),
      uses: ids(app.uses), provides: ids(app.provides), view,
    })
  }
  return { schema: 1, store: text(doc?.store, 40) || 'wizardapps', apps }
}

/** Builds the index proxy with a small cache. fetchImpl and now are injectable for tests. */
export function createIndexProxy({ base = APP_INDEX_URL, fetchImpl = fetch, now = Date.now, timeoutMs = 8000 } = {}) {
  const cache = new Map()
  return async function proxy(subpath, searchParams) {
    if (!INDEX_PATH.test(subpath)) return { status: 404, body: { error: 'not_found' } }
    const q = new URLSearchParams()
    for (const [k, v] of searchParams) if (INDEX_QUERY.has(k) && v.length <= 200) q.set(k, v)
    const target = `${base.replace(/\/$/u, '')}${subpath}${q.size ? `?${q}` : ''}`
    const hit = cache.get(target)
    if (hit && now() - hit.at < TTL_MS) return { status: 200, body: hit.body, cached: true }
    try {
      const r = await fetchImpl(target, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
      const raw = await r.text()
      if (raw.length > INDEX_LIMIT) return { status: 502, body: { error: 'index_too_large' } }
      let body
      try { body = JSON.parse(raw) } catch { return { status: 502, body: { error: 'index_unreadable' } } }
      if (!r.ok) return { status: r.status === 404 ? 404 : 502, body: { error: r.status === 404 ? 'not_found' : 'index_unavailable' } }
      cache.set(target, { at: now(), body })
      if (cache.size > 200) cache.delete(cache.keys().next().value)
      return { status: 200, body }
    } catch {
      if (hit) return { status: 200, body: hit.body, stale: true }
      return { status: 502, body: { error: 'index_unavailable' } }
    }
  }
}

/**
 * Route handler. Returns true when it answered. access(request) → boolean gates both routes the same way
 * /wizard/v1/apps is gated.
 */
export function createAppsViewsRoutes({ appsJsonPath, indexBase, fetchImpl, access } = {}) {
  const index = createIndexProxy({ base: indexBase || APP_INDEX_URL, ...(fetchImpl ? { fetchImpl } : {}) })
  const send = (response, status, value) => {
    const body = Buffer.from(JSON.stringify(value))
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(body)
  }
  return async function handle(request, response, url) {
    const p = url.pathname
    const mine = p === '/wizard/v1/wizard-apps' || p === '/wizard/v1/index' || p.startsWith('/wizard/v1/index/')
    if (!mine) return false
    if (request.method !== 'GET' && request.method !== 'HEAD') { send(response, 405, { error: 'read_only' }); return true }
    if (access && !await access(request)) { send(response, 403, { error: 'access_required' }); return true }
    if (p === '/wizard/v1/wizard-apps') { send(response, 200, readWizardApps(appsJsonPath)); return true }
    const r = await index(p.slice('/wizard/v1/index'.length) || '/', url.searchParams)
    send(response, r.status, r.body)
    return true
  }
}
