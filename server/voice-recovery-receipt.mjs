import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Use an absolute end assertion: JavaScript's $ also accepts a final newline.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}(?![\s\S])/
const SHA256 = /^[a-f0-9]{64}(?![\s\S])/
const REQUEST_FIELDS = ['sessionId', 'intentId', 'sourceFileId', 'audioSha256', 'inputSha256']
const ENTRY_FIELDS = ['sessionId', 'sourceFileId', 'audioSha256', 'inputSha256', 'recoveredRunId', 'recoveryIdempotencyKey']
const RECOVERY_CONTEXT = '\n\n[Archimedes recovery context'

function receiptError(status) {
  // Do not surface database errors, paths, run input, or recovery context.
  const message = status === 400 ? 'Invalid voice recovery receipt request'
    : status === 409 ? 'Saved text differs from recovered request; recording retained'
      : 'Voice recovery receipt unavailable'
  return Object.assign(new Error(message), { status })
}

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((key) => Object.hasOwn(value, key))
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function digest(value) {
  return typeof value === 'string' && SHA256.test(value)
}

function within(root, path) {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function verifiedBlob(upload, inboxDbPath, blobRoot, expectedHash) {
  if (typeof upload.blob_path !== 'string' || !upload.blob_path || isAbsolute(upload.blob_path)
    || !Number.isSafeInteger(upload.bytes) || upload.bytes < 0) return false

  const root = realpathSync(blobRoot)
  const candidate = resolve(dirname(inboxDbPath), upload.blob_path)
  // Check both lexical containment and canonical containment (including symlink parents).
  if (!within(resolve(blobRoot), candidate)) return false
  const path = realpathSync(candidate)
  if (!within(root, path)) return false

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size !== upload.bytes) return false
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let bytes = 0
    let count
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count
      if (bytes > upload.bytes) return false
      hash.update(buffer.subarray(0, count))
    }
    const after = fstatSync(fd)
    return bytes === upload.bytes && after.size === before.size
      && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
      && hash.digest('hex') === expectedHash
  } finally {
    closeSync(fd)
  }
}

/**
 * Read-only evidence for an explicitly curated, independently recovered voice run.
 * intentId is echoed to bind the caller's reconciliation; it is not recovery evidence.
 * This never admits work, acknowledges audio, or mutates any durable state.
 */
export function resolveVoiceRecoveryReceipt({ request, manifestPath, queueDbPath, inboxDbPath, blobRoot }) {
  if (!exactFields(request, REQUEST_FIELDS)
    || !['sessionId', 'intentId', 'sourceFileId'].every((key) => safeId(request[key]))
    || !digest(request.audioSha256) || !digest(request.inputSha256)) throw receiptError(400)

  let queue
  let inbox
  try {
    if (![manifestPath, queueDbPath, inboxDbPath, blobRoot].every((path) => typeof path === 'string' && path.length > 0)) return null
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!exactFields(manifest, ['version', 'entries']) || manifest.version !== 1 || !Array.isArray(manifest.entries)
      || !manifest.entries.every((entry) => exactFields(entry, ENTRY_FIELDS)
        && ['sessionId', 'sourceFileId', 'recoveredRunId', 'recoveryIdempotencyKey'].every((key) => safeId(entry[key]))
        && digest(entry.audioSha256) && digest(entry.inputSha256))) throw receiptError(503)

    const audioEntries = manifest.entries.filter((entry) => ['sessionId', 'sourceFileId', 'audioSha256']
      .every((key) => entry[key] === request[key]))
    // The audio is already attested as recovered: changed text must block resend,
    // not be mistaken for an absent recovery receipt.
    if (audioEntries.some((entry) => entry.inputSha256 !== request.inputSha256)) throw receiptError(409)
    const entries = audioEntries
    // Ambiguous operator mappings must not choose an arbitrary completed run.
    if (entries.length !== 1) return null
    const entry = entries[0]
    if (entry.recoveryIdempotencyKey !== `recover-voice-${entry.sourceFileId}`) return null

    // A missing database is no receipt, never an invitation for SQLite to create it.
    if (!statSync(queueDbPath).isFile() || !statSync(inboxDbPath).isFile()) return null
    queue = new DatabaseSync(queueDbPath, { readOnly: true })
    inbox = new DatabaseSync(inboxDbPath, { readOnly: true })
    const run = queue.prepare(`SELECT body FROM wizard_run_queue
      WHERE public_run_id = ? AND runtime = 'direct' AND session_id = ?
        AND idempotency_key = ? AND status = 'completed'`).get(entry.recoveredRunId, entry.sessionId, entry.recoveryIdempotencyKey)
    if (!run) return null
    const body = JSON.parse(run.body)
    if (!body || typeof body.input !== 'string'
      || (Object.hasOwn(body, 'session_id') && body.session_id !== entry.sessionId)) return null
    const input = body.input.split(RECOVERY_CONTEXT, 1)[0].replace(/\s+/gu, ' ').trim()
    if (createHash('sha256').update(input, 'utf8').digest('hex') !== entry.inputSha256) return null

    const upload = inbox.prepare(`SELECT uploads.sha256, uploads.status, uploads.bytes, drops.blob_path
      FROM uploads JOIN drops ON uploads.drop_id = drops.id AND drops.upload_id = uploads.id
      WHERE uploads.drop_id = ? AND uploads.sha256 = drops.sha256 AND uploads.bytes = drops.bytes`).get(entry.sourceFileId)
    if (!upload || upload.sha256 !== entry.audioSha256 || upload.status !== 'RECEIVED'
      || !verifiedBlob(upload, inboxDbPath, blobRoot, entry.audioSha256)) return null

    return {
      version: 1,
      sessionId: request.sessionId,
      intentId: request.intentId,
      sourceFileId: request.sourceFileId,
      audioSha256: request.audioSha256,
      inputSha256: request.inputSha256,
      runId: entry.recoveredRunId,
      status: 'completed',
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    if (error?.status === 409) throw receiptError(409)
    throw receiptError(503)
  } finally {
    // Always attempt both closes, including failures during the second open/query.
    try { inbox?.close() } finally { queue?.close() }
  }
}
