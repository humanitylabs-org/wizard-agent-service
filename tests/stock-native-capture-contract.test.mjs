import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sha256, events, observedFinal, classifyWire } from './helpers/stock-capture-contract.mjs'
const root=new URL('./fixtures/stock-native-20261101/',import.meta.url)
const bytes=n=>readFileSync(new URL(n,root)), json=n=>JSON.parse(bytes(n))
const provenance=json('provenance.json'), source=json('title-source-contract.json')
test('captured bytes remain pinned to the complete verified stock evidence index',()=>{
 assert.equal(provenance.complete_evidence_files_verified,539)
 assert.equal(provenance.evidence_manifest_sha256,'0326f165a1326b5f95fc46e4310b24d6caa816fc9932e66d2b96c66ddbafd28a')
 for(const [n,v] of Object.entries(provenance.files)) { const b=bytes(n);assert.equal(b.length,v.bytes,n);assert.equal(sha256(b),v.sha256,n) }
})
for(const variant of ['generic','named'])test(`stock ${variant}: actual chat final differs deliberately from requested/projection metadata`,()=>{
 const requested={provider:variant==='named'?'custom:fixture-local':'custom',model:'fixture-alpha'}
 const final=json(variant+'/native/chat-turn.response.body')
 assert.equal(final.runtime.provider,'custom');assert.equal(final.runtime.model,'fixture-alpha')
 assert(observedFinal(final.runtime,requested,'custom'));assert(!('resolved_route' in final.runtime))
 const native=json(variant+'/native/native-status-01.response.body')
 assert.equal(native.status,'completed');assert.equal(native.runtime.provider,'custom');assert.equal(native.runtime.model,'fixture-alpha')
 assert(!('model_lock' in native.runtime));assert(!observedFinal(native.runtime,requested,'custom'))
 const legacy=json(variant+'/native/legacy-projection.response.body')
 assert(!('model_lock' in legacy));assert(!('runtime' in legacy),'saved legacy metadata is not observed selected runtime')
})
test('stock named options expose a logical saved provider, not an observed endpoint attestation',()=>{
 const options=json('named/native/options.response.body');assert.equal(options.provider,'custom:fixture-local')
 const p=options.providers.find(p=>p.slug==='fixture-local');assert(p.authenticated);assert(p.is_user_defined);assert(p.models.includes('fixture-alpha'))
 assert(!('resolved_route' in options));assert(!('model_lock' in options))
})
test('stock stream exposes assistant and progress BEFORE confirmation; accepted phase is not final proof',()=>{
 for(const v of ['generic','named']){
  const e=events(bytes(v+'/native/stream-turn.response.body')),start=e[0].data.runtime
  assert.equal(start.model_lock,'accepted');assert.equal(start.provider,'');assert.equal(start.model,'')
  const f=e.findIndex(x=>x.event==='assistant.completed'),d=e.findIndex(x=>x.event==='assistant.delta'),p=e.findIndex(x=>x.event==='tool.progress')
  assert(d>0&&d<f);assert(p>d&&p<f);assert.equal(e[f].data.runtime.model_lock,'confirmed')
 }
})
test('negative mutations cannot turn requested-only, wrong route or native runs into observed finals',()=>{
 const r=json('named/native/chat-turn.response.body').runtime, q={provider:'custom:fixture-local',model:'fixture-alpha'}
 for(const mutation of [{model_lock:'accepted'},{model_lock:undefined},{provider:''},{provider:'wrong-provider'},{model:'fixture-beta'},{requested:{...q,provider:'custom:other'}},{requested:{...q,model:'fixture-beta'}},{requested:undefined}]){
  const candidate={...r,...mutation};assert.equal(observedFinal(candidate,q,'custom'),false,JSON.stringify(mutation))
  const visible=[];if(observedFinal(candidate,q,'custom'))visible.push('not authorized');assert.deepEqual(visible,[])
 }
 // Even a valid native final is primary-transport evidence, never endpoint/title-egress proof.
 assert(!('base_url' in r));assert(!('title_runtime' in r));assert(!('resolved_route' in r))
})
test('wire oracle v2: original two adapters produced FOUR replies PLUS TWO title inferences and FOUR metadata calls',()=>{
 const all=[]
 for(const name of ['was','was-main']){
  const before=json(`${name}-original-wire-before.stdout.log`),after=json(`${name}-original-wire-after.stdout.log`)
  assert.deepEqual(after.slice(0,before.length),before)
  const delta=after.slice(before.length),kinds=delta.map(r=>classifyWire(r.path,json(`provider-final/request-${String(r.index).padStart(3,'0')}.body`),source))
  // Exact first-turn title ordering; the second user reply has no title. No metadata/free relabel.
  assert.deepEqual(kinds,['metadata','reply_inference','title_inference','metadata','reply_inference'])
  assert.deepEqual(delta.filter(r=>r.classification==='inference').map(r=>r.model),['fixture-alpha','fixture-alpha','fixture-beta'])
  all.push(...kinds)
 }
 assert.equal(all.filter(k=>k.endsWith('_inference')).length,6)
 assert.equal(all.filter(k=>k==='reply_inference').length,4);assert.equal(all.filter(k=>k==='title_inference').length,2);assert.equal(all.filter(k=>k==='metadata').length,4)
})
test('title classifier requires exact pinned prompt, schema, endpoint and shape, not matching user text',()=>{
 const b=json('provider-final/request-015.body');assert.equal(classifyWire('/v1/chat/completions',b,source),'title_inference')
 for(const m of [{...b,response_format:undefined},{...b,extra:'x'},{...b,messages:[{...b.messages[0],content:b.messages[0].content+'x'},b.messages[1]]}])assert.notEqual(classifyWire('/v1/chat/completions',m,source),'title_inference')
 assert.equal(classifyWire('/wrong',b,source),'unclassified');assert.equal(classifyWire('/api/show',{name:'fixture-alpha',messages:b.messages},source),'unclassified')
})
