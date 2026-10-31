// Build-local list evidence only. Never cache truth across projections or start
// queue/recovery controllers here: all database readers are read-only.
import { createHermesSessionTruthReader } from './session-truth.mjs'
import { readNonHoldingFollowUps } from './owned-open-work-follow-through.mjs'
import { readHelperStatuses } from './helper-status.mjs'
import { pendingHeavyJobs, heavyResultOwed } from './heavy-wait.mjs'
import { readSupervisorBuildWaits, readSupervisorWaitStamps } from './supervisor-wait.mjs'

export function createListEvidenceReader(hermesStatePath) {
  const listTruthReader = createHermesSessionTruthReader(hermesStatePath)
  return {
    close: () => listTruthReader.close(),
    read({ kind, ids, activeSessionIds, heavyJobs, supervisorStatePath, operator, now }) {
      if (kind === 'signals') return {
        supervisorWaitIds: [...readSupervisorBuildWaits(supervisorStatePath, hermesStatePath, ids, now).keys()],
        supervisorStamps: readSupervisorWaitStamps(supervisorStatePath),
      }
      const followUps = new Map()
      const nonHoldingFor = id => {
        if (!followUps.has(id)) followUps.set(id, readNonHoldingFollowUps(hermesStatePath, id))
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
