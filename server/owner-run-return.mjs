// wizard-ux issue 1997 (James, 27 Nov 2026): the owner archives a thread while his own run still works and trusts
// it to come back when there is news. Archive is only a flag on the session, so the run carries on; the owner's own
// run re-opened the thread when it was admitted, so a thread still archived when that run ends was archived mid-run.
// A visible reply (or a stop for his approval) brings it back once; an empty or [SILENT] reply keeps it archived.
// Shared by the main queue (service.mjs) and every routed agent's queue (routed-run-queue.mjs).
import { isSilentResult } from './scheduler.mjs'

// Runs the Service or an agent started (helper receipts, follow-through, heavy results, schedules, agent inbox, app
// wakes) keep their own issue 675 rules; only the owner's own turns come back here. A tap on an agent-inbox card
// answer (wizard-inbox-answer-*) is the owner's next turn, as in service.mjs agentStartedRun.
const AGENT_STARTED = /^(?:wizard-helper-receipt-|wizard-follow-through-|wizard-heavy-|schedule:|wizard-inbox-(?!answer-)|wizard-wake-)/u

export const isOwnerRun = (record) => Boolean(record?.sessionId) && !record.continuation && !record.recoveryAuthorized
  && !AGENT_STARTED.test(String(record.idempotencyKey || ''))

/** True once for an owner run that ended with something for the owner: a visible reply, or a wait for his approval
 * (`approvals` remembers which runs already came back for one, since the queue reads a waiting run again). */
export function ownerRunReturns(record, payload, approvals) {
  if (!isOwnerRun(record)) return false
  if (payload?.status === 'waiting_for_approval') {
    const id = String(record.publicRunId || '')
    if (!id || approvals.has(id)) return false
    approvals.add(id)
    if (approvals.size > 256) approvals.delete(approvals.values().next().value)
    return true
  }
  if (payload?.status !== 'completed') return false
  const output = typeof payload.output === 'string' ? payload.output : ''
  return Boolean(output.trim()) && !isSilentResult(output)
}
