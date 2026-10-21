// Service-owned stores only. Never apply this protocol to upstream Hermes databases.
import { openSync, closeSync, fsyncSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, statSync, chmodSync } from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const BACKUP_SUFFIX = '.pre-agent-pairs-v1.bak'
export const INVENTORY_NAME = '.agent-pairs-v1.inventory.json'
const held = new Set()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const diagnostic = message => new Error(`[agent-pairs] ${message}; stop service and recover the store/validated inventory before retrying`)
// SQLite's native exclusive writer locks are OS-released, including after SIGKILL.
// Keep the lock database inode: unlinking a lock file could let two writers own different inodes.
export function acquireLease(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  chmodSync(path, 0o600)
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') }
  catch { db.close(); throw diagnostic('exclusive writer ownership unavailable (service/restore lease held)') }
  let released = false
  return () => { if (!released) { released = true; try { db.exec('ROLLBACK') } finally { db.close() } } }
}
const serviceLeases = new Map()
export function acquireServiceLeases(directories, { shared = false } = {}) {
  const releases = []
  try {
    for (const dir of [...new Set(directories.map(dir => resolve(dir)))].sort()) {
      if (!shared) { releases.push(acquireLease(join(dir, '.agent-pairs.service-lease.sqlite'))); continue }
      // Several listeners in one service process share the lifetime lease, not restore's
      // exclusive acquisition. Restore (even in this process) can never share this reference.
      let lease = serviceLeases.get(dir)
      if (!lease) { lease = { release: acquireLease(join(dir, '.agent-pairs.service-lease.sqlite')), count: 0 }; serviceLeases.set(dir, lease) }
      lease.count++
      releases.push(() => { if (--lease.count === 0) { serviceLeases.delete(dir); lease.release() } })
    }
  } catch (error) { for (const release of releases.reverse()) release(); throw error }
  let released = false
  return () => { if (!released) { released = true; for (const release of releases.reverse()) release() } }
}
export function withStoreLock(path, fn) {
  if (!path) return fn()
  path = resolve(path)
  if (held.has(path)) return fn()
  const release = acquireLease(`${path}.agent-pairs.lock.sqlite`)
  held.add(path)
  try { return fn() }
  finally { held.delete(path); release() }
}
function syncDirectory(path) {
  const fd = openSync(dirname(path), 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
export function atomicStoreWrite(path, bytes, { inventory = true, kind = 'json' } = {}) {
  return withStoreLock(path, () => {
    if (inventory && !existsSync(path)) recordCreatedStore(path, kind)
    const temporary = `${path}.${process.pid}.${randomUUID()}.agent-pairs.tmp`
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, path); syncDirectory(path)
    } finally { rmSync(temporary, { force: true }) }
  })
}
const inventoryPath = path => join(dirname(path), INVENTORY_NAME)
function inventory(path) {
  const target = inventoryPath(path)
  if (!existsSync(target)) return { schema: 1, stores: {} }
  const value = JSON.parse(readFileSync(target, 'utf8'))
  if (value.schema !== 1 || !value.stores || typeof value.stores !== 'object' || Array.isArray(value.stores)) throw diagnostic('invalid migration inventory')
  return value
}
export const migrationEntry = path => inventory(path).stores[basename(path)]
function record(path, entry) {
  const target = inventoryPath(path)
  withStoreLock(target, () => {
    const value = inventory(path)
    value.stores[basename(path)] = { store: basename(path), ...entry }
    atomicStoreWrite(target, JSON.stringify(value, null, 2) + '\n', { inventory: false })
  })
}
export function recordCreatedStore(path, kind = 'json') {
  if (path && !migrationEntry(path)) record(path, { kind, disposition: 'created', phase: 'complete', source_generation: 'absent' })
}
function generation(path) {
  const metadata = statSync(path, { bigint: true })
  return `${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${digest(readFileSync(path))}`
}
export function validateBackup(path, entry = migrationEntry(path)) {
  if (!entry || entry.disposition !== 'migrated' || !entry.backup || !entry.source_generation) throw diagnostic('backup completion marker missing')
  if (entry.backup !== basename(path) + BACKUP_SUFFIX) throw diagnostic('invalid backup target')
  const backup = join(dirname(path), entry.backup)
  const bytes = readFileSync(backup)
  if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw diagnostic('backup checksum/size mismatch')
  return backup
}
function publishBackup(path, bytes, kind, sourceGeneration) {
  const backup = path + BACKUP_SUFFIX
  // A completion marker is published only after durable backup bytes and rename.
  atomicStoreWrite(backup, bytes, { inventory: false })
  const entry = { kind, disposition: 'migrated', phase: 'backed_up', backup: basename(backup), sha256: digest(bytes), size: bytes.length, source_generation: sourceGeneration }
  record(path, entry); validateBackup(path, entry)
  return backup
}
export function backupJson(path, { canRecreate = true, kind = 'json' } = {}) {
  const entry = migrationEntry(path)
  if (entry?.disposition === 'created') return ''
  if (entry?.phase === 'complete') return validateBackup(path, entry)
  if (entry?.phase === 'backed_up') {
    const backup = validateBackup(path, entry)
    if (entry.source_generation !== generation(path)) throw diagnostic('source generation changed after backup: keep source, keep backup; operator chooses recovery baseline')
    return backup
  }
  if (!canRecreate) throw diagnostic('unvalidated backup cannot be reconstructed from migrated source')
  return publishBackup(path, readFileSync(path), kind, generation(path))
}
function complete(path) {
  const entry = migrationEntry(path)
  if (entry && entry.phase !== 'complete') record(path, { ...entry, phase: 'complete' })
}
export function migrateText(path, transform, kind = 'json') {
  if (!path) return false
  return withStoreLock(path, () => {
    if (!existsSync(path)) { recordCreatedStore(path, kind); return false }
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = generation(path), old = readFileSync(path, 'utf8')
      const next = transform(old)
      if (before !== generation(path)) continue // A non-cooperating legacy writer raced the read/transform.
      const entry = migrationEntry(path)
      if (entry?.disposition === 'migrated' && entry.phase === 'complete') validateBackup(path, entry)
      // Existing unmodified stores also need a rollback baseline before later paired writes.
      if (!entry || entry.phase !== 'complete') {
        if (next === old && existsSync(path + BACKUP_SUFFIX) && !entry) throw diagnostic('unvalidated backup beside already-qualified source')
        if (!entry && existsSync(path + BACKUP_SUFFIX) && /"agent_id"\s*:/u.test(old)) throw diagnostic('unvalidated backup beside partially-qualified source')
        backupJson(path, { kind })
      }
      if (before !== generation(path)) continue
      if (next !== old) atomicStoreWrite(path, next, { inventory: false })
      complete(path)
      return next !== old
    }
    throw diagnostic('source generation kept changing during migration')
  })
}
// VACUUM INTO on a second connection includes committed WAL pages. BEGIN IMMEDIATE on
// the source holds SQLite's real writer lock across backup, validation and schema mutation.
const sqliteGeneration = path => `${generation(path)}:wal:${existsSync(path + '-wal') ? digest(readFileSync(path + '-wal')) : 'absent'}`
export function backupSqlite(db, path) {
  const entry = migrationEntry(path)
  if (entry?.disposition === 'created') return ''
  if (entry?.phase === 'complete') return validateBackup(path, entry)
  if (entry?.phase === 'backed_up') {
    const backup = validateBackup(path, entry)
    if (entry.source_generation !== sqliteGeneration(path)) throw diagnostic('SQLite source generation changed after backup: keep source, keep backup; operator chooses recovery baseline')
    return backup
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  const alreadyQualified = tables.some(({ name }) => db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all().some(row => row.name === 'agent_id'))
  if (alreadyQualified && existsSync(path + BACKUP_SUFFIX)) {
    if (!entry) throw diagnostic('unvalidated SQLite backup beside migrated source')
    return validateBackup(path, entry)
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.vacuum.tmp`
  try {
    db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`)
    const check = new DatabaseSync(temporary, { readOnly: true })
    try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw diagnostic('SQLite backup integrity failure') }
    finally { check.close() }
    chmodSync(temporary, 0o600)
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    const bytes = readFileSync(temporary)
    const sourceGeneration = sqliteGeneration(path)
    // publishBackup itself uses a durable temp+rename; never trust a leftover VACUUM output.
    return publishBackup(path, bytes, 'sqlite', sourceGeneration)
  } finally { rmSync(temporary, { force: true }) }
}
export function withSqliteMigration(db, path, hadState, fn) {
  return withStoreLock(path, () => {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
    try {
      if (hadState) {
        const reader = new DatabaseSync(path, { readOnly: true })
        try { backupSqlite(reader, path) } finally { reader.close() }
      } else recordCreatedStore(path, 'sqlite')
      fn()
      db.exec('COMMIT'); complete(path)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  })
}

// Validate *every* entry, including created stores, before touching any source.
function restoreEntries(directories) {
  return directories.flatMap(dir => Object.entries(inventory(join(dir, 'placeholder')).stores).map(([key, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.store !== 'string' || !entry.store || ['.', '..'].includes(entry.store)
      || entry.store.startsWith('.agent-pairs.') || entry.store === INVENTORY_NAME || entry.store.endsWith('.agent-pairs.lock.sqlite') || entry.store.endsWith(BACKUP_SUFFIX)
      || /[/\\\\\u0000]/u.test(entry.store) || key !== entry.store
      || !['json', 'jsonl', 'sqlite'].includes(entry.kind)
      || !['created', 'migrated'].includes(entry.disposition)
      || !['backed_up', 'complete'].includes(entry.phase)
      || typeof entry.source_generation !== 'string' || !entry.source_generation) throw diagnostic('invalid inventory entry')
    const path = join(dir, entry.store)
    if (entry.disposition === 'created') {
      if (entry.phase !== 'complete' || entry.source_generation !== 'absent' || ['backup', 'sha256', 'size'].some(key => Object.hasOwn(entry, key))) throw diagnostic('invalid created inventory entry')
    } else {
      const generationPattern = entry.kind === 'sqlite' ? /^\d+:\d+:-?\d+:[a-f0-9]{64}:wal:(?:absent|[a-f0-9]{64})$/u : /^\d+:\d+:-?\d+:[a-f0-9]{64}$/u
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !generationPattern.test(entry.source_generation)) throw diagnostic('invalid migrated inventory entry')
      validateBackup(path, entry)
    }
    return { path, entry }
  }))
}
// Every service holds a lease in each configured store directory for its whole lifetime.
// Sorted per-directory restore locks fence overlapping sets, not just identical argv sets.
export function restoreStoreSet(directories, { serviceStopped = false } = {}) {
  if (!serviceStopped) throw diagnostic('restore requires explicit stopped-service acknowledgement')
  directories = [...new Set(directories.map(dir => resolve(dir)))].sort()
  const releases = []
  try {
    releases.push(acquireServiceLeases(directories))
    for (const dir of directories) releases.push(acquireLease(join(dir, '.agent-pairs.restore-lock.sqlite')))
    const entries = restoreEntries(directories)
    // Hold *all* writer locks through validation and restore (no partially acquired set).
    const lockAll = index => index === entries.length ? restore() : withStoreLock(entries[index].path, () => lockAll(index + 1))
    const restore = () => {
      restoreEntries(directories)
      for (const { path, entry } of entries) {
        if (entry.disposition === 'created') rmSync(path, { force: true })
        else atomicStoreWrite(path, readFileSync(validateBackup(path, entry)), { inventory: false })
        rmSync(path + '-wal', { force: true }); rmSync(path + '-shm', { force: true })
      }
      return entries.map(({ path }) => path)
    }
    return lockAll(0)
  } finally { for (const release of releases.reverse()) release() }
}
