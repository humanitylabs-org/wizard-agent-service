import { readHelperStatuses } from './helper-status.mjs'
import { findPendingFollowThroughs } from './delegation-follow-through.mjs'
import { findIdleUndeliveredHelperReceipts } from './delegation-receipts.mjs'
import { captureContinuation, continuationCurrent } from './helper-continuation.mjs'
// Use exactly the automatic watcher's request and idempotency identity. Never create a new user ask.
export async function resumeHelper({ sessionDbPath, sessionId, admit, now=Date.now() }) {
  const status=readHelperStatuses(sessionDbPath,[sessionId],{now}).get(sessionId)
  if(!status?.resumeEligible) return {status:409,body:{error:'helper_not_resumable'}}
  const candidates=[...findPendingFollowThroughs(sessionDbPath,{now}),...findIdleUndeliveredHelperReceipts(sessionDbPath,{now})]
  const pending=candidates.find(r=>r.sessionId===sessionId)
  if(!pending) return {status:409,body:{error:'helper_not_resumable'}}
  const key=pending.key??`wizard-follow-through-${pending.sessionId}-${pending.messageId}`
  const token=captureContinuation(sessionDbPath,pending)
  if(!continuationCurrent(sessionDbPath,token,now)) return {status:409,body:{error:'helper_not_resumable'}}
  try {
    await admit(sessionId,pending.input??'[Wizard follow-through] The delegated results above have arrived. Finish the original request now, in one self-contained reply.',key,token)
  } catch(error) {
    if(error?.status===410) return {status:409,body:{error:'helper_not_resumable'}}
    throw error
  }
  return {status:202,body:{ok:true,state:'queued'}}
}
