// Health of the read-only Hermes session database (WIZARD_HERMES_STATE_PATH).
//
// Alongside boxes bind-mount state.db, state.db-wal and state.db-shm as three single-file mounts
// (wizard-app-manager wam/alongside.py, --share-sessions). A file bind mount keeps the inode it was
// started with: when Hermes deletes and recreates its -wal/-shm (a Hermes restart, a full checkpoint),
// the container keeps reading the old, unlinked files. Reads then fail with "database disk image is
// malformed" or return a frozen snapshot, so archiving looks like it does nothing and new threads never
// show (issue 430). Inside the container such a file still stats, but with zero links, which is how
// the service can tell. Only remounting (restarting the container) brings the live files back, so the
// service reports it in /wizard/health and logs it once per change instead of failing silently.
import { statSync } from 'node:fs'
import { basename } from 'node:path'

const SIDECARS = ['', '-wal', '-shm']
const LOG_EVERY_MS = 5 * 60_000

/** Names of the session-database files that were replaced on the host since this process mounted them. */
export function staleHermesStateFiles(dbPath, { stat = statSync } = {}) {
  if (!dbPath) return []
  const out = []
  for (const suffix of SIDECARS) {
    let details
    try { details = stat(`${dbPath}${suffix}`) } catch { continue }
    if (details && Number(details.nlink) === 0) out.push(`${basename(dbPath)}${suffix}`)
  }
  return out
}

const errorCode = (error) => {
  const code = error?.errcode ?? error?.code
  return code === undefined || code === null ? 'error' : String(code)
}

export function createHermesStateHealth({ dbPath = '', stat = statSync, log = console.warn, now = Date.now } = {}) {
  // Each reader keeps its own failure until that same reader succeeds again; logs are throttled per key.
  const errors = new Map()
  const loggedAt = new Map()
  const note = (key, line) => {
    const at = now()
    if (loggedAt.has(key) && at - loggedAt.get(key) < LOG_EVERY_MS) return
    loggedAt.set(key, at)
    if (loggedAt.size > 64) loggedAt.delete(loggedAt.keys().next().value)
    try { log(line) } catch { /* logging never breaks a read */ }
  }
  const stale = () => staleHermesStateFiles(dbPath, { stat })
  const hint = 'Hermes replaced its session database files since the Agent Service started; restart the Agent Service (wam app update) so the mounts refresh.'
  return {
    /** Wrap a state.db read: failures are recorded and logged, then re-thrown so callers keep their fallback. */
    read(where, fn) {
      try {
        const value = fn()
        errors.delete(where)
        return value
      } catch (error) {
        const files = stale()
        const failure = { where, code: errorCode(error), message: String(error?.message ?? error).slice(0, 200), at: new Date(now()).toISOString() }
        errors.set(where, failure)
        note(`${where}:${failure.code}:${files.join(',')}`,
          `[hermes-state] ${where} read of ${dbPath} failed (${failure.code}: ${failure.message})${files.length ? `; stale mount: ${files.join(', ')}. ${hint}` : ''}`)
        throw error
      }
    },
    /** For /wizard/health. null when no Hermes state database is configured. */
    report() {
      if (!dbPath) return null
      const files = stale()
      if (files.length) note(`stale:${files.join(',')}`, `[hermes-state] stale mount: ${files.join(', ')}. ${hint}`)
      const failures = [...errors.values()]
      const lastError = failures.sort((a, b) => b.at.localeCompare(a.at))[0]
      return {
        ok: !files.length && !failures.length,
        ...(files.length ? { reason: 'stale_mount', stale: files, hint } : failures.length ? { reason: 'read_failed' } : {}),
        ...(failures.length ? { failing: failures.map((f) => f.where).sort(), last_error: lastError } : {}),
      }
    },
  }
}
