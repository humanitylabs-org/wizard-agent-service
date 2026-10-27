import { test } from 'vitest'
import assert from 'node:assert/strict'
import { fixture, withServer, sid } from './fixtures/helper-backend.mjs'
import { captureContinuation, continuationCurrent } from '../server/helper-continuation.mjs'
import { findPendingFollowThroughs, startDelegationFollowThrough } from '../server/delegation-follow-through.mjs'
import { RECEIPT_PREFIX, receiptConsumed, findIdleUndeliveredHelperReceipts } from '../server/delegation-receipts.mjs'
import { readHelperStatuses } from '../server/helper-status.mjs'
const final = state => `Verified outcome\n[WIZARD_STATUS_V1]{"state":"${state}","ask":"Verified result"}[/WIZARD_STATUS_V1]`
const status = path => readHelperStatuses(path,[sid]).get(sid)
const complete = ({message,sec}) => message('user','[ASYNC DELEGATION BATCH COMPLETE — deleg_review]\nSaved sanitized findings',sec-250)
const capture = path => captureContinuation(path,findPendingFollowThroughs(path)[0])

// Only a service witness captured before cleanup retains the original boundary.
for(const removeBeforeCapture of [true,false]) test(`receipt cleanup preserves captured authority only (before=${removeBeforeCapture})`,()=>fixture(async(ctx)=>{
 const {path,db}=ctx;complete(ctx)
 if(removeBeforeCapture)db.exec('DELETE FROM async_delegations')
 const token=capture(path)
 if(!removeBeforeCapture)db.exec('DELETE FROM async_delegations')
 assert.equal(continuationCurrent(path,token),!removeBeforeCapture)
 let calls=0;const watcher=startDelegationFollowThrough({sessionDbPath:path,intervalMs:60000,enabled:async()=>true,admit:async(s,input,key,t)=>{
  assert.equal(continuationCurrent(path,t),true);assert.equal(key,'wizard-helper-receipt-deleg_review');assert.match(input,/Saved sanitized findings/);calls++
 }})
 try{await watcher.tick();await watcher.tick();assert.equal(calls,0)}finally{watcher.stop()} // fresh captures lack original provenance
}))
for(const mutation of ['content','delegation','session','inactive','deleted'])test(`cleaned receipt rejects changed completion: ${mutation}`,()=>fixture(ctx=>{
 const {db,path}=ctx;const row=complete(ctx);const token=capture(path);db.exec('DELETE FROM async_delegations')
 if(mutation==='content')db.prepare("UPDATE messages SET content=content||' changed' WHERE id=?").run(row.lastInsertRowid)
 if(mutation==='delegation')db.prepare("UPDATE messages SET content='[ASYNC DELEGATION BATCH COMPLETE — deleg_other] findings' WHERE id=?").run(row.lastInsertRowid)
 if(mutation==='session')db.prepare("UPDATE messages SET session_id='wizard_other' WHERE id=?").run(row.lastInsertRowid)
 if(mutation==='inactive')db.prepare('UPDATE messages SET active=0 WHERE id=?').run(row.lastInsertRowid)
 if(mutation==='deleted')db.prepare('DELETE FROM messages WHERE id=?').run(row.lastInsertRowid)
 assert.equal(continuationCurrent(path,token),false)
}))
test('old queued token without captured receipt provenance fails closed',()=>fixture(({path,db})=>{
 const token=captureContinuation(path,findIdleUndeliveredHelperReceipts(path)[0]);delete token.receipt;db.exec('DELETE FROM async_delegations')
 assert.equal(continuationCurrent(path,token),false)
}))
for(const guard of ['owner','approval','lease','stale','duplicate','wrong-origin','running'])test(`completion fallback preserves ${guard} guard`,()=>fixture(ctx=>{
 const {path,db,message,sec}=ctx;complete(ctx);const token=capture(path)
 if(!['wrong-origin','running'].includes(guard))db.exec('DELETE FROM async_delegations')
 if(guard==='owner')message('user','Changed instructions',sec-100)
 if(guard==='approval'){message('assistant',final('needs_you'),sec-270);message('assistant',final('fyi'),sec-260)}
 if(guard==='lease')db.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run(sid,sec+100)
 if(guard==='duplicate')message('user',RECEIPT_PREFIX+'deleg_review\nSaved findings',sec-100)
 if(guard==='wrong-origin')db.exec("UPDATE async_delegations SET origin_session_id='wizard_other'")
 if(guard==='running')db.exec("UPDATE async_delegations SET state='running'")
 assert.equal(continuationCurrent(path,token,guard==='stale'?(sec+7201)*1000:Date.now()),false)
}))
test('request compaction preserves UID, timestamp and exact content, not physical row id',()=>fixture(({db,path,sec,message})=>{
 db.exec('ALTER TABLE messages ADD COLUMN message_uid TEXT; ALTER TABLE messages ADD COLUMN compacted INT DEFAULT 0;')
 db.exec("UPDATE messages SET message_uid='request-stable'")
 const token=captureContinuation(path,findIdleUndeliveredHelperReceipts(path)[0])
 db.exec('UPDATE messages SET active=0,compacted=1; INSERT INTO messages(session_id,role,content,timestamp,message_uid) SELECT session_id,role,content,timestamp,message_uid FROM messages WHERE id=1;')
 assert.equal(continuationCurrent(path,token),true)
 const row=message('user','Build only the approved backend; do not deploy',sec-2000)
 db.prepare("UPDATE messages SET message_uid='new-request' WHERE id=?").run(row.lastInsertRowid)
 assert.equal(continuationCurrent(path,token),false)
}))
for(const mutation of ['content','timestamp','active-original','missing-lineage','different-uid'])test(`request lineage rejects ${mutation}`,()=>fixture(({db,path})=>{
 db.exec('ALTER TABLE messages ADD COLUMN message_uid TEXT; ALTER TABLE messages ADD COLUMN compacted INT DEFAULT 0;');db.exec("UPDATE messages SET message_uid='request-stable'")
 const token=captureContinuation(path,findIdleUndeliveredHelperReceipts(path)[0])
 db.exec('INSERT INTO messages(session_id,role,content,timestamp,message_uid) SELECT session_id,role,content,timestamp,message_uid FROM messages WHERE id=1;')
 if(mutation!=='active-original')db.exec('UPDATE messages SET active=0,compacted=1 WHERE id=1')
 if(mutation==='missing-lineage')db.exec('DELETE FROM messages WHERE id=1')
 if(mutation==='content')db.exec("UPDATE messages SET content='Do not continue' WHERE id=2")
 if(mutation==='timestamp')db.exec('UPDATE messages SET timestamp=timestamp+1 WHERE id=2')
 if(mutation==='different-uid')db.exec("UPDATE messages SET message_uid='new-request' WHERE id=2")
 assert.equal(continuationCurrent(path,token),false)
}))
test('typed completion plus matching tool dispatch admits a machine follow-through after ledger cleanup',()=>fixture(async(ctx)=>{
 const {db,path,message,sec}=ctx
 message('tool',JSON.stringify({status:'dispatched',mode:'background',delegation_id:'deleg_review',count:1}),sec-1800)
 const row=complete(ctx)
 db.prepare("UPDATE messages SET display_kind='async_delegation_complete' WHERE id=?").run(row.lastInsertRowid)
 db.exec('DELETE FROM async_delegations')
 const token=capture(path)
 assert.equal(continuationCurrent(path,token),true)
 await withServer(path,async(server)=>{
  await new Promise(resolve=>setTimeout(resolve,5200)) // normal five-second watcher tick, not manual Continue
  assert.equal(server.launches,1)
  assert.equal(server.bodies[0].headers['idempotency-key'],'wizard-helper-receipt-deleg_review')
  assert.match(server.bodies[0].body.input,/^\[Wizard follow-through\] Recovered helper receipt deleg_review/u)
 },{followThrough:true,joinedDelegation:'off'})
}),10000)

// System-alerts shape: recovered result -> reviewed done -> unrelated automated FYI.
test('integrated recovered findings stay resolved after a later FYI',()=>fixture(({path,sec,message})=>{
 message('user',RECEIPT_PREFIX+'deleg_review\nSaved review findings',sec-250)
 message('assistant',final('done'),sec-200);message('assistant',final('fyi'),sec-50)
 assert.equal(status(path),undefined)
}))
test('delivery alone is not integration, and done before delivery is insufficient',()=>fixture(({path,sec,message})=>{
 message('assistant',final('done'),sec-270);message('user',RECEIPT_PREFIX+'deleg_review\nSaved review findings',sec-250)
 message('assistant',final('fyi'),sec-50)
 assert.equal(status(path)?.phase,'stalled');assert.equal(status(path)?.resumeEligible,false)
}))
// Voice-cost shape: a checkpoint write names a delegation while its result remains dropped.
test('checkpoint/tool prose mentioning an ID is not result consumption',()=>fixture(({db,path,sec,message})=>{
 const row=message('assistant','',sec-200)
 db.prepare('UPDATE messages SET tool_calls=? WHERE id=?').run(JSON.stringify([{function:{name:'write_file',arguments:JSON.stringify({path:'checkpoint.md',content:'Still awaiting deleg_review'})}}]),row.lastInsertRowid)
 message('tool','Checkpoint saved: waiting for deleg_review',sec-190)
 assert.equal(receiptConsumed(db,sid,'deleg_review',sec-300),false)
 assert.equal(status(path)?.resumeEligible,true);assert.equal(findIdleUndeliveredHelperReceipts(path).length,1)
}))
test('structured terminal result with actual summary is delivery; terminal metadata alone is not',()=>fixture(({db,path,sec,message})=>{
 message('tool',JSON.stringify({delegation_id:'deleg_review',status:'completed'}),sec-250)
 assert.equal(receiptConsumed(db,sid,'deleg_review',sec-300),false)
 message('tool',JSON.stringify({delegation_id:'deleg_review',status:'completed',results:[{status:'completed',summary:'Actual saved findings'}]}),sec-200)
 assert.equal(receiptConsumed(db,sid,'deleg_review',sec-300),true)
 message('assistant',final('done'),sec-150);message('assistant',final('fyi'),sec-100)
 assert.equal(status(path),undefined)
}))
test('real queued admission survives receipt cleanup and restart, then launches once',()=>fixture(async(ctx)=>{
 const {path,dir,db}=ctx;complete(ctx);let dispatch=false
 await withServer(path,async(server)=>{
  assert.equal((await server.post()).status,202);assert.equal(server.launches,0)
  db.exec('DELETE FROM async_delegations');dispatch=true;await server.restart()
  // Queue admission is asynchronous; its normal read API drives the dispatcher.
  const { DatabaseSync }=await import('node:sqlite');const q=new DatabaseSync(dir+'/queue.db')
  const row=q.prepare('SELECT * FROM wizard_run_queue').get();q.close()
  await fetch(`http://127.0.0.1:${server.server.address().port}/wizard/hermes/v1/runs/${row.public_run_id}`)
  assert.equal(server.launches,1);assert.equal(server.bodies[0].headers['idempotency-key'],'wizard-helper-receipt-deleg_review')
 },{runQueueStatePath:dir+'/queue.db',runQueuePollIntervalMs:0,activeSessionReader:async()=>[],dispatchHealthReader:()=>dispatch})
}))
