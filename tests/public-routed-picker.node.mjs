import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { ModelSelections } from '../server/model-selection.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoutedQueues, resolveAgentTransport } from '../server/routed-run-queue.mjs'
import { LockedRunBridge } from '../server/locked-run-bridge.mjs'
import { ModelSelectionConflict } from '../server/model-selection.mjs'
const A={model:'fixture-alpha',provider:'anthropic'}, B={model:'fixture-beta',provider:'anthropic'}
const native='claude-subscription-directsdk-experimental'
const frame=(name,value)=>`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5))}assert.fail('synthetic dispatch did not occur')}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}})
const request=(value,key='one')=>({method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(value)})
async function fixture(t,kind='host-profile',privateRoute=false) {
  const root=mkdtempSync(join(tmpdir(),'rms-')); t.after(()=>rmSync(root,{recursive:true,force:true}))
  const provider=privateRoute?'tinfoil':A.provider, transport=privateRoute?'custom:tinfoil-operator':native
  const agents=new Map(['first','second'].map(id=>[id,{id,privacy:'standard',kind,model:{provider,model:A.model,allowed_models:[A.model,B.model]}}]))
  for(const id of agents.keys())mkdirSync(join(root,id))
  const calls=[],runs=new Map(),disposers=[]; let unsafe=false, count=0, optionsOverride, hasOptionsOverride=false, unselected=false, failNext=false, pickerGate=null
  // createAgentRegistry.list() is synchronous and returns full agent records.
  const registry={agentsDir:root,list:()=>[...agents.values()],apiKey:()=> 'synthetic-no-authority',async fetchAgent(agent,path,init={}) {
    const body=init.body?JSON.parse(init.body):null;calls.push({agent:agent.id,path,body})
    if(path==='/api/model/options')return json(hasOptionsOverride?optionsOverride:{provider:unsafe?'openai-codex':transport,model:A.model,providers:[{slug:privateRoute?'tinfoil-operator':native,is_user_defined:privateRoute,authenticated:true,models:[A.model,B.model]}]})
    if(path.endsWith('/model')) { if(pickerGate) await pickerGate; return json({runtime:{model:body.model,provider:body.provider,model_lock:'accepted'}}) }
    if(path.endsWith('/chat/stream')) {
      const run_id='native_'+(++count),runtime={model:body.model,provider:privateRoute?'custom':transport,requested:{model:body.model,provider:body.provider},model_lock:'confirmed'}
      if (failNext) {
        failNext=false;const error={type:'synthetic_failure',message:'Synthetic failed turn'}
        runs.set(run_id,{run_id,session_id:'wizard_shared',status:'failed',runtime,error})
        return new Response(frame('run.started',{run_id,runtime:{...runtime,model_lock:'accepted'}})+frame('run.failed',{run_id,status:'failed',runtime,error}),{headers:{'Content-Type':'text/event-stream'}})
      }
      runs.set(run_id,{run_id,session_id:'wizard_shared',status:'running',runtime})
      return new Response(frame('run.started',{run_id,runtime:{model:'',provider:'',requested:{model:body.model,provider:body.provider},model_lock:'accepted'}})+frame('run.completed',{run_id,runtime,output:'fixture'}),{headers:{'Content-Type':'text/event-stream'}})
    }
    if(path.startsWith('/api/sessions/'))return json({id:'wizard_shared',...(unselected?{}:{model:A.model,provider:transport})})
    if(path==='/v1/runs') {
      const run_id='legacy_'+(++count); runs.set(run_id,{run_id,session_id:body.session_id,status:'running'})
      return json(runs.get(run_id),202)
    }
    if(path.startsWith('/v1/runs/')&&path.endsWith('/steer'))return json({status:'accepted'})
    if(path.startsWith('/v1/runs/'))return json(runs.get(path.split('/')[3])||{},runs.has(path.split('/')[3])?200:404)
    throw Error('unhandled synthetic endpoint '+path)
  }}
  let queues
  const start=()=>{
    const listed=registry.list()
    assert.ok(Array.isArray(listed),'registry list is synchronous')
    assert.deepEqual(listed,[...agents.values()],'registry list returns full agent records, not ids')
    return queues=createRoutedQueues({registry,pollIntervalMs:0,own:fn=>disposers.push(fn)})
  }
  start(); t.after(async()=>{for(const dispose of disposers.splice(0))await dispose()})
  return {root,failNext(){failNext=true},holdPicker(){let release;pickerGate=new Promise(r=>release=r);return ()=>{pickerGate=null;release()}},agent:agents.get('first'),second:agents.get('second'),calls,registry,transport,provider,fetch:(a,path,init)=>queues.fetch(a,path,init),setUnsafe:()=>unsafe=true,
    setOptions(value){hasOptionsOverride=true;optionsOverride=value},
    setUnselected(){unselected=true},
    async restart(){for(const dispose of disposers.splice(0))await dispose();start()}}
}
for(const [kind,privateRoute] of [['host-profile',false],['container',false],['restricted',false]]) {
  test(`${kind}${privateRoute?' private':''}: exact transport, qualified custody, immutable replay and stale refusal`,async t=>{
    const f=await fixture(t,kind,privateRoute), route={model:A.model,provider:f.provider}
    const body={session_id:'wizard_shared',input:'synthetic owner turn',...route,selection_version:0,require_model_lock:true}
    const first=await f.fetch(f.agent,'/v1/runs',request(body));assert.equal(first.status,202);const admitted=await first.json()
    await until(()=>f.calls.some(c=>c.path.endsWith('/chat/stream')))
    const wires=f.calls.filter(c=>c.path.endsWith('/chat/stream'));assert.equal(wires.length,1);assert.equal(wires[0].body.provider,f.transport);assert.equal(wires[0].body.require_model_lock,true)
    assert.equal(f.calls.filter(c=>c.path==='/v1/runs').length,0,'native unguarded run factory is never called')
    const selection=await f.fetch(f.agent,'/api/sessions/wizard_shared/model',request({model:B.model,provider:f.provider,selection_version:1,selection_request_id:'pick-b'}));assert.equal(selection.status,200);assert.equal((await selection.json()).selection.version,2)
    const other=await f.fetch(f.second,'/v1/runs',request(body));assert.equal(other.status,202,'same sid on a different agent has independent custody')
    await f.restart()
    const replay=await f.fetch(f.agent,'/v1/runs',request(body));assert.equal(replay.headers.get('Idempotency-Replayed'),'true');assert.equal((await replay.json()).run_id,admitted.run_id)
    await assert.rejects(f.fetch(f.agent,'/v1/runs',request(body,'new-stale-id')),e=>e.status===409)
    assert.equal(f.calls.filter(c=>c.path.endsWith('/chat/stream')&&c.agent==='first').length,1)
  })
}
for(const provider of ['openai','openai-codex','google','nvidia','openrouter']) {
  test(`provider-neutral configured-route proof: ${provider}`,()=>{
    const agent={model:{provider,model:A.model,allowed_models:[A.model]}},options={provider,model:A.model,providers:[{slug:provider,authenticated:true,models:[A.model]}]}
    assert.deepEqual(resolveAgentTransport(agent,options,{model:A.model,provider}),{model:A.model,provider})
    assert.throws(()=>resolveAgentTransport(agent,{...options,provider:'different-provider'},{model:A.model,provider}),error=>error.status===409)
  })
}
test('unselected public legacy keeps native configured routing and exact replay across restart', async t => {
  const f=await fixture(t); f.setUnselected(); f.setOptions(null)
  const body={session_id:'wizard_shared',input:'Synthetic scheduled or first owner message'}
  const response=await f.fetch(f.agent,'/v1/runs',request(body)); assert.equal(response.status,202)
  const admitted=await response.json(); await until(()=>f.calls.some(c=>c.path==='/v1/runs'))
  const wires=f.calls.filter(c=>c.path==='/v1/runs'); assert.equal(wires.length,1)
  assert.deepEqual(wires[0].body,{...body,model:A.model})
  assert.equal(f.calls.filter(c=>c.path==='/api/model/options'||c.path.endsWith('/chat/stream')).length,0)
  await f.restart()
  const replay=await f.fetch(f.agent,'/v1/runs',request(body));assert.equal(replay.headers.get('Idempotency-Replayed'),'true')
  assert.equal((await replay.json()).run_id,admitted.run_id); assert.equal(f.calls.filter(c=>c.path==='/v1/runs').length,1)
})
for (const claim of [{model:A.model},{provider:A.provider},{require_model_lock:false},{selection_version:0},{wizard_retry_run_id:'unknown'},{wizard_selection:{model:A.model}},{route:{}},{runtime:{}}])
test(`legacy exception refuses explicit selection metadata without a catalogue: ${JSON.stringify(claim)}`,async t=>{
  const f=await fixture(t);f.setUnselected();f.setOptions(null)
  await assert.rejects(f.fetch(f.agent,'/v1/runs',request({session_id:'wizard_shared',input:'Kept synthetic message',...claim})),e=>e.status===409)
  assert.equal(f.calls.filter(c=>c.path==='/v1/runs'||c.path.endsWith('/chat/stream')||c.path.endsWith('/model')).length,0)
})
// Loopback HTTP exercises the actual routed adapter and real durable queue;
// only inference is synthetic. SQLite is read-only observation, never a seed.
async function retryFixture(t, empty=false) {
  const f=await fixture(t)
  const server=createServer(async(req,res)=>{
    try {
      let body='';for await(const c of req)body+=c
      const response=await f.fetch(f.agent,req.url,{method:req.method,headers:req.headers,...(body?{body}:{})})
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text())
    } catch(e) {res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify(e.payload||{error:e.message}))}
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}))
  const http=(path,init)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,init)
  const row=id=>{const db=new DatabaseSync(join(f.root,'first','wizard-run-queue.sqlite3'),{readOnly:true});try{return db.prepare('SELECT * FROM wizard_run_queue WHERE public_run_id=?').get(id)}finally{db.close()}}
  const custody=()=>readFileSync(join(f.root,'first','wizard-public-locked-runs.json.transports'),'utf8')
  const wires=()=>f.calls.filter(c=>c.path.endsWith('/chat/stream')||c.path==='/v1/runs')
  const pick=async(route,version,id)=>{const r=await http('/api/sessions/wizard_shared/model',request({...route,selection_version:version,selection_request_id:id},id));assert.equal(r.status,200);return (await r.json()).selection.version}
  const input=empty?'':[{role:'user',content:[{type:'text',text:'  Full saved source\nnot the preview'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}]}]
  f.failNext()
  const first=await http('/v1/runs',request({session_id:'wizard_shared',input,...A,selection_version:0,wizard_file_ids:['synthetic-file']},'source'))
  assert.equal(first.status,202);const source=await first.json()
  for(let i=0;i<100;i++){const r=await http(`/v1/runs/${source.run_id}`);if((await r.json()).status==='failed')break;await new Promise(r=>setTimeout(r,5))}
  assert.equal(row(source.run_id).status,'failed')
  const retry=(extra={})=>http('/v1/runs',request({session_id:'wizard_shared',wizard_retry_run_id:source.run_id,input:'untrusted preview',...A,selection_version:1,...extra},crypto.randomUUID()))
  return {...f,http,row,custody,wires,pick,input,source,retry}
}
test('saved Retry HTTP first admission and A-B-A/pending/restart replay retain original custody',async t=>{
  const f=await retryFixture(t), original=f.row(f.source.run_id).body
  const response=await f.retry();assert.equal(response.status,202);const child=await response.json()
  await until(()=>f.wires().length===2)
  const saved=f.row(child.run_id),body=JSON.parse(saved.body),bytes=f.custody()
  assert.deepEqual(body.input,f.input);assert.deepEqual(body.wizard_file_ids,['synthetic-file'])
  assert.equal(body.selection_version,1);assert.equal(body.provider,A.provider)
  assert.equal(saved.request_hash,queueRequestHash('direct',saved.body))
  assert.deepEqual(new Map(JSON.parse(bytes)).get(saved.request_hash),{model:A.model,provider:native,selection_version:1})
  assert.equal(f.wires()[1].body.provider,native);assert.equal(f.wires()[1].body.model,A.model)
  assert.ok(JSON.stringify(f.wires()[1].body.message).includes('Full saved source'))
  assert.ok(!JSON.stringify(f.wires()[1].body.message).includes('untrusted preview'))
  await f.pick(B,1,'to-b');await f.pick(A,2,'back-a')
  const replay=async()=>{const r=await f.retry({selection_version:3});assert.equal(r.status,202);assert.equal(r.headers.get('Idempotency-Replayed'),'true');assert.equal((await r.json()).run_id,child.run_id);assert.equal(f.custody(),bytes);assert.equal(f.row(child.run_id).body,saved.body);assert.equal(f.wires().length,2)}
  await replay()
  const release=f.holdPicker(),pending=f.pick(B,3,'pending-b')
  await until(()=>f.calls.some(c=>c.path.endsWith('/model')&&c.body.model===B.model&&c.body.selection_version===3))
  try {await replay()} finally {release();await pending}
  for(const extra of [{model:B.model},{provider:'wrong-provider'},{session_id:'wizard_wrong'}]){
    const r=await f.retry(extra);assert.equal(r.status,extra.session_id?404:412);assert.equal(f.custody(),bytes);assert.equal(f.wires().length,2)
  }
  await f.restart();await replay();assert.equal(f.row(f.source.run_id).body,original)
})
test('saved Retry HTTP catalogue race cannot overwrite a concurrently admitted child custody',async t=>{
  const f=await retryFixture(t),raw=f.registry.fetchAgent
  let release,entered=false,hold=true
  const gate=new Promise(r=>release=r)
  f.registry.fetchAgent=async function(agent,path,init){if(hold&&path==='/api/model/options'){hold=false;entered=true;await gate}return raw.call(this,agent,path,init)}
  // Both callers pass the adapter's early replay lookup before the first child
  // exists. The delayed caller carries a later CAS; the queue must replay first.
  const delayed=f.retry({selection_version:3})
  await until(()=>entered)
  let child,bytes,saved
  try {
    const first=await f.retry();assert.equal(first.status,202);child=await first.json()
    await until(()=>f.wires().length===2);saved=f.row(child.run_id);bytes=f.custody()
    await f.pick(B,1,'race-b');await f.pick(A,2,'race-a')
  } finally {release()}
  const response=await delayed;assert.equal(response.status,202);assert.equal((await response.json()).run_id,child.run_id)
  assert.equal(f.custody(),bytes);assert.equal(f.row(child.run_id).body,saved.body);assert.equal(f.wires().length,2)
})
test('saved Retry HTTP rejects ineligible sources and stale/new pending admissions without custody writes',async t=>{
  const f=await retryFixture(t),bytes=f.custody(),source=f.row(f.source.run_id).body
  for(const extra of [{session_id:'wizard_wrong'},{wizard_retry_run_id:'wizardq_'+'0'.repeat(32)},{selection_version:999}]){
    const r=await f.retry(extra);assert.ok([404,409].includes(r.status));assert.equal(f.custody(),bytes);assert.equal(f.wires().length,1)
  }
  const release=f.holdPicker(),pending=f.pick(B,1,'pending-new')
  await until(()=>f.calls.some(c=>c.path.endsWith('/model')))
  try {assert.equal((await f.retry()).status,409);assert.equal(f.custody(),bytes)}finally{release();await pending}
  // A newer real admission makes the old failed source no longer current.
  const latest=await f.http('/v1/runs',request({session_id:'wizard_shared',input:'newer turn',...B,selection_version:2},'newer'))
  assert.equal(latest.status,202);await until(()=>f.wires().length===2)
  const after=f.custody();assert.equal((await f.retry({...B,selection_version:2})).status,409)
  assert.equal(f.custody(),after);assert.equal(f.row(f.source.run_id).body,source);assert.equal(f.wires().length,2)
})
test('saved Retry HTTP empty source refuses without admission or custody writes',async t=>{
  const f=await retryFixture(t,true),bytes=f.custody(),source=f.row(f.source.run_id).body
  assert.equal((await f.retry()).status,409);assert.equal(f.custody(),bytes);assert.equal(f.row(f.source.run_id).body,source);assert.equal(f.wires().length,1)
})
test('saved Retry HTTP owner-stopped source refuses without admission or custody writes',async t=>{
  const f=await retryFixture(t),bytes=f.custody(),source=f.row(f.source.run_id).body
  assert.equal((await f.http(`/v1/runs/${f.source.run_id}/stop`,request({},'stop'))).status,200)
  assert.equal((await f.retry()).status,409);assert.equal(f.custody(),bytes);assert.equal(f.row(f.source.run_id).body,source);assert.equal(f.wires().length,1)
})
test('saved Retry HTTP legitimate route change stamps new revision and accepts matching guidance',async t=>{
  const f=await retryFixture(t);await f.pick(B,1,'new-route')
  const r=await f.retry({...B,selection_version:2});assert.equal(r.status,202);const child=await r.json()
  const row=f.row(child.run_id),body=JSON.parse(row.body),transport=new Map(JSON.parse(f.custody())).get(row.request_hash)
  assert.deepEqual(body.input,f.input);assert.equal(body.selection_version,2);assert.equal(transport.selection_version,2)
  assert.equal(body.model,B.model);assert.equal(transport.model,B.model);assert.equal(transport.provider,native)
  await until(()=>f.wires().length===2)
  // Force a capacity-held new child through the real queue in the seam test below;
  // this dispatched child's matching guidance still validates before native GET.
  const guidance=await f.http(`/v1/runs/${child.run_id}/steer`,request({input:'matching guidance',...B,selection_version:2},'guidance'))
  assert.equal(guidance.status,200)
  assert.equal(f.calls.filter(c=>c.path.endsWith('/steer')).at(-1).body.provider,native)
})
test('saved Retry HTTP custody persistence failure refuses before child admission or dispatch',async t=>{
  const f=await retryFixture(t),bytes=f.custody(),source=f.row(f.source.run_id).body,save=ModelSelections.prototype.save
  ModelSelections.prototype.save=function(){if(this.statePath.endsWith('.transports'))throw Error('synthetic custody persistence failure');return save.call(this)}
  try {assert.equal((await f.retry()).status,500)}finally{ModelSelections.prototype.save=save}
  assert.equal(f.custody(),bytes);assert.equal(f.row(f.source.run_id).body,source);assert.equal(f.wires().length,1)
  const r=await f.retry();assert.equal(r.status,202);await until(()=>f.wires().length===2)
})
test('saved Retry preparation runs after real queue eligibility only, never replay, failure admits nothing',async t=>{
  const root=mkdtempSync(join(tmpdir(),'retry-seam-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  let calls=0,dispatch=0
  const q=new DurableRunQueue({statePath:join(root,'q.db'),pollIntervalMs:0,canDispatch:()=>false,launch:async()=>{dispatch++;return {}},lookup:async()=>({})});t.after(()=>q.close())
  const admit=async(input,key)=>{const value={session_id:'s',input,...A,selection_version:1},body=JSON.stringify(value);return (await q.admit({runtime:'direct',sessionId:'s',idempotencyKey:key,body,requestHash:queueRequestHash('direct',body)})).record}
  const empty=await admit('','empty');q._update(empty.publicRunId,{status:'failed'})
  const prepare=()=>{calls++;throw Error('preparation failed')}
  await assert.rejects(q.retrySaved(empty.publicRunId,'s',A,prepare),/empty/);assert.equal(calls,0)
  const source=await admit('source','full');q._update(source.publicRunId,{status:'failed'})
  const before=q.get(source.publicRunId)
  await assert.rejects(q.retrySaved(source.publicRunId,'wrong',A,prepare),/not found/)
  await assert.rejects(q.retrySaved(empty.publicRunId,'s',A,prepare),/no longer current/);assert.equal(calls,0)
  await assert.rejects(q.retrySaved(source.publicRunId,'s',A,prepare),/preparation failed/);assert.equal(calls,1)
  assert.deepEqual(q.get(source.publicRunId),before);assert.equal(q.byIdempotencyKey('direct',`wizard-saved-retry-${source.publicRunId}`),null);assert.equal(dispatch,0)
  const result=await q.retrySaved(source.publicRunId,'s',A,value=>{calls++;value.selection_version=2})
  assert.equal(JSON.parse(result.record.body).selection_version,2)
  await q.retrySaved(source.publicRunId,'s',A,prepare);assert.equal(calls,2);assert.equal(dispatch,0)
})
const shapeConflict = error => error instanceof ModelSelectionConflict && error.status === 409 && error.payload.error.code === 'agent_model_route_unproven'
for (const allowed of [undefined, null, A.model, {}, [null], [7]]) test(`malformed allowed_models is typed fail-closed with no inference: ${JSON.stringify(allowed)}`, async t => {
  const f = await fixture(t)
  if (allowed === undefined) delete f.agent.model.allowed_models
  else f.agent.model.allowed_models = allowed
  const options = { provider: native, providers: [{ slug: native, models: [A.model] }] }
  assert.throws(() => resolveAgentTransport(f.agent, options, A), shapeConflict)
  const read = await f.fetch(f.agent, '/api/sessions/wizard_shape')
  assert.equal(read.status, 200)
  const row = await read.json(); assert.equal(row.model, A.model); assert.equal(row.wizard_selection, undefined)
  assert.equal(row.wizard_provider, undefined)
  await assert.rejects(f.fetch(f.agent, '/v1/runs', request({ session_id: 'wizard_shape', input: 'kept original', ...A })), shapeConflict)
  assert.equal(f.calls.filter(call => call.path.endsWith('/chat/stream') || call.path === '/v1/runs' || call.path.endsWith('/model')).length, 0)
})
for (const [name, options] of [
  ['null options', null], ['missing provider', { providers: [] }], ['wrong provider type', { provider: 7, providers: [] }],
  ['wrong providers shape', { provider: native, providers: {} }],
  ['wrong models shape', { provider: native, providers: [{ slug: native, models: {} }] }],
  ['invalid provider rows', { provider: native, providers: [null, {}] }],
  ['invalid model rows', { provider: native, providers: [{ slug: native, models: [null, {}] }] }],
]) test(`malformed catalogue shape is typed fail-closed with no inference: ${name}`, async t => {
  const f = await fixture(t); f.setOptions(options)
  assert.throws(() => resolveAgentTransport(f.agent, options, A), shapeConflict)
  await assert.rejects(f.fetch(f.agent, '/v1/runs', request({ session_id: 'wizard_shape', input: 'kept original', ...A })), shapeConflict)
  assert.equal(f.calls.filter(call => call.path.endsWith('/chat/stream') || call.path === '/v1/runs' || call.path.endsWith('/model')).length, 0)
})
