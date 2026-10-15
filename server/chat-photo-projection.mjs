// Owner-only, rebuildable projection of delivered chat images. Never an upload index.
import { createHash, randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, renameSync, unlinkSync, existsSync, fsyncSync } from 'node:fs'
import { resolve, join, sep, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const MAX_INDEX = 16 * 1024 * 1024
export const MAX_PHOTO = 20 * 1024 * 1024
const SHA = /^[0-9a-f]{64}$/
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }

function directory(path) {
  const absolute = resolve(path)
  let current = sep
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part)
    try { mkdirSync(current, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
    const s = lstatSync(current)
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('photo directory is not a plain directory')
  }
  return absolute
}
export function readPhotoBytes(path) {
  // Call only after the canonical attachment resolver has authorized this exact file.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.size < 1 || s.size > MAX_PHOTO) throw new Error('photo size/type denied')
    const bytes = readFileSync(fd)
    if (bytes.length !== s.size) throw new Error('photo changed during read')
    return bytes
  } finally { closeSync(fd) }
}
function jsonRead(path, fallback) {
  try { lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_INDEX) throw new Error('photo metadata limit')
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}
function atomicJson(path, value) {
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw) > MAX_INDEX) throw new Error('photo metadata limit')
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, raw); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(tmp, path) } finally { if (existsSync(tmp)) unlinkSync(tmp) }
}
const sourceKey = s => `${s.thread_id}\0${s.message_id}\0${s.role}`

export function createPhotoProjection({ root, ownerLabel, agentLabel, maxBytes = 900 * 1024 * 1024 }) {
  if (!root || !ownerLabel || !agentLabel || resolve(root) === sep) throw new Error('explicit owner photo configuration required')
  const base = directory(root)
  const metadata = directory(join(base, '.wizard'))
  const images = directory(join(base, 'Photos', 'Chats'))
  const index = join(metadata, 'photo-provenance.json')
  return {
    index,
    publish(bytes, mime, evidence) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PHOTO || !EXT[mime]) throw new Error('unsupported photo')
      if (!['user', 'assistant'].includes(evidence.role) || evidence.agent_id !== 'main'
        || !evidence.thread_id || !evidence.message_id || !Number.isFinite(Date.parse(evidence.sent_at))) throw new Error('invalid photo provenance')
      const source = { role: evidence.role, agent_id: 'main', sender_label: evidence.role === 'user' ? ownerLabel : agentLabel,
        thread_id: String(evidence.thread_id), message_id: String(evidence.message_id), sent_at: evidence.sent_at }
      if ([source.thread_id, source.message_id].some(x => x.length > 250 || /[\u0000-\u001f]/.test(x))) throw new Error('invalid source identity')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const lock = join(metadata, 'photo-provenance.lock')
      // Single service writer. A second/backfill process must retry; never steal a lock.
      const lockFd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try {
        const manifest = jsonRead(index, { schema: 1, owner_label: ownerLabel, agent_labels: { main: agentLabel }, files: [] })
        if (manifest.schema !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 20000) throw new Error('invalid existing photo manifest')
        for (const f of manifest.files) if (!SHA.test(f.sha256) || !/^Photos\/Chats\/[0-9a-f]{64}\.(png|jpg|webp|gif|bmp)$/.test(f.path) || !Array.isArray(f.sources)) throw new Error('invalid existing photo entry')
        let record = manifest.files.find(f => f.sha256 === sha256)
        const rel = record?.path || `Photos/Chats/${sha256}.${EXT[mime]}`
        const target = join(base, rel)
        if (realpathSync(images) !== images || realpathSync(metadata) !== metadata) throw new Error('photo directory changed')
        if (existsSync(target)) {
          if (createHash('sha256').update(readPhotoBytes(target)).digest('hex') !== sha256) throw new Error('immutable photo hash mismatch')
        } else {
          // Bound the projection's storage, not the rest of the owner's media library.
          const used = manifest.files.reduce((n, f) => n + lstatSync(join(base, f.path)).size, 0)
          if (used + bytes.length > maxBytes) throw new Error('photo projection storage budget')
          const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444)
          try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
        }
        if (!record) { record = { path: rel, sha256, sources: [] }; manifest.files.push(record) }
        const added = !record.sources.some(s => sourceKey(s) === sourceKey(source))
        if (added) record.sources.push(source)
        manifest.owner_label = ownerLabel; manifest.agent_labels = { main: agentLabel }
        atomicJson(index, manifest)
        return { path: rel, sha256, added }
      } finally { closeSync(lockFd); unlinkSync(lock) }
    },
  }
}

// Durable scan checkpoints are private service state, never Files-visible. Both
// backfill and future gateway reconciliation use this same bounded reader/writer.
export function createChatPhotoReconciler({ database, statePath, ownerId, projection, resolveReference, authorizeEvidence, log = console.error }) {
  // Text grammar finds candidates, not authority. Production activation must
  // supply a reviewed adapter proving owner, main agent and actual delivery.
  if (typeof authorizeEvidence !== 'function') throw new Error('chat photo delivery-evidence adapter required')
  directory(dirname(statePath))
  let busy = false
  let stopped = false
  let timer
  async function step({ limit = 1000 } = {}) {
    if (busy || stopped) return null
    busy = true
    try {
      const state = jsonRead(statePath, { schema: 1, cursor: 0, ceiling: 0, counts: {}, excluded_reasons: {}, unavailable: [], samples: {} })
      const { stdout } = await exec('python3', [fileURLToPath(new URL('./read-chat-photos.py', import.meta.url)), database, String(state.cursor), String(state.ceiling), ownerId || '', String(limit)], { maxBuffer: 32 * 1024 * 1024, timeout: 15000 })
      const batch = JSON.parse(stdout)
      for (const [k, v] of Object.entries(batch.counts)) state.counts[k] = (state.counts[k] || 0) + v
      for (const [k, v] of Object.entries(batch.excluded_reasons)) state.excluded_reasons[k] = (state.excluded_reasons[k] || 0) + v
      for (const message of batch.evidence) for (const ref of message.refs) {
        try {
          if (!await authorizeEvidence(message, ref)) throw new Error('delivery evidence not proven')
          const resolved = await resolveReference(ref, message)
          if (!resolved) throw new Error('canonical resolver unavailable or denied')
          const published = projection.publish(resolved.bytes, resolved.mime, { ...message, agent_id: 'main', sent_at: new Date(message.timestamp * 1000).toISOString() })
          state.counts.resolved = (state.counts.resolved || 0) + 1
          if (published.added) state.counts.added_sources = (state.counts.added_sources || 0) + 1
          state.samples[message.role] ||= { thread_id: message.thread_id, message_id: message.message_id, gateway: message.gateway, ...published }
        } catch (error) {
          state.counts.unavailable = (state.counts.unavailable || 0) + 1
          // No private paths, tokens, image contents or transcript text in receipts.
          state.unavailable.push({ thread_id: message.thread_id, message_id: message.message_id, role: message.role, kind: ref.kind, reason: error.code || error.message })
        }
      }
      state.cursor = batch.cursor; state.ceiling = batch.done ? 0 : batch.ceiling
      state.last_completed_ceiling = batch.done ? batch.ceiling : state.last_completed_ceiling
      state.updated_at = new Date().toISOString()
      atomicJson(statePath, state)
      return { done: batch.done, cursor: state.cursor, counts: state.counts }
    } finally { busy = false }
  }
  return {
    step,
    // Canonical service events kick the durable reader. The service-owned bounded
    // reconciliation also covers Telegram and crash/restart windows, not a cron.
    kick() { if (!stopped) step().catch(e => log(`[chat-photos] ${e.code || e.message}`)) },
    start() { timer = setInterval(() => this.kick(), 3000); timer.unref(); this.kick() },
    stop() { stopped = true; clearInterval(timer) },
  }
}
