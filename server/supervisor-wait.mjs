// Supervisor builders are durable agent-owned work, even after the dispatching run
// ends to wait on its own helper. The build ledger, not that run's lease, owns the wait.
import { DatabaseSync } from 'node:sqlite'
import { readHermesSessionTruth } from './session-truth.mjs'
import { withoutOwnerGates } from './heavy-wait.mjs'

export const SUPERVISOR_WAIT_CAP_SECONDS = 12 * 3600
export function readSupervisorBuildWaits(supervisorPath, hermesPath, ids, now = Date.now(), { includeOwnerGates = false } = {}) {
  const waits = new Map(), wanted = [...new Set(ids)]
  if (!supervisorPath || !hermesPath || !wanted.length) return waits
  let db, hermes
  try {
    db = new DatabaseSync(supervisorPath, { readOnly: true })
    hermes = new DatabaseSync(hermesPath, { readOnly: true })
    const builds = db.prepare(`SELECT b.thread,b.state,b.data,r.thread AS parent FROM builds b JOIN reviews r ON r.id=b.review
      WHERE r.state='open' AND b.state IN ('running','ended') AND r.thread IN (${wanted.map(() => '?').join(',')})`).all(...wanted)
    if (!builds.length) return waits
    const start = hermes.prepare('SELECT started_at FROM sessions WHERE id=?')
    const parents = readHermesSessionTruth(hermesPath, wanted, now / 1000)
    const children = new Map()
    const threads = [...new Set(builds.map(b => b.thread))]
    for (let at = 0; at < threads.length; at += 100) for (const [id, truth] of readHermesSessionTruth(hermesPath, threads.slice(at, at + 100), now / 1000)) children.set(id, truth)
    for (const build of builds) {
      let data; try { data = JSON.parse(build.data) } catch { continue }
      // Legacy build rows predate created_at. Never renew their cap from read time.
      const since = Number(data.created_at) / 1000 || Number(start.get(build.thread)?.started_at)
      if (!since || since > now / 1000 || now / 1000 - since > SUPERVISOR_WAIT_CAP_SECONDS) continue
      const parent = parents.get(build.parent)
      // Explicit answers settle a build; FYI/progress handoffs do not. Real owner gates
      // are removed below using the same compaction-safe boundary as helper receipts.
      const child = children.get(build.thread)
      if (build.state === 'ended' && !child?.active && !child?.helpersRunning && !child?.helperResultUnanswered
        && child?.status?.state === 'done' && parent?.status?.state === 'done'
        && parent.lastAssistantAt >= Math.max(since, child.lastAssistantAt)) continue
      const wait = waits.get(build.parent) ?? { pending: 0, since }
      wait.pending++; wait.since = Math.min(wait.since, since)
      waits.set(build.parent, wait)
    }
    return includeOwnerGates ? waits : withoutOwnerGates(hermesPath, waits)
  } catch { return new Map() } finally { db?.close(); hermes?.close() }
}

// A build report can change attention without adding a Hermes message yet.
export function readSupervisorWaitStamps(path) {
  const stamps = new Map()
  for (const row of JSON.parse(readSupervisorWaitRevision(path) || '[]')) {
    stamps.set(row.parent, `${stamps.get(row.parent) ?? ''}|${row.id}:${row.state}:${row.review_state}`)
  }
  return stamps
}

export function readSupervisorWaitRevision(path) {
  if (!path) return ''
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    return JSON.stringify(db.prepare('SELECT b.id,b.state,r.thread AS parent,r.state AS review_state FROM builds b JOIN reviews r ON b.review=r.id ORDER BY b.id').all())
  } catch { return '' } finally { db?.close() }
}
