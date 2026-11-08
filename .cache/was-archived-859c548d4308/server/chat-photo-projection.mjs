// Owner-only, rebuildable projection of canonical visible chat images.
import { createHash, randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, renameSync, unlinkSync, existsSync, fsyncSync } from 'node:fs'
import { resolve, join, sep, dirname } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const MAX_INDEX = 16 * 1024 * 1024
export const MAX_PHOTO = 20 * 1024 * 1024 // same as canonical history image route
const SHA = /^[0-9a-f]{64}$/
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }
function syncDir(path) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
function directory(path, privateLeaf = false) {
  const absolute = resolve(path)
  let current = sep
  for (const part of absolute.split(sep).filter(Boolean)) {
    const parent = current; current = join(current, part)
    try { mkdirSync(current, { mode: 0o700 }); syncDir(parent) } catch (e) { if (e.code !== 'EEXIST') throw e }
    const s = lstatSync(current)
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('photo directory is not a plain directory')
  }
  const leaf = lstatSync(absolute)
  if (privateLeaf && (leaf.uid !== process.getuid() || (leaf.mode & 0o077))) throw new Error('unsafe photo directory permissions')
  return absolute
}
export function readPhotoBytes(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.size < 1 || s.size > MAX_PHOTO) throw new Error('canonical_image_size_limit')
    const bytes = readFileSync(fd)
    if (bytes.length !== s.size) throw new Error('photo_changed')
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
export function atomicPhotoJson(path, value) {
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw) > MAX_INDEX) throw new Error('photo metadata limit')
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, raw); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(tmp, path); syncDir(dirname(path)) } finally { if (existsSync(tmp)) unlinkSync(tmp) }
}
export async function acquirePhotoLock(path) {
  const child = spawn('python3', [fileURLToPath(new URL('./photo-lock.py', import.meta.url)), path], { stdio: ['pipe', 'pipe', 'pipe'] })
  return new Promise((accept, reject) => {
    let ready = false
    const timer = setTimeout(() => { child.kill(); reject(new Error('photo_lock_timeout')) }, 5000)
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('exit', () => { clearTimeout(timer); if (!ready) reject(Object.assign(new Error('photo_lock_busy'), { code: 'ELOCKED' })) })
    child.stdout.once('data', data => {
      clearTimeout(timer)
      if (data.toString().trim() !== 'locked') { child.kill(); reject(new Error('photo_lock_protocol')); return }
      ready = true
      accept(async () => { const done = new Promise(r => child.once('exit', r)); child.stdin.end(); await done })
    })
  })
}
const sourceKey = s => `${s.thread_id}\0${s.message_id}\0${s.role}`
function validSource(s, ownerLabel, agentLabel) {
  return s && ['user', 'assistant'].includes(s.role) && s.agent_id === 'main'
    && s.sender_label === (s.role === 'user' ? ownerLabel : agentLabel)
    && [s.thread_id, s.message_id].every(x => typeof x === 'string' && x.length > 0 && x.length <= 250 && !/[\u0000-\u001f]/.test(x))
    && Number.isFinite(Date.parse(s.sent_at))
}
export function createPhotoProjection({ root, ownerId, authorityId, ownerLabel, agentLabel, maxBytes }) {
  if (!root || !ownerId || !SHA.test(authorityId || '') || !ownerLabel || !agentLabel || resolve(root) === sep) throw new Error('explicit owner photo configuration required')
  const base = resolve(root), metadata = join(base, '.wizard'), images = join(base, 'Photos', 'Chats')
  const index = join(metadata, 'photo-provenance.json')
  const binding = { owner_id: ownerId, authority_id: authorityId }
  return { index, stats() {
    const manifest = jsonRead(index, { files: [] })
    return { files: manifest.files.length, resolved: manifest.files.reduce((n, f) => n + f.sources.length, 0) }
  }, async publish(bytes, mime, evidence) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PHOTO || !EXT[mime]) throw new Error('unsupported photo')
    if (evidence.owner_id !== ownerId || evidence.authority_id !== authorityId || evidence.agent_id !== 'main') throw new Error('invalid photo provenance')
    const source = { role: evidence.role, agent_id: 'main', sender_label: evidence.role === 'user' ? ownerLabel : agentLabel,
      thread_id: String(evidence.thread_id), message_id: String(evidence.message_id), sent_at: evidence.sent_at }
    if (!validSource(source, ownerLabel, agentLabel)) throw new Error('invalid photo provenance')
    directory(base); directory(metadata, true); directory(images, true)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const release = await acquirePhotoLock(join(metadata, 'photo-provenance.lock'))
    try {
      const manifest = jsonRead(index, { schema: 1, ...binding, owner_label: ownerLabel, agent_labels: { main: agentLabel }, files: [] })
      if (manifest.schema !== 1 || manifest.owner_id !== ownerId || manifest.authority_id !== authorityId || manifest.owner_label !== ownerLabel || manifest.agent_labels?.main !== agentLabel || !Array.isArray(manifest.files) || manifest.files.length > 20000) throw new Error('invalid existing photo manifest binding')
      const seen = new Set()
      for (const f of manifest.files) {
        if (!SHA.test(f.sha256) || !new RegExp(`^Photos/Chats/${f.sha256}\\.(png|jpg|webp|gif|bmp)$`).test(f.path) || seen.has(f.sha256) || !Array.isArray(f.sources) || !f.sources.length || !f.sources.every(s => validSource(s, ownerLabel, agentLabel))) throw new Error('invalid existing photo entry')
        seen.add(f.sha256)
      }
      let record = manifest.files.find(f => f.sha256 === sha256)
      const rel = record?.path || `Photos/Chats/${sha256}.${EXT[mime]}`, target = join(base, rel)
      if (realpathSync(images) !== images || realpathSync(metadata) !== metadata) throw new Error('photo directory changed')
      // An orphan target from a crash is not yet accounted in the manifest.
      // Its admission must pass the same placement budget as a new copy.
      if (!record) {
        const used = manifest.files.reduce((n, f) => n + lstatSync(join(base, f.path)).size, 0)
        if (!Number.isSafeInteger(maxBytes) || used + bytes.length > maxBytes) throw new Error('storage_placement_required')
      }
      if (existsSync(target)) {
        const permissions = lstatSync(target)
        if (permissions.uid !== process.getuid() || (permissions.mode & 0o077)) throw new Error('unsafe photo file permissions')
        if (createHash('sha256').update(readPhotoBytes(target)).digest('hex') !== sha256) throw new Error('immutable photo hash mismatch')
      } else {
        const tmp = join(images, `.${randomUUID()}.tmp`)
        const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400)
        try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(tmp, target); syncDir(images)
      }
      if (!record) { record = { path: rel, sha256, sources: [] }; manifest.files.push(record) }
      const added = !record.sources.some(s => sourceKey(s) === sourceKey(source))
      if (added) record.sources.push(source)
      atomicPhotoJson(index, manifest)
      return { path: rel, sha256, added }
    } finally { await release() }
  } }
}

// One bounded transaction: publication is idempotent, cursor+retry admission atomic.
// A failed commit replays the page; transient failures cannot disappear behind cursor.
export function createChatPhotoReconciler({ database, registryPath, statePath, ownerId, authorityId, projection, resolveMessage, verifyAuthority, scanBatch, log = console.error }) {
  if (typeof resolveMessage !== 'function' || !ownerId || !SHA.test(authorityId || '')) throw new Error('canonical owner history adapter required')
  if (typeof verifyAuthority !== 'function') throw new Error('authenticated runtime verification required')
  if (!scanBatch && !registryPath) throw new Error('canonical registry path required')
  let busy = false, stopped = false, timer
  const pendingEvents = {}
  const scan = scanBatch || (async state => {
    const { stdout } = await exec('python3', [fileURLToPath(new URL('./read-chat-photos.py', import.meta.url)), database, String(state.cursor), String(state.ceiling), ownerId, '250', registryPath], { maxBuffer: 32 * 1024 * 1024, timeout: 30000 })
    return JSON.parse(stdout)
  })
  async function step() {
    if (busy || stopped) return null
    busy = true
    let release
    try {
      await verifyAuthority()
      directory(dirname(statePath), true)
      release = await acquirePhotoLock(`${statePath}.lock`)
      const state = jsonRead(statePath, { schema: 2, owner_id: ownerId, authority_id: authorityId, cursor: 0, ceiling: 0, counts: {}, reasons: {}, pending: [], samples: {}, unavailable: [] })
      if (state.schema !== 2 || state.owner_id !== ownerId || state.authority_id !== authorityId || !Array.isArray(state.pending) || state.pending.length > 512) throw new Error('invalid photo checkpoint binding')
      const unavailable = (m, reason, n = 1) => {
        state.reasons[reason] = (state.reasons[reason] || 0) + n
        state.counts.unavailable = (state.counts.unavailable || 0) + n
        if (state.unavailable.length < 50) state.unavailable.push({ thread_id: m.thread_id, message_id: m.message_id, role: m.role, reason, count: n })
      }
      const processMessage = async (entry) => {
        const m = entry.message
        let publishing = false
        try {
          const result = await resolveMessage(m)
          publishing = true
          for (const photo of result.photos) {
            const published = await projection.publish(photo.bytes, photo.mime, { ...m, agent_id: 'main', owner_id: ownerId, authority_id: authorityId, sent_at: new Date(m.timestamp * 1000).toISOString() })

            state.samples[m.role] ||= { thread_id: m.thread_id, message_id: m.message_id, gateway: m.gateway, ...published }
          }
          for (const reason of result.unavailable) unavailable(m, reason)
          return null
        } catch (e) {
          // Never classify publication/integrity failures by error-message wording.
          // Only an explicitly transient resolver failure may advance with a retry.
          const retryCodes = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])
          const transient = retryCodes.has(e.code) || retryCodes.has(e.cause?.code) || [5, 6].includes(e.errcode)
            || ['TimeoutError', 'AbortError'].includes(e.name) || e.message === 'helm_transient' || e.upstreamStatus >= 500
          if (publishing || !transient) throw e
          const attempts = Math.min(entry.attempts + 1, 20)
          return { message: m, attempts, after: Date.now() + Math.min(3600000, 1000 * 2 ** attempts) }
        }
      }
      const pending = []
      for (const entry of state.pending) {
        const retry = entry.after > Date.now() ? entry : await processMessage(entry)
        if (retry) pending.push(retry)
      }
      state.pending = pending
      let batch = { done: false, cursor: state.cursor }
      // Backpressure instead of dropping retries or advancing an unqueued page.
      if (pending.length < 128) {
        batch = await scan(state)
        if (batch.evidence.length + pending.length > 512) throw new Error('photo retry page exceeds bound')
        for (const m of batch.evidence) { const retry = await processMessage({ message: m, attempts: 0 }); if (retry) state.pending.push(retry) }
        for (const [k, v] of Object.entries(batch.counts)) state.counts[k] = (state.counts[k] || 0) + v
        state.cursor = batch.cursor; state.ceiling = batch.done ? 0 : batch.ceiling
        if (batch.done) state.last_completed_ceiling = batch.ceiling
      }
      state.updated_at = new Date().toISOString()
      Object.assign(state.counts, projection.stats?.() || {})
      const events = { ...pendingEvents }
      state.event_counts ||= {}
      for (const [name, count] of Object.entries(events)) state.event_counts[name] = (state.event_counts[name] || 0) + count
      atomicPhotoJson(statePath, state)
      for (const [name, count] of Object.entries(events)) pendingEvents[name] -= count
      return { done: batch.done && !state.pending.length, cursor: state.cursor, pending: state.pending.length, counts: state.counts }
    } finally { if (release) await release(); busy = false }
  }
  return { step, kick(reason = 'repair') { if (!stopped) { pendingEvents[reason] = (pendingEvents[reason] || 0) + 1; void step().catch(e => log(`[chat-photos] ${e.code || e.message}`)) } },
    start() { timer = setInterval(() => this.kick('repair'), 3000); timer.unref(); this.kick('startup') }, stop() { stopped = true; clearInterval(timer) } }
}
