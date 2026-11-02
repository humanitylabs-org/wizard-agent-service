// Fixed browser operations for the first-party Files view (humanitylabs-org/wizard-files) under the browser boundary
// (wizard-os #385/#386, ADAPTER-SKETCH §4 and §6; default-off). Not a relay: each operation is one constant path on the
// installation's WAM-recorded upstream with its WAM listener credential, exact argument/result schemas, no owner
// credentials, cookies, shell token, redirects or upstream bodies passed through.
//
//   files.list       one folder (personal | app data), entries with an opaque per-binding resource id per file
//   files.index      the bounded search/recent/type index (same paging contract as the app's own api/index)
//   files.thumbnail  one small JPEG preview (<= 512 KiB) for a resource id, returned as bytes
//   files.content    a 60 s Range-capable read ticket for a resource id (read | play | download)
//   files.upload     create / chunk / status / commit (sha256) / abort into the owner's files root through the
//                    Service's own resumable store (the store WizUploads uses), per-chunk grant checks
//
// A resource id is minted here for files the app's own listing returned to THIS binding; it never is a path or URL,
// and it dies with the binding. Folder names in list/upload arguments are re-checked by the app (visibility) and by
// this module (upload destination policy) on every call.
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }) }
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',')
const str = (v, max) => typeof v === 'string' && v.length <= max
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024
const THUMB_MAX = 512 * 1024
export const UPLOAD_CHUNK = 1024 * 1024              // ADAPTER-SKETCH §6: one outstanding chunk of at most 1 MiB
const UPLOAD_TICKET_MS = 30 * 60 * 1000
const RESOURCES_PER_BINDING = 20000
const TYPES = new Set(['', 'video', 'photo', 'document', 'link', 'audio'])
const KINDS = new Set(['video', 'photo', 'document', 'link', 'audio'])
const PURPOSES = new Set(['read', 'play', 'download'])
const SAFE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime|x-m4v)|audio\/(mpeg|mp4|x-m4a|wav|ogg|opus|flac|aac)|text\/plain|application\/pdf)$/
const EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.txt': 'text/plain', '.pdf': 'application/pdf' }
const ext = name => (/\.[A-Za-z0-9]{1,6}$/.exec(name)?.[0] || '').toLowerCase()
/** Content type the ticket listener may serve inline; everything else is an inert attachment. */
export const safeMime = name => EXT_MIME[ext(name)] && SAFE.test(EXT_MIME[ext(name)]) ? EXT_MIME[ext(name)] : 'application/octet-stream'
const IDENTITY = /^[0-9]{1,20}:[0-9]{1,20}:[0-9]{1,20}:[0-9]{1,24}:[0-9]{1,24}$/
const RESOURCE = /^fr_[A-Za-z0-9_-]{22}$/
const CLIENT_ID = /^[A-Za-z0-9._:-]{8,64}$/
const UPLOAD_ID = /^up_[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/

/** Folder argument: '' or relative segments the app itself accepts (no dot-names, colons or control characters). */
function folderArg(v) {
  if (!str(v, 4096) || /[\\\u0000-\u001f\u007f]/.test(v)) fail('bad_request')
  if (v === '') return ''
  const parts = v.split('/')
  if (parts.length > 64 || parts.some(p => !p || p.startsWith('.') || p.includes(':'))) fail('bad_request')
  return parts.join('/')
}

export function createFilesOperations({ fetchImpl = globalThis.fetch, listenerCredential = () => null, tickets = null, receipts = null,
  uploads = () => null, userFiles = () => null, timeZone = () => '', timeoutMs = 15000, now = () => Date.now() } = {}) {
  const resources = new Map()       // binding handle -> Map(resource id -> {path, identity, size, name, type})
  const uploadTickets = new Map()   // ticket -> {handle, generation, uploadId, installationId, expires}
  const authHeaders = p => {
    let cred = null
    try { cred = listenerCredential(p) } catch { fail('backend_unavailable') }
    return cred ? { [cred.header]: cred.value } : {}
  }
  async function upstream(p, path, { accept = 'application/json', headers = {}, method = 'GET', raw = false } = {}) {
    if (!p.upstream) fail('backend_unavailable')
    const auth = authHeaders(p)
    let r
    try {
      r = await fetchImpl(new URL(path, p.upstream), { method, redirect: 'manual', cache: 'no-store', signal: raw ? undefined : AbortSignal.timeout(timeoutMs), headers: { accept, ...headers, ...auth } })
    } catch (e) { fail(e?.name === 'TimeoutError' ? 'timeout' : 'backend_unavailable') }
    if (raw) return r
    if (r.status === 404) { await r.arrayBuffer().catch(() => null); fail('not_found') }
    if (r.status === 400) { await r.arrayBuffer().catch(() => null); fail('bad_request') }
    if (r.status === 503 || r.status === 429) { await r.arrayBuffer().catch(() => null); fail('backend_unavailable') }
    if (r.status !== 200 || !String(r.headers.get('content-type') || '').startsWith('application/json')) { await r.arrayBuffer().catch(() => null); fail('backend_failed') }
    const text = await r.text()
    if (Buffer.byteLength(text) > MAX_UPSTREAM_BYTES) fail('backend_failed')
    try { return JSON.parse(text) } catch { fail('backend_failed') }
  }
  // ---- resources --------------------------------------------------------------------------------------------------
  function mint(handle, entry) {
    let m = resources.get(handle)
    if (!m) { m = new Map(); resources.set(handle, m) }
    for (const [id, e] of m) if (e.path === entry.path && e.identity === entry.identity) { m.delete(id); m.set(id, e); return id }
    const id = 'fr_' + randomBytes(16).toString('base64url').slice(0, 22)
    m.set(id, entry)
    while (m.size > RESOURCES_PER_BINDING) m.delete(m.keys().next().value)
    return id
  }
  const resolve = (handle, id) => { if (!str(id, 40) || !RESOURCE.test(id)) fail('bad_request'); const e = resources.get(handle)?.get(id); if (!e) fail('not_found'); return e }
  // One file row the app returned. Anything off-schema is a backend failure; nothing extra is forwarded.
  function fileRow(handle, raw, folder) {
    if (!raw || typeof raw !== 'object' || !str(raw.name, 255) || !raw.name || raw.name.startsWith('.') || raw.name.includes('/') || typeof raw.is_dir !== 'boolean') fail('backend_failed')
    const path = str(raw.path, 4096) ? raw.path : (folder ? `${folder}/${raw.name}` : raw.name)
    if (!path.endsWith(raw.name)) fail('backend_failed')
    const size = Number.isSafeInteger(raw.size) && raw.size >= 0 ? raw.size : 0
    const type = KINDS.has(raw.type) ? raw.type : 'document'
    const identity = str(raw.identity, 100) && IDENTITY.test(raw.identity) ? raw.identity : ''
    const row = { name: raw.name, path, is_dir: raw.is_dir, size, mtime: str(raw.mtime, 40) ? raw.mtime : '', type, resource: null }
    if (!raw.is_dir && identity) row.resource = mint(handle, { path, identity, size, name: raw.name, type })
    return row
  }
  const prefixes = v => Array.isArray(v) && v.length <= 256 && v.every(x => str(x, 4096)) ? [...v] : fail('backend_failed')

  async function list(p, args, binding) {
    if (!exact(args, ['folder', 'scope']) || !['personal', 'app'].includes(args.scope)) fail('bad_request')
    const folder = folderArg(args.folder)
    const raw = await upstream(p, `/api/files?${new URLSearchParams({ folder, scope: args.scope })}`)
    if (!raw || !Array.isArray(raw.entries) || raw.entries.length > 5000) fail('backend_failed')
    return { folder, scope: args.scope, entries: raw.entries.map(e => fileRow(binding.handle, e, folder)), truncated: raw.truncated === true,
      upload_allowed: raw.upload_allowed === true, app_data_prefixes: prefixes(raw.app_data_prefixes) }
  }

  const SENDER = /^(|owner|unknown|agent:[A-Za-z0-9_.-]{1,128})$/
  async function index(p, args, binding) {
    if (!exact(args, ['q', 'type', 'scope', 'sender', 'offset', 'limit', 'snapshot'])) fail('bad_request')
    const { q, type, scope, sender, offset, limit, snapshot } = args
    if (!str(q, 200) || !TYPES.has(type) || !['personal', 'app'].includes(scope) || !str(sender, 134) || !SENDER.test(sender)
      || !Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 300
      || !str(snapshot, 64) || (snapshot && !HEX64.test(snapshot))) fail('bad_request')
    const raw = await upstream(p, `/api/index?${new URLSearchParams({ q, type, scope, sender, offset: String(offset), limit: String(limit), snapshot })}`)
    if (!raw || !Array.isArray(raw.items) || raw.items.length > 300) fail('backend_failed')
    const nat = v => Number.isSafeInteger(v) && v >= 0 ? v : 0
    const prov = raw.provenance && typeof raw.provenance === 'object' ? raw.provenance : {}
    const labels = prov.agent_labels && typeof prov.agent_labels === 'object' ? Object.fromEntries(Object.entries(prov.agent_labels).slice(0, 128).filter(([k, v]) => /^[A-Za-z0-9_.-]{1,128}$/.test(k) && str(v, 80)).map(([k, v]) => [k, v])) : {}
    const items = raw.items.map(it => {
      const row = fileRow(binding.handle, it, '')
      if (row.is_dir) fail('backend_failed')
      const senders = Array.isArray(it.senders) ? it.senders.filter(s => str(s, 134) && SENDER.test(s)).slice(0, 16) : []
      const sources = Array.isArray(it.sources) ? it.sources.slice(0, 32).filter(s => s && str(s.sender_label, 80)).map(s => ({ sender_label: s.sender_label })) : []
      return { ...row, senders, sources, ...(str(it.sent_at, 40) ? { sent_at: it.sent_at } : {}), ...(it.verification_pending === true ? { verification_pending: true } : {}) }
    })
    const counts = Object.fromEntries([...KINDS].map(k => [k, nat(raw.counts?.[k])]))
    const senderCounts = raw.sender_counts && typeof raw.sender_counts === 'object' ? Object.fromEntries(Object.entries(raw.sender_counts).slice(0, 130).filter(([k]) => SENDER.test(k)).map(([k, v]) => [k, nat(v)])) : {}
    return { scope, items, counts, sender_counts: senderCounts,
      provenance: { available: prov.available === true, partial: prov.partial === true, pending: nat(prov.pending), owner_label: str(prov.owner_label, 80) ? prov.owner_label : 'Owner', agent_labels: labels },
      total: nat(raw.total), truncated: raw.truncated === true, offset: nat(raw.offset), limit: nat(raw.limit), has_more: raw.has_more === true,
      next_offset: Number.isSafeInteger(raw.next_offset) ? raw.next_offset : null, snapshot: str(raw.snapshot, 64) && HEX64.test(raw.snapshot) ? raw.snapshot : '', reset: raw.reset === true }
  }

  async function thumbnail(p, args, binding) {
    if (!exact(args, ['resourceId'])) fail('bad_request')
    const e = resolve(binding.handle, args.resourceId)
    if (!['photo', 'video'].includes(e.type)) fail('not_found')
    const r = await upstream(p, `/api/files/thumbnail?${new URLSearchParams({ path: e.path, v: e.identity })}`, { accept: 'image/jpeg', raw: true })
    if (r.status === 503) { await r.arrayBuffer().catch(() => null); fail('busy', { retryable: true }) }
    if (r.status === 404 || r.status === 415 || r.status === 400) { await r.arrayBuffer().catch(() => null); fail('not_found') }
    if (r.status !== 200 || String(r.headers.get('content-type') || '') !== 'image/jpeg' || Number(r.headers.get('content-length') || 0) > THUMB_MAX) { await r.arrayBuffer().catch(() => null); fail('backend_failed') }
    const body = Buffer.from(await r.arrayBuffer())
    if (body.length > THUMB_MAX || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) fail('backend_failed')
    return { mime: 'image/jpeg', bytes: body.length, data: body.toString('base64') }
  }

  /** files.content -> a 60 s ticket on the content listener; bytes stream from the app on every request (Range). */
  async function content(p, args, binding) {
    if (!tickets) fail('unsupported_capability')
    if (!exact(args, ['resourceId', 'purpose']) || !PURPOSES.has(args.purpose)) fail('bad_request')
    const e = resolve(binding.handle, args.resourceId)
    const mime = safeMime(e.name)
    // Confirm the file is still the one listed (size + the app's ETag over path and identity) before minting.
    const head = await upstream(p, `/api/files/content?${new URLSearchParams({ path: e.path })}`, { method: 'HEAD', accept: '*/*', raw: true })
    if (head.status === 404) fail('not_found')
    const etag = head.headers.get('etag') || ''
    if (head.status !== 200 || Number(head.headers.get('content-length')) !== e.size || !/^"[a-f0-9]{64}"$/.test(etag)) fail('not_found')
    await binding.recheck()
    const fileUrl = `/api/files/content?${new URLSearchParams({ path: e.path })}`
    const minted = tickets.mint({
      handle: binding.handle, generation: binding.generation, appId: binding.appId, operation: 'files.content', identity: binding.identity,
      mime, bytes: e.size, filename: e.name, disposition: args.purpose === 'download' || mime === 'application/octet-stream' ? 'attachment' : 'inline',
      // Each ticket request re-resolves the installation's current upstream + credential and asks the app for exactly
      // that byte range; a changed file (other ETag/size) ends the ticket.
      stream: async ({ start, end, method }) => {
        const q = binding.current()
        const r = await upstream(q, fileUrl, { method, accept: '*/*', raw: true, headers: { range: `bytes=${start}-${end}` } })
        const total = Number(/\/(\d+)$/.exec(r.headers.get('content-range') || '')?.[1] ?? r.headers.get('content-length'))
        if (r.headers.get('etag') !== etag || total !== e.size || ![200, 206].includes(r.status)) { r.body?.cancel().catch(() => {}); return { changed: true } }
        return { body: r.body }
      },
    })
    return { kind: 'ticket', url: minted.url, expiresAt: minted.expiresAt, mime, bytes: e.size, methods: ['GET', 'HEAD'], range: true }
  }

  // ---- uploads (ADAPTER-SKETCH §6) ---------------------------------------------------------------------------------
  const owner = p => 'bt-' + createHash('sha256').update(['wizard-files-upload-v1', p.installationId, p.sourceId].join('|')).digest('hex').slice(0, 16) + '-'
  const store = () => uploads() || fail('unsupported_capability')
  const mineOr404 = async (p, uploadId) => {
    if (!str(uploadId, 40) || !UPLOAD_ID.test(uploadId)) fail('bad_request')
    let rec; try { rec = await store().getUpload(uploadId) } catch { fail('not_found') }
    if (!rec || !String(rec.client_upload_id).startsWith(owner(p))) fail('not_found')   // other installations: invisible
    return rec
  }
  const publicState = rec => ({ uploadId: rec.id, offset: rec.offset, bytes: rec.bytes, status: rec.status === 'complete' ? 'committed' : rec.status === 'uploading' ? 'open' : rec.error === 'aborted' ? 'aborted' : 'failed' })
  function ticketFor(binding, rec) {
    for (const [t, x] of uploadTickets) if (x.expires < now() || (x.handle === binding.handle && x.uploadId === rec.id)) uploadTickets.delete(t)
    if (uploadTickets.size >= 4096) fail('busy', { retryable: true })
    const ticket = randomBytes(32).toString('base64url'), expires = now() + UPLOAD_TICKET_MS
    uploadTickets.set(ticket, { handle: binding.handle, generation: binding.generation, uploadId: rec.id, installationId: binding.installationId, expires })
    return { ticket, expiresAt: new Date(expires).toISOString() }
  }
  /** Destination policy, server-side: the app's own listing must say the folder takes uploads and is not app data. */
  async function checkDestination(p, folder) {
    const policy = await upstream(p, `/api/files?${new URLSearchParams({ folder, scope: 'personal' })}`).catch(e => { if (e.code === 'not_found') fail('not_found'); throw e })
    const pre = prefixes(policy?.app_data_prefixes)
    const target = folder || 'Inbox'
    if (policy?.upload_allowed !== true || pre.some(x => target === x || target.startsWith(x + '/') || (!folder && (x === 'Inbox' || x.startsWith('Inbox/'))))) fail('not_allowed')
  }
  async function uploadCreate(p, args, binding) {
    if (!exact(args, ['folder', 'filename', 'mime', 'bytes', 'clientUploadId'])) fail('bad_request')
    const folder = folderArg(args.folder)
    if (!str(args.filename, 240) || !args.filename.trim() || !str(args.mime, 160) || !Number.isSafeInteger(args.bytes) || args.bytes < 1 || !str(args.clientUploadId, 64) || !CLIENT_ID.test(args.clientUploadId)) fail('bad_request')
    const files = userFiles(); if (!files) fail('unsupported_capability')
    await checkDestination(p, folder)
    try { if (folder) files.checkFolder(folder) } catch (e) { fail(e?.status === 404 ? 'not_found' : e?.status === 403 ? 'not_allowed' : 'bad_request') }
    await binding.recheck()
    let rec
    try {
      ({ record: rec } = await store().createUpload({ client_upload_id: owner(p) + args.clientUploadId, filename: args.filename, mime: args.mime, bytes: args.bytes },
        { targetKey: files.targetKey({ folder, timeZone: timeZone() }) }))
    } catch (e) { fail(e?.status === 507 ? 'quota_exceeded' : e?.status === 409 ? 'conflict' : e?.status === 413 ? 'too_large' : 'backend_failed') }
    if (rec.status !== 'uploading' && rec.status !== 'complete') fail('expired')
    return { ...publicState(rec), chunkBytes: UPLOAD_CHUNK, ...(rec.status === 'uploading' ? ticketFor(binding, rec) : {}) }
  }
  async function uploadStatus(p, args) {
    if (!exact(args, ['uploadId'])) fail('bad_request')
    return publicState(await mineOr404(p, args.uploadId))
  }
  /**
   * One chunk (the shell's upload port): ticket + live binding + current grant + exact offset + chunk hash, <= 1 MiB.
   * Called by browser-adapters.mjs after its own binding/grant check for THIS chunk.
   */
  function chunkTicket(ticket) {
    if (!str(ticket, 64) || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) fail('bad_request')
    const t = uploadTickets.get(ticket)
    if (!t) fail('expired')
    if (t.expires < now()) { uploadTickets.delete(ticket); fail('expired') }
    return t
  }
  async function uploadChunk(p, t, { offset, sha256, body }) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !HEX64.test(String(sha256)) || !Buffer.isBuffer(body) || body.length < 1 || body.length > UPLOAD_CHUNK) fail('bad_request')
    if (createHash('sha256').update(body).digest('hex') !== sha256) fail('integrity')
    await mineOr404(p, t.uploadId)
    const stream = Readable.from([body]); stream.headers = { 'content-length': String(body.length) }
    try { return { offset: await store().patchUpload(t.uploadId, offset, stream) } } catch (e) {
      if (e?.status === 409) fail('offset_mismatch', { offset: Number(e.payload?.offset) })
      if (e?.status === 410) fail('expired')
      if (e?.status === 507) fail('quota_exceeded')
      if (e?.status === 413) fail('too_large')
      fail('backend_failed', { retryable: true })
    }
  }
  async function uploadCommit(p, args, binding) {
    if (!exact(args, ['uploadId', 'sha256', 'operationKey']) || !HEX64.test(String(args.sha256)) || !str(args.operationKey, 36) || !/^[0-9a-f-]{36}$/.test(args.operationKey)) fail('bad_request')
    const rec = await mineOr404(p, args.uploadId)
    await binding.recheck()
    let done
    try { done = await store().completeUpload(rec.id, { sha256: args.sha256 }) } catch (e) {
      if (e?.status === 409) fail('conflict', { offset: Number(e.payload?.offset) })
      if (e?.status === 422) fail('integrity')
      if (e?.status === 403) fail('not_allowed')
      if (e?.status === 507) fail('quota_exceeded')
      fail('outcome_unknown', { operationKey: args.operationKey })
    }
    const file = store().publicUpload(done).file
    if (!file || !str(file.path, 4096)) fail('outcome_unknown', { operationKey: args.operationKey })
    // Readback through the app itself: the new file is listed, with the committed size.
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
    const listed = await list(p, { folder, scope: 'personal' }, binding)
    const row = listed.entries.find(x => x.path === file.path && !x.is_dir)
    if (!row || row.size !== done.bytes) fail('outcome_unknown', { operationKey: args.operationKey })
    for (const [t, x] of uploadTickets) if (x.uploadId === rec.id) uploadTickets.delete(t)
    return { resourceId: row.resource, path: file.path, folder, name: row.name, bytes: done.bytes, sha256: args.sha256, operationKey: args.operationKey }
  }
  async function uploadAbort(p, args) {
    if (!exact(args, ['uploadId'])) fail('bad_request')
    const rec = await mineOr404(p, args.uploadId)
    for (const [t, x] of uploadTickets) if (x.uploadId === rec.id) uploadTickets.delete(t)
    try { return { status: await store().abortUpload(rec.id) === 'committed' ? 'committed' : 'aborted' } } catch { return { status: 'unknown' } }
  }
  function forget(handle) {
    resources.delete(handle)
    for (const [t, x] of uploadTickets) if (x.handle === handle) uploadTickets.delete(t)
  }
  return Object.freeze({ list, index, thumbnail, content, uploadCreate, uploadStatus, uploadChunk, chunkTicket, uploadCommit, uploadAbort, forget })
}
