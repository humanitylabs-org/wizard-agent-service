import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { fixture, withServer, sid } from './fixtures/helper-backend.mjs'
import { readHelperStatuses } from '../server/helper-status.mjs'
import { helperDelegationQuery, assignedHelperCount } from '../server/helper-source.mjs'
import { captureContinuation, continuationCurrent, requireCurrentContinuation } from '../server/helper-continuation.mjs'
import { startDelegationFollowThrough, findPendingFollowThroughs } from '../server/delegation-follow-through.mjs'
import { findIdleUndeliveredHelperReceipts } from '../server/delegation-receipts.mjs'
import { resumeHelper } from '../server/helper-resume.mjs'
const status=path=>readHelperStatuses(path,[sid]).get(sid)

for(const kind of ['commentary','tool'])test(`bounded message evidence stays uncertain and never admits recovery (${kind})`,()=>fixture(async({path,db,sec,message})=>{
 if(kind==='commentary')message('assistant','[WIZARD_STATUS_V1]{"state":"needs_you","ask":"Approve the owner-only release"}[/WIZARD_STATUS_V1]',sec-600)
 const add=db.prepare('INSERT INTO messages(session_id,role,content,timestamp,display_kind)VALUES(?,?,?,?,?)')
 db.exec('BEGIN');for(let i=0;i<600;i++)add.run(sid,kind==='tool'?'tool':'assistant','Internal progress only',sec-200,kind==='tool'?null:'commentary');db.exec('COMMIT')
 assert.equal(status(path).phase,'uncertain');assert.equal(status(path).returned,1);assert.equal(status(path).resumeEligible,false)
 assert.equal((await resumeHelper({sessionDbPath:path,sessionId:sid,admit:()=>assert.fail()})).status,409)
}))

test('two authenticated Continue requests during one capability wait make exactly one upstream admission',()=>fixture(async({path})=>{
 let entered,release,secondVerified,verified=0
 const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),second=new Promise(r=>secondVerified=r)
 await withServer(path,async(ctx)=>{
  const headers={'cf-access-jwt-assertion':'fixture-approved'}
  const a=ctx.post(headers);await ready
  const b=ctx.post(headers);await second;release()
  const results=await Promise.all([a,b]);assert.deepEqual(results.map(r=>r.status),[202,202]);assert.equal(ctx.launches,1)
 },{requireAccess:true,accessVerifier:async assertion=>{assert.equal(assertion,'fixture-approved');verified++;if(verified===2)secondVerified();return {sub:'fixture-user'}},capability:async()=>{entered();await gate}})
}))

test('same-origin JSON is admitted; missing JSON and forged forwarded host never confer authority',()=>fixture(async({path})=>withServer(path,async(ctx)=>{
 const origin=`http://127.0.0.1:${ctx.server.address().port}`
 assert.equal((await ctx.post({'content-type':'text/plain'})).status,415)
 assert.equal((await ctx.post({origin:'https://untrusted.example','x-forwarded-host':'untrusted.example','sec-fetch-site':'same-origin'})).status,403)
 assert.equal((await ctx.post({origin,'sec-fetch-site':'same-origin'})).status,202)
 assert.equal(ctx.launches,1)
 assert.ok(ctx.bodies[0].body.instructions.includes('final reply'))
 assert.equal(ctx.bodies[0].body.delegation_delivery,undefined)
})))
for(const indexes of [[1,1,-1,3,'2',1.5],[],[99]])test(`validated grouped subset ${JSON.stringify(indexes)}`,()=>fixture(({path,db})=>{
 db.prepare('UPDATE async_delegations SET task_json=?').run(JSON.stringify({goals:['A','B','C'],task_indexes:indexes}))
 assert.equal(status(path)?.returned,indexes.length===6?1:0)
}))
test('legacy and malformed task metadata have a conservative fallback',()=>{
 assert.equal(assignedHelperCount({task_json:JSON.stringify({goals:['A','B','C']})}),3)
 for(const task_json of ['{','{}',null])assert.equal(assignedHelperCount({task_json}),1)
})
for(const at of [0,-1000])test(`generation invalidates newly inserted same/backdated user request (${at})`,()=>fixture(({path,message})=>{
 const token=captureContinuation(path,findIdleUndeliveredHelperReceipts(path)[0])
 assert.ok(continuationCurrent(path,token));message('user','New request even if its timestamp is not monotone',token.request.at+at)
 assert.equal(continuationCurrent(path,token),false)
}))
test('internal and hidden user-role messages do not advance the owner request generation',()=>fixture(({path,message,db})=>{
 const token=captureContinuation(path,findIdleUndeliveredHelperReceipts(path)[0])
 message('user','[Wizard follow-through] Internal delivery',Date.now()/1000)
 const row=message('user','Hidden metadata',Date.now()/1000)
 db.prepare("UPDATE messages SET display_kind='hidden' WHERE id=?").run(row.lastInsertRowid)
 assert.ok(continuationCurrent(path,token))
}))
test('manual and automatic watcher share token/key; watcher rechecks after async wait',()=>fixture(async({path,sec,message})=>{
 const manual=[];await resumeHelper({sessionDbPath:path,sessionId:sid,admit:async(...args)=>manual.push(args)})
 message('user','[ASYNC DELEGATION BATCH COMPLETE — deleg_review] ordinary delivery',sec-250)
 const ordinary=findPendingFollowThroughs(path)[0]
 assert.equal(ordinary.key,manual[0][2]);assert.equal(ordinary.input,manual[0][1])
 let entered,release;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let launch=0
 const watcher=startDelegationFollowThrough({sessionDbPath:path,intervalMs:60000,enabled:async()=>true,admit:async(s,input,key,token)=>{
  assert.deepEqual(token.request,manual[0][3].request);assert.equal(token.delegationId,manual[0][3].delegationId);assert.ok(token.completion);entered();await gate;requireCurrentContinuation(path,token);launch++
 }})
 try{const tick=watcher.tick();await ready;message('user','The owner moved on',Date.now()/1000);release();await tick;await watcher.tick();assert.equal(launch,0)}finally{watcher.stop()}
}))
for(const restart of [false,true])test(`queued helper with newer owner request never launches (restart=${restart})`,()=>fixture(async({path,dir,message})=>{
 let dispatch=false;const queue=join(dir,'queue.db')
 await withServer(path,async(ctx)=>{
  assert.equal((await ctx.post()).status,202);assert.equal(ctx.launches,0)
  const q=new DatabaseSync(queue),row=q.prepare('SELECT * FROM wizard_run_queue').get();q.close()
  assert.equal(JSON.parse(row.continuation_json).request.id,1);assert.equal((await ctx.post()).status,409)
  message('user','Moved on after admission; no stale receipt may launch',Date.now()/1000);dispatch=true
  if(restart)await ctx.restart()
  const r=await fetch(`http://127.0.0.1:${ctx.server.address().port}/wizard/hermes/v1/runs/${row.public_run_id}`)
  assert.equal(r.status,200);assert.equal((await r.json()).status,'cancelled');assert.equal(ctx.launches,0)
  const after=new DatabaseSync(queue);assert.equal(after.prepare('SELECT COUNT(*) AS n FROM wizard_run_queue').get().n,1);after.close()
 },{runQueueStatePath:queue,runQueuePollIntervalMs:0,activeSessionReader:async()=>[],dispatchHealthReader:()=>dispatch})
}))
test('restart launch revalidates generation after its capability await, not only queue admission',()=>fixture(async({path,dir,message})=>{
 let dispatch=false,checks=0,entered,release
 const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),queue=join(dir,'queue.db')
 await withServer(path,async(ctx)=>{
  assert.equal((await ctx.post()).status,202)
  const q=new DatabaseSync(queue),row=q.prepare('SELECT * FROM wizard_run_queue').get();q.close()
  dispatch=true;await ctx.restart();await ready
  message('user','New request during queued launch await',Date.now()/1000);release()
  const r=await fetch(`http://127.0.0.1:${ctx.server.address().port}/wizard/hermes/v1/runs/${row.public_run_id}`)
  assert.equal((await r.json()).status,'cancelled');assert.equal(ctx.launches,0)
 },{runQueueStatePath:queue,runQueuePollIntervalMs:0,activeSessionReader:async()=>[],dispatchHealthReader:()=>dispatch,capability:async()=>{checks++;if(checks===2){entered();await gate}}})
}))
test('unchanged queued request survives restart, launches once, and preserves public identity',()=>fixture(async({path,dir})=>{
 let dispatch=false;const queue=join(dir,'queue.db')
 await withServer(path,async(ctx)=>{
  assert.equal((await ctx.post()).status,202)
  const q=new DatabaseSync(queue),before=q.prepare('SELECT * FROM wizard_run_queue').get();q.close()
  dispatch=true;await ctx.restart()
  const r=await fetch(`http://127.0.0.1:${ctx.server.address().port}/wizard/hermes/v1/runs/${before.public_run_id}`)
  assert.equal((await r.json()).run_id,before.public_run_id);assert.equal(ctx.launches,1)
  assert.equal(ctx.bodies[0].headers['idempotency-key'],before.idempotency_key)
  assert.equal((await ctx.post()).status,202);assert.equal(ctx.launches,1)
  const after=new DatabaseSync(queue);assert.equal(after.prepare('SELECT COUNT(*) AS n FROM wizard_run_queue').get().n,1);after.close()
 },{runQueueStatePath:queue,runQueuePollIntervalMs:0,activeSessionReader:async()=>[],dispatchHealthReader:()=>dispatch})
}))
test('pre-repair queued helper without persisted generation fails closed on restart',()=>fixture(async({path,dir})=>{
 let dispatch=false;const queue=join(dir,'queue.db')
 await withServer(path,async(ctx)=>{
  assert.equal((await ctx.post()).status,202)
  const q=new DatabaseSync(queue),row=q.prepare('SELECT * FROM wizard_run_queue').get();q.exec("UPDATE wizard_run_queue SET continuation_json='null'");q.close()
  dispatch=true;await ctx.restart()
  const r=await fetch(`http://127.0.0.1:${ctx.server.address().port}/wizard/hermes/v1/runs/${row.public_run_id}`)
  assert.ok(['cancelled','failed'].includes((await r.json()).status));assert.equal(ctx.launches,0)
 },{runQueueStatePath:queue,runQueuePollIntervalMs:0,activeSessionReader:async()=>[],dispatchHealthReader:()=>dispatch})
}))
test('2h recovery / 6h completed visibility hold, even for fresh markers over stale receipts',()=>fixture(async({path,db,sec,message})=>{
 db.prepare('UPDATE messages SET timestamp=?').run(sec-30000)
 db.prepare('UPDATE async_delegations SET completed_at=?').run(sec-3*3600)
 assert.equal(status(path).phase,'uncertain');assert.equal(status(path).resumeEligible,false)
 message('user','[ASYNC DELEGATION BATCH COMPLETE — deleg_review] late delivery',sec-1)
 assert.equal((await resumeHelper({sessionDbPath:path,sessionId:sid,admit:()=>assert.fail()})).status,409)
 db.prepare('UPDATE async_delegations SET completed_at=?').run(sec-7*3600);assert.equal(status(path),undefined)
}))
test('source-index fixture: 100k archival delegations + 100k historical messages avoid list-history scans',()=>fixture(({path,db,sec})=>{
 const historical='x'.repeat(1024),add=db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)'),message=db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)')
 db.exec('BEGIN')
 for(let i=0;i<100000;i++) {
  add.run(`deleg_archive_${i}`,i%2?sid:'wizard_other',null,'','completed',sec-100000,sec-90000,'{}','delivered',historical)
  message.run(sid,'assistant',historical,sec-90000-i)
 }
 db.exec('COMMIT');db.prepare("UPDATE async_delegations SET delivery_state='future-delivery-state' WHERE delegation_id='deleg_review'").run()
 const query=helperDelegationQuery(db,[sid,'wizard_other'],sec),plan=db.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.params).map(r=>r.detail)
 assert.ok(plan.some(line=>line.includes('idx_async_delegations_delivery')));assert.ok(!plan.some(line=>/SCAN async_delegations/u.test(line)))
 const start=performance.now(),result=readHelperStatuses(path,[sid,'wizard_other']),durationMs=performance.now()-start
 assert.equal(result.get(sid).returned,1);assert.equal(result.get(sid).phase,'stalled');assert.equal(result.size,1)
 assert.ok(durationMs<1000,`Indexed projection took ${durationMs}ms`)
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM async_delegations').get().n,100001)
 console.log('HELPER_SOURCE_INDEX_RECEIPT '+JSON.stringify({archivalDelegations:100000,historicalMessages:100000,listedSessions:2,returnedRows:result.size,durationMs,plan}))
}),15000)

test('no-Access Host=Origin DNS rebinding and wrong-scheme origins are refused',()=>fixture(async({path})=>withServer(path,async(ctx)=>{
 const port=ctx.server.address().port
 assert.equal((await ctx.postRaw({host:`attacker.example:${port}`,origin:`http://attacker.example:${port}`,'sec-fetch-site':'same-origin'})).status,403)
 assert.equal((await ctx.post({origin:`https://127.0.0.1:${port}`,'sec-fetch-site':'same-origin'})).status,403)
 assert.equal(ctx.launches,0)
})))
test('explicit trusted public origin enables no-Access proxy hosting, but not forwarded-header spoofing',()=>fixture(async({path})=>withServer(path,async(ctx)=>{
 assert.equal((await ctx.postRaw({host:'approved.example',origin:'https://approved.example','sec-fetch-site':'same-origin'})).status,202)
 assert.equal(ctx.launches,1)
},{helperContinueOrigins:['https://approved.example']})))
test('an owner lease acquired after queue admission waits instead of permanently cancelling its receipt',()=>fixture(async({path,dir,db,sec})=>{
 let dispatch=false;const queue=join(dir,'queue.db')
 await withServer(path,async(ctx)=>{
  assert.equal((await ctx.post()).status,202)
  const q=new DatabaseSync(queue),row=q.prepare('SELECT * FROM wizard_run_queue').get();q.close()
  db.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run(sid,sec+120);dispatch=true
  let r=await fetch(`http://127.0.0.1:${ctx.server.address().port}/wizard/hermes/v1/runs/${row.public_run_id}`)
  assert.equal((await r.json()).status,'queued');assert.equal(ctx.launches,0)
  db.exec('DELETE FROM session_turn_leases')
  const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+3000)
  try {
   r=await fetch(`http://127.0.0.1:${ctx.server.address().port}/wizard/hermes/v1/runs/${row.public_run_id}`)
   assert.equal(r.status,200);assert.equal(ctx.launches,1)
  } finally { clock.mockRestore() }
 },{runQueueStatePath:queue,runQueuePollIntervalMs:0,runQueueRetryDelayMs:0,activeSessionReader:async()=>[],dispatchHealthReader:()=>dispatch})
}))
for(const text of ['Example [WIZARD_STATUS_V1]{"state":"done","ask":"Example only"}[/WIZARD_STATUS_V1] followed by more progress','[WIZARD_STATUS_V1]{"state":"done","ask":"Genuine result"}[/WIZARD_STATUS_V1]']) test(`completion requires a terminal parsed final, not an inline example: ${text}`,()=>fixture(({path,sec,message})=>{
 message('user','[ASYNC DELEGATION BATCH COMPLETE — deleg_review] findings',sec-250);message('assistant',text,sec-200)
 assert.equal(status(path)?.phase,text.endsWith('followed by more progress')?'stalled':undefined)
}))
test('bounded-source overflow suppresses incomplete counts and manual authority, rather than inventing zero/exact totals',()=>fixture(async({path,db,sec})=>{
 const add=db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)')
 db.exec('BEGIN');for(let i=0;i<513;i++)add.run(`deleg_extra_${i}`,sid,null,'','completed',sec-1000,sec-300,'{}','pending','{}');db.exec('COMMIT')
 assert.equal(status(path),undefined)
 assert.equal((await resumeHelper({sessionDbPath:path,sessionId:sid,admit:()=>assert.fail()})).status,409)
}))
