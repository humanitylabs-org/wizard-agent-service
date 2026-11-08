import { test } from 'vitest'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fixture, withServer, sid } from './fixtures/helper-backend.mjs'
import { captureContinuation, continuationCurrent } from '../server/helper-continuation.mjs'
import { findPendingFollowThroughs, startDelegationFollowThrough } from '../server/delegation-follow-through.mjs'
import { findIdleUndeliveredHelperReceipts } from '../server/delegation-receipts.mjs'
const deliver = c => c.message('user','[ASYNC DELEGATION BATCH COMPLETE — deleg_review]\nSaved sanitized findings',c.sec-250)

// The failing production ordering: admission precedes delivery and ledger cleanup.
for (const state of ['pending','dropped']) test(`persisted ${state} receipt survives late delivery, cleanup and service restart exactly once`,()=>fixture(async c=>{
 c.db.prepare('UPDATE async_delegations SET delivery_state=?').run(state)
 let dispatch=false,admissions=0,captured
 await withServer(c.path,async server=>{
  const watcher=startDelegationFollowThrough({sessionDbPath:c.path,intervalMs:60000,enabled:async()=>true,admit:async(s,input,key,token)=>{
   admissions++;captured=token
   assert.equal(key,'wizard-helper-receipt-deleg_review')
   assert.equal((await server.post()).status,202)
  }})
  try {
   await watcher.tick();assert.equal(admissions,1);assert.equal(server.launches,0)
   assert.equal(captured.completion,undefined);assert.equal(captured.receipt.completedAt,c.sec-300)
   const q=new DatabaseSync(c.dir+'/queue.db')
   try {
    const queued=q.prepare('SELECT * FROM wizard_run_queue').get()
    assert.deepEqual(JSON.parse(queued.continuation_json),captured)
    deliver(c);c.db.exec("UPDATE async_delegations SET delivery_state='delivered'")
    assert.equal(continuationCurrent(c.path,captured),true)
    c.db.exec('DELETE FROM async_delegations')
    assert.equal(continuationCurrent(c.path,captured),true)
    assert.equal(captureContinuation(c.path,findPendingFollowThroughs(c.path)[0]),null)
    dispatch=true;await server.restart()
    const response=await fetch(`http://127.0.0.1:${server.server.address().port}/wizard/hermes/v1/runs/${queued.public_run_id}`)
    assert.notEqual((await response.json()).status,'cancelled')
    await watcher.tick();await watcher.tick()
    assert.equal(admissions,1);assert.equal(server.launches,1)
    assert.equal(server.bodies[0].headers['idempotency-key'],queued.idempotency_key)
    assert.match(server.bodies[0].body.input,/Verified saved findings/)
    assert.equal((await server.post()).status,409) // no fresh authority or new replay key
   } finally { q.close() }
  } finally { watcher.stop() }
 },{runQueueStatePath:c.dir+'/queue.db',runQueuePollIntervalMs:0,activeSessionReader:async()=>[],dispatchHealthReader:()=>dispatch})
}))
for(const variant of ['three-hour-old','new-human']) test(`delivery after cleanup never renews ${variant} authority`,()=>fixture(async c=>{
 if(variant==='three-hour-old'){
  c.db.prepare('UPDATE messages SET timestamp=?').run(c.sec-30000)
  c.db.prepare('UPDATE async_delegations SET completed_at=?').run(c.sec-10800)
 } else c.message('user','Cancel prior work; explain billing instead',c.sec-275)
 deliver(c)
 assert.equal(continuationCurrent(c.path,captureContinuation(c.path,findPendingFollowThroughs(c.path)[0])),false)
 c.db.exec('DELETE FROM async_delegations')
 assert.equal(captureContinuation(c.path,findPendingFollowThroughs(c.path)[0]),null)
 let admissions=0
 const watcher=startDelegationFollowThrough({sessionDbPath:c.path,intervalMs:60000,enabled:async()=>true,admit:async()=>{admissions++}})
 try{await watcher.tick();assert.equal(admissions,0)}finally{watcher.stop()}
}))
for(const mutation of ['origin','completed-time','result','nonterminal']) test(`captured receipt rejects changed ${mutation}`,()=>fixture(c=>{
 const token=captureContinuation(c.path,findIdleUndeliveredHelperReceipts(c.path)[0])
 if(mutation==='origin')c.db.exec("UPDATE async_delegations SET origin_session_id='wizard_elsewhere'")
 if(mutation==='completed-time')c.db.exec('UPDATE async_delegations SET completed_at=completed_at+1')
 if(mutation==='result')c.db.exec(`UPDATE async_delegations SET result_json='{"results":[{"summary":"Different findings"}]}'`)
 if(mutation==='nonterminal')c.db.exec("UPDATE async_delegations SET state='running'")
 assert.equal(continuationCurrent(c.path,token),false)
}))
for(const mutation of ['new-human','expired','gate','duplicate','lease']) test(`pre-delivery cleanup retains ${mutation} fence`,()=>fixture(c=>{
 const token=captureContinuation(c.path,findIdleUndeliveredHelperReceipts(c.path)[0]);deliver(c);c.db.exec('DELETE FROM async_delegations')
 if(mutation==='new-human')c.message('user','Stop this task',c.sec-200)
 if(mutation==='gate')c.message('assistant','[WIZARD_STATUS_V1]{"state":"needs_you","ask":"Approve release"}[/WIZARD_STATUS_V1]',c.sec-200)
 if(mutation==='duplicate')c.message('user','[Wizard follow-through] Recovered helper receipt deleg_review\nSaved findings',c.sec-200)
 if(mutation==='lease')c.db.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run(sid,c.sec+100)
 assert.equal(continuationCurrent(c.path,token,mutation==='expired'?(c.sec+7201)*1000:Date.now()),false)
}))
