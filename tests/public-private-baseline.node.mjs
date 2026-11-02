// Source-only synthetic differential. Never opens an installed private profile.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LockedRunBridge as Candidate } from '../server/locked-run-bridge.mjs'
import { createRoutedQueues as candidateQueues } from '../server/routed-run-queue.mjs'
const baseline=process.env.BASELINE_SERVICE
assert.ok(baseline,'BASELINE_SERVICE must name the exact sealed live-source checkout')
const {LockedRunBridge:Baseline}=await import(pathToFileURL(join(baseline,'server/locked-run-bridge.mjs')))
const {createRoutedQueues:baselineQueues}=await import(pathToFileURL(join(baseline,'server/routed-run-queue.mjs')))
const route={model:'claude-sonnet-5-5',provider:'anthropic'}
const frame=(event,payload)=>`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}})
const post=value=>({method:'POST',headers:{'Idempotency-Key':'synthetic'},body:JSON.stringify(value)})
for(const requested of [{},route,{model:'claude-opus-5-5',provider:'anthropic'},{model:'fixture-other',provider:'custom:fixture'}]) test('private/unknown bridge baseline differential '+JSON.stringify(requested),async t=>{
 const now=Date.UTC(2026,0,2,3,4,5)
 t.mock.timers.enable({apis:['Date'],now})
 async function run(Bridge){
  const calls=[],logs=[]
  const b=new Bridge({origin:'http://fixture',isPublicSession:()=>false,sessionRoute:()=>route,log:l=>logs.push(l),fetchImpl:async(url,init)=>{
   const body=init?.body?JSON.parse(init.body):undefined;calls.push({url,body,signal:init?.signal?.aborted})
   if(url.endsWith('/chat/stream'))return new Response(frame('run.started',{run_id:'native_fixture',runtime:{model:body.model,provider:body.provider,model_lock:'accepted'}})+frame('run.completed',{runtime:{model:body.model,provider:body.provider,model_lock:'confirmed'}}),{headers:{'Content-Type':'text/event-stream'}})
   return json({runtime:{...route,model_lock:'accepted'}})
  }})
  const selected=await(await b.fetch('http://fixture/api/sessions/wizard_private/model',post(route))).json()
  const response=await b.fetch('http://fixture/v1/runs',post({session_id:'wizard_private',input:'synthetic',...requested}))
  const payload=await response.json();await Promise.all([...b.streams])
  if(requested.provider==='custom:fixture') assert.equal(b.entries.size,0,'unlocked pass-through creates no synthetic admission timestamp')
  else {
   assert.equal(payload.created_at,now/1000,'native admission timestamp derives from the same frozen clock')
   assert.equal([...b.entries.values()][0].createdAt,now)
  }
  return {selected,status:response.status,payload,calls,logs}
 }
 assert.deepEqual(await run(Candidate),await run(Baseline))
})
for(const privacy of ['private',undefined]) for(const kind of ['host-profile','container','restricted']) test(`routed ${privacy||'unknown'} ${kind}: legacy provider stripping, run request counts and replies unchanged`,async()=>{
 async function run(factory){
  const root=mkdtempSync(join(tmpdir(),'public-baseline-'));mkdirSync(join(root,'fixture'))
  const agent={id:'fixture',privacy,kind,model:{provider:'tinfoil',model:'fixture-a',allowed_models:['fixture-a','fixture-b']}}
  const calls=[],disposers=[]
  const registry={agentsDir:root,list:()=>[agent],apiKey:()=> 'synthetic-no-authority',fetchAgent:async(a,path,init={})=>{
   const body=init.body?JSON.parse(init.body):undefined;calls.push({path,method:init.method||'GET',body})
   if(path==='/v1/runs')return json({run_id:'native_fixture',status:'running'})
   if(path.endsWith('/model'))return json({runtime:{model:body.model,provider:'custom',model_lock:'accepted'}})
   if(path.startsWith('/api/sessions/'))return json({id:'wizard_private',model:'fixture-a',provider:'custom'})
   return json({run_id:'native_fixture',status:'running'})
  }}
  try{
   const q=factory({registry,pollIntervalMs:0,own:f=>disposers.push(f)})
   const selected=await q.fetch(agent,'/api/sessions/wizard_private/model',post({model:'fixture-b'}));const selection=selected?await selected.json():null
   const response=await q.fetch(agent,'/v1/runs',post({session_id:'wizard_private',input:'synthetic',model:'fixture-b'}))
   const payload=await response.json()
   for(let i=0;i<100&&!calls.some(c=>c.path==='/v1/runs');i++)await new Promise(r=>setTimeout(r,5))
   assert.equal(calls.filter(c=>c.path==='/v1/runs').length,1)
   return {selection,status:response.status,queued:payload.status,calls}
  }finally{for(const f of disposers)await f();rmSync(root,{recursive:true,force:true})}
 }
 assert.deepEqual(await run(candidateQueues),await run(baselineQueues))
})
test('Incognito implementation and native lock creation/confirmation code remain live-source bytes',()=>{
 for(const file of ['server/incognito.mjs']) assert.equal(readFileSync(new URL('../'+file,import.meta.url),'utf8'),readFileSync(join(baseline,file),'utf8'))
 const current=readFileSync(new URL('../server/locked-run-bridge.mjs',import.meta.url),'utf8'),old=readFileSync(join(baseline,'server/locked-run-bridge.mjs'),'utf8')
 for(const marker of ['export function runtimeMatches','export function sessionMessage','export function selectLockedRoute']){
  const section=text=>text.slice(text.indexOf(marker),text.indexOf('\n}',text.indexOf(marker))+2)
  assert.equal(section(current),section(old),marker)
 }
 assert.equal(current.slice(current.indexOf('  async start(')),old.slice(old.indexOf('  async start(')),'start, journal, stream, stock runtime confirmation unchanged')
})
