import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DurableRunQueue,queueRequestHash} from '../server/run-queue.mjs'
const failed=()=>({status:'completed',output:'⚠️ Provider authentication failed: synthetic sign-in expired',usage:{input_tokens:0,output_tokens:0,total_tokens:0}})
function fixture(t,extra={}) {
 const root=mkdtempSync(join(tmpdir(),'provider-access-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const state={recovered:false,sent:[],healthy:true,override:null}
 const options={statePath:join(root,'q.db'),pollIntervalMs:0,providerAccessRecovery:true,maxActive:2,canDispatch:()=>state.healthy,launch:async r=>{
   state.sent.push(r); const value=JSON.parse(r.body)
   return{upstreamRunId:'synthetic-'+r.publicRunId,payload:state.override?state.override(r):state.recovered||value.input==='provider health confirmation'?{status:'completed',output:'Synthetic answer',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}:failed()}
 },lookup:async()=>({payload:failed()}),...extra}
 const q=new DurableRunQueue(options);t.after(()=>q.close())
 const admit=async(input,session='wizard_'+input.replaceAll(' ','_'),provider='anthropic',continuation=null)=>{
   const body=JSON.stringify({session_id:session,input,model:'original-model',provider,require_model_lock:true})
   return(await q.admit({runtime:'direct',sessionId:session,idempotencyKey:crypto.randomUUID(),requestHash:queueRequestHash('direct',body),body,trustedPaths:['/synthetic/original.txt'],continuation})).record
 }
 return{q,state,admit,options}
}
test('Provider auth failure waits without blind resend; a successful run wakes saved requests once in original order',async t=>{
 const {q,state,admit}=fixture(t)
 const first=await admit('first'),second=await admit('second')
 assert.equal(first.waitingReason,'provider_access');assert.equal(first.status,'queued');assert(first.providerWaitDeadline>first.createdAt)
 state.healthy=false;await q.tick(true);assert.equal(q.get(first.publicRunId).waitingReason,'provider_access');state.healthy=true
 await q.tick(true);await q.tick(true);assert.equal(state.sent.length,2)
 await admit('provider health confirmation','wizard_health','other-provider');await q.tick(true);assert.equal(state.sent.length,3,'another provider does not unblock this sign-in')
 state.recovered=true;await admit('provider health confirmation','wizard_health_anthropic');await q.tick(true);await q.tick(true)
 assert.deepEqual(state.sent.filter(r=>r.retrySourceId).map(r=>JSON.parse(r.body).input),['first','second'])
 for(const source of [first,second]) {const children=state.sent.filter(r=>r.retrySourceId===source.publicRunId);assert.equal(children.length,1);assert(children[0].providerRecoveryAttempted);assert.equal(children[0].continuation,source.continuation);assert.deepEqual(children[0].trustedPaths,source.trustedPaths);assert.equal(JSON.parse(children[0].body).model,'original-model');assert.equal(q.get(source.publicRunId).status,'cancelled')}
 await q.tick(true);assert.equal(state.sent.length,6)
})
test('Recovered helper and owner messages keep source FIFO despite the normal interactive-first sort',async t=>{
 const {q,admit,state}=fixture(t,{maxActive:4,reservedInteractive:2})
 const helper=await admit('older helper delivery','wizard_older_helper','anthropic',{kind:'helper',type:'helper-follow-through',helper_id:'synthetic'})
 const owner=await admit('newer owner request','wizard_newer_owner')
 await admit('provider health confirmation');await q.tick(true)
 assert.deepEqual(state.sent.filter(r=>r.retrySourceId).map(r=>r.retrySourceId),[helper.publicRunId,owner.publicRunId])
})

test('An acknowledged run that fails later at auth preflight waits, then notices provider success on status refresh',async t=>{
 const {q,admit}=fixture(t,{launch:async r=>({upstreamRunId:r.publicRunId,payload:{status:'running'}}),
   lookup:async r=>({payload:JSON.parse(r.body).input==='provider health confirmation'||r.retrySourceId?{status:'completed',output:'Synthetic answer'}:failed()})})
 const source=await admit('first request');assert.equal(source.status,'running');await q.tick(true)
 assert.equal(q.get(source.publicRunId).waitingReason,'provider_access')
 await admit('provider health confirmation');await q.tick(true)
 const child=q.byIdempotencyKey('direct','wizard-saved-retry-'+source.publicRunId)
 assert(child);assert.equal(child.status,'running');await q.tick(true);assert.equal(q.get(child.publicRunId).status,'completed')
})

test('Concurrent manual Retry and automatic recovery share one durable admission, including after restart',async t=>{
 const {q,state,admit,options}=fixture(t)
 const source=await admit('owner words');state.recovered=true;await admit('provider health confirmation')
 const [,manual]=await Promise.all([q.tick(true),q.retrySaved(source.publicRunId,source.sessionId)])
 await q.tick(true);assert.equal(state.sent.filter(r=>r.retrySourceId===source.publicRunId).length,1)
 const id=manual.record.publicRunId;await q.close()
 const reopened=new DurableRunQueue(options);t.after(()=>reopened.close());await reopened.initialize()
 const replay=await reopened.retrySaved(source.publicRunId,source.sessionId);assert.equal(replay.record.publicRunId,id);assert.equal(replay.replayed,true)
})
test('Expired waiting window returns saved failed+Retry without sending; owner stops and content failures never automatically resend',async t=>{
 const {q,state,admit}=fixture(t)
 const source=await admit('deadline');q._update(source.publicRunId,{providerWaitDeadline:Date.now()/1000-1})
 await q.tick(true);assert.equal(q.get(source.publicRunId).status,'failed');assert.match(q.get(source.publicRunId).payload.safe_error,/Tap Retry/);assert.equal(state.sent.length,1)
 const stopped=await admit('stopped');q.markOwnerStop(stopped.publicRunId);await q.tick(true);assert.equal(q.get(stopped.publicRunId).status,'cancelled')
 state.override=()=>({status:'failed',error:{type:'invalid_content'},output:'synthetic content error'})
 const content=await admit('content');assert.equal(content.status,'failed');assert.equal(content.waitingReason,'')
 state.recovered=true;state.override=null;await admit('provider health confirmation');await q.tick(true)
 assert(!state.sent.some(r=>[source.publicRunId,stopped.publicRunId,content.publicRunId].includes(r.retrySourceId)))
})
test('Automatic retry is bounded to one attempt; helper and heavy completion deliveries retain authority and bytes',async t=>{
 const {q,state,admit}=fixture(t)
 const helper={kind:'helper',session_id:'wizard_helper',token:'synthetic-helper-authority'}
 const heavy={kind:'external-heavy',session_id:'wizard_heavy',job_id:'synthetic-heavy-job'}
 const a=await admit('helper follow-through','wizard_helper','anthropic',helper),b=await admit('heavy completion','wizard_heavy','anthropic',heavy)
 await admit('provider health confirmation'); // this run succeeds, but synthetic credentials fail again on the retry
 await q.tick(true);await q.tick(true)
 for(const source of [a,b]) {const child=q.byIdempotencyKey('direct','wizard-saved-retry-'+source.publicRunId);assert(child);assert.equal(child.status,'failed');assert.equal(child.waitingReason,'');assert.equal(child.providerRecoveryAttempted,true);assert.deepEqual(child.continuation,source.continuation);assert.equal(child.body,source.body)}
 const count=state.sent.length;await q.tick(true);assert.equal(state.sent.length,count)
})
