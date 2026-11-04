import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs';
import { createRoutedQueues } from '../server/routed-run-queue.mjs';
const failed = { status: 'completed', output: '⚠️ Provider authentication failed: synthetic expired sign-in', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
test('automatic sign-in recovery drops superseded owner requests and never lets empty input poison the queue', async t => {
 const root=mkdtempSync(join(tmpdir(),'recovery-current-')); t.after(()=>rmSync(root,{recursive:true,force:true})); const sent=[]; let recovered=false;
 const q=new DurableRunQueue({statePath:join(root,'q.db'),pollIntervalMs:0,providerAccessRecovery:true,launch:async r=>{sent.push(r);return {upstreamRunId:r.publicRunId,payload:recovered?{status:'completed',output:'synthetic answer'}:failed}},lookup:async()=>({payload:failed})});t.after(()=>q.close());
 const admit=async(input,sessionId)=>{const body=JSON.stringify({session_id:sessionId,input,provider:'synthetic',model:'original'});return(await q.admit({runtime:'direct',sessionId,idempotencyKey:crypto.randomUUID(),requestHash:queueRequestHash('direct',body),body})).record};
 const old=await admit('superseded words','wizard_same'),current=await admit('current words','wizard_same');
 const empty=await admit('','wizard_empty');assert.equal(empty.status,'failed');assert.equal(empty.waitingReason,'');
 recovered=true;await admit('health confirmation','wizard_health');await q.tick(true);await q.tick(true);
 assert(!sent.some(r=>r.retrySourceId===old.publicRunId));assert.equal(sent.filter(r=>r.retrySourceId===current.publicRunId).length,1);
 assert(!sent.some(r=>r.retrySourceId===empty.publicRunId));assert.equal(q.get(old.publicRunId).status,'cancelled');
 const next=await admit('unrelated owner message','wizard_unrelated');assert.equal(next.status,'completed');
});
for(const kind of ['host-profile','container','restricted'])test(`${kind}: scoped queues share opt-in sign-in waiting and exactly-once recovery`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'routed-access-'));const disposers=[];t.after(async()=>{for(const f of disposers)await f();rmSync(root,{recursive:true,force:true})});
 const agent={id:'fixture-agent',runtime:{kind},model:{model:'original',provider:'display-only'}};let recovered=false;const sent=[];
 const registry={agentsDir:root,list:()=>[],apiKey:()=> 'synthetic-key',fetchAgent:async(target,path,init={})=>{
  assert.equal(target.id,agent.id);
  if(path==='/v1/runs'&&init.method==='POST'){const body=JSON.parse(init.body);sent.push(body);assert.equal(body.provider,undefined);return Response.json({run_id:'upstream-'+sent.length,...(recovered?{status:'completed',output:'Synthetic answer'}:failed)})}
  if(path.startsWith('/api/sessions/'))return Response.json({error:'not_found'},{status:404});
  return Response.json({status:'completed',output:'Synthetic answer'});
 }};
 const queues=createRoutedQueues({registry,own:f=>disposers.push(f),pollIntervalMs:0,providerAccessRecovery:true});
 const send=(session_id,input)=>queues.fetch(agent,'/v1/runs',{method:'POST',body:JSON.stringify({session_id,input,model:'original'})});
 const receipt=await(await send('wizard_first','saved owner words')).json();
 const detail=await(await queues.fetch(agent,'/api/sessions/wizard_first?view=detail')).json();assert.equal(detail.queue_reason,'provider_access');assert.equal(detail.status,'queued');
 recovered=true;await send('wizard_health','health confirmation');await queues.fetch(agent,'/v1/runs/'+receipt.run_id);await queues.fetch(agent,'/v1/runs/'+receipt.run_id);
 assert.equal(sent.filter(x=>x.session_id==='wizard_first').length,2);assert.equal(sent.at(-1).input,'saved owner words');
});
