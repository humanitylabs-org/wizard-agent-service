// Shared Chats-window projection with a hot/cold split.
//
// Every offset-0 window poll used to re-project every listed thread (~950, 5-6 s of mostly
// synchronous work) for every visible client every 15 s. This module keeps one projected list
// for all clients and re-projects only threads that can be changing:
//   - changed newest canonical rows (preserving enrichment and first-send rows),
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
// caller's head enrichment flag and global preview offset across that head.
export async function projectListSlices(sessions, project, firstPage, sliceSize = 20, previewOffset = 0) {
  const rows = []
  for (let at = 0; at < sessions.length; at += sliceSize) {
    await new Promise(resolve => setImmediate(resolve))
    rows.push(...await project(sessions.slice(at, at + sliceSize), firstPage, (Array.isArray(previewOffset) ? previewOffset.slice(at, at + sliceSize) : previewOffset + at)))
  }
  return rows
}

// A slow self-check has one owner; all callers observe the same result/failure.
export function createJoinedListCheck(checkCore) {
  let checking = null
  return () => checking ?? (checking = Promise.resolve().then(checkCore).finally(() => { checking = null }))
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
// Stable per-id refresh phases spread even a simultaneously warmed head over 30-60 s.
// Unknown transcript/helper/reconnect inputs are therefore bounded, never cached indefinitely.
const headRefreshAge = (id, maxAge) => {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return maxAge * (0.5 + (hash >>> 0) / 0x100000000 / 2)
}

export function createHybridProjector({ batchSize = 100, sweepMaxAgeMs = 10 * 60_000, sweepPerMinute = 100, warmMaxAgeMs = 60_000, headMaxAgeMs = 60_000, now = Date.now } = {}) {
  let cache = new Map()
  let epoch = null
  let sweptAt = null
  const keyed = (batch, projected) => {
    const ids = new Set(batch.map(session => session.id)), byId = new Map()
    for (const row of projected) {
      if (!row || typeof row.id !== 'string' || !ids.has(row.id) || byId.has(row.id)) throw Object.assign(new Error('list projection is not per-thread'), { code: 'list_cache_unkeyed' })
      byId.set(row.id, row)
    }
    return new Map(batch.map(session => [session.id, byId.get(session.id) ?? null]))
  }
  const projectInBatches = async (sessions, projectBatch, out, firstPage = false, offset = 0) => {
    for (let index = 0; index < sessions.length; index += batchSize) {
      const batch = sessions.slice(index, index + batchSize)
      const positions = Array.isArray(offset) ? offset.slice(index, index + batchSize) : offset + index
      for (const [id, row] of keyed(batch, await projectBatch(batch, firstPage, positions))) out.set(id, row)
    }
  }
  // Raw canonical rows include timestamps/count/title/pin/agent metadata. Stamps cover
  // outside queue/background/direct/heavy state. Hot and non-cacheable rows stay fresh.
  // headContext invalidates global owner changes; index preserves head preview enrichment.
  const project = async ({ sessions, hot = new Set(), warm = new Set(), stamps = null, epoch: nextEpoch = '', headContext = '', reuseHead = true, projectBatch }) => {
    if (nextEpoch !== epoch) { cache = new Map(); epoch = nextEpoch; sweptAt = null }
    const at = now()
    const head = sessions.slice(0, batchSize)
    const rest = sessions.slice(batchSize)
    const headStarted = performance.now()
    const raws = new Map(sessions.map(session => [session.id, JSON.stringify(session)]))
    const stamp = id => stamps === null ? undefined : (stamps.get(id) ?? '')
    const changed = (session, entry) => hot.has(session.id) || !entry || entry.raw !== raws.get(session.id)
      || !cacheableRow(entry.row) || entry.stamp !== stamp(session.id)
    const fresh = new Map()
    const headNeed = head.map((session, index) => !reuseHead || changed(session, cache.get(session.id))
      || cache.get(session.id)?.headIndex !== index || cache.get(session.id)?.headContext !== headContext
      || at - cache.get(session.id).builtAt >= headRefreshAge(session.id, Math.min(60_000, headMaxAgeMs)))
    let headRows
    if (!reuseHead) {
      // Pending first-send enrichment can append rows to each original slice. Preserve
      // that exact legacy output rather than keying/reordering/inventing those rows.
      headRows = await projectBatch(head, true, 0)
      for (const session of head) cache.delete(session.id)
    } else {
      // Batch sparse changes together (one truth read per slice), but carry each
      // row's ORIGINAL offset: row 49 must never inherit row 1's 48-row preview cap.
      const positions = head.flatMap((_, index) => headNeed[index] ? [index] : [])
      await projectInBatches(positions.map(index => head[index]), projectBatch, fresh, true, positions)
      for (let index = 0; index < head.length; index++) {
        const id = head[index].id
        if (fresh.has(id)) cache.set(id, { raw: raws.get(id), row: fresh.get(id), builtAt: at, stamp: stamp(id), headIndex: index, headContext })
      }
      headRows = head.map(session => cache.get(session.id).row).filter(Boolean)
    }
    const head_projected = headNeed.filter(Boolean).length
    const head_reused = head.length - head_projected
    const head_ms = performance.now() - headStarted
    const hotStarted = performance.now()
    const budget = sweptAt === null ? 0 : Math.min(batchSize, Math.floor((at - sweptAt) / 60_000 * sweepPerMinute))
    const sweep = new Set(rest
      .map(session => ({ id: session.id, entry: cache.get(session.id) }))
      .filter(({ entry }) => entry && at - entry.builtAt >= sweepMaxAgeMs)
      .sort((left, right) => left.entry.builtAt - right.entry.builtAt)
      .slice(0, budget)
      .map(({ id }) => id))
    if (sweptAt === null || budget > 0) sweptAt = at
    const need = rest.filter(session => {
      const entry = cache.get(session.id)
      return changed(session, entry) || sweep.has(session.id) || entry.headIndex !== undefined
        || (warm.has(session.id) && at - entry.builtAt >= warmMaxAgeMs)
    })
    const coldFresh = new Map()
    await projectInBatches(need, projectBatch, coldFresh)
    for (const [id, row] of coldFresh) cache.set(id, { raw: raws.get(id), row, builtAt: at, stamp: stamp(id) })
    for (const id of cache.keys()) if (!raws.has(id)) cache.delete(id)
    const rows = [...headRows]
    const cachedIds = head.filter((_, index) => !headNeed[index]).map(session => session.id)
    for (const session of rest) {
      if (!coldFresh.has(session.id)) cachedIds.push(session.id)
      const row = cache.get(session.id)?.row
      if (row) rows.push(row)
    }
    const hot_ms = performance.now() - hotStarted
    return { rows, cachedIds, head_ms, hot_ms, head_reused, head_projected, projected: head_projected + need.length, cached: cachedIds.length, swept: sweep.size }
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

/** Per-thread fingerprint of in-memory direct (unqueued) run admissions. A thread is hot only while
 * its direct run is tracked; when the run ends and leaves the map, its fingerprint changes once more
 * so the cached row is re-projected without that run (wizard_last_run_*), instead of serving it stale
 * until a self-check catches the difference and switches the whole cache off. */
export function directRunStamps(runs) {
  const parts = new Map()
  for (const run of runs ?? []) {
    const id = typeof run?.sessionId === 'string' ? run.sessionId : ''
    if (!id) continue
    if (!parts.has(id)) parts.set(id, [])
    parts.get(id).push(`${run.publicRunId ?? run.runId ?? ''}=${run.status ?? ''}`)
  }
  return new Map([...parts].map(([id, list]) => [id, `direct:${list.sort().join(',')}`]))
}

/** Heavy snapshot fields are cheap compared with transcript projection, and include
 * delivery/resume/receipt changes, not only job state. Never persist these stamps. */
export function heavyJobStamps(jobs) {
  const parts = new Map()
  for (const job of jobs ?? []) {
    if (job.agent_id && job.agent_id !== 'hermes') continue
    const id = job.sessionId ?? job.session_id
    if (typeof id !== 'string') continue
    if (!parts.has(id)) parts.set(id, [])
    parts.get(id).push(JSON.stringify(job))
  }
  return new Map([...parts].map(([id, list]) => [id, JSON.stringify(list.sort())]))
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
