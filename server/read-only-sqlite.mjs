// Statement ownership follows the DB handle, never a filename or evidence revision.
import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const statements = new WeakMap()
export function preparedRead(db, sql) {
  let cache = statements.get(db)
  if (!cache) { cache = new Map(); statements.set(db, cache) }
  if (!cache.has(sql)) {
    const statement = db.prepare(sql)
    if (cache.size >= 256) cache.delete(cache.keys().next().value)
    cache.set(sql, statement)
  }
  return cache.get(sql)
}

// One service-owned connection, no open transaction or cached query results. WAL
// writes remain visible on the next statement; atomic database replacement reopens.
export function createReadOnlySqlite(path) {
  let db, identity
  const close = () => { try { db?.close() } finally { db = null; identity = null } }
  return {
    close,
    get() {
      try {
        const stat = statSync(path), key = `${stat.dev}:${stat.ino}`
        if (db && key !== identity) close()
        if (!db) { db = new DatabaseSync(path, { readOnly: true }); identity = key }
        return db
      } catch { close(); return null }
    },
  }
}
