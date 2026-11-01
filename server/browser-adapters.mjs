// Stage-2 prototype: fixed synthetic operation, not an HTTP/MCP relay.
import { randomUUID } from 'node:crypto'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',')
export function createBrowserAdapters({ resolveInstallation, resolveGrants } = {}) {
  const bindings = new Map()
  const snapshot = appId => {
    const p = resolveInstallation?.(appId)
    if (!p || p.status !== 'running' || !p.installationId || !p.sourceId || !p.installedCommit || !p.permissionRevision) fail('not_allowed')
    return structuredClone(p)
  }
  const identity = p => JSON.stringify([p.installationId, p.sourceId, p.installedCommit, p.permissionRevision])
  const admit = (p, operation) => {
    const grants = resolveGrants?.(p.installationId)
    if (!Array.isArray(p.browser_contract?.operations) || !p.browser_contract.operations.includes(operation) || !grants?.operations?.includes(operation)) fail('not_allowed')
  }
  function current(b) {
    if (!b || b.expires < Date.now()) fail('stale_binding')
    const p = snapshot(b.appId)
    if (identity(p) !== identity(b.principal)) fail('revoked')
    return p
  }
  return Object.freeze({
    create(request) {
      if (!exact(request, ['appId', 'generation']) || typeof request.appId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(request.appId) || !/^[a-f0-9-]{36}$/.test(request.generation)) fail('bad_request')
      const p = snapshot(request.appId)
      for (const [id,b] of bindings) if (b.expires < Date.now()) bindings.delete(id)
      if (bindings.size >= 512) fail('busy')
      const handle = randomUUID()
      bindings.set(handle, { appId: request.appId, principal: p, generation: request.generation, expires: Date.now()+3600000, seen: new Set() })
      return { handle, principal: { installationId: p.installationId, sourceId: p.sourceId, installedCommit: p.installedCommit, permissionRevision: p.permissionRevision } }
    },
    check(request) {
      if (!exact(request, ['handle', 'generation', 'requestId', 'operation', 'args'])) fail('bad_request')
      const b = bindings.get(request.handle), p = current(b)
      if (request.generation !== b.generation) fail('stale_binding')
      if (typeof request.requestId !== 'string' || !/^wbs-[1-9][0-9]{0,9}$/.test(request.requestId)) fail('bad_request')
      if (b.seen.has(request.requestId)) fail('replay')
      if (b.seen.size >= 4096) fail('busy')
      b.seen.add(request.requestId)
      // Declaration is only a request. Both state and data need independent grants.
      admit(p, request.operation)
      if (request.operation === 'state.local') {
        if (!exact(request.args, [])) fail('bad_request')
        return { principal: { installationId:p.installationId, sourceId:p.sourceId, installedCommit:p.installedCommit, permissionRevision:p.permissionRevision }, namespace: JSON.stringify(['local-owner-profile', p.installationId, p.sourceId]), quota: Math.min(5242880, Math.max(0, p.browser_contract?.state?.persistent_bytes || 0)) }
      }
      if (request.operation !== 'fixture.notifications.list') fail('not_allowed')
      if (!exact(request.args, ['limit']) || !Number.isInteger(request.args.limit) || request.args.limit < 1 || request.args.limit > 20) fail('bad_request')
      const result = { items: [{ id: 'synthetic-1', title: 'Synthetic list item', read: false, revision: 'r1' }].slice(0, request.args.limit), nextCursor: null }
      // Fixed output schema; no upstream bodies, headers, redirects or credentials.
      if (!exact(result, ['items','nextCursor']) || result.nextCursor !== null || result.items.some(x => !exact(x,['id','title','read','revision']) || typeof x.id !== 'string' || typeof x.title !== 'string' || x.title.length > 200 || typeof x.read !== 'boolean' || typeof x.revision !== 'string')) fail('backend_failed')
      current(b); admit(snapshot(b.appId), request.operation)
      return result
    },
    revoke(handle) { bindings.delete(handle) },
  })
}

export async function browserAdaptersHttp(request, response, url, { enabled, principal, access, adapters, readBody, send }) {
  if (!url.pathname.startsWith('/wizard/v1/browser-adapters/')) return false
  const reply = (status, value) => send(response, status, value, { 'Cache-Control': 'no-store' })
  if (!enabled || !adapters) { reply(404,{error:'not_found'}); return true }
  if (principal.kind !== 'owner' || !access) { reply(403,{error:'owner_required'}); return true }
  if (request.method !== 'POST') { reply(405,{error:'method_not_allowed'}); return true }
  try {
    const bytes = await readBody(request, 65536)
    const body = JSON.parse(bytes.toString('utf8'))
    let value
    if (url.pathname === '/wizard/v1/browser-adapters/bindings') value = adapters.create(body)
    else if (url.pathname === '/wizard/v1/browser-adapters/call') value = adapters.check(body)
    else if (url.pathname === '/wizard/v1/browser-adapters/revoke' && exact(body,['handle'])) { adapters.revoke(body.handle); value = {revoked:true} }
    else fail('bad_request')
    reply(200,value)
  } catch (e) { const code = ['bad_request','not_allowed','stale_binding','revoked','replay','busy','backend_failed'].includes(e.code) ? e.code : 'bad_request'; reply(code === 'bad_request' ? 400 : 403,{error:code}) }
  return true
}
