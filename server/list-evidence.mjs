// Build-local list evidence only. Never cache truth across projections or start
// queue/recovery controllers here: all database readers are read-only. The one
// exception is owned-work evidence, reused only while its session revision holds.
import { createHermesSessionTruthReader, readHermesFirstRequests, readHermesListRevision, readHermesMessageDelta, readHermesSessionTruth, readRecentHermesRootIds } from './session-truth.mjs'
import { readFirstPostPages } from './first-post.mjs'
import { readArchivedSessions } from './archived-sessions.mjs'
import { createOwnedOpenWorkReader } from './owned-open-work-follow-through.mjs'
import { readHelperStatuses } from './helper-status.mjs'
import { pendingHeavyJobs, heavyResultOwed } from './heavy-wait.mjs'
import { readSupervisorBuildWaits, readSupervisorWaitStamps } from './supervisor-wait.mjs'

export function createListEvidenceReader(hermesStatePath) {
  const listTruthReader = createHermesSessionTruthReader(hermesStatePath)
  const ownedWork = createOwnedOpenWorkReader(hermesStatePath)
  return {
    close: () => { listTruthReader.close(); ownedWork.close() },
    read({ kind, ids, activeSessionIds, heavyJobs, supervisorStatePath, operator, now, posts, path, limit, mark, since }) {
      // Chats list reads of Hermes' state.db (issue 584). A cold read of a large state.db waits on the disk for
      // seconds; here it waits off the HTTP thread. A failure comes back as { failed } (the caller re-throws it for
      // its health report), so one bad read never takes the worker down.
      // `path` names a routed agent's own state.db; without it, the main one.
      if (kind === 'revision' || kind === 'first-posts' || kind === 'first-requests' || kind === 'archive' || kind === 'hot') {
        const db = path || hermesStatePath
        try {
          if (kind === 'revision') return { value: readHermesListRevision(db) }
          // The list cache's change set: threads with new messages since `mark`, and threads active since `since`.
          if (kind === 'hot') return { value: { delta: readHermesMessageDelta(db, mark), recent: readRecentHermesRootIds(db, since) } }
          if (kind === 'first-posts') return { value: readFirstPostPages(db, posts) }
          if (kind === 'archive') return { value: readArchivedSessions(db, { limit }) }
          return { value: readHermesFirstRequests(db, ids) }
        } catch (error) { return { failed: { message: String(error?.message ?? error).slice(0, 200), code: error?.errcode ?? error?.code ?? null } } }
      }
      // A routed agent's list (issue 584): its open-ask evidence from its own state.db, 100 threads per read as
      // before. On the HTTP thread this held every route for seconds on each agent list read.
      if (kind === 'agent-evidence') {
        try { return { value: readAgentEvidence(path, ids, supervisorStatePath, now) } }
        catch (error) { return { failed: { message: String(error?.message ?? error).slice(0, 200), code: error?.errcode ?? error?.code ?? null } } }
      }
      if (kind === 'signals') return {
        supervisorWaitIds: [...readSupervisorBuildWaits(supervisorStatePath, hermesStatePath, ids, now).keys()],
        supervisorStamps: readSupervisorWaitStamps(supervisorStatePath),
      }
      const followUps = new Map()
      const nonHoldingFor = id => {
        if (!followUps.has(id)) followUps.set(id, ownedWork.nonHolding(id))
        return followUps.get(id)
      }
      const sessionTruth = listTruthReader.read(ids, now / 1000, { nonHoldingFor })
      const helperStatuses = readHelperStatuses(hermesStatePath, ids, { now, nonHoldingFor, activeSessionIds: new Set(activeSessionIds) })
      for (const [id, helperStatus] of helperStatuses) { const t = sessionTruth.get(id); if (t) t.helperStatus = helperStatus }
      if (!operator) {
        try {
          const pendingIds = new Set(pendingHeavyJobs(heavyJobs, ids, now).keys())
          const nonHolding = new Map([...pendingIds].map(id => [id, nonHoldingFor(id)]))
          const holdingJobs = heavyJobs.filter(job => {
            const id = job.sessionId ?? job.session_id
            return !pendingIds.has(id) || !nonHolding.get(id).has(job.job_id ?? job.id)
          })
          for (const [id] of pendingHeavyJobs(holdingJobs, ids, now)) {
            const t = sessionTruth.get(id); if (t) t.heavyPending = true
          }
        } catch { /* unavailable heavy evidence must not break ordinary Chats */ }
        for (const [id] of readSupervisorBuildWaits(supervisorStatePath, hermesStatePath, ids, now, { includeOwnerGates: true })) {
          const t = sessionTruth.get(id); if (t) t.supervisorPending = true
        }
      }
      // Later open-ask guards run after an await. Ship their build-local witnesses
      // too, rather than opening transcripts on the HTTP thread after the reply.
      const wanted = new Set(ids)
      for (const job of heavyJobs) {
        const id = job.sessionId ?? job.session_id
        if (wanted.has(id) && (job.agent_id ?? 'hermes') === 'hermes' && heavyResultOwed(job)) nonHoldingFor(id)
      }
      return { sessionTruth, followUps }
    },
  }
}

/** A routed agent's open-ask evidence per thread: Map id -> { truth, helperStatus, supervisorPending }. */
export function readAgentEvidence(path, ids, supervisorStatePath, now = Date.now()) {
  const wanted = [...new Set((ids ?? []).filter(id => typeof id === 'string' && id))]
  const evidence = new Map(wanted.map(id => [id, { truth: undefined, helperStatus: undefined, supervisorPending: false }]))
  // Same 100-thread batches as the main list (readers cap at 200; helper evidence caps per batch).
  for (let at = 0; at < wanted.length; at += 100) {
    const batch = wanted.slice(at, at + 100)
    for (const [id, truth] of readHermesSessionTruth(path, batch, now / 1000)) if (evidence.has(id)) evidence.get(id).truth = truth
    for (const [id, status] of readHelperStatuses(path, batch, { now })) if (evidence.has(id)) evidence.get(id).helperStatus = status
    for (const id of readSupervisorBuildWaits(supervisorStatePath, path, batch, now, { includeOwnerGates: true }).keys()) if (evidence.has(id)) evidence.get(id).supervisorPending = true
  }
  return evidence
}
