// Delegation follow-through for agents that cannot join delegated work inside a run.
//
// Stock Hermes runs delegate_task in the background for a stateful API session: the run ends with
// "the subagent is working", and the subagent's result is saved into the thread as a user-role
// "[ASYNC DELEGATION BATCH COMPLETE …]" row that the agent only reads on the next turn. Hermes
// deliberately never wakes the model by itself for API sessions; the client owns the next turn.
//
// The Agent Service is that client. This watcher finds Wizard threads whose newest message is such a
// completion row, with no turn running, and starts one continuation run so the agent finishes the
// original request without the person having to say anything. Each completion row is followed up
// at most once (idempotency key = session + row id). Finding them goes over Hermes HTTP
// (hermes-http-readers.mjs createFollowThroughFinder); this file keeps only the watcher.

export const FOLLOW_THROUGH_PREFIX = '[ASYNC DELEGATION BATCH COMPLETE'
// Wizard app threads and phone-intake (Wizard Inbox) threads both show in Wizard, so both get the next turn.
export const FOLLOW_THROUGH_SESSION_PREFIXES = ['wizard_', 'wizard-assistant-']
export const FOLLOW_THROUGH_INPUT = '[Wizard follow-through] The delegated results above have arrived. Finish the original request now, in one self-contained reply.'

/**
 * Start the watcher. `find()` returns the pending threads ({ sessionId, messageId }).
 * `admit(sessionId, input, idempotencyKey)` submits one run through the service's normal admission
 * path. `enabled()` is checked every tick so it turns itself off on agents that join delegated work
 * inside the run.
 */
export function startDelegationFollowThrough({ find, admit, enabled, intervalMs = 5000, log = () => {} }) {
  const done = new Set()
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      if (!(await enabled())) return
      for (const pending of await find()) {
        const key = `wizard-follow-through-${pending.sessionId}-${pending.messageId}`
        if (done.has(key)) continue
        done.add(key)
        try {
          await admit(pending.sessionId, FOLLOW_THROUGH_INPUT, key)
          log(`follow-through started for ${pending.sessionId} (row ${pending.messageId})`)
        } catch (error) {
          done.delete(key)
          log(`follow-through failed for ${pending.sessionId}: ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      log(`follow-through scan failed: ${error?.message ?? error}`)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}
