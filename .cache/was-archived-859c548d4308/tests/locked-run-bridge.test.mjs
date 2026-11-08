import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LockedRunBridge, runtimeMatches, sessionMessage } from '../server/locked-run-bridge.mjs'
const route = { model:'glm-5-3', provider:'custom:tinfoil-operator' }
const start = body => ({method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':'synthetic-key'},body:JSON.stringify(body)})
const payload = {session_id:'wizard_synthetic', input:'synthetic text', ...route, require_model_lock:true}
const frame = (name,p)=>`event: ${name}\ndata: ${JSON.stringify(p)}\n\n`
const ack = {model:'',provider:'',requested:route,model_lock:'accepted'}
function stream(text) { return new Response(text,{headers:{'Content-Type':'text/event-stream'}}) }

test('native lock endpoint, not unguarded v1/runs, creates a controllable native run',async()=>{
 const calls=[];const bridge=new LockedRunBridge({origin:'http://127.0.0.1:8865',fetchImpl:async(url,init)=>{
  calls.push({url,body:JSON.parse(init.body),signal:init.signal});
  return stream(frame('run.started',{run_id:'run_synthetic',runtime:ack})+frame('run.completed',{runtime:{model:route.model,provider:'custom',requested:route}}))
 }});
 const r=await bridge.fetch('http://127.0.0.1:8865/v1/runs',start(payload));assert.equal(r.status,202);assert.equal((await r.json()).run_id,'run_synthetic');
 assert.equal(calls.length,1);assert(calls[0].url.endsWith('/api/sessions/wizard_synthetic/chat/stream'));
 assert.equal(calls[0].body.message,'synthetic text');assert.equal(calls[0].body.require_model_lock,true);assert.equal(calls[0].signal,undefined);
 assert.equal(calls[0].body.provider,route.provider)
});
test('Responses user-message input keeps text and image parts in native session chat',()=>{
 const image={type:'image_url',image_url:{url:'data:image/png;base64,synthetic'}};
 assert.deepEqual(sessionMessage([{role:'user',content:[{type:'text',text:'synthetic'},image]}]),[{type:'text',text:'synthetic'},image]);
 assert.deepEqual(sessionMessage([{role:'user',content:'first'},{role:'user',content:[image]}]),[{type:'text',text:'first'},image]);
 assert.throws(()=>sessionMessage([{role:'system',content:'synthetic'}]),/user messages only/);
});

test('older client inherits persisted selector lock before admission',async()=>{
 let received; const b=new LockedRunBridge({origin:'http://localhost:8865',sessionRoute:()=>route,fetchImpl:async(_,init)=>{received=JSON.parse(init.body);return stream(frame('run.started',{run_id:'run_old_client',runtime:ack}))}});
 await b.fetch('http://localhost:8865/v1/runs',start({session_id:'wizard_synthetic',input:'synthetic'}));assert.equal(received.provider,route.provider);assert.equal(received.model,route.model)
});
test('requested provider cannot override contradictory actual provider',()=>{
 assert.equal(runtimeMatches({model:route.model,provider:'different-provider',requested:route},route),false);
 assert.equal(runtimeMatches({model:route.model,provider:'custom',requested:route},route),true);
 assert.equal(runtimeMatches({model:route.model,provider:'custom',requested:{...route,provider:'custom:other'}},route),false)
});
test('wrong admission lock fails and never uses a fallback endpoint',async()=>{
 const calls=[];const b=new LockedRunBridge({origin:'http://localhost:8865',fetchImpl:async(url)=>{calls.push(url);return stream(frame('run.started',{run_id:'run_bad',runtime:{...ack,provider:'public-provider'}}))}});
 await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),/acknowledge/);assert.equal(calls.length,1)
});
test('network uncertainty blocks replay rather than duplicate inference',async()=>{
 let calls=0;const b=new LockedRunBridge({origin:'http://localhost:8865',fetchImpl:async()=>{calls++;throw Error('network lost')}});
 await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),/network lost/);
 await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),/uncertain/);assert.equal(calls,1)
});
test('durable acknowledgement replays after restart without a second call',async()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'model-lock-test-'));
 try {
  const p=join(dir,'admissions.json');let calls=0;
  const raw=async()=>{calls++;return stream(frame('run.started',{run_id:'run_durable',runtime:ack}))};
  const b=new LockedRunBridge({origin:'http://localhost:8865',statePath:p,fetchImpl:raw});await b.fetch('http://localhost:8865/v1/runs',start(payload));
  const b2=new LockedRunBridge({origin:'http://localhost:8865',statePath:p,fetchImpl:raw});const r=await b2.fetch('http://localhost:8865/v1/runs',start(payload));
  assert.equal(r.headers.get('Idempotency-Replayed'),'true');assert.equal((await r.json()).run_id,'run_durable');assert.equal(calls,1)
  await assert.rejects(b2.fetch('http://localhost:8865/v1/runs',start({...payload,model:'different-model'})),/different selected/)
 } finally {rmSync(dir,{recursive:true,force:true})}
});
test('observed native usage runtime is projected and mismatches are failed visibly',async()=>{
 const b=new LockedRunBridge({origin:'http://localhost:8865',fetchImpl:async()=>new Response(JSON.stringify({status:'completed',output:'synthetic',usage:{runtime:{model:route.model,provider:'custom',requested:route,model_lock:'confirmed'}}}),{headers:{'Content-Type':'application/json'}})});
 b.entries.set('fixture',{runId:'run_actual',...route});
 let r=await b.fetch('http://localhost:8865/v1/runs/run_actual');let value=await r.json();assert.equal(value.runtime.model_lock,'confirmed');assert.equal(value.status,'completed');
 b.entries.get('fixture').provider='different-provider';r=await b.fetch('http://localhost:8865/v1/runs/run_actual');value=await r.json();assert.equal(value.status,'failed');assert.equal(value.output,null)
});

test('unknown stream or rejected upstream never drops the lock',async()=>{
 const b=new LockedRunBridge({origin:'http://localhost:8865',fetchImpl:async()=>new Response('no',{status:503})});
 await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),/rejected before execution/)
});

// 17 Oct 2026 incident: a gateway restart cut six of James's sends mid-request; "uncertain" then failed them permanently.
test('connection refused means never sent, so the queue may retry it without a duplicate',async()=>{
 let calls=0;const b=new LockedRunBridge({origin:'http://localhost:8865',fetchImpl:async()=>{calls++;if(calls===1)throw new TypeError('fetch failed',{cause:Object.assign(Error('connect'),{code:'ECONNREFUSED'})});return stream(frame('run.started',{run_id:'run_after_restart',runtime:ack}))}});
 await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),TypeError);
 const r=await b.fetch('http://localhost:8865/v1/runs',start(payload));assert.equal((await r.json()).run_id,'run_after_restart');assert.equal(calls,2)
});
test('uncertain send waits retriably, then replays once Hermes provably never recorded it',async()=>{
 let calls=0;const probes=[];
 const b=new LockedRunBridge({origin:'http://localhost:8865',uncertainSettleMs:0,
  deliveryProbe:(sid,since,text)=>{probes.push([sid,text]);return false},
  fetchImpl:async()=>{calls++;if(calls===1)throw Error('socket hang up');return stream(frame('run.started',{run_id:'run_replayed',runtime:ack}))}});
 await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),/socket hang up/);
 const r=await b.fetch('http://localhost:8865/v1/runs',start(payload));assert.equal((await r.json()).run_id,'run_replayed');
 assert.equal(calls,2);assert.deepEqual(probes,[['wizard_synthetic','synthetic text']])
});
test('uncertain send that Hermes did record is never replayed',async()=>{
 let calls=0;const b=new LockedRunBridge({origin:'http://localhost:8865',uncertainSettleMs:0,deliveryProbe:()=>true,fetchImpl:async()=>{calls++;throw Error('socket hang up')}});
 await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),/socket hang up/);
 await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),/uncertain/);assert.equal(calls,1)
});
test('uncertain send inside the settle window or with an unreadable transcript stays retriable (503), never terminal',async()=>{
 for (const opts of [{uncertainSettleMs:60_000,deliveryProbe:()=>false},{uncertainSettleMs:0,deliveryProbe:()=>null}]) {
  let calls=0;const b=new LockedRunBridge({origin:'http://localhost:8865',...opts,fetchImpl:async()=>{calls++;throw Error('socket hang up')}});
  await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),/socket hang up/);
  await assert.rejects(b.fetch('http://localhost:8865/v1/runs',start(payload)),e=>e.status===503);assert.equal(calls,1)
 }
});
