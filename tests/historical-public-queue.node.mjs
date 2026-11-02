// Source-derived historical compatibility; executed only by the parent-admitted worker.
// PUBLIC_ROUTING_BASELINE_DIR must be an archive of 37b99737351369652f2c6126dde9b6eb403a8060.
// All data are synthetic. Never point agentsDir at an installed agent directory.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createRoutedQueues, historicalUnselected } from '../server/routed-run-queue.mjs'

assert.ok(process.env.PUBLIC_ROUTING_BASELINE_DIR, 'baseline archive is mandatory; no skip counts as upgrade proof')
const baselineDir = resolve(process.env.PUBLIC_ROUTING_BASELINE_DIR)
const baselineImport = file => import(pathToFileURL(join(baselineDir, 'server', file)).href)
const { createRoutedQueues: baselineQueues } = await baselineImport('routed-run-queue.mjs')
const { DurableRunQueue: BaselineDurableRunQueue } = await baselineImport('run-queue.mjs')
const { proxyToAgent: baselineProxy } = await baselineImport('agents-http.mjs')
const A = 'fixture-alpha', B = 'fixture-beta', native = 'claude-subscription-directsdk-experimental'
const sid = 'wizard_historical', bare = {session_id:sid,input:'Synthetic preserved owner message'}
const json = (value, status=200) => new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json'}})
const post = (value, key) => ({method:'POST',headers:{'Idempotency-Key':key},body:typeof value === 'string' ? value : JSON.stringify(value)})

async function fixture(t, {privacy='standard'}={}) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'hpub-'))
  const agent = {id:'synthetic-public',privacy,kind:'host-profile',model:{provider:'anthropic',model:A,allowed_models:[A,B]},permissions:{files:'none'}}
  mkdirSync(join(root, agent.id))
  let release = false, count = 0, queues, disposers = [], pickerGate = null, pickerEntered = null
  const calls = [], runs = new Map()
  const registry = {agentsDir:root,list:()=>[agent],read:id=>id === agent.id ? agent : null,
    apiKey:()=> 'synthetic-no-authority',pin(){},noteRun(){},threadAgent:()=>({id:agent.id,privacy}),
    async fetchAgent(a,path,init={}) {
      const body = init.body ? JSON.parse(init.body) : null
      calls.push({path,body,raw:init.body})
      if (path === '/api/model/options') return json({provider:native,providers:[{slug:native,models:[A,B]}]})
      if (path.endsWith('/model')) {
        pickerEntered?.();if(pickerGate) await pickerGate
        return json({runtime:{model:body.model,provider:body.provider,model_lock:'accepted'}})
      }
      if (path.startsWith('/api/sessions/')) return json({id:decodeURIComponent(path.split('/')[3])})
      if (path === '/v1/runs') {
        const run_id = 'native_' + (++count)
        const value = {run_id,session_id:body.session_id,status:'running'}
        runs.set(run_id,value); return json(value,202)
      }
      if (path.startsWith('/v1/runs/')) {
        const value = runs.get(path.split('/')[3])
        return value ? json({...value,...(release && value.session_id === 'wizard_blocker' ? {status:'completed',output:'Synthetic blocker released'} : {})}) : json({},404)
      }
      throw Error('Unexpected synthetic endpoint: ' + path)
    }}
  const start = async factory => {queues=factory({registry,pollIntervalMs:10,maxActive:1,own:fn=>disposers.push(fn)});await queues.ready}
  const close = async () => {for(const dispose of disposers.splice(0)) await dispose()}
  const fetch = (path,init) => queues.fetch(agent,path,init)
  const throughProxy = async (wire,key) => {
    const request = new EventEmitter();request.headers={'idempotency-key':key}
    const response = new EventEmitter(); let code, result
    response.writeHead = status => {code=status}
    response.end = bytes => {result=JSON.parse(Buffer.from(bytes).toString('utf8'));response.writableEnded=true}
    await baselineProxy({registry,isAllowedProxyRequest:()=>true,mainSecrets:[],runInstructions:'Synthetic baseline instructions',
      fetchAgent:(a,path,init)=>queues.fetch(a,path,init),sendJson:(_,status,payload)=>{code=status;result=payload}},
      {agent,method:'POST',upstreamPath:'/v1/runs',searchParams:new URLSearchParams(),request,response,body:Buffer.from(wire),bodyRead:true})
    assert.equal(code,202);return result
  }
  const record = id => {
    // Read-only synthetic observation through the actual baseline queue record decoder.
    // Do NOT initialize: that would drain or reconcile the fixture while observing it.
    const observer = new BaselineDurableRunQueue({agentId:agent.id,statePath:join(root,agent.id,'wizard-run-queue.sqlite3'),pollIntervalMs:0,
      launch:async()=>{throw Error('Observer must not launch')},lookup:async()=>{throw Error('Observer must not lookup')}})
    try {return observer.get(id)} finally {observer.close()}
  }
  t.after(async()=>{await close();rmSync(root,{recursive:true,force:true})})
  const custodyPath = join(root,agent.id,'wizard-public-locked-runs.json.transports')
  return {agent,calls,start,close,fetch,throughProxy,record,custodyPath,
    holdPicker() {
      let finish
      pickerGate=new Promise(resolve=>{finish=resolve})
      const entered=new Promise(resolve=>{pickerEntered=resolve})
      return {entered,release:finish}
    },
    release(){release=true},wireFor:session=>calls.filter(c=>c.path === '/v1/runs' && c.body.session_id === session),
    async seed(wire=JSON.stringify(bare),viaProxy=true) {
      await start(baselineQueues)
      const blocker = await fetch('/v1/runs',post({session_id:'wizard_blocker',input:'Synthetic real admitted capacity blocker'},'blocker'))
      assert.equal(blocker.status,202)
      assert.equal(this.wireFor('wizard_blocker').length,1)
      const admitted = viaProxy ? await throughProxy(wire,'old') : await (await fetch('/v1/runs',post(wire,'old'))).json()
      const old = record(admitted.run_id)
      assert.equal(old.status,'queued');assert.equal(old.dispatchBody,null)
      assert.equal(old.requestHash,createHash('sha256').update(typeof wire === 'string' ? wire : JSON.stringify(wire)).digest('hex'),'actual original admission hash domain')
      assert.equal(old.idempotencyKey,'old');assert.equal(old.agent_id,agent.id)
      assert.equal(this.wireFor(sid).length,0)
      await close()
      return old
    },
    async drain(id) {
      this.release()
      for(let i=0;i<100;i++){
        await fetch('/v1/runs/'+id)
        const row=record(id)
        if(row.upstreamRunId || row.waitingReason==='admission_retry' || row.status==='failed')return row
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      assert.fail('Historical row never reached dispatch or visible route hold')
    } }
}

// Compare with an ACTUAL baseline native wire capture, never a predicted JSON body.
async function baselineWire(t,wire,viaProxy) {
  const reference = await fixture(t)
  const old = await reference.seed(wire,viaProxy)
  await reference.start(baselineQueues);await reference.drain(old.publicRunId)
  assert.equal(reference.wireFor(sid).length,1)
  return reference.wireFor(sid)[0].raw
}
for (const viaProxy of [false,true]) for (const laterPicker of [false,true]) {
  test(`baseline ${viaProxy?'real HTTP proxy':'internal raw'} bare admission resumes exact wire; later picker=${laterPicker}`,async t=>{
    const wire=JSON.stringify(bare), expected=await baselineWire(t,wire,viaProxy), f=await fixture(t)
    const old=await f.seed(wire,viaProxy)
    assert.equal(historicalUnselected(old,f.agent.id),true)
    await f.start(createRoutedQueues)
    if (laterPicker) {
      const picked=await f.fetch('/api/sessions/'+sid+'/model',post({model:B,provider:'anthropic',selection_version:0,selection_request_id:'later-choice'},'pick'))
      assert.equal(picked.status,200)
    }
    await f.drain(old.publicRunId)
    assert.equal(f.wireFor(sid).length,1);assert.equal(f.wireFor(sid)[0].raw,expected)
    assert.equal(f.calls.filter(c=>c.path.endsWith('/chat/stream')).length,0)
    const custody=readFileSync(f.custodyPath,'utf8')
    assert.deepEqual(new Map(JSON.parse(custody)).get(old.requestHash),{legacyUnselected:true})
    await f.close();await f.start(createRoutedQueues)
    const replay=await f.fetch('/v1/runs',post(wire,'old')) // Same exact original byte hash; replay exits before selection checks.
    assert.equal(replay.headers.get('Idempotency-Replayed'),'true')
    assert.equal((await replay.json()).run_id,old.publicRunId)
    assert.equal(f.wireFor(sid).length,1)
    assert.equal(readFileSync(f.custodyPath,'utf8'),custody,'existing sidecar is not rewritten')
  })
}

for (const claim of [{model:A},{provider:'anthropic'},{require_model_lock:false},{selection_version:0},{wizard_selection:{}},{route:{}},{runtime:{}},{transport:{}},{model:null},{model:''}]) {
  test('real baseline original authority is never reconstructed away: '+JSON.stringify(claim),async t=>{
    const f=await fixture(t),old=await f.seed(JSON.stringify({...bare,...claim}),true)
    assert.equal(historicalUnselected(old,f.agent.id),false)
    await f.start(createRoutedQueues);await f.drain(old.publicRunId)
    assert.equal(f.wireFor(sid).length,0)
    if(existsSync(f.custodyPath)) assert.equal(new Map(JSON.parse(readFileSync(f.custodyPath,'utf8'))).has(old.requestHash),false)
  })
}
for (const [name,wire] of [
  ['whitespace',JSON.stringify(bare,null,2)],
  // Integer keys enumerate numerically, unlike this original byte order.
  ['key enumeration mismatch','{"session_id":"wizard_historical","input":"Synthetic preserved owner message","2":"b","1":"a"}'],
  ['escaped unicode','{"session_id":"wizard_historical","input":"\\u0053ynthetic preserved owner message"}'],
  ['overwritten instructions',JSON.stringify({...bare,instructions:'Original instructions replaced by the real baseline proxy'})],
  ['removed rendering metadata',JSON.stringify({...bare,response_rendering:{synthetic:true}})],
]) test('real baseline noninvertible bytes stay held: '+name,async t=>{
  const f=await fixture(t),old=await f.seed(wire,true)
  assert.equal(historicalUnselected(old,f.agent.id),false)
  await f.start(createRoutedQueues);await f.drain(old.publicRunId)
  assert.equal(f.wireFor(sid).length,0)
})

test('fresh bare admission does not inherit an ambiguous historical latest row',async t=>{
  const f=await fixture(t),old=await f.seed(JSON.stringify({...bare,model:A}),true)
  await f.start(createRoutedQueues)
  const fresh=await f.fetch('/v1/runs',post({...bare,input:'A genuine fresh synthetic message'},'fresh'))
  assert.equal(fresh.status,202)
  const saved=f.record((await fresh.json()).run_id)
  assert.notEqual(saved.publicRunId,old.publicRunId)
  assert.deepEqual(new Map(JSON.parse(readFileSync(f.custodyPath,'utf8'))).get(saved.requestHash),{legacyUnselected:true})
  assert.equal(f.calls.filter(c=>c.path === '/api/model/options').length,0)
})

test('new marker survives restart/replay without historical reclassification or rewrite',async t=>{
  const f=await fixture(t);await f.start(createRoutedQueues)
  const admitted=await f.fetch('/v1/runs',post(bare,'new-marker'));assert.equal(admitted.status,202)
  const id=(await admitted.json()).run_id,custody=readFileSync(f.custodyPath,'utf8')
  await f.close();await f.start(createRoutedQueues)
  const replay=await f.fetch('/v1/runs',post(bare,'new-marker'))
  assert.equal(replay.headers.get('Idempotency-Replayed'),'true');assert.equal((await replay.json()).run_id,id)
  assert.equal(readFileSync(f.custodyPath,'utf8'),custody)
  assert.equal(f.wireFor(sid).length,1)
})

test('a later fresh send cannot overwrite existing marker custody under a reused raw hash',async t=>{
  const f=await fixture(t);await f.start(createRoutedQueues)
  const first=await f.fetch('/v1/runs',post(bare,'original-marker'));assert.equal(first.status,202)
  const custody=readFileSync(f.custodyPath,'utf8')
  const picked=await f.fetch('/api/sessions/'+sid+'/model',post({model:B,provider:'anthropic',selection_version:0,selection_request_id:'change'},'pick'))
  assert.equal(picked.status,200)
  await assert.rejects(f.fetch('/v1/runs',post(bare,'new-key-same-bytes')),error=>error.status===409)
  assert.equal(readFileSync(f.custodyPath,'utf8'),custody)
  assert.equal(f.wireFor(sid).length,1)
})

test('pending picker fences a NEW bare admission before transport custody persists',async t=>{
  const f=await fixture(t);await f.start(createRoutedQueues)
  const gate=f.holdPicker()
  const picking=f.fetch('/api/sessions/'+sid+'/model',post({model:B,provider:'anthropic',selection_version:0,selection_request_id:'pending'},'pick'))
  try {
    await gate.entered
    await assert.rejects(f.fetch('/v1/runs',post(bare,'during-picker')),error=>error.status===409)
    assert.equal(existsSync(f.custodyPath),false)
    assert.equal(f.wireFor(sid).length,0)
  } finally {gate.release();await picking}
})

for (const privacy of ['private',undefined]) test('synthetic non-public privacy stays outside public migration: '+String(privacy),async t=>{
  // Explicit assignment preserves unknown privacy instead of fixture defaulting it.
  const f=await fixture(t);f.agent.privacy=privacy
  const old=await f.seed(JSON.stringify(bare),false)
  await f.start(createRoutedQueues);await f.drain(old.publicRunId)
  assert.equal(f.wireFor(sid).length,1,'unchanged baseline private/raw-forward branch')
  assert.equal(existsSync(f.custodyPath),false)
  assert.equal(f.calls.filter(c=>c.path === '/api/model/options' || c.path.endsWith('/chat/stream')).length,0)
})
test('a proven old admission dispatches while a later picker is pending',async t=>{
  const wire=JSON.stringify(bare),expected=await baselineWire(t,wire,true),f=await fixture(t),old=await f.seed(wire,true)
  await f.start(createRoutedQueues)
  const gate=f.holdPicker(),picking=f.fetch('/api/sessions/'+sid+'/model',post({model:B,provider:'anthropic',selection_version:0,selection_request_id:'pending-old'},'pending-old'))
  try {await gate.entered;await f.drain(old.publicRunId);assert.equal(f.wireFor(sid)[0].raw,expected)}
  finally {gate.release();await picking}
})

test('stale new admission cannot create or overwrite historical custody',async t=>{
  const f=await fixture(t);await f.start(createRoutedQueues)
  const picked=await f.fetch('/api/sessions/'+sid+'/model',post({model:B,provider:'anthropic',selection_version:0,selection_request_id:'new-choice'},'new-choice'))
  assert.equal(picked.status,200)
  await assert.rejects(f.fetch('/v1/runs',post({...bare,model:A,provider:'anthropic',selection_version:0},'stale-new')),error=>error.status===409)
  assert.equal(existsSync(f.custodyPath),false);assert.equal(f.wireFor(sid).length,0)
})

test('Incognito historical public row is never migrated',async t=>{
  const f=await fixture(t), incognito={...bare,session_id:'incog_synthetic'}
  const old=await f.seed(JSON.stringify(incognito),false)
  assert.equal(historicalUnselected(old,f.agent.id),false)
  await f.start(createRoutedQueues);await f.drain(old.publicRunId)
  assert.equal(f.wireFor(incognito.session_id).length,0)
  if(existsSync(f.custodyPath)) assert.equal(new Map(JSON.parse(readFileSync(f.custodyPath,'utf8'))).has(old.requestHash),false)
})
