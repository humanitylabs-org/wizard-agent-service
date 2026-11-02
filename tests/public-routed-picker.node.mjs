import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
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
  const calls=[],runs=new Map(),disposers=[]; let unsafe=false, count=0, optionsOverride, hasOptionsOverride=false, unselected=false
  // createAgentRegistry.list() is synchronous and returns full agent records.
  const registry={agentsDir:root,list:()=>[...agents.values()],apiKey:()=> 'synthetic-no-authority',async fetchAgent(agent,path,init={}) {
    const body=init.body?JSON.parse(init.body):null;calls.push({agent:agent.id,path,body})
    if(path==='/api/model/options')return json(hasOptionsOverride?optionsOverride:{provider:unsafe?'openai-codex':transport,model:A.model,providers:[{slug:privateRoute?'tinfoil-operator':native,is_user_defined:privateRoute,authenticated:true,models:[A.model,B.model]}]})
    if(path.endsWith('/model'))return json({runtime:{model:body.model,provider:body.provider,model_lock:'accepted'}})
    if(path.endsWith('/chat/stream')) {
      const run_id='native_'+(++count),runtime={model:body.model,provider:privateRoute?'custom':transport,requested:{model:body.model,provider:body.provider},model_lock:'confirmed'}
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
  return {agent:agents.get('first'),second:agents.get('second'),calls,registry,transport,provider,fetch:(a,path,init)=>queues.fetch(a,path,init),setUnsafe:()=>unsafe=true,
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
