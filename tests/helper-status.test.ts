import { test } from 'vitest'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHelperStatuses } from '../server/helper-status.mjs'
import { resumeHelper } from '../server/helper-resume.mjs'
const now=2000000000000, sec=now/1000,sid='wizard_fixture'
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'helper-status-')),path=join(dir,'state.db'),db=new DatabaseSync(path);db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INT DEFAULT 1,display_kind TEXT,tool_calls TEXT); CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY,origin_session_id TEXT,parent_session_id TEXT,origin_ui_session_id TEXT,state TEXT,dispatched_at REAL,completed_at REAL,task_json TEXT,delivery_state TEXT,result_json TEXT);CREATE TABLE sessions(id TEXT PRIMARY KEY,started_at REAL,model TEXT,model_config TEXT);CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL);`);db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,'user','Build the request',sec-3000);return Promise.resolve(fn({db,path})).finally(()=>{db.close();rmSync(dir,{recursive:true,force:true})})}
function add(db,state='running',id='deleg_one',ended=sec-720,n=1){db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,sid,null,'',state,sec-2400,ended,JSON.stringify({goals:Array(n).fill('Task')}),'pending',JSON.stringify({results:[{task_index:0,status:'completed',summary:'Saved fixture findings'}]}))}
const read=path=>readHelperStatuses(path,[sid],{now}).get(sid)
test('HTTP continuation validates access, payload and the original receipt identity',()=>fixture(async({db,path})=>{
 const {createWizardServer,listen}=await import('../server/service.mjs');add(db,'completed');
 const delta=Date.now()/1000-sec;db.prepare('UPDATE messages SET timestamp=timestamp+?').run(delta);db.prepare('UPDATE async_delegations SET dispatched_at=dispatched_at+?,completed_at=completed_at+?').run(delta,delta);
 const calls=[];const s=createWizardServer({requireAccess:false,joinedDelegation:'off',hermesStatePath:path,sessionDbPath:path,followThrough:false,fetchImpl:async(url,o)=>{calls.push({url,options:o});return new Response(JSON.stringify(String(url).endsWith('/v1/capabilities')?{}:{run_id:'helper_fixture',status:'running'}),{status:202,headers:{'content-type':'application/json'}})}});await listen(s);const url=`http://127.0.0.1:${s.address().port}/wizard/helper-continue`;
 try {
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session_id:'bad'})})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session_id:sid})})).status,202);
  const admissions=calls.filter(r=>r.url.endsWith('/v1/runs'));assert.equal(admissions.length,1);assert.equal(admissions[0].options.headers.get('Idempotency-Key'),'wizard-helper-receipt-deleg_one');assert.ok(!admissions[0].url.includes('/wizard/hermes'));
 }finally{await new Promise(r=>s.close(r))}
 const protectedServer=createWizardServer({requireAccess:true,accessVerifier:async()=>false,hermesStatePath:path,followThrough:false});await listen(protectedServer);
 try{assert.equal((await fetch(`http://127.0.0.1:${protectedServer.address().port}/wizard/helper-continue`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session_id:sid})})).status,403)}finally{await new Promise(r=>protectedServer.close(r))}
}))
test('session-list projection carries helper status through the real API code',()=>fixture(async({db,path})=>{
 const {createWizardServer,listen}=await import('../server/service.mjs');add(db,'running');db.exec('ALTER TABLE messages ADD COLUMN finish_reason TEXT DEFAULT "stop";');db.prepare('INSERT INTO sessions(id,started_at) VALUES(?,?)').run(sid,sec-3000);
 const delta=Date.now()/1000-sec;db.prepare('UPDATE messages SET timestamp=timestamp+?').run(delta);db.prepare('UPDATE async_delegations SET dispatched_at=dispatched_at+?,completed_at=completed_at+?').run(delta,delta);
 const s=createWizardServer({archivedSessionReader:()=>[],requireAccess:false,hermesKey:'fixture-only',hermesStatePath:path,sessionDbPath:path,followThrough:false,fetchImpl:async(url)=>new Response(JSON.stringify(String(url).includes('/api/sessions?')?{data:[{id:sid,source:'wizard-mobile',title:'Helper example'}]}:{data:[]}),{headers:{'content-type':'application/json'}})});await listen(s);
 try{const r=await fetch(`http://127.0.0.1:${s.address().port}/wizard/hermes/api/sessions?limit=10`);assert.equal(r.status,200);const p=await r.json();assert.equal(p.data[0].wizard_helper_status.phase,'running');assert.equal(p.data[0].wizard_helper_status.pending,1)}finally{await new Promise(r=>s.close(r))}
}))
test('delivered but unanswered helper stays Working and admits the original receipt after steering and FYI',()=>fixture(async({db,path})=>{
 const {createWizardServer,listen}=await import('../server/service.mjs');add(db,'completed');
 db.exec('ALTER TABLE messages ADD COLUMN finish_reason TEXT DEFAULT "stop";');
 db.prepare('INSERT INTO sessions(id,started_at) VALUES(?,?)').run(sid,sec-3000);
 db.exec("UPDATE async_delegations SET delivery_state='delivered'");
 const message=(role,content,at)=>db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,role,content,at);
 message('user','Keep the approved scope; do not deploy',sec-800);
 message('user','[ASYNC DELEGATION BATCH COMPLETE — deleg_one] Findings',sec-600);
 message('assistant','Still integrating [WIZARD_STATUS_V1]{"state":"fyi","ask":"Helpers returned; still verifying"}[/WIZARD_STATUS_V1]',sec-500);
 const delta=Date.now()/1000-sec;db.prepare('UPDATE messages SET timestamp=timestamp+?').run(delta);db.prepare('UPDATE async_delegations SET dispatched_at=dispatched_at+?,completed_at=completed_at+?').run(delta,delta);
 const calls=[];
 const s=createWizardServer({archivedSessionReader:()=>[],requireAccess:false,joinedDelegation:'off',hermesKey:'fixture-only',hermesStatePath:path,sessionDbPath:path,followThrough:false,fetchImpl:async(url,o)=>{
  calls.push({url,options:o});return new Response(JSON.stringify(String(url).includes('/api/sessions?')?{data:[{id:sid,source:'wizard-mobile',title:'Delivered fixture',status:'completed'}]}:String(url).endsWith('/v1/capabilities')?{}:{run_id:'delivered_fixture',status:'running'}),{status:String(url).endsWith('/v1/runs')?202:200,headers:{'content-type':'application/json'}})
 }});await listen(s);const origin=`http://127.0.0.1:${s.address().port}`;
 try{
  const list=await fetch(origin+'/wizard/hermes/api/sessions?limit=10');assert.equal(list.status,200);const row=(await list.json()).data[0];
  assert.equal(row.wizard_helper_status.phase,'stalled');assert.equal(row.wizard_helper_status.returned,1);assert.equal(row.wizard_helper_status.resumeEligible,true);
  const response=await fetch(origin+'/wizard/helper-continue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session_id:sid})});
  console.log('DELIVERED_RECOVERY_RECEIPT '+JSON.stringify({listStatus:row.status,phase:row.wizard_helper_status.phase,continueStatus:response.status}));
  assert.equal(row.status,'running');assert.equal(response.status,202);
  const admissions=calls.filter(r=>r.url.endsWith('/v1/runs'));assert.equal(admissions.length,1);assert.equal(admissions[0].options.headers.get('Idempotency-Key'),'wizard-helper-receipt-deleg_one');assert.ok(JSON.parse(admissions[0].options.body).input.includes('Saved fixture findings'));
 }finally{await new Promise(r=>s.close(r))}
}))
test('assigned batch count is exact and partial sibling remains pending',()=>fixture(({db,path})=>{add(db,'running','deleg_a',null,2);add(db,'completed','deleg_b');assert.deepEqual([read(path).phase,read(path).pending,read(path).returned],['running',2,1]);assert.equal(read(path).resumeEligible,false)}))
test('lease means parent integrating, never stalled',()=>fixture(({db,path})=>{add(db,'completed');db.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run(sid,sec+60);assert.equal(read(path).phase,'integrating');assert.equal(read(path).resumeEligible,false)}))
test('active API run without a lease also means integrating',()=>fixture(({db,path})=>{add(db,'completed');assert.equal(readHelperStatuses(path,[sid],{now,activeSessionIds:new Set([sid])}).get(sid).phase,'integrating')}))
test('fresh returned results get a short automatic-continuation window',()=>fixture(({db,path})=>{add(db,'completed','deleg_one',sec-30);assert.equal(read(path).phase,'waiting')}))
test('idle completed receipt is stalled and safely resumable',()=>fixture(async({db,path})=>{add(db,'completed');assert.equal(read(path).phase,'stalled');let admitted=[];const outcome=await resumeHelper({sessionDbPath:path,sessionId:sid,now,admit:async(...args)=>admitted.push(args)});assert.equal(outcome.status,202);assert.equal(admitted.length,1);assert.equal(admitted[0][2],'wizard-helper-receipt-deleg_one');assert.ok(admitted[0][1].includes('Saved fixture findings'))}))
test('running sibling blocks manual resume',()=>fixture(async({db,path})=>{add(db,'completed');add(db,'running','deleg_two',null);const r=await resumeHelper({sessionDbPath:path,sessionId:sid,now,admit:()=>assert.fail('must not admit')});assert.equal(r.status,409)}))
test('owner decision holds helper recovery',()=>fixture(async({db,path})=>{add(db,'completed');db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,'assistant','Choose [WIZARD_STATUS_V1]{"state":"needs_you","ask":"Choose layout","subject":"Wizard OS"}[/WIZARD_STATUS_V1]',sec-500);assert.equal(read(path).phase,'held');assert.equal((await resumeHelper({sessionDbPath:path,sessionId:sid,now,admit:()=>assert.fail()})).status,409)}))
test('old running and returned receipts are uncertain',()=>fixture(({db,path})=>{add(db,'running');db.prepare('UPDATE async_delegations SET dispatched_at=?').run(sec-7*3600);assert.equal(read(path).phase,'uncertain');db.prepare('UPDATE messages SET timestamp=?').run(sec-10000);db.prepare("UPDATE async_delegations SET state='completed',dispatched_at=?,completed_at=?").run(sec-9000,sec-8000);assert.equal(read(path).phase,'uncertain')}))
test('later user request does not inherit completed helpers',()=>fixture(({db,path})=>{add(db,'completed');db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,'user','New task',sec-200);assert.equal(read(path),undefined)}))
test('steering an active request keeps its running helpers visible',()=>fixture(({db,path})=>{add(db,'running');db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,'user','Steer the current task',sec-200);assert.equal(read(path).phase,'running')}))
test('actual answered completion clears helper state',()=>fixture(({db,path})=>{add(db,'completed');db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,'user','[ASYNC DELEGATION BATCH COMPLETE — deleg_one] Findings',sec-600);db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,'assistant','Finished [WIZARD_STATUS_V1]{"state":"done","ask":"Verified result","subject":"Wizard OS"}[/WIZARD_STATUS_V1]',sec-500);assert.equal(read(path),undefined)}))
test('a premature done before helper completion is not completion evidence',()=>fixture(({db,path})=>{add(db,'completed');db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,'assistant','[WIZARD_STATUS_V1]{"state":"done","ask":"Premature answer","subject":"Wizard OS"}[/WIZARD_STATUS_V1]',sec-900);assert.equal(read(path).phase,'stalled')}))
