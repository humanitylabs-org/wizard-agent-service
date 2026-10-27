import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const failure = {status:'completed',output:'⚠️ Provider authentication failed: No Anthropic credentials found',usage:{input_tokens:0,output_tokens:0,total_tokens:0}}
const full = 'Synthetic saved request that never reached the AI. ' + 'retain every word '.repeat(60)

test('Retry resends a message that never reached the AI after a sign-in outage', async t => {
  const root=mkdtempSync(join(tmpdir(),'retry-sign-in-')); t.after(()=>rmSync(root,{recursive:true,force:true}))
  const state=join(root,'queue.sqlite3'), os=join(root,'os'); mkdirSync(os)
  const q=new DurableRunQueue({statePath:state,pollIntervalMs:0,launch:async()=>({upstreamRunId:'synthetic-failed',payload:failure}),lookup:async()=>({payload:failure})})
  const body=JSON.stringify({session_id:'wizard_synthetic_outage',input:full,model:'original-model',provider:'anthropic',require_model_lock:true})
  const source=(await q.admit({runtime:'direct',sessionId:'wizard_synthetic_outage',idempotencyKey:'synthetic-first',requestHash:queueRequestHash('direct',body),body})).record
  assert.equal(source.status,'failed'); await q.close()
  const calls=[]
  const server=createWizardServer({upstreamOrigin:'http://127.0.0.1:19876',fetchImpl:async(url,init={})=>{
    const path=new URL(url).pathname
    if(path.endsWith('/chat/stream')&&init.method==='POST') {const value=JSON.parse(String(init.body));calls.push(value);return new Response('event: run.started\ndata: '+JSON.stringify({run_id:'synthetic-retried',runtime:{model:'original-model',provider:'anthropic',model_lock:'accepted'}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}})}
    if(path==='/v1/capabilities') return Response.json({features:{}})
    if(path.endsWith('/messages')) return Response.json({data:[],has_more:false})
    return Response.json({id:'wizard_synthetic_outage',source:'wizard-mobile',message_count:0,model:'original-model',provider:'anthropic'})
  },hermesKey:'synthetic-key',requireAccess:false,agents:false,agentBridge:false,followThrough:false,joinedDelegation:'off',wizardOsHome:os,runQueueStatePath:state,runQueuePollIntervalMs:20,activeSessionReader:async()=>[],dispatchHealthReader:()=>true})
  t.after(()=>new Promise(r=>server.close(r)))
  const addr=await listen(server), base=`http://127.0.0.1:${addr.port}/wizard/hermes`
  const detail=await(await fetch(base+'/api/sessions/wizard_synthetic_outage?view=detail')).json()
  assert.equal(detail.wizard_retry_input,full.trim()); assert.equal(detail.status,'failed'); assert.equal(detail.wizard_retry_run_id,source.publicRunId)
  const retry=()=>fetch(base+'/v1/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({session_id:'wizard_synthetic_outage',input:'display text is not authoritative',wizard_retry_run_id:source.publicRunId,model:'original-model',provider:'anthropic',require_model_lock:true})})
  const responses=await Promise.all([retry(),retry()]); assert(responses.every(r=>r.status===202), await responses[0].clone().text())
  const receipts=await Promise.all(responses.map(r=>r.json())); assert.equal(receipts[0].run_id,receipts[1].run_id)
  for (let i=0;i<50&&!calls.length;i++) await new Promise(r=>setTimeout(r,20))
  assert.equal(calls.length,1, JSON.stringify(await (await fetch(base+'/v1/runs/'+receipts[0].run_id)).json())); assert.equal(calls[0].message,full); assert.equal(calls[0].model,'original-model'); assert.equal(calls[0].provider,'anthropic')
})

test('saved Retry preserves multimodal bytes, trusted paths and continuation authority; rejects cross-thread, empty, stopped and superseded sources',async t=>{
 const root=mkdtempSync(join(tmpdir(),'retry-custody-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let dispatch=false;const sent=[]
 const q=new DurableRunQueue({statePath:join(root,'q.db'),pollIntervalMs:0,canDispatch:()=>dispatch,launch:async r=>{sent.push(r);return{payload:{status:'running'},upstreamRunId:'synthetic'}},lookup:async()=>({payload:{status:'running'}})});t.after(()=>q.close())
 const input=[{role:'user',content:[{type:'text',text:full},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}]}]
 const body=JSON.stringify({session_id:'wizard_files',input,model:'m',provider:'p',require_model_lock:true})
 const source=(await q.admit({runtime:'direct',sessionId:'wizard_files',idempotencyKey:'first',requestHash:queueRequestHash('direct',body),body,trustedPaths:['/synthetic/retained/photo.png'],continuation:{kind:'heavy',session_id:'wizard_files',token:'synthetic'}})).record
 q._update(source.publicRunId,{status:'failed',payload:{status:'failed'}})
 await assert.rejects(q.retrySaved(source.publicRunId,'another-thread'),/not found/)
 dispatch=true;const results=await Promise.all([q.retrySaved(source.publicRunId,'wizard_files'),q.retrySaved(source.publicRunId,'wizard_files')])
 assert.equal(results[0].record.publicRunId,results[1].record.publicRunId);assert.equal(sent.length,1)
 assert.deepEqual(JSON.parse(sent[0].body).input,input);assert.deepEqual(sent[0].trustedPaths,['/synthetic/retained/photo.png']);assert.deepEqual(sent[0].continuation,source.continuation)
 q._update(results[0].record.publicRunId,{status:'failed',payload:{status:'failed'}});q.markOwnerStop(results[0].record.publicRunId)
 await assert.rejects(q.retrySaved(results[0].record.publicRunId,'wizard_files'),/no longer current/)
})
