// Fixed browser data operations for the Notifications default app. Not a relay: each operation has one
// constant upstream path on the installation's WAM-recorded upstream, exact argument/result schemas and
// no owner credentials, cookies, shell token, redirects or upstream bodies passed through.
import { createHash } from 'node:crypto'

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }) }
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',')
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/
const REVISION = /^r-[a-f0-9]{16}$/
export const OPERATION_KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024

/** Reviewed registry v1 (wizard-os spec/BROWSER_TRUST_ADAPTERS.md). `slot` = must be that slot's current provider. */
export const OPERATIONS = Object.freeze({
  'state.local': Object.freeze({ kind: 'state' }),
  'fixture.notifications.list': Object.freeze({ kind: 'read', fixture: true }),
  'notifications.list': Object.freeze({ kind: 'read', slot: 'notifications' }),
  'notifications.mark_read': Object.freeze({ kind: 'write', slot: 'notifications' }),
})

const revisionOf = it => 'r-' + sha(['notification-mark-v1', it.id, !!it.read, !!it.flag, !!it.archived]).slice(0, 16)

function project(raw) {
  // Fixed output DTO; anything off-schema is a backend failure, never forwarded.
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items) || raw.items.length > 500) fail('backend_failed')
  return raw.items.map(it => {
    if (!it || typeof it.id !== 'string' || !ITEM_ID.test(it.id) || typeof it.read !== 'boolean') fail('backend_failed')
    return {
      id: it.id,
      title: typeof it.title === 'string' ? it.title.slice(0, 200) : '',
      message: typeof it.message === 'string' ? it.message.slice(0, 2000) : '',
      time: Number.isSafeInteger(it.time) && it.time >= 0 ? it.time : 0,
      read: it.read,
      revision: revisionOf(it),
    }
  })
}

export function createNotificationsOperations({ fetchImpl = globalThis.fetch, receipts, timeoutMs = 15000 } = {}) {
  const inflight = new Set()
  async function upstream(p, path, body) {
    if (!p.upstream) fail('backend_unavailable')
    let r
    try {
      r = await fetchImpl(new URL(path, p.upstream), {
        method: body ? 'POST' : 'GET', redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
        headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) { fail(e?.name === 'TimeoutError' ? 'timeout' : 'backend_unavailable') }
    if (r.status !== 200 || !String(r.headers.get('content-type') || '').startsWith('application/json')) fail('backend_failed')
    const text = await r.text()
    if (Buffer.byteLength(text) > MAX_UPSTREAM_BYTES) fail('backend_failed')
    try { return JSON.parse(text) } catch { fail('backend_failed') }
  }
  const inbox = async (p, limit) => project(await upstream(p, `/notifications/api/items?view=inbox&limit=${limit}`))
  const find = async (p, id) => (await inbox(p, 500)).find(it => it.id === id) || null

  async function list(p, args) {
    if (!exact(args, ['limit', 'cursor']) || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50) fail('bad_request')
    if (args.cursor !== null) fail('unsupported_capability')   // no stable upstream cursor yet
    const items = (await inbox(p, args.limit)).slice(0, args.limit).map(({ id, title, message, time, read, revision }) => ({ id, title, message, time, read, revision }))
    return { items, nextCursor: null }
  }

  async function markRead(p, args, operationKey, recheck) {
    if (!receipts) fail('unsupported_capability')
    if (!exact(args, ['id', 'expectedRevision']) || typeof args.id !== 'string' || !ITEM_ID.test(args.id) || typeof args.expectedRevision !== 'string' || !REVISION.test(args.expectedRevision)) fail('bad_request')
    if (typeof operationKey !== 'string' || !OPERATION_KEY.test(operationKey)) fail('bad_request')
    const op = 'notifications.mark_read', digest = sha([op, args.id, args.expectedRevision])
    const lock = [p.installationId, op, operationKey].join('|')
    if (inflight.has(lock)) fail('busy', { retryable: true })   // concurrent retry of the same key
    inflight.add(lock)
    try {
      let r = receipts.get(p.installationId, op, operationKey)
      if (r && (r.digest !== digest || r.sourceId !== p.sourceId)) fail('conflict')   // key reuse, other args/source
      if (r?.status === 'succeeded') return r.result
      if (r?.status === 'failed') fail(r.error)
      const base = { installationId: p.installationId, sourceId: p.sourceId, operation: op, operationKey, digest }
      const settle = (status, extra) => receipts.put({ ...base, status, ...extra })
      const cur = await find(p, args.id)
      if (!r) {
        if (!cur) { settle('failed', { error: 'not_found' }); fail('not_found') }
        if (cur.revision !== args.expectedRevision) { settle('failed', { error: 'conflict' }); fail('conflict') }
        r = settle('pending')    // durable BEFORE the effect; quota/storage failure stops here, nothing written upstream
      } else if (cur?.read) {
        // Reconcile a lost reply: the earlier attempt landed.
        const result = { id: args.id, read: true, revision: cur.revision, operationKey }
        settle('succeeded', { result }); return result
      } else if (!cur || cur.revision !== args.expectedRevision) {
        settle('failed', { error: cur ? 'conflict' : 'not_found' }); fail(cur ? 'conflict' : 'not_found')
      }
      await recheck()   // grant/install/source still current immediately before the effect
      let applied = true
      try { await upstream(p, '/notifications/api/mark', { ids: [args.id], read: true }) } catch { applied = false }
      let after = null
      try { after = await find(p, args.id) } catch { /* readback unavailable: outcome unknown */ }
      if (!after?.read) {
        try { settle('unknown') } catch { /* pending receipt stays; next retry reconciles */ }
        fail('outcome_unknown', { outcome: applied ? 'unknown' : 'not_started_or_unknown', operationKey })
      }
      const result = { id: args.id, read: true, revision: after.revision, operationKey }
      try { settle('succeeded', { result }) } catch { fail('outcome_unknown', { outcome: 'unknown', operationKey }) }
      return result
    } finally { inflight.delete(lock) }
  }

  async function status(p, args) {
    if (!receipts) fail('unsupported_capability')
    if (!exact(args, ['operation', 'operationKey']) || args.operation !== 'notifications.mark_read' || typeof args.operationKey !== 'string' || !OPERATION_KEY.test(args.operationKey)) fail('bad_request')
    const r = receipts.get(p.installationId, args.operation, args.operationKey)
    if (!r || r.sourceId !== p.sourceId) fail('not_found')   // scoped: other installs/sources cannot probe keys
    const out = { status: r.status === 'unknown' ? 'unknown' : r.status, operationKey: r.operationKey }
    if (r.status === 'succeeded') out.result = r.result
    if (r.status === 'failed') out.error = { code: r.error, retryable: false }
    return out
  }

  return Object.freeze({ list, markRead, status })
}
