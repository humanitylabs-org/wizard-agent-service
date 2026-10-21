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
export function withStoreLock(path, fn) {
  if (!path) return fn()
  path = resolve(path)
  if (held.has(path)) return fn()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lock = `${path}.agent-pairs.lock`
  let fd
  try { fd = openSync(lock, 'wx', 0o600) }
  catch { throw diagnostic('exclusive writer ownership unavailable') }
  held.add(path)
  try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); return fn() }
  finally { held.delete(path); closeSync(fd); rmSync(lock, { force: true }) }
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
  if (value.schema !== 1 || !value.stores || typeof value.stores !== 'object') throw diagnostic('invalid migration inventory')
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
        if (entry?.phase === 'backed_up' && next === old) validateBackup(path, entry)
        else {
          if (!entry && existsSync(path + BACKUP_SUFFIX) && /"agent_id"\s*:/u.test(old)) throw diagnostic('unvalidated backup beside partially-qualified source')
          backupJson(path, { kind })
        }
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
export function backupSqlite(db, path) {
  const entry = migrationEntry(path)
  if (entry?.disposition === 'created') return ''
  if (entry?.phase === 'complete') return validateBackup(path, entry)
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
    const sourceGeneration = `${generation(path)}:wal:${existsSync(path + '-wal') ? digest(readFileSync(path + '-wal')) : 'absent'}`
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

// Caller must have stopped every service/worker. Validate the whole set before restoring any store.
export function restoreStoreSet(directories, { serviceStopped = false } = {}) {
  if (!serviceStopped) throw diagnostic('restore requires explicit stopped-service acknowledgement')
  const entries = directories.flatMap(dir => Object.values(inventory(join(dir, 'placeholder')).stores).map(entry => ({ path: join(dir, entry.store), entry })))
  for (const { path, entry } of entries) {
    if (basename(entry.store) !== entry.store) throw diagnostic('invalid inventory store')
    if (entry.disposition === 'migrated') validateBackup(path, entry)
  }
  for (const { path, entry } of entries) withStoreLock(path, () => {
    if (entry.disposition === 'created') rmSync(path, { force: true })
    else atomicStoreWrite(path, readFileSync(validateBackup(path, entry)), { inventory: false })
    rmSync(path + '-wal', { force: true }); rmSync(path + '-shm', { force: true })
  })
  return entries.map(({ path }) => path)
}
