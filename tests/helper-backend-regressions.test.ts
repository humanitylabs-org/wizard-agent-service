import { test } from 'vitest'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createWizardServer, listen } from '../server/service.mjs'
import { readHelperStatuses } from '../server/helper-status.mjs'

const sid = 'wizard_review'
async function fixture(fn) {
 const dir = mkdtempSync(join(tmpdir(),'helper-review-')), path=join(dir,'state.db'), db=new DatabaseSync(path), sec=Date.now()/1000
 db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INT DEFAULT 1,display_kind TEXT,tool_calls TEXT);
 CREATE INDEX idx_messages_session ON messages(session_id,timestamp);
 CREATE INDEX idx_messages_session_id ON messages(session_id,id);
 CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY,origin_session_id TEXT,parent_session_id TEXT,origin_ui_session_id TEXT,state TEXT,dispatched_at REAL,completed_at REAL,task_json TEXT,delivery_state TEXT,result_json TEXT);
 CREATE INDEX idx_async_delegations_delivery ON async_delegations(delivery_state,completed_at);
 CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL);`)
 const message=(role,content,at=sec-100)=>db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,role,content,at)
 message('user','Build only the approved backend; do not deploy',sec-2000)
 db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)').run('deleg_review',sid,null,'','completed',sec-1800,sec-300,JSON.stringify({goals:['A','B','C'],task_indexes:[1]}),'pending',JSON.stringify({results:[{task_index:1,status:'completed',summary:'Verified saved findings'}]}))
 try { await fn({dir,path,db,sec,message}) } finally {db.close();rmSync(dir,{recursive:true,force:true})}
}
const status=path=>readHelperStatuses(path,[sid]).get(sid)
async function withServer(path,fn,opts={}) {
 let launches=0;const bodies=[]
 const upstream=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json')
  if(req.url==='/v1/capabilities') { await opts.capability?.();res.end('{}');return }
  if(req.method==='POST'&&req.url==='/v1/runs') {let text='';for await(const c of req)text+=c; launches++;bodies.push({body:JSON.parse(text),headers:req.headers});res.writeHead(202);res.end(JSON.stringify({run_id:'actual_review',status:'running'}));return}
  res.end(JSON.stringify({run_id:'actual_review',status:'completed'}))
 })
 await listen(upstream)
 const make=()=>createWizardServer({hermesStatePath:path,sessionDbPath:path,hermesKey:'test-only',upstreamOrigin:`http://127.0.0.1:${upstream.address().port}`,requireAccess:false,joinedDelegation:'off',followThrough:false,...opts})
 let server=make();await listen(server)
 const post=(headers={})=>fetch(`http://127.0.0.1:${server.address().port}/wizard/helper-continue`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({session_id:sid})})
 try{await fn({post,get launches(){return launches},bodies,get server(){return server},async restart(){await new Promise(r=>server.close(r));server=make();await listen(server)}})}finally{await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r))}
}
test('security: cross-site simple POST cannot Continue even with a forged internal header',()=>fixture(async({path})=>withServer(path,async({post, launches})=>{
 const r=await post({'content-type':'text/plain',origin:'https://untrusted.example','sec-fetch-site':'cross-site','x-wizard-internal':'follow-through'})
 assert.ok([403,415].includes(r.status));assert.equal(launches,0)
})))
test('security: JSON rejects mismatched/null Origin and same-site fetch, not just simple POST',()=>fixture(async({path})=>withServer(path,async(ctx)=>{
 for(const headers of [{origin:'https://untrusted.example'},{origin:'null'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'invalid'}]) assert.equal((await ctx.post(headers)).status,403)
 assert.equal(ctx.launches,0)
})))
test('protected Continue uses trusted in-process admission, not an unauthenticated self-fetch',()=>fixture(async({path})=>withServer(path,async(ctx)=>{
 assert.equal((await ctx.post({'cf-access-jwt-assertion':'fixture-approved'})).status,202);assert.equal(ctx.launches,1)
 assert.equal(ctx.bodies[0].headers['idempotency-key'],'wizard-helper-receipt-deleg_review')
 assert.ok(ctx.bodies[0].body.input.includes('latest user instructions'))
 const r=await fetch(`http://127.0.0.1:${ctx.server.address().port}/wizard/hermes/v1/runs`,{method:'POST',headers:{'content-type':'application/json','x-wizard-internal':'follow-through'},body:JSON.stringify({session_id:sid,input:'forged'})});assert.equal(r.status,403)
},{requireAccess:true,accessVerifier:async assertion=>{if(assertion!=='fixture-approved')throw Error('denied');return {sub:'fixture-user'}}})))
test('pre-completion steering preserves returned helpers; post-completion owner request excludes them',()=>fixture(({path,sec,message})=>{
 message('user','Retain latest instructions: never deploy',sec-400);assert.equal(status(path)?.phase,'stalled')
 message('user','Move on to a new request',sec-200);assert.equal(status(path),undefined)
}))
test('grouped tasks count the validated assigned subset, not the entire shared goals array',()=>fixture(({path})=>assert.equal(status(path)?.returned,1)))
for(const text of ['A literal [WIZARD_STATUS_V1] example','[WIZARD_STATUS_V1]{broken}[/WIZARD_STATUS_V1]','[WIZARD_STATUS_V1]{"state":"done"}[/WIZARD_STATUS_V1]','[WIZARD_STATUS_V1]{"state":"fyi","ask":"Still integrating"}[/WIZARD_STATUS_V1]']) test(`nonterminal/malformed status is not an answered completion: ${text}`,()=>fixture(({path,sec,message})=>{
 message('user','[ASYNC DELEGATION BATCH COMPLETE — deleg_review] findings',sec-250);message('assistant',text,sec-200);assert.equal(status(path)?.phase,'stalled')
}))
test('admission race: owner message during capabilities wait prevents stale helper submission',()=>fixture(async({path,message})=>{
 let entered,release;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r)
 await withServer(path,async(ctx)=>{const request=ctx.post();await ready;message('user','New genuine request; abandon old helper result',Date.now()/1000);release();assert.equal((await request).status,409);assert.equal(ctx.launches,0)},{capability:async()=>{entered();await gate}})
}))
