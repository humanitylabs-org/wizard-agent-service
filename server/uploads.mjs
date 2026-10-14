// Resumable uploads and shares (wizard-os spec/AGENT_SERVICE_API.md, "Uploads" and "Shares").
//
// One upload path for everything: chat attachments and shares send files in chunks that are streamed to
// disk (never buffered whole), fsynced per chunk and resumable from the last durable byte. The only
// size limit is the box's real free space (minus a reserve), plus an optional box cap.
//
// Records live in one SQLite file. A target says where a finished file goes:
//   kind 'local'  staged as <stagingDir>/<upload_id>.part on the store's own filesystem, then handed to
//                 target.finalize(path, meta) (Wizard Files on a Wizard OS box, an agent's home inbox)
//   kind 'drop'   James's box: the Wizard Inbox drop service owns the bytes. With a sha256 declared up
//                 front, chunks stream straight through to the drop upload; without one they stage
//                 locally and are pushed to the drop service from disk at completion (it needs the hash
//                 before the first byte).
//
// Shares group uploads and, once the last one completes, deliver exactly once through
// options.deliverShare(share, uploads). File names and contents are never logged.
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, mkdirSync, statfsSync, unlinkSync, chmodSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
export const UPLOAD_MAX_CHUNK_BYTES = 64 * 1024 * 1024
export const UPLOAD_RESERVE_BYTES = 5 * 1024 * 1024 * 1024
export const UPLOAD_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
export const SHARE_FILE_LIMIT = 8
export const SHARE_NOTE_LIMIT = 8000

export const UPLOAD_ID = /^up_[0-9a-f]{32}$/
export const SHARE_ID = /^sh_[0-9a-f]{32}$/
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const PERMANENT = new Set([400, 401, 403, 404, 410, 413, 415, 422])
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
const MAX_DELIVERY_ATTEMPTS = 30

export class UploadError extends Error {
  constructor(status, error, extra = {}) {
    super(error)
    this.status = status
    this.payload = { error, ...extra }
  }
}

const hex = () => randomBytes(16).toString('hex')
const cleanText = (value, max) => String(value ?? '').replace(/\p{Cc}/gu, ' ').trim().slice(0, max)
export const cleanFilename = (value) => {
  const name = cleanText(value, 240).replaceAll('/', '_').replaceAll('\\', '_').replace(/^\.+/u, '_')
  return name || 'shared-file'
}
const cleanMime = (value) => {
  const mime = cleanText(value, 160).toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/u.test(mime) ? mime : 'application/octet-stream'
}

function fileSpec(value, { requireClientId = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UploadError(400, 'invalid_request')
  const clientUploadId = value.client_upload_id
  if (requireClientId && (typeof clientUploadId !== 'string' || !CLIENT_ID.test(clientUploadId))) throw new UploadError(400, 'invalid_request', { field: 'client_upload_id' })
  const bytes = value.bytes
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new UploadError(400, 'invalid_request', { field: 'bytes' })
  let sha256 = ''
  if (value.sha256 !== undefined && value.sha256 !== null && value.sha256 !== '') {
    sha256 = String(value.sha256).toLowerCase()
    if (!HEX64.test(sha256)) throw new UploadError(400, 'invalid_request', { field: 'sha256' })
  }
  return { clientUploadId: requireClientId ? clientUploadId : '', filename: cleanFilename(value.filename), mime: cleanMime(value.mime), bytes, sha256 }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const part of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(part)
  return hash.digest('hex')
}

/**
 * options:
 *   statePath       SQLite file for upload and share records
 *   target(key)     → { kind:'local', stagingDir, finalize(path, meta) → file, recover?(key) → file|null } | { kind:'drop', stagingDir } | null
 *   drop            Wizard Inbox drop client (kind 'drop' targets): create/status/chunk/complete/file/cancel/maxChunk
 *   deliverShare    async (share, uploads) → { run_id }  (must be idempotent per share: it may be re-driven)
 *   reserveBytes, maxBytes, expiryMs, sweepIntervalMs, now, statfs, log
 */
export function createUploadStore(options) {
  const statePath = String(options.statePath)
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(statePath)
  try { chmodSync(statePath, 0o600) } catch { /* best effort */ }
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, client_upload_id TEXT NOT NULL UNIQUE, share_id TEXT, share_index INTEGER,
      target TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
      offset INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, mode TEXT NOT NULL, remote_id TEXT NOT NULL DEFAULT '',
      staging_path TEXT NOT NULL DEFAULT '', file_json TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS uploads_share ON uploads(share_id, share_index);
    CREATE INDEX IF NOT EXISTS uploads_status ON uploads(status, updated_at);
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY, client_share_id TEXT NOT NULL UNIQUE, agent TEXT NOT NULL, agent_label TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL, thread_new INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', target TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered_at INTEGER);`)
  const now = options.now ?? (() => Date.now())
  const statfs = options.statfs ?? ((dir) => statfsSync(dir))
  const reserveBytes = Number.isFinite(options.reserveBytes) && options.reserveBytes >= 0 ? options.reserveBytes : UPLOAD_RESERVE_BYTES
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 0
  const expiryMs = Number.isFinite(options.expiryMs) && options.expiryMs > 0 ? options.expiryMs : UPLOAD_EXPIRY_MS
  const log = options.log ?? ((line) => process.stdout.write(`[uploads] ${line}\n`))
  const drop = options.drop ?? null
  const locks = new Map()
  const active = new Map()
  const delivering = new Map()
  const timers = new Set()
  let closed = false

  const row = (id) => db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) ?? null
  const shareRow = (id) => db.prepare('SELECT * FROM shares WHERE id = ?').get(id) ?? null
  const touch = (id, changes) => {
    const keys = Object.keys(changes)
    db.prepare(`UPDATE uploads SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => changes[key]), now(), id)
  }
  const touchShare = (id, changes) => {
    const keys = Object.keys(changes)
    db.prepare(`UPDATE shares SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => changes[key]), now(), id)
  }
  const withLock = (id, fn) => {
    const previous = locks.get(id) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(fn)
    const tail = run.catch(() => undefined)
    locks.set(id, tail)
    void tail.then(() => { if (locks.get(id) === tail) locks.delete(id) })
    return run
  }
  const target = (key) => {
    const value = options.target(key)
    if (!value) throw new UploadError(503, 'service_unavailable')
    return value
  }
  const chunkBytes = UPLOAD_CHUNK_BYTES

  // ---- space -------------------------------------------------------------------------------------
  const committedBytes = () => Number(db.prepare("SELECT COALESCE(SUM(bytes - offset), 0) AS n FROM uploads WHERE status = 'uploading'").get().n)
  const ensureSpace = (dir, sizes) => {
    if (maxBytes && sizes.some((size) => size > maxBytes)) throw new UploadError(507, 'insufficient_storage')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const info = statfs(dir)
    const free = Number(info.bavail) * Number(info.bsize)
    const need = sizes.reduce((sum, size) => sum + size, 0)
    if (need > free - reserveBytes - committedBytes()) throw new UploadError(507, 'insufficient_storage')
  }

  // ---- public shapes -----------------------------------------------------------------------------
  const fileOf = (record) => { try { return record.file_json ? JSON.parse(record.file_json) : null } catch { return null } }
  const publicUpload = (record, mapFile = (file) => file) => {
    const file = record.status === 'complete' ? fileOf(record) : null
    return {
      upload_id: record.id, offset: record.offset, bytes: record.bytes, chunk_bytes: chunkBytes,
      status: record.status === 'complete' ? 'complete' : record.status === 'uploading' ? 'uploading' : 'failed',
      ...(file ? { file: mapFile(file) } : {}),
      ...(record.status !== 'complete' && record.status !== 'uploading' ? { error: record.error || record.status } : {}),
    }
  }
  const shareUploads = (shareId) => db.prepare('SELECT * FROM uploads WHERE share_id = ? ORDER BY share_index').all(shareId)
  const publicShare = (share, { withUploads = true } = {}) => ({
    share_id: share.id, agent: share.agent, ...(share.agent_label ? { agent_label: share.agent_label } : {}),
    thread_id: share.thread_id, status: share.status,
    ...(share.run_id ? { run_id: share.run_id } : {}),
    ...(share.status === 'failed' ? { error: share.error || 'failed' } : {}),
    ...(withUploads ? { uploads: shareUploads(share.id).map((u) => {
      const { upload_id, offset, bytes, chunk_bytes, status } = publicUpload(u)
      return { upload_id, offset, bytes, chunk_bytes, status }
    }) } : {}),
  })

  // ---- create ------------------------------------------------------------------------------------
  // A drop-backed upload with a declared sha256 streams through: its drop upload is opened before the
  // record exists, so the drop service's own limits answer the create.
  const prepareUpload = async (spec, targetKey) => {
    const id = `up_${hex()}`
    const tgt = target(targetKey)
    const mode = tgt.kind === 'drop' && spec.sha256 ? 'stream' : 'stage'
    let remote = { upload_id: '', offset: 0 }
    if (mode === 'stream') remote = await drop.create({ client_upload_id: `wizard-${id}`, filename: spec.filename, mime: spec.mime, bytes: spec.bytes, sha256: spec.sha256 })
    return { id, spec, targetKey, mode, stagingPath: mode === 'stage' ? join(tgt.stagingDir, `${id}.part`) : '', remoteId: remote.upload_id, offset: remote.offset || 0 }
  }
  const insertUpload = (prepared, { shareId = null, shareIndex = null, clientUploadId }) => {
    const { id, spec, targetKey, mode, stagingPath, remoteId, offset } = prepared
    const at = now()
    db.prepare(`INSERT INTO uploads (id, client_upload_id, share_id, share_index, target, filename, mime, bytes, sha256, offset, status, mode, remote_id, staging_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?)`).run(id, clientUploadId, shareId, shareIndex, targetKey, spec.filename, spec.mime, spec.bytes, spec.sha256, offset, mode, remoteId, stagingPath, at, at)
    return row(id)
  }
  // The staging file (or drop upload) is created lazily on the first PATCH, so a create never leaves
  // anything behind on disk but its record.
  const ensureBacking = async (record) => {
    if (record.mode === 'stage') {
      mkdirSync(dirname(record.staging_path), { recursive: true, mode: 0o700 })
      const handle = await open(record.staging_path, 'a', 0o600)
      await handle.close()
      return record
    }
    if (!record.remote_id) throw new UploadError(500, 'upload_state_invalid')
    return record
  }

  const sameSpec = (record, spec) => record.bytes === spec.bytes && (!spec.sha256 || !record.sha256 || record.sha256 === spec.sha256)

  const existingUpload = (spec) => {
    const existing = db.prepare('SELECT * FROM uploads WHERE client_upload_id = ?').get(spec.clientUploadId)
    if (existing && !sameSpec(existing, spec)) throw new UploadError(409, 'client_upload_id_conflict')
    return existing ?? null
  }
  async function createUpload(input, { targetKey = 'files' } = {}) {
    const spec = fileSpec(input)
    const existing = existingUpload(spec)
    if (existing) return { record: existing, replayed: true }
    ensureSpace(target(targetKey).stagingDir, [spec.bytes])
    const prepared = await prepareUpload(spec, targetKey)
    const raced = existingUpload(spec)
    if (raced) return { record: raced, replayed: true }
    return { record: insertUpload(prepared, { clientUploadId: spec.clientUploadId }), replayed: false }
  }

  async function getUpload(id) {
    const record = UPLOAD_ID.test(String(id)) ? row(id) : null
    if (!record) throw new UploadError(404, 'not_found')
    // The drop service is authoritative for streamed bytes (a crash can leave our offset behind it).
    if (record.mode === 'stream' && record.status === 'uploading' && record.remote_id && !active.has(id)) {
      try {
        const remote = await drop.status(record.remote_id)
        if (Number.isSafeInteger(remote.offset) && remote.offset !== record.offset) touch(id, { offset: remote.offset })
      } catch { /* keep our offset */ }
      return row(id)
    }
    return record
  }

  // ---- patch -------------------------------------------------------------------------------------
  function assertOpen(record) {
    if (record.status === 'complete') throw new UploadError(409, 'offset_mismatch', { offset: record.bytes })
    if (record.status !== 'uploading') throw new UploadError(410, record.error || 'upload_failed')
  }

  async function writeLocal(record, offset, request, limit) {
    const handle = await open(record.staging_path, 'r+')
    let position = offset
    let failure = null
    try {
      await handle.truncate(offset)
      try {
        for await (const part of request) {
          if (position + part.length > offset + limit) { failure = new UploadError(413, 'chunk_too_large', { offset: position }); request.destroy(); break }
          await handle.write(part, 0, part.length, position)
          position += part.length
        }
      } catch (error) {
        failure = error?.code === 'ENOSPC' ? new UploadError(507, 'insufficient_storage') : error
      }
      try { await handle.sync() } catch (error) { if (!failure) failure = error }
    } finally { await handle.close() }
    touch(record.id, { offset: position })
    return { position, failure }
  }

  async function writeStream(record, offset, request, limit) {
    const piece = Math.max(64 * 1024, Math.min(drop.maxChunk || 4 * 1024 * 1024, UPLOAD_MAX_CHUNK_BYTES))
    let position = offset
    let pending = []
    let pendingBytes = 0
    let failure = null
    const send = async (buffer) => {
      const next = await drop.chunk(record.remote_id, position, buffer)
      if (next !== position + buffer.length) throw new UploadError(502, 'upstream_unavailable')
      position = next
      touch(record.id, { offset: position })
    }
    try {
      for await (const part of request) {
        if (position + pendingBytes + part.length > offset + limit) { failure = new UploadError(413, 'chunk_too_large'); request.destroy(); break }
        pending.push(part)
        pendingBytes += part.length
        while (pendingBytes >= piece) {
          const joined = Buffer.concat(pending, pendingBytes)
          pending = [joined.subarray(piece)]
          pendingBytes -= piece
          await send(joined.subarray(0, piece))
        }
      }
    } catch (error) { failure = error }
    // Bytes that did arrive before a dropped connection are kept, so the client resumes after them.
    if (pendingBytes && !(failure instanceof UploadError)) {
      try { await send(Buffer.concat(pending, pendingBytes)) } catch (error) { failure = failure ?? error }
    }
    if (failure?.remoteOffset !== undefined) touch(record.id, { offset: failure.remoteOffset })
    return { position: row(record.id).offset, failure }
  }

  async function patchUpload(id, offset, request) {
    const first = UPLOAD_ID.test(String(id)) ? row(id) : null
    if (!first) throw new UploadError(404, 'not_found')
    assertOpen(first)
    const declared = Number(request.headers['content-length'] ?? NaN)
    if (Number.isFinite(declared) && declared > UPLOAD_MAX_CHUNK_BYTES) throw new UploadError(413, 'body_too_large', { max_chunk_bytes: UPLOAD_MAX_CHUNK_BYTES })
    // A client that lost its connection retries before the server noticed: the new chunk wins and the
    // stale one stops at whatever bytes reached disk.
    const stale = active.get(id)
    if (stale) stale.destroy()
    return withLock(id, async () => {
      let record = row(id)
      assertOpen(record)
      if (record.mode === 'stream' && record.remote_id) record = await getUpload(id)
      if (offset !== record.offset) throw new UploadError(409, 'offset_mismatch', { offset: record.offset })
      if (Number.isFinite(declared) && offset + declared > record.bytes) throw new UploadError(413, 'chunk_too_large', { offset: record.offset })
      record = await ensureBacking(record)
      if (offset !== record.offset) throw new UploadError(409, 'offset_mismatch', { offset: record.offset })
      const limit = Math.min(UPLOAD_MAX_CHUNK_BYTES, record.bytes - offset)
      active.set(id, request)
      try {
        const { position, failure } = record.mode === 'stage'
          ? await writeLocal(record, offset, request, limit)
          : await writeStream(record, offset, request, limit)
        if (failure instanceof UploadError) throw failure
        if (failure && failure.code !== 'ECONNRESET' && failure.code !== 'ERR_STREAM_PREMATURE_CLOSE' && failure.message !== 'aborted') throw failure
        return position
      } finally { if (active.get(id) === request) active.delete(id) }
    })
  }

  // ---- complete ----------------------------------------------------------------------------------
  async function pushStagedToDrop(record, sha256) {
    let remoteId = record.remote_id
    let offset = 0
    const created = await drop.create({ client_upload_id: `wizard-${record.id}`, filename: record.filename, mime: record.mime, bytes: record.bytes, sha256 })
    remoteId = created.upload_id
    touch(record.id, { remote_id: remoteId })
    let dropId = created.status === 'RECEIVED' ? created.drop_id : ''
    if (!dropId) {
      offset = created.offset
      const piece = Math.max(64 * 1024, Math.min(drop.maxChunk || 4 * 1024 * 1024, UPLOAD_MAX_CHUNK_BYTES))
      const buffer = Buffer.allocUnsafe(piece)
      const handle = await open(record.staging_path, 'r')
      try {
        while (offset < record.bytes) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(piece, record.bytes - offset), offset)
          if (!bytesRead) throw new UploadError(500, 'staging_lost')
          const next = await drop.chunk(remoteId, offset, buffer.subarray(0, bytesRead))
          if (next !== offset + bytesRead) throw new UploadError(502, 'upstream_unavailable')
          offset = next
        }
      } finally { await handle.close() }
      dropId = await drop.complete(remoteId, { bytes: record.bytes, sha256 })
    }
    return drop.file(dropId)
  }

  function failUpload(record, error) {
    touch(record.id, { status: 'failed', error })
    if (record.staging_path) { try { unlinkSync(record.staging_path) } catch { /* gone */ } }
    if (record.share_id) failShare(record.share_id, error)
  }

  async function completeUpload(id) {
    const first = UPLOAD_ID.test(String(id)) ? row(id) : null
    if (!first) throw new UploadError(404, 'not_found')
    const record = await withLock(id, async () => {
      let current = row(id)
      if (current.status === 'complete') return current
      if (current.status !== 'uploading') throw new UploadError(410, current.error || 'upload_failed')
      if (current.mode === 'stream') current = await getUpload(id)
      if (current.offset !== current.bytes) throw new UploadError(409, 'upload_incomplete', { offset: current.offset })
      let file
      const tgt = target(current.target)
      if (current.mode === 'stream') {
        let dropId
        try { dropId = await drop.complete(current.remote_id, { bytes: current.bytes, sha256: current.sha256 }) } catch (error) {
          if (error?.integrity) { failUpload(current, 'sha256_mismatch'); throw new UploadError(422, 'sha256_mismatch') }
          throw error
        }
        file = await drop.file(dropId)
      } else {
        // A crash between the hand-over and this record's update leaves no staging file: the target
        // finds the file it already stored under this upload's key.
        const recovered = tgt.recover ? await tgt.recover(current.id) : null
        if (recovered) {
          try { unlinkSync(current.staging_path) } catch { /* already moved */ }
          touch(id, { status: 'complete', file_json: JSON.stringify(recovered), error: '' })
          return row(id)
        }
        const actual = await sha256File(current.staging_path)
        if (current.sha256 && actual !== current.sha256) { failUpload(current, 'sha256_mismatch'); throw new UploadError(422, 'sha256_mismatch') }
        if (tgt.kind === 'drop') {
          file = await pushStagedToDrop(current, actual)
          try { unlinkSync(current.staging_path) } catch { /* gone */ }
        } else {
          file = await tgt.finalize(current.staging_path, { filename: current.filename, mime: current.mime, bytes: current.bytes, sha256: actual, key: current.id })
        }
      }
      touch(id, { status: 'complete', file_json: JSON.stringify(file), error: '' })
      log(`complete ${id} (${current.bytes} bytes${current.share_id ? `, share ${current.share_id}` : ''})`)
      return row(id)
    })
    if (record.share_id) void maybeDeliver(record.share_id)
    return record
  }

  // ---- shares ------------------------------------------------------------------------------------
  const existingShare = (input, specs) => {
    const existing = db.prepare('SELECT * FROM shares WHERE client_share_id = ?').get(input.client_share_id)
    if (!existing) return null
    const uploads = shareUploads(existing.id)
    if (uploads.length !== specs.length || uploads.some((u, i) => !sameSpec(u, specs[i]))) throw new UploadError(409, 'client_share_id_conflict')
    return existing
  }
  // A replay is answered before any routing (the client may retry after the thread was created).
  function replayShare(input) {
    return existingShare(input, input.files.map((file) => fileSpec(file, { requireClientId: false })))
  }
  async function createShare(input, resolved) {
    // resolved: { agent, agent_label, thread_id, thread_new, target } from the agent router
    const specs = input.files.map((file) => fileSpec(file, { requireClientId: false }))
    const existing = existingShare(input, specs)
    if (existing) return { share: existing, replayed: true }
    ensureSpace(target(resolved.target).stagingDir, specs.map((spec) => spec.bytes))
    const prepared = []
    for (const spec of specs) prepared.push(await prepareUpload(spec, resolved.target))
    const raced = existingShare(input, specs)
    if (raced) return { share: raced, replayed: true }
    const id = `sh_${hex()}`
    const at = now()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`INSERT INTO shares (id, client_share_id, agent, agent_label, thread_id, thread_new, note, target, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`).run(id, input.client_share_id, resolved.agent, resolved.agent_label ?? '', resolved.thread_id, resolved.thread_new ? 1 : 0, input.note, resolved.target, at, at)
      prepared.forEach((item, index) => insertUpload(item, { shareId: id, shareIndex: index, clientUploadId: `#share:${id}:${index}` }))
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
    log(`share ${id}: ${specs.length} file(s) to ${resolved.agent}`)
    return { share: shareRow(id), replayed: false }
  }

  function getShare(id) {
    const share = SHARE_ID.test(String(id)) ? shareRow(id) : null
    if (!share) throw new UploadError(404, 'not_found')
    return share
  }

  function failShare(id, error) {
    const share = shareRow(id)
    if (!share || share.status === 'delivered' || share.status === 'failed') return
    touchShare(id, { status: 'failed', error })
    log(`share ${id} failed: ${error}`)
  }

  function schedule(fn, ms) {
    if (closed) return
    const timer = setTimeout(() => { timers.delete(timer); fn() }, ms)
    timer.unref?.()
    timers.add(timer)
  }

  // Exactly once: the uploading → delivering switch happens synchronously, a delivery in flight is
  // shared by every caller, and deliverShare itself is idempotent per share (re-driven after a crash).
  function maybeDeliver(id) {
    if (delivering.has(id)) return delivering.get(id)
    const share = shareRow(id)
    if (!share || !['uploading', 'delivering'].includes(share.status)) return Promise.resolve(share)
    const uploads = shareUploads(id)
    const broken = uploads.find((u) => u.status !== 'uploading' && u.status !== 'complete')
    if (broken) { failShare(id, broken.error || 'upload_failed'); return Promise.resolve(shareRow(id)) }
    if (!uploads.length || uploads.some((u) => u.status !== 'complete')) return Promise.resolve(share)
    if (share.status === 'uploading') touchShare(id, { status: 'delivering' })
    const run = (async () => {
      const current = shareRow(id)
      try {
        const files = uploads.map((u) => ({ upload_id: u.id, filename: u.filename, mime: u.mime, bytes: u.bytes, file: fileOf(u) }))
        const result = await options.deliverShare(current, files)
        touchShare(id, { status: 'delivered', run_id: String(result?.run_id ?? ''), delivered_at: now(), error: '' })
        log(`share ${id} delivered`)
      } catch (error) {
        const attempts = current.attempts + 1
        const status = Number(error?.status ?? 0)
        const code = error instanceof UploadError ? error.payload.error : PERMANENT.has(status) ? `delivery_rejected_${status}` : 'delivery_failed'
        if (PERMANENT.has(status) || attempts >= MAX_DELIVERY_ATTEMPTS) failShare(id, code)
        else {
          touchShare(id, { attempts, error: code })
          log(`share ${id} delivery attempt ${attempts} failed (${status || 'network'}); retrying`)
          schedule(() => { void maybeDeliver(id) }, RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)])
        }
      }
      return shareRow(id)
    })().finally(() => delivering.delete(id))
    delivering.set(id, run)
    return run
  }

  // ---- expiry ------------------------------------------------------------------------------------
  function sweep() {
    const cutoff = now() - expiryMs
    const stale = db.prepare("SELECT * FROM uploads WHERE status = 'uploading' AND updated_at < ?").all(cutoff)
    for (const record of stale) {
      if (active.has(record.id)) continue
      failUpload(record, 'expired')
      if (record.remote_id && drop?.cancel) void drop.cancel(record.remote_id).catch(() => undefined)
    }
    if (stale.length) log(`expired ${stale.length} incomplete upload(s)`)
    return stale.length
  }

  // Re-drive deliveries a restart interrupted (and shares whose last upload completed just before it).
  for (const share of db.prepare("SELECT id FROM shares WHERE status IN ('uploading', 'delivering')").all()) {
    schedule(() => { void maybeDeliver(share.id) }, 0)
  }
  sweep()
  const sweepMs = Number.isFinite(options.sweepIntervalMs) && options.sweepIntervalMs > 0 ? options.sweepIntervalMs : 60 * 60 * 1000
  const sweeper = setInterval(sweep, sweepMs)
  sweeper.unref?.()

  return {
    chunkBytes,
    createUpload,
    getUpload,
    patchUpload,
    completeUpload,
    publicUpload,
    createShare,
    replayShare,
    getShare,
    publicShare,
    maybeDeliver,
    sweep,
    upload: (id) => (UPLOAD_ID.test(String(id)) ? row(id) : null),
    close() {
      closed = true
      clearInterval(sweeper)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      try { db.close() } catch { /* closed */ }
    },
  }
}

/** Validates a share request body (agent routing and thread checks happen in the caller). */
export function parseShareRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UploadError(400, 'invalid_request')
  if (typeof value.client_share_id !== 'string' || !CLIENT_ID.test(value.client_share_id)) throw new UploadError(400, 'invalid_request', { field: 'client_share_id' })
  if (value.agent !== undefined && value.agent !== null && (typeof value.agent !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.agent))) throw new UploadError(400, 'invalid_request', { field: 'agent' })
  if (value.thread !== undefined && value.thread !== null && (typeof value.thread !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value.thread))) throw new UploadError(400, 'invalid_request', { field: 'thread' })
  if (value.note !== undefined && value.note !== null && typeof value.note !== 'string') throw new UploadError(400, 'invalid_request', { field: 'note' })
  if (!Array.isArray(value.files) || !value.files.length) throw new UploadError(400, 'invalid_request', { field: 'files' })
  if (value.files.length > SHARE_FILE_LIMIT) throw new UploadError(400, 'too_many_files', { max_files: SHARE_FILE_LIMIT })
  for (const file of value.files) fileSpec(file, { requireClientId: false })
  return {
    client_share_id: value.client_share_id,
    agent: value.agent || '',
    thread: value.thread || '',
    note: String(value.note ?? '').replace(/\r\n?/gu, '\n').trim().slice(0, SHARE_NOTE_LIMIT),
    files: value.files,
  }
}

/** The user-authored text of a share message: the note, or a short neutral line. */
export function shareMessageText(note, files) {
  if (note) return note
  return files.length === 1 ? 'Shared 1 file' : `Shared ${files.length} files`
}
