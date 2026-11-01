import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableRunQueue,queueRequestHash} from '../server/run-queue.mjs';
for(const agent of ['', 'host-profile','container','restricted']) for(const automaticFirst of [false,true]) test(`${agent||'main'}: manual model escape ${automaticFirst?'loses safely to automatic recovery':'retains full input and files exactly once'}`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'provider-route-race-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let dispatch=false;
 const sent=[],options={statePath:join(root,'q.db'),agentId:agent||'hermes',pollIntervalMs:0,canDispatch:()=>dispatch,launch:async r=>{sent.push(r);return{upstreamRunId:r.publicRunId,payload:{status:'running'}}},lookup:async()=>({})};
 const q=new DurableRunQueue(options);t.after(()=>q.close());
 const input=[{role:'user',content:[{type:'text',text:'  Synthetic complete request\n'+'all original words '.repeat(100)},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}]}];
 const original={session_id:'wizard_synthetic',input,model:'original',provider:'anthropic',wizard_file_ids:['synthetic-image','synthetic-document'],require_model_lock:true};
 const body=JSON.stringify(original),trustedPaths=['/synthetic/image.png','/synthetic/document.pdf'];
 const source=(await q.admit({runtime:'direct',sessionId:original.session_id,idempotencyKey:'first',requestHash:queueRequestHash('direct',body),body,trustedPaths,agent_id:agent||'hermes'})).record;
 q._update(source.publicRunId,{status:'queued',waitingReason:'provider_access'});
 let retry;
 if(automaticFirst){
   retry=q._retrySavedRow(source.publicRunId,source.sessionId,{},true);
   await assert.rejects(q.retrySaved(source.publicRunId,source.sessionId,{model:'chosen',provider:'other-provider'}),e=>e.status===412||e.statusCode===412);
 }else{
   retry=await q.retrySaved(source.publicRunId,source.sessionId,{model:'chosen',provider:'other-provider'});
   const again=await q.retrySaved(source.publicRunId,source.sessionId,{model:'chosen',provider:'other-provider'});assert.equal(again.record.publicRunId,retry.record.publicRunId);assert.equal(again.replayed,true);
 }
 const child=q.get(retry.record.publicRunId),value=JSON.parse(child.body);
 assert.deepEqual(value.input,input);assert.deepEqual(value.wizard_file_ids,original.wizard_file_ids);assert.deepEqual(child.trustedPaths,trustedPaths);assert.equal(value.model,automaticFirst?'original':'chosen');assert.equal(value.provider,automaticFirst?'anthropic':'other-provider');assert.equal(value.require_model_lock,true);assert.equal(q.get(source.publicRunId).status,'cancelled');assert.equal(q.get(source.publicRunId).waitingReason,'');
 assert.equal(q.database.prepare('SELECT count(*) AS n FROM wizard_run_queue WHERE retry_source_id=?').get(source.publicRunId).n,1);assert.equal(sent.length,0);
 await assert.rejects(q.retrySaved(source.publicRunId,source.sessionId,{model:value.model,provider:'wrong-provider'}),e=>e.status===412||e.statusCode===412);
 dispatch=true;await q.tick(true);assert.equal(sent.length,1);assert.equal(sent[0].publicRunId,child.publicRunId);assert.deepEqual(JSON.parse(sent[0].body).input,input);assert.deepEqual(sent[0].trustedPaths,trustedPaths);
 await q.tick(true);assert.equal(sent.length,1);
 await q.close();const reopened=new DurableRunQueue(options);t.after(()=>reopened.close());await reopened.initialize();
 const same=await reopened.retrySaved(source.publicRunId,source.sessionId,{model:value.model,provider:value.provider});assert.equal(same.record.publicRunId,child.publicRunId);
 await assert.rejects(reopened.retrySaved(source.publicRunId,source.sessionId,{model:'not-the-admitted-model',provider:value.provider}),e=>e.status===412||e.statusCode===412);
});
