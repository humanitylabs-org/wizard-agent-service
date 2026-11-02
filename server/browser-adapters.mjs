// Fixed browser data/state admission, not an HTTP/MCP relay. Identity and grants come only from the
// injected resolver: the synthetic prototype rig, or the production WAM resolver (browser-installations.mjs).
import { randomUUID } from 'node:crypto'
import { OPERATIONS, OPERATION_KEY, WRITE_OPERATIONS, createNotificationsOperations } from './browser-operations.mjs'
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }) }
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',')
// Files view sub-operations: one grant (files.upload) covers the whole upload port.
const FILES_UPLOAD = Object.freeze({ 'files.upload.create': 'uploadCreate', 'files.upload.status': 'uploadStatus', 'files.upload.commit': 'uploadCommit', 'files.upload.abort': 'uploadAbort' })
const FILES_READ = Object.freeze({ 'files.list': 'list', 'files.index': 'index', 'files.thumbnail': 'thumbnail' })
const THUMBNAILS_PER_MINUTE = 240
export function createBrowserAdapters({ resolveInstallation, resolveGrants, operations = null, tickets = null, ai = null, files = null, now = () => Date.now() } = {}) {
  const bindings = new Map()
  // Shell intents (wizard-os spec/browser-trust-shell-intents). An owner-consent operation runs only through an intent
  // the SHELL queued and confirmed: bound to the binding + document generation, installation/source/commit/permission
  // revision, the operation and its exact normalized arguments + operationKey; consumed once; 2 min to confirm.
  // Review requests: at most 3 a minute per installation (confirm + navigate together), one open per binding.
  const intents = new Map()
  const INTENT_TTL_MS = 120_000, INTENTS_PER_MINUTE = 3, intentLog = new Map()
  const MEDIA_PER_MINUTE = 10, MEDIA_SESSION_MS = 8 * 3600 * 1000   // ADAPTER-SKETCH §6 renewal bounds
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
  const real = new Set(['notifications.list', 'notifications.mark_read', 'notifications.inbox', 'notifications.mark', 'notifications.media', 'data.status', ...Object.keys(ai || {}),
    ...(files ? [...Object.keys(FILES_READ), 'files.content', ...Object.keys(FILES_UPLOAD)] : [])])
  const filesBinding = (request, b, operation) => Object.freeze({
    handle: request.handle, generation: b.generation, appId: b.appId, identity: identity(b.principal), installationId: b.principal.installationId,
    recheck: async () => recheck(b, operation), current: () => recheck(b, operation),
  })
  // Media renewal bounds (ADAPTER-SKETCH §6), shared by every media operation of one binding.
  const mediaBudget = b => {
    const t = now()
    b.media = (b.media || []).filter(x => x > t - 60_000)
    if (b.media.length >= MEDIA_PER_MINUTE) fail('quota_exceeded')
    if (t - b.created > MEDIA_SESSION_MS) fail('stale_binding')
    b.media.push(t)
  }
  // Provider sign-in pages the Service itself read from this binding's upstream and matched to the installed contract.
  // The frame only ever sees the target id; the URL leaves only to the shell, through a confirmed navigation intent.
  const remember = b => (ref, target, url) => {
    b.signin ||= new Map()
    b.signin.delete(ref); b.signin.set(ref, { target, url, at: now() })
    while (b.signin.size > 16) b.signin.delete(b.signin.keys().next().value)
  }
  async function runAi(b, p, operation, args, operationKey) {
    const handler = ai[operation]
    const value = await handler.run(p, args, operationKey, { recheck: async () => recheck(b, operation), signin: remember(b) })
    recheck(b, operation)
    return value
  }
  async function callFiles(request) {
    const { b, p } = admitRequest(request, ['handle', 'generation', 'requestId', 'operation', 'args'])
    const op = request.operation, grant = Object.hasOwn(FILES_UPLOAD, op) ? 'files.upload' : op
    admit(p, grant)
    const ctx = filesBinding(request, b, grant)
    let value
    if (op === 'files.content') { mediaBudget(b); value = await files.content(p, request.args, ctx) }
    else if (Object.hasOwn(FILES_UPLOAD, op)) value = await files[FILES_UPLOAD[op]](p, request.args, ctx)
    else {
      if (op === 'files.thumbnail') {
        const t = now(); b.thumbs = (b.thumbs || []).filter(x => x > t - 60_000)
        if (b.thumbs.length >= THUMBNAILS_PER_MINUTE) fail('busy', { retryable: true })
        b.thumbs.push(t)
      }
      value = await files[FILES_READ[op]](p, request.args, ctx)
    }
    recheck(b, grant)   // grant/install still current before the result leaves
    return value
  }
  async function call(request) {
    if (files && (Object.hasOwn(FILES_READ, request?.operation) || Object.hasOwn(FILES_UPLOAD, request?.operation) || request?.operation === 'files.content')) return callFiles(request)
    const write = WRITE_OPERATIONS.includes(request?.operation)
    const { b, p } = admitRequest(request, ['handle', 'generation', 'requestId', 'operation', 'args', ...(write ? ['operationKey'] : [])])
    if (ai && Object.hasOwn(ai, request.operation)) {
      admit(p, request.operation)
      // Never on the app's word: no `confirmed` argument exists, and consent operations need a consumed intent.
      if (OPERATIONS[request.operation].consent === 'owner') fail('confirmation_required')
      const args = ai[request.operation].validate(request.args)
      if (write && (typeof request.operationKey !== 'string' || !OPERATION_KEY.test(request.operationKey))) fail('bad_request')
      return runAi(b, p, request.operation, args, request.operationKey)
    }
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
    if (request.operation === 'notifications.media') {
      // Renewal is just another open through this live binding: at most ten a minute, never past eight hours.
      mediaBudget(b)
      const value = await operations.media(p, request.args, Object.freeze({
        handle: request.handle, generation: b.generation, appId: b.appId, identity: identity(p),
        recheck: effect, current: () => recheck(b, 'notifications.media'),
      }))
      recheck(b, request.operation)
      return value
    }
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
  // A content ticket is good only while its binding is live and the installation/grant it was minted under is
  // still current (same installation, source, commit, permission revision; operation still granted).
  tickets?.setAdmission(e => {
    try {
      const b = bindings.get(e.handle)
      if (!b || b.generation !== e.generation || b.appId !== e.appId) return false
      const p = current(b)
      if (identity(p) !== e.identity) return false
      admit(p, e.operation)
      return true
    } catch { return false }
  })
  function intentBudget(p) {
    const t = now(), log = (intentLog.get(p.installationId) || []).filter(x => x > t - 60_000)
    if (log.length >= INTENTS_PER_MINUTE) fail('rate_limited', { retryAfterMs: Math.max(1, log[0] + 60_000 - t) })
    log.push(t); intentLog.set(p.installationId, log)
  }
  const host = url => { const u = new URL(url); return { host: u.hostname, path: u.pathname } }
  /** Shell-only: queue a review. confirm = {operation, args, operationKey}; navigate = {target, ref}. */
  async function intentCreate(request) {
    const kind = request?.kind
    const keys = kind === 'confirm' ? ['handle', 'generation', 'requestId', 'kind', 'operation', 'args', 'operationKey'] : ['handle', 'generation', 'requestId', 'kind', 'target', 'ref']
    if (kind !== 'confirm' && kind !== 'navigate') fail('bad_request')
    const { b, p } = admitRequest(request, keys)
    for (const [id, it] of intents) if (it.expires < now() || it.consumed) intents.delete(id)
    if ([...intents.values()].some(it => it.handle === request.handle)) fail('busy', { retryable: true })
    let entry
    if (kind === 'confirm') {
      if (!ai || !Object.hasOwn(ai, request.operation) || OPERATIONS[request.operation]?.consent !== 'owner') fail('not_allowed')
      admit(p, request.operation)
      const args = ai[request.operation].validate(request.args)
      if (typeof request.operationKey !== 'string' || !OPERATION_KEY.test(request.operationKey)) fail('bad_request')
      intentBudget(p)
      const summary = await ai[request.operation].describe(p, args)
      recheck(b, request.operation)
      entry = { kind, operation: request.operation, args, digest: JSON.stringify([request.operation, args, request.operationKey]), operationKey: request.operationKey, summary }
    } else {
      if (typeof request.target !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(request.target) || typeof request.ref !== 'string' || !/^(ai|cc):[A-Za-z0-9_-]{8,64}$/.test(request.ref)) fail('bad_request')
      const seen = b.signin?.get(request.ref)
      // Only a page this binding's own upstream produced, for an operation still granted, still in the contract.
      const producer = request.ref.startsWith('ai:') ? 'ai_accounts.progress' : 'claude_code.connect'
      admit(p, producer)
      if (!seen || seen.target !== request.target || now() - seen.at > 15 * 60_000) fail('not_found')
      const { navigationTarget } = await import('./browser-ai-accounts.mjs')
      if (navigationTarget(p.browser_contract, seen.url) !== request.target) fail('not_allowed')
      intentBudget(p)
      const where = host(seen.url)
      entry = { kind, target: request.target, ref: request.ref, url: seen.url, summary: { title: 'Open the sign-in page?', detail: `Opens ${where.host} in a new tab. Sign in there, then come back.`, danger: false, action: 'Open', ...where } }
    }
    const id = randomUUID()
    intents.set(id, { ...entry, id, handle: request.handle, generation: b.generation, identity: identity(p), appId: b.appId, expires: now() + INTENT_TTL_MS, consumed: false })
    return { intent: id, kind, expiresAt: new Date(now() + INTENT_TTL_MS).toISOString(), summary: entry.summary }
  }
  /** Shell-only, after a trusted owner activation in the shell's own dialog. Consumes the intent before any effect. */
  async function intentConfirm(request) {
    // No requestId here: the intent id itself is the single-use handle (the frame never learns it).
    if (!exact(request, ['handle', 'generation', 'intent'])) fail('bad_request')
    const b = bindings.get(request.handle), p = current(b)
    if (request.generation !== b.generation) fail('stale_binding')
    const it = typeof request.intent === 'string' ? intents.get(request.intent) : null
    if (!it || it.handle !== request.handle || it.generation !== b.generation) fail('not_found')
    if (it.consumed) fail('replay')
    it.consumed = true; intents.delete(it.id)
    if (it.expires < now()) fail('expired')
    if (identity(p) !== it.identity) fail('revoked')   // update, source switch, grant change since the review opened
    if (it.kind === 'navigate') {
      const producer = it.ref.startsWith('ai:') ? 'ai_accounts.progress' : 'claude_code.connect'
      admit(p, producer)
      const { navigationTarget } = await import('./browser-ai-accounts.mjs')
      if (navigationTarget(p.browser_contract, it.url) !== it.target) fail('not_allowed')
      return { kind: 'navigate', url: it.url }
    }
    admit(p, it.operation)
    return { kind: 'confirm', value: await runAi(b, p, it.operation, it.args, it.operationKey) }
  }
  function intentCancel(request) {
    if (!exact(request, ['handle', 'intent'])) fail('bad_request')
    const it = intents.get(request.intent)
    if (it && it.handle === request.handle) intents.delete(it.id)
    return { cancelled: true }
  }
  /**
   * One upload chunk from the shell's upload port (Files view). Per chunk: the upload ticket, the SAME live binding and
   * document generation, the installation unchanged and files.upload still granted; then exact offset + chunk hash.
   */
  async function uploadChunk({ ticket, offset, sha256, body }) {
    if (!files) fail('unsupported_capability')
    const t = files.chunkTicket(ticket)
    const b = bindings.get(t.handle)
    if (!b) fail('revoked')
    if (b.generation !== t.generation) fail('stale_binding')
    const p = current(b)
    if (p.installationId !== t.installationId) fail('revoked')
    admit(p, 'files.upload')
    const value = await files.uploadChunk(p, t, { offset, sha256, body })
    recheck(b, 'files.upload')
    return value
  }
  const api = Object.freeze({
    intentCreate, intentConfirm, intentCancel, uploadChunk,
    create(request) {
      if (!exact(request, ['appId', 'generation']) || typeof request.appId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(request.appId) || !/^[a-f0-9-]{36}$/.test(request.generation)) fail('bad_request')
      const p = snapshot(request.appId)
      for (const [id,b] of bindings) if (b.expires < Date.now()) bindings.delete(id)
      if (bindings.size >= 512) fail('busy')
      const handle = randomUUID()
      bindings.set(handle, { appId: request.appId, principal: p, generation: request.generation, created: now(), expires: Date.now()+3600000, seen: new Set() })
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
    revoke(handle) { bindings.delete(handle); tickets?.revokeBinding(handle); files?.forget(handle); for (const [id, it] of intents) if (it.handle === handle) intents.delete(id) },
  })
  return api
}

const HTTP_ERRORS = Object.freeze({
  bad_request: 400, not_allowed: 403, stale_binding: 403, revoked: 403, replay: 403, confirmation_required: 403, not_found: 404,
  expired: 410, rate_limited: 429, offset_mismatch: 409, integrity: 422, too_large: 413,
  conflict: 409, outcome_unknown: 409, busy: 429, quota_exceeded: 507, unsupported_capability: 501,
  backend_failed: 502, backend_unavailable: 503, storage_unavailable: 503, timeout: 504,
})

export async function browserAdaptersHttp(request, response, url, { enabled, principal, access, adapters, readBody, send }) {
  if (!url.pathname.startsWith('/wizard/v1/browser-adapters/')) return false
  const reply = (status, value) => send(response, status, value, { 'Cache-Control': 'no-store' })
  if (!enabled || !adapters) { reply(404,{error:'not_found'}); return true }
  if (principal.kind !== 'owner' || !access) { reply(403,{error:'owner_required'}); return true }
  if (request.method !== 'POST') { reply(405,{error:'method_not_allowed'}); return true }
  if (url.pathname === '/wizard/v1/browser-adapters/upload-chunk' && adapters.uploadChunk) {
    // Binary chunk (<= 1 MiB) of the Files view's upload port; the shell sends it, never the frame.
    try {
      const sha256 = String(request.headers['x-wizard-chunk-sha256'] || ''), offsetHeader = String(request.headers['upload-offset'] || '')
      if (!/^\d{1,16}$/.test(offsetHeader) || !String(request.headers['content-type'] || '').startsWith('application/offset+octet-stream')) fail('bad_request')
      const body = await readBody(request, 1024 * 1024)
      reply(200, await adapters.uploadChunk({ ticket: String(request.headers['x-wizard-upload-ticket'] || ''), offset: Number(offsetHeader), sha256, body }))
    } catch (e) {
      const code = Object.hasOwn(HTTP_ERRORS, e.code) ? e.code : e.status === 413 || e.code === 'body_too_large' ? 'too_large' : 'bad_request'
      reply(HTTP_ERRORS[code], { error: code, ...(Number.isSafeInteger(e.offset) ? { offset: e.offset } : {}), retryable: ['busy', 'timeout', 'backend_unavailable', 'backend_failed'].includes(code) && e.retryable !== false })
    }
    return true
  }
  try {
    const bytes = await readBody(request, 65536)
    const body = JSON.parse(bytes.toString('utf8'))
    let value
    if (url.pathname === '/wizard/v1/browser-adapters/bindings') value = adapters.create(body)
    else if (url.pathname === '/wizard/v1/browser-adapters/call') value = await (adapters.dispatch ? adapters.dispatch(body) : adapters.check(body))
    else if (url.pathname === '/wizard/v1/browser-adapters/revoke' && exact(body,['handle'])) { adapters.revoke(body.handle); value = {revoked:true} }
    else if (url.pathname === '/wizard/v1/browser-adapters/intents' && adapters.intentCreate) value = await adapters.intentCreate(body)
    else if (url.pathname === '/wizard/v1/browser-adapters/intents/confirm' && adapters.intentConfirm) value = await adapters.intentConfirm(body)
    else if (url.pathname === '/wizard/v1/browser-adapters/intents/cancel' && adapters.intentCancel) value = adapters.intentCancel(body)
    else fail('bad_request')
    reply(200,value)
  } catch (e) {
    const code = Object.hasOwn(HTTP_ERRORS, e.code) ? e.code : 'bad_request'
    // Sanitized: code plus the documented outcome fields only; never an upstream body or credential.
    reply(HTTP_ERRORS[code], { error: code, ...(e.outcome ? { outcome: e.outcome } : {}), ...(e.operationKey ? { operationKey: e.operationKey } : {}), ...(Number.isSafeInteger(e.retryAfterMs) ? { retryAfterMs: e.retryAfterMs } : {}), retryable: ['busy', 'timeout', 'backend_unavailable', 'storage_unavailable', 'rate_limited'].includes(code) })
  }
  return true
}
