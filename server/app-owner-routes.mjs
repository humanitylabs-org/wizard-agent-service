// Trusted bootstrap registration only. This is not an installed-metadata plugin loader.
import { principalOf, isAgentIngress } from './principals.mjs'

const ID = /^[a-z][a-z0-9-]{1,40}$/u
export function createAppOwnerRoutes(registrations = []) {
  if (!Array.isArray(registrations)) throw Error('invalid_app_owner_routes')
  const rows = registrations.map(row => {
    if (!ID.test(row?.appId || '') || typeof row.handle !== 'function' || !Array.isArray(row.routes) || !row.routes.length ||
        row.routes.some(r => !/^(GET|POST) [a-z][a-z0-9-]*$/u.test(r))) throw Error('invalid_app_owner_routes')
    return Object.freeze({ ...row, base: `/wizard/apps/${row.appId}/api/`, routes: new Set(row.routes) })
  })
  if (new Set(rows.map(r => r.appId)).size !== rows.length) throw Error('duplicate_app_owner_route')
  return async (request, response, { accessAllowed, installed }) => {
    // Use the ORIGINAL raw target; URL normalization may erase dot segments or encodings.
    const raw = request.url || ''
    const row = rows.find(r => raw.startsWith(r.base) || raw === r.base.slice(0, -1))
    if (!row) return false
    const deny = status => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"error":"app_owner_route_denied"}'); return true }
    const principal = principalOf(request)
    if (!await accessAllowed() || isAgentIngress(request) || principal.kind !== 'owner' || !['proxy_proof', 'access_verifier'].includes(principal.via)) return deny(403)
    if (!installed(row.appId)) return deny(404)
    if (!row.routes.has(`${request.method} ${raw.slice(row.base.length)}`)) return deny(403)
    if (await row.handle(request, response) !== true) return deny(503)
    return true
  }
}
