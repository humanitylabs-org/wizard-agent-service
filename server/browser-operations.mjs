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
const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024   // 500 inbox items with full bodies
const VIEWS = new Set(['inbox', 'flagged', 'archive', 'all'])
const MARKS = ['read', 'flag', 'archived']

// Pictures: the same rules as the app's own /notifications/media/ (image extension, sniffed type, 8 MiB).
const MEDIA_MAX_BYTES = 8 * 1024 * 1024
const MEDIA_LINE = /^\s*MEDIA:(\/\S{1,1000})\s*$/
const RESOURCE = /^n:([A-Za-z0-9_-]{1,128}):([1-9][0-9]?)$/
const PURPOSES = new Set(['thumbnail', 'read'])
const MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  const h = b.subarray(0, 6).toString('latin1'); if (h === 'GIF87a' || h === 'GIF89a') return 'image/gif'
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return ''
}
/** The n-th MEDIA:/path line of a notification body (1-based), as the app's renderer numbers them. */
export function mediaPath(message, index) {
  let n = 0
  for (const line of String(message || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = MEDIA_LINE.exec(line)
    if (m && ++n === index) return m[1]
  }
  return null
}

/** Reviewed registry v1 (wizard-os spec/BROWSER_TRUST_ADAPTERS.md). `slot` = must be that slot's current provider. */
export const OPERATIONS = Object.freeze({
  'state.local': Object.freeze({ kind: 'state' }),
  'fixture.notifications.list': Object.freeze({ kind: 'read', fixture: true }),
  'notifications.list': Object.freeze({ kind: 'read', slot: 'notifications' }),
  'notifications.mark_read': Object.freeze({ kind: 'write', slot: 'notifications' }),
  // Card 2 (wizard-os spec/browser-trust-card2-notifications): the real Notifications screens.
  'notifications.inbox': Object.freeze({ kind: 'read', slot: 'notifications' }),
  'notifications.mark': Object.freeze({ kind: 'write', slot: 'notifications' }),
  // Card 3 media (ADAPTER-SKETCH §6): one picture of one notification, as a 60 s read ticket. Own grant.
  'notifications.media': Object.freeze({ kind: 'media', slot: 'notifications' }),
  // Shell intents (wizard-os spec/browser-trust-shell-intents): the ChatGPT/Claude connection pages, each the
  // installation's own upstream. `consent: 'owner'` = only through a consumed trusted-shell confirmation, never a plain
  // data.call. `signin` = may hand the shell a provider sign-in page (navigation intent, installed contract only).
  'ai_accounts.inventory': Object.freeze({ kind: 'read' }),
  'ai_accounts.change': Object.freeze({ kind: 'write', consent: 'owner' }),
  'ai_accounts.progress': Object.freeze({ kind: 'read', signin: true }),
  'ai_accounts.step': Object.freeze({ kind: 'write' }),
  'claude_code.status': Object.freeze({ kind: 'read' }),
  'claude_code.connect': Object.freeze({ kind: 'write', consent: 'owner', signin: true }),
  'claude_code.code': Object.freeze({ kind: 'write' }),
  'claude_code.cancel': Object.freeze({ kind: 'write' }),
  'claude_code.logout': Object.freeze({ kind: 'write', consent: 'owner' }),
  'claude_code.test': Object.freeze({ kind: 'write' }),
})
export const WRITE_OPERATIONS = Object.freeze(Object.keys(OPERATIONS).filter(k => OPERATIONS[k].kind === 'write'))

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

// Full inbox DTO for the real screens. Text is data; links are https only; nothing off-schema is forwarded.
// `cas` (internal, never returned) says the upstream reports the same revision, i.e. it can compare-and-set.
const nat = v => Number.isSafeInteger(v) && v >= 0 ? v : 0
const httpsLink = v => typeof v === 'string' && v.length <= 2000 && /^https:\/\/[^\s<>"]+$/.test(v) ? v : ''
function projectInbox(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items) || raw.items.length > 500) fail('backend_failed')
  const c = raw.counts && typeof raw.counts === 'object' ? raw.counts : {}
  const seen = new Set()
  const items = raw.items.map(it => {
    if (!it || typeof it.id !== 'string' || !ITEM_ID.test(it.id) || seen.has(it.id) || MARKS.some(k => typeof it[k] !== 'boolean')) fail('backend_failed')
    seen.add(it.id)
    const revision = revisionOf(it)
    return {
      id: it.id,
      title: typeof it.title === 'string' ? it.title.slice(0, 300) : '',
      message: typeof it.message === 'string' ? it.message.slice(0, 8000) : '',
      time: Number.isSafeInteger(it.time) && it.time >= 0 ? it.time : 0,
      priority: Number.isInteger(it.priority) && it.priority >= 1 && it.priority <= 5 ? it.priority : 3,
      link: httpsLink(it.link),
      source: it.source === 'cron' ? 'cron' : 'agent',
      read: it.read, flag: it.flag, archived: it.archived, revision,
      cas: it.revision === revision,
    }
  })
  return { counts: { unread: nat(c.unread), needs: nat(c.needs), flagged: nat(c.flagged) }, items }
}
const publicItem = ({ cas, ...it }) => it

export function createNotificationsOperations({ fetchImpl = globalThis.fetch, receipts, timeoutMs = 15000, listenerCredential = () => null, tickets = null, mediaMaxBytes = MEDIA_MAX_BYTES } = {}) {
  const inflight = new Set()
  // App-scoped listener credential (wizard-os #386); headers are built here, never copied from the request.
  function authHeaders(p) {
    let cred = null
    try { cred = listenerCredential(p) } catch { fail('backend_unavailable') }
    return cred ? { [cred.header]: cred.value } : {}
  }
  async function upstream(p, path, body) {
    if (!p.upstream) fail('backend_unavailable')
    const auth = authHeaders(p)
    let r
    try {
      r = await fetchImpl(new URL(path, p.upstream), {
        method: body ? 'POST' : 'GET', redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), accept: 'application/json', ...auth },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) { fail(e?.name === 'TimeoutError' ? 'timeout' : 'backend_unavailable') }
    if (r.status !== 200 || !String(r.headers.get('content-type') || '').startsWith('application/json')) fail('backend_failed')
    const text = await r.text()
    if (Buffer.byteLength(text) > MAX_UPSTREAM_BYTES) fail('backend_failed')
    try { return JSON.parse(text) } catch { fail('backend_failed') }
  }
  // A write's upstream reply: 'ok', 'conflict' (compare-and-set refused, nothing written) or 'unknown'.
  async function upstreamWrite(p, path, body) {
    if (!p.upstream) fail('backend_unavailable')
    const auth = authHeaders(p)   // before the effect: a missing credential is backend_unavailable, nothing sent
    try {
      const r = await fetchImpl(new URL(path, p.upstream), {
        method: 'POST', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...auth }, body: JSON.stringify(body),
      })
      await r.text().catch(() => '')
      return r.status === 200 ? 'ok' : r.status === 409 ? 'conflict' : 'unknown'
    } catch { return 'unknown' }
  }
  const all = async p => projectInbox(await upstream(p, '/notifications/api/items?view=all&limit=500'))
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

  // The real screens' read: one view (inbox | flagged | archive | all), counts and every mark.
  async function inboxView(p, args) {
    if (!exact(args, ['view', 'limit']) || !VIEWS.has(args.view) || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500) fail('bad_request')
    const { counts, items } = projectInbox(await upstream(p, `/notifications/api/items?view=${args.view}&limit=${args.limit}`))
    return { view: args.view, counts, items: items.slice(0, args.limit).map(publicItem) }
  }

  /** read / unread, flag / unflag, archive / restore and mark-all-read: one compare-and-set write for 1..500 items. */
  async function mark(p, args, operationKey, recheck) {
    if (!receipts) fail('unsupported_capability')
    if (!exact(args, ['items', 'marks']) || !Array.isArray(args.items) || args.items.length < 1 || args.items.length > 500) fail('bad_request')
    const ids = new Set()
    for (const it of args.items) {
      if (!exact(it, ['id', 'expectedRevision']) || typeof it.id !== 'string' || !ITEM_ID.test(it.id) || ids.has(it.id) || typeof it.expectedRevision !== 'string' || !REVISION.test(it.expectedRevision)) fail('bad_request')
      ids.add(it.id)
    }
    const marks = args.marks
    if (!marks || typeof marks !== 'object' || Array.isArray(marks) || !Object.keys(marks).length || Object.keys(marks).some(k => !MARKS.includes(k) || typeof marks[k] !== 'boolean')) fail('bad_request')
    if (typeof operationKey !== 'string' || !OPERATION_KEY.test(operationKey)) fail('bad_request')
    const op = 'notifications.mark', digest = sha([op, args.items.map(i => [i.id, i.expectedRevision]), MARKS.map(k => marks[k] ?? null)])
    const lock = [p.installationId, op, operationKey].join('|')
    if (inflight.has(lock)) fail('busy', { retryable: true })
    inflight.add(lock)
    // What each item must look like once the write landed (the backend also marks an archived item read).
    const want = cur => ({ read: marks.read ?? (marks.archived === true ? true : cur.read), flag: marks.flag ?? cur.flag, archived: marks.archived ?? cur.archived })
    const landed = (byId, before) => args.items.every(i => { const c = byId.get(i.id), w = before.get(i.id); return c && w && MARKS.every(k => c[k] === w[k]) })
    // Compact on purpose: it is kept in the durable receipt (1 MiB store) for 7 days. The screen re-reads.
    const result = byId => ({ items: args.items.map(i => ({ id: i.id, revision: byId.get(i.id).revision })), marks: { ...marks }, operationKey })
    try {
      let r = receipts.get(p.installationId, op, operationKey)
      if (r && (r.digest !== digest || r.sourceId !== p.sourceId)) fail('conflict')
      if (r?.status === 'succeeded') return r.result
      if (r?.status === 'failed') fail(r.error)
      const base = { installationId: p.installationId, sourceId: p.sourceId, operation: op, operationKey, digest }
      const settle = (status, extra) => receipts.put({ ...base, status, ...extra })
      const now = new Map((await all(p)).items.map(c => [c.id, c]))
      const missing = args.items.some(i => !now.has(i.id))
      const stale = args.items.some(i => now.get(i.id)?.revision !== i.expectedRevision)
      const target = new Map(args.items.filter(i => now.has(i.id)).map(i => [i.id, want(now.get(i.id))]))
      if (!r) {
        if (missing) { settle('failed', { error: 'not_found' }); fail('not_found') }
        if (stale) { settle('failed', { error: 'conflict' }); fail('conflict') }
        // Unread, unflag and restore are not monotonic: only an upstream that compares and sets may take them.
        if (args.items.some(i => !now.get(i.id).cas)) fail('unsupported_capability')
        r = settle('pending', { target: [...target] })   // durable BEFORE the effect; quota/storage failure stops here
      } else if (stale) {
        // A retry after a lost reply: the expected marks are gone. Either this write landed or someone else wrote.
        if (!missing && r.target && landed(now, new Map(r.target))) { const out = result(now); settle('succeeded', { result: out }); return out }
        settle('failed', { error: missing ? 'not_found' : 'conflict' }); fail(missing ? 'not_found' : 'conflict')
      }
      if (!r.target) r = settle(r.status, { target: [...target] })
      await recheck()
      const expect = Object.fromEntries(args.items.map(i => [i.id, i.expectedRevision]))
      const sent = await upstreamWrite(p, '/notifications/api/mark', { ids: args.items.map(i => i.id), ...marks, expect })
      if (sent === 'conflict') { settle('failed', { error: 'conflict' }); fail('conflict') }   // nothing was written
      let after = null
      try { after = new Map((await all(p)).items.map(c => [c.id, c])) } catch { /* readback unavailable */ }
      if (!after || !landed(after, new Map(r.target))) {
        try { settle('unknown', { target: r.target }) } catch { /* pending receipt stays; a retry reconciles */ }
        fail('outcome_unknown', { outcome: sent === 'ok' ? 'unknown' : 'not_started_or_unknown', operationKey })
      }
      const out = result(after)
      try { settle('succeeded', { result: out }) } catch { fail('outcome_unknown', { outcome: 'unknown', operationKey }) }
      return out
    } finally { inflight.delete(lock) }
  }

  async function status(p, args) {
    if (!receipts) fail('unsupported_capability')
    if (!exact(args, ['operation', 'operationKey']) || !WRITE_OPERATIONS.includes(args.operation) || typeof args.operationKey !== 'string' || !OPERATION_KEY.test(args.operationKey)) fail('bad_request')
    const r = receipts.get(p.installationId, args.operation, args.operationKey)
    if (!r || r.sourceId !== p.sourceId) fail('not_found')   // scoped: other installs/sources cannot probe keys
    const out = { status: r.status === 'unknown' ? 'unknown' : r.status, operationKey: r.operationKey }
    if (r.status === 'succeeded') out.result = r.result
    if (r.status === 'failed') out.error = { code: r.error, retryable: false }
    return out
  }

  // Picture bytes for one resolved path, through the app's own media route with this installation's credential.
  async function pictureBytes(p, path) {
    if (!p.upstream) fail('backend_unavailable')
    const auth = authHeaders(p)
    let r
    try {
      r = await fetchImpl(new URL('/notifications/media' + path.split('/').map(encodeURIComponent).join('/'), p.upstream), {
        method: 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'image/*', ...auth },
      })
    } catch (e) { fail(e?.name === 'TimeoutError' ? 'timeout' : 'backend_unavailable') }
    if (r.status === 404) { await r.arrayBuffer().catch(() => null); fail('not_found') }
    if (r.status !== 200) { await r.arrayBuffer().catch(() => null); fail('backend_failed') }
    const declared = Number(r.headers.get('content-length') || 0)
    if (declared > mediaMaxBytes) fail('backend_failed')
    const body = Buffer.from(await r.arrayBuffer())
    const want = MEDIA_TYPES[(/\.[A-Za-z0-9]+$/.exec(path)?.[0] || '').toLowerCase()]
    if (!want || body.length > mediaMaxBytes || sniff(body) !== want || String(r.headers.get('content-type') || '').split(';')[0] !== want) fail('backend_failed')
    return { body, mime: want }
  }

  /**
   * notifications.media {resourceId: 'n:<notification id>:<picture n>', purpose: thumbnail|read}. The frame names a
   * notification and a picture number, never a path or URL: the Service reads the item from the app, takes its n-th
   * MEDIA line, fetches those bytes once (type/size checked) and mints a 60 s ticket bound to this binding,
   * installation and resource. Each ticket request re-fetches and must match the minted digest.
   */
  async function media(p, args, binding) {
    if (!tickets) fail('unsupported_capability')
    if (!exact(args, ['resourceId', 'purpose']) || typeof args.resourceId !== 'string' || !PURPOSES.has(args.purpose)) fail('bad_request')
    const m = RESOURCE.exec(args.resourceId)
    if (!m) fail('bad_request')
    const raw = await upstream(p, '/notifications/api/items?view=all&limit=500')
    if (!raw || !Array.isArray(raw.items)) fail('backend_failed')
    const item = raw.items.find(it => it && it.id === m[1])
    const path = item && typeof item.message === 'string' ? mediaPath(item.message, Number(m[2])) : null
    if (!path) fail('not_found')
    const first = await pictureBytes(p, path)
    const sha256 = createHash('sha256').update(first.body).digest('hex')
    await binding.recheck()   // grant/install still current immediately before minting
    const minted = tickets.mint({
      handle: binding.handle, generation: binding.generation, appId: binding.appId, operation: 'notifications.media',
      identity: binding.identity, mime: first.mime, bytes: first.body.length, sha256, filename: 'picture.' + EXT[first.mime],
      // Fresh bytes on every ticket request, re-resolving the installation's current upstream and credential.
      fetchBytes: async () => (await pictureBytes(binding.current(), path)).body,
    })
    return { kind: 'ticket', url: minted.url, expiresAt: minted.expiresAt, mime: first.mime, bytes: first.body.length, methods: ['GET', 'HEAD'], range: true }
  }

  return Object.freeze({ list, markRead, inbox: inboxView, mark, status, media })
}
