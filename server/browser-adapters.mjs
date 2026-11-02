// Fixed browser data/state admission, not an HTTP/MCP relay. Identity and grants come only from the
// injected resolver: the synthetic prototype rig, or the production WAM resolver (browser-installations.mjs).
import { randomUUID } from 'node:crypto'
import { OPERATIONS, OPERATION_KEY, WRITE_OPERATIONS, createNotificationsOperations } from './browser-operations.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',')
export function createBrowserAdapters({ resolveInstallation, resolveGrants, operations = null } = {}) {
  const bindings = new Map()
  const snapshot = appId => {
    const p = resolveInstallation?.(appId)
    if (!p || p.status !== 'running' || !p.installationId || !p.sourceId || !p.installedCommit || !p.permissionRevision) fail('not_allowed')
    return structuredClone(p)
  }
  const identity = p => JSON.stringify([p.installationId, p.sourceId, p.installedCommit, p.permissionRevision, p.upstream ?? null])
  const admit = (p, operation) => {
    const descriptor = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : null
    if (!descriptor) fail('not_allowed')
    const grants = resolveGrants?.(p.installationId, p.sourceId)
    if (!Array.isArray(p.browser_contract?.operations) || !p.browser_contract.operations.includes(operation) || !grants?.operations?.includes(operation)) fail('not_allowed')
    // Provider-bound operations: only the slot's CURRENT provider installation (provider change = refusal).
    if (descriptor.slot && p.providers?.[descriptor.slot] !== true) fail('not_allowed')
  }
  function admitRequest(request, keys) {
    if (!exact(request, keys)) fail('bad_request')
    const b = bindings.get(request.handle), p = current(b)
    if (request.generation !== b.generation) fail('stale_binding')
    if (typeof request.requestId !== 'string' || !/^wbs-[1-9][0-9]{0,9}$/.test(request.requestId)) fail('bad_request')
    if (b.seen.has(request.requestId)) fail('replay')
    if (b.seen.size >= 4096) fail('busy')
    b.seen.add(request.requestId)
    return { b, p }
  }
  // Re-resolve the installation before an effect and before releasing any result.
  const recheck = (b, operation) => { const p = current(b); admit(p, operation); return p }
  const real = new Set(['notifications.list', 'notifications.mark_read', 'notifications.inbox', 'notifications.mark', 'data.status'])
  async function call(request) {
    const write = WRITE_OPERATIONS.includes(request?.operation)
    const { b, p } = admitRequest(request, ['handle', 'generation', 'requestId', 'operation', 'args', ...(write ? ['operationKey'] : [])])
    if (!operations) fail('unsupported_capability')
    if (request.operation === 'data.status') {
      if (!request.args || typeof request.args !== 'object' || typeof request.args.operation !== 'string') fail('bad_request')
      admit(p, request.args.operation)
      const value = await operations.status(p, request.args)
      recheck(b, request.args.operation)
      return value
    }
    admit(p, request.operation)
    if (write && (typeof request.operationKey !== 'string' || !OPERATION_KEY.test(request.operationKey))) fail('bad_request')
    const effect = async () => recheck(b, request.operation)
    const value = request.operation === 'notifications.list' ? await operations.list(p, request.args)
      : request.operation === 'notifications.inbox' ? await operations.inbox(p, request.args)
        : request.operation === 'notifications.mark' ? await operations.mark(p, request.args, request.operationKey, effect)
          : await operations.markRead(p, request.args, request.operationKey, effect)
    recheck(b, request.operation)
    return value
  }
  function current(b) {
    if (!b || b.expires < Date.now()) fail('stale_binding')
    const p = snapshot(b.appId)
    if (identity(p) !== identity(b.principal)) fail('revoked')
    return p
  }
  const api = Object.freeze({
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
      const { b, p } = admitRequest(request, ['handle', 'generation', 'requestId', 'operation', 'args'])
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
    call,
    /** HTTP entry: fixed real operations are async; state.local and the synthetic fixture stay synchronous. */
    async dispatch(request) { return real.has(request?.operation) ? call(request) : api.check(request) },
    revoke(handle) { bindings.delete(handle) },
  })
  return api
}

const HTTP_ERRORS = Object.freeze({
  bad_request: 400, not_allowed: 403, stale_binding: 403, revoked: 403, replay: 403, not_found: 404,
  conflict: 409, outcome_unknown: 409, busy: 429, quota_exceeded: 507, unsupported_capability: 501,
  backend_failed: 502, backend_unavailable: 503, storage_unavailable: 503, timeout: 504,
})

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
    else if (url.pathname === '/wizard/v1/browser-adapters/call') value = await (adapters.dispatch ? adapters.dispatch(body) : adapters.check(body))
    else if (url.pathname === '/wizard/v1/browser-adapters/revoke' && exact(body,['handle'])) { adapters.revoke(body.handle); value = {revoked:true} }
    else fail('bad_request')
    reply(200,value)
  } catch (e) {
    const code = Object.hasOwn(HTTP_ERRORS, e.code) ? e.code : 'bad_request'
    // Sanitized: code plus the documented outcome fields only; never an upstream body or credential.
    reply(HTTP_ERRORS[code], { error: code, ...(e.outcome ? { outcome: e.outcome } : {}), ...(e.operationKey ? { operationKey: e.operationKey } : {}), retryable: ['busy', 'timeout', 'backend_unavailable', 'storage_unavailable'].includes(code) })
  }
  return true
}
