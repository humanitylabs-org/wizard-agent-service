// Shared Chats-window projection with a hot/cold split.
//
// Every offset-0 window poll used to re-project every listed thread (~950, 5-6 s of mostly
// synchronous work) for every visible client every 15 s. This module keeps one projected list
// for all clients and re-projects only threads that can be changing:
//   - the newest canonical batch (it carries enrichment and first-send rows),
//   - every thread the caller marks hot (queued/running work, live turns, helpers, Helm,
//     background results, unresolved external runs), and recently active threads once a minute,
//   - any thread whose canonical row changed, that has no cached row yet, or whose cached row
//     shows live state (Working, failed, waiting, helper, background result),
//   - a rolling sweep of the oldest cached rows, so an unforeseen change is late, never permanent.
// Everything else (idle archive threads) is served from the cached projected row.
//
// Safety: callers compare this against the full projection on a timer and switch the cache off
// on a confirmed difference; any error falls back to the full projection; WIZARD_LIST_CACHE=off
// restores the old path without a code change.

// Yield to the HTTP loop, not merely the promise microtask queue. Preserve the
// caller's head enrichment flag for every slice of that head.
export async function projectListSlices(sessions, project, firstPage, sliceSize = 20) {
  const rows = []
  for (let at = 0; at < sessions.length; at += sliceSize) {
    await new Promise(resolve => setImmediate(resolve))
    rows.push(...await project(sessions.slice(at, at + sliceSize), firstPage))
  }
  return rows
}

export const LIVE_ROW_STATUSES = new Set(['submitting', 'queued', 'accepted', 'launching', 'running', 'stopping',
  'waiting_for_approval', 'unknown', 'failed', 'interrupted'])
const LIVE_ROW_FIELDS = ['wizard_waiting_on', 'wizard_helper_status', 'wizard_background_result', 'wizard_run_id',
  'wizard_safe_error', 'wizard_pending_first_send', 'queue_position']

/** A projected row may be served from cache only when it shows no live or failed state. */
export function cacheableRow(row) {
  if (row === null) return true
  if (!row || typeof row !== 'object') return false
  if (LIVE_ROW_STATUSES.has(String(row.status ?? ''))) return false
  return !LIVE_ROW_FIELDS.some((field) => Boolean(row[field]))
}

export function listCacheMode(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  return ['off', 'shadow', 'on'].includes(mode) ? mode : 'on'
}

/**
 * projectBatch(sessions, firstPage) projects one canonical batch exactly as the full path does and
 * returns the projected rows (before shared decoration). Batches never exceed `batchSize`.
 * The rolling sweep re-projects the oldest cached rows at `sweepPerMinute`, so every cached row is
 * rebuilt at least every `sweepMaxAgeMs` plus one cycle even if every signal missed it.
 */
// warm: threads that were recently active but show no live signal now. They are re-projected at
// most every `warmMaxAgeMs` instead of on every build: a new message, queue change, running turn or
// live row still re-projects them at once through raw/stamps/hot/cacheableRow.
export function createHybridProjector({ batchSize = 100, sweepMaxAgeMs = 10 * 60_000, sweepPerMinute = 100, warmMaxAgeMs = 60_000, now = Date.now } = {}) {
  let cache = new Map()
  let epoch = null
  let sweptAt = null
  const projectInBatches = async (sessions, projectBatch, out) => {
    for (let index = 0; index < sessions.length; index += batchSize) {
      const batch = sessions.slice(index, index + batchSize)
      const ids = new Set(batch.map((session) => session.id))
      const projected = await projectBatch(batch, false)
      const byId = new Map()
      for (const row of projected) {
        // A projection that renames or invents a thread cannot be cached per thread.
        if (!row || typeof row.id !== 'string' || !ids.has(row.id) || byId.has(row.id)) throw Object.assign(new Error('list projection is not per-thread'), { code: 'list_cache_unkeyed' })
        byId.set(row.id, row)
      }
      for (const session of batch) out.set(session.id, byId.get(session.id) ?? null)
    }
  }
  // stamps: optional Map(thread id -> fingerprint of outside state the projection reads, e.g. its
  // queue rows). A cached row whose fingerprint changed (including disappeared) is re-projected.
  const project = async ({ sessions, hot = new Set(), warm = new Set(), stamps = null, epoch: nextEpoch = '', projectBatch }) => {
    if (nextEpoch !== epoch) { cache = new Map(); epoch = nextEpoch; sweptAt = null }
    const at = now()
    const head = sessions.slice(0, batchSize)
    const rest = sessions.slice(batchSize)
    const headRows = await projectBatch(head, true)
    const raws = new Map(rest.map((session) => [session.id, JSON.stringify(session)]))
    const budget = sweptAt === null ? 0 : Math.min(batchSize, Math.floor((at - sweptAt) / 60_000 * sweepPerMinute))
    const sweep = new Set(rest
      .map((session) => ({ id: session.id, entry: cache.get(session.id) }))
      .filter(({ entry }) => entry && at - entry.builtAt >= sweepMaxAgeMs)
      .sort((left, right) => left.entry.builtAt - right.entry.builtAt)
      .slice(0, budget)
      .map(({ id }) => id))
    if (sweptAt === null || budget > 0) sweptAt = at
    const need = rest.filter((session) => {
      const entry = cache.get(session.id)
      return hot.has(session.id) || sweep.has(session.id) || !entry || entry.raw !== raws.get(session.id) || !cacheableRow(entry.row)
        || (stamps !== null && entry.stamp !== (stamps.get(session.id) ?? ''))
        || (warm.has(session.id) && at - entry.builtAt >= warmMaxAgeMs)
    })
    const fresh = new Map()
    await projectInBatches(need, projectBatch, fresh)
    for (const [id, row] of fresh) cache.set(id, { raw: raws.get(id), row, builtAt: at, stamp: stamps === null ? undefined : (stamps.get(id) ?? '') })
    for (const id of cache.keys()) if (!raws.has(id)) cache.delete(id)
    const rows = [...headRows]
    const cachedIds = []
    for (const session of rest) {
      const fromCache = !fresh.has(session.id)
      const row = fromCache ? cache.get(session.id)?.row : fresh.get(session.id)
      if (fromCache) cachedIds.push(session.id)
      if (row) rows.push(row)
    }
    return { rows, cachedIds, projected: head.length + need.length, cached: cachedIds.length, swept: sweep.size }
  }
  return { project, size: () => cache.size, clear: () => { cache = new Map(); epoch = null; sweptAt = null } }
}

/** Adds outside per-thread state (e.g. a saved background result) to the queue fingerprints, so a
 * cached row is re-projected when that state appears, changes or clears. */
export function mergeStamps(base, extra) {
  if (!base || !extra?.size) return base
  const out = new Map(base)
  for (const [id, stamp] of extra) out.set(id, `${out.get(id) ?? ''}|bg:${stamp}`)
  return out
}

/** Per-thread differences between two projected lists, ignoring order. */
export function diffProjectedRows(expected, actual) {
  const key = (row) => JSON.stringify(row, Object.keys(row ?? {}).sort())
  const left = new Map(expected.map((row) => [row.id, row]))
  const right = new Map(actual.map((row) => [row.id, row]))
  const differences = []
  for (const [id, row] of left) {
    const other = right.get(id)
    if (!other) { differences.push({ id, kind: 'missing' }); continue }
    if (key(row) !== key(other)) {
      const fields = [...new Set([...Object.keys(row), ...Object.keys(other)])]
        .filter((field) => JSON.stringify(row[field]) !== JSON.stringify(other[field]))
      differences.push({ id, kind: 'changed', fields })
    }
  }
  for (const id of right.keys()) if (!left.has(id)) differences.push({ id, kind: 'extra' })
  return differences
}

/**
 * One shared snapshot for every client. A snapshot is reused while the revision gate is unchanged
 * (up to `ceilingMs`), and for at most `debounceMs` while it changes. A changed local revision
 * (an owner action on this service) always rebuilds. Concurrent callers share one rebuild.
 */
export function createSharedSnapshot({ debounceMs = 3_000, ceilingMs = 30_000, staleMs = 0, now = Date.now } = {}) {
  let current = null
  let inFlight = null
  return {
    async get({ gate, local, build }) {
      const at = now()
      if (current && current.local === local) {
        const age = at - current.at
        if (age < debounceMs || (gate !== null && gate === current.gate && age < ceilingMs)) return current.value
      }
      // A rebuild that started before an owner action cannot answer for it: wait, then rebuild.
      if (inFlight && inFlight.local !== local) await inFlight.promise.catch(() => undefined)
      const start = () => {
        const promise = (async () => {
          const startedAt = now()
          const value = await build()
          current = { value, gate, local, at: startedAt }
          return value
        })().finally(() => { if (inFlight?.promise === promise) inFlight = null })
        inFlight = { promise, local }
      }
      // Stale-while-revalidate: with agents always replying the gate moves on almost every request,
      // and waiting for each rebuild made every Chats load take seconds. Serve the current snapshot
      // (younger than the ceiling, same owner revision) and rebuild in the background.
      if (current && current.local === local && at - current.at < staleMs) {
        if (!inFlight) { start(); inFlight.promise.catch(() => undefined) }
        return current.value
      }
      if (!inFlight) start()
      return inFlight.promise
    },
    peek() { return current?.value ?? null },
    clear() { current = null },
    age() { return current ? now() - current.at : null },
  }
}
