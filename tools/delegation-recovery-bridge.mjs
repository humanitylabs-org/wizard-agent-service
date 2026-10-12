// Temporary no-restart bridge for the reviewed receipt recovery module.
// Uses the existing Agent Service admission boundary; no Hermes DB writes or gateway restart.
import { startDelegationFollowThrough } from '../server/delegation-follow-through.mjs'
const origin = process.env.WIZARD_RECOVERY_ORIGIN || 'http://127.0.0.1:8923'
const path = process.env.WIZARD_RECOVERY_STATE_DB
const allowedSessions = new Set((process.env.WIZARD_RECOVERY_SESSION_IDS || '').split(',').filter(Boolean))
if (!path || !allowedSessions.size || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Explicit local origin, state DB and session allowlist required')
const watcher = startDelegationFollowThrough({sessionDbPath:path,enabled:async()=>true,
 allowSession:sessionId=>allowedSessions.has(sessionId),
 admit:async(sessionId,input,key)=>{
   const list = await fetch(`${origin}/wizard/hermes/api/sessions?limit=200`,{signal:AbortSignal.timeout(20000)})
   if(!list.ok) throw new Error(`session preflight ${list.status}`)
   const s = (await list.json()).data?.find(row=>row.id===sessionId)
   if(!s) throw new Error('session not in verified live projection')
   if(['queued','running','waiting_for_approval'].includes(s.status) && s.wizard_run_id) throw new Error('parent owns a live run; wait')
   const response=await fetch(`${origin}/wizard/hermes/v1/runs`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,'X-Wizard-Internal':'follow-through'},body:JSON.stringify({session_id:sessionId,input}),signal:AbortSignal.timeout(20000)})
   const result=await response.json()
   if(!response.ok) throw new Error(`admission ${response.status}`)
   const id=result.run_id||result.id
   if(!id) throw new Error('missing durable run identity')
   const verify=await fetch(`${origin}/wizard/hermes/v1/runs/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(20000)})
   if(!verify.ok) throw new Error(`run readback ${verify.status}`)
   console.log(JSON.stringify({event:'receipt_admitted',sessionId,key,runId:id,run:await verify.json()}))
 },log:line=>console.log(line)})
await watcher.tick()
for(const sig of ['SIGTERM','SIGINT']) process.on(sig,()=>{watcher.stop();process.exit(0)})
// The shared watcher unrefs its timer in the embedded service; this bridge owns one process.
setInterval(()=>{},60000)
