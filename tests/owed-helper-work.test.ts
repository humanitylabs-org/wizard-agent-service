import { test } from 'vitest'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { Supervisor } from '../server/supervisor.mjs'
import { currentOwnerResult, ownerMovedOn, RECEIPT_PREFIX } from '../server/delegation-receipts.mjs'
import { findPendingFollowThroughs, startDelegationFollowThrough } from '../server/delegation-follow-through.mjs'
import { requestWatermark, captureContinuation, continuationCurrent } from '../server/helper-continuation.mjs'
import { readSupervisorBuildWaits, readSupervisorWaitRevision, SUPERVISOR_WAIT_CAP_SECONDS } from '../server/supervisor-wait.mjs'
const sid = 'wizard_owed', builder = 'wizard_builder_test', now = Date.now(), sec = now / 1000
const status = (state: string) => `Outcome\n[WIZARD_STATUS_V1]{"state":"${state}","ask":"Result"}[/WIZARD_STATUS_V1]`
async function fixture(fn: (ctx: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'owed-work-')), path = join(dir, 'state.db'), ledger = join(dir, 'supervisor.db')
  const db = new DatabaseSync(path), supervisorOwner = new Supervisor({ statePath: ledger, deliver: async () => { throw Error('test must not dispatch') } }), supervisor = supervisorOwner.db
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,started_at REAL,model TEXT,model_config TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INT DEFAULT 1,display_kind TEXT,finish_reason TEXT DEFAULT 'stop',tool_calls TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL);
    CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY,origin_session_id TEXT,parent_session_id TEXT,origin_ui_session_id TEXT,state TEXT,dispatched_at REAL,completed_at REAL,task_json TEXT,delivery_state TEXT,result_json TEXT);`)
  for (const id of [sid,builder]) db.prepare('INSERT INTO sessions(id,started_at) VALUES(?,?)').run(id,sec-300)
  supervisor.prepare('INSERT INTO reviews(id,thread,state) VALUES(?,?,?)').run('review',sid,'open')
  const say = (role: string,content: string,at: number,active=1,kind: string | null=null) => db.prepare('INSERT INTO messages(session_id,role,content,timestamp,active,display_kind) VALUES(?,?,?,?,?,?)').run(sid,role,content,at,active,kind)
  const server = createWizardServer({ archivedSessionReader:()=>[], requireAccess:false, hermesKey:'fixture-only', hermesStatePath:path,sessionDbPath:path,followThrough:false, supervisorStatePath:ledger, supervisorIntervalMs:600000,
    fetchImpl:async (url: string)=>new Response(JSON.stringify(String(url).includes('/api/sessions?')?{data:[{id:sid,source:'api_server',title:'Owed work'}]}:{data:[]}),{headers:{'content-type':'application/json'}}),
  })
  await listen(server)
  const list = async()=> (await (await fetch(`http://127.0.0.1:${(server.address() as any).port}/wizard/hermes/api/sessions?limit=10`)).json()).data[0]
  try { await fn({db,supervisor,path,ledger,say,list,server}) } finally { server.closeAllConnections?.();await new Promise(r=>server.close(r));db.close();supervisor.close();rmSync(dir,{recursive:true,force:true}) }
}

test('a thread whose helper results arrive after compaction stays in Working until answered',()=>fixture(async({db,path,say,list})=>{
  say('user','Please choose a rollout',sec-300)
  say('assistant',status('needs_you'),sec-250)
  const request=say('user','Approved. Ship it and finish the checks.',sec-200,0)
  say('assistant','My helpers are doing the checks.',sec-150)
  db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)').run('deleg_owed',sid,sid,sid,'completed',sec-190,sec-20,'[]','delivered',JSON.stringify({results:[{task_index:0,status:'completed',summary:'Saved checks passed'}]}))
  say('user','[ASYNC DELEGATION BATCH COMPLETE — deleg_owed]\nSaved checks passed',sec-10)
  assert.equal(currentOwnerResult(db,sid),null)
  assert.equal(requestWatermark(db,sid)!.id,Number(request.lastInsertRowid))
  const pending=findPendingFollowThroughs(path,{now})
  assert.equal(pending.length,1);assert.match(pending[0].input!,new RegExp('^'+RECEIPT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))
  assert.equal(continuationCurrent(path,captureContinuation(path,pending[0]),now),true)
  assert.equal((await list()).status,'running');assert.equal((await list()).wizard_waiting_on,'helper')
  const calls: any[][]=[];const watcher=startDelegationFollowThrough({sessionDbPath:path,enabled:()=>true,intervalMs:60000,admit:async(...args: any[])=>calls.push(args)})
  try {await watcher.tick();await watcher.tick();assert.equal(calls.length,1);assert.equal(calls[0][2],'wizard-helper-receipt-deleg_owed')}finally{await watcher.stop()}
  say('user',RECEIPT_PREFIX+'deleg_owed\nSaved findings',sec-5,1,'internal_notification')
  say('assistant',status('done'),sec-1)
  assert.notEqual((await list()).status,'running')
}))

test('a typed delivered helper result can resume after ledger cleanup without renewing its dispatch deadline',()=>fixture(async({db,path,say})=>{
  say('user','Finish the checks',sec-300,0)
  const dispatch=say('tool',JSON.stringify({status:'dispatched',mode:'background',delegation_id:'deleg_owed',count:5}),sec-200)
  const completion=say('user','[ASYNC DELEGATION BATCH COMPLETE — deleg_owed]\nAll saved checks passed',sec-10,1,'async_delegation_complete')
  const pending=findPendingFollowThroughs(path,{now})[0]
  const token=captureContinuation(path,pending)
  assert.ok(token);assert.equal(token!.completedAt,sec-200)
  assert.equal(continuationCurrent(path,token,now),true)
  // A fresh completion cannot renew the original dispatch's authority.
  assert.equal(continuationCurrent(path,token,(sec-200+7201)*1000),false)
  db.prepare("UPDATE messages SET display_kind=NULL WHERE id=?").run(completion.lastInsertRowid)
  assert.equal(captureContinuation(path,pending),null);assert.equal(continuationCurrent(path,token,now),false)
  db.prepare("UPDATE messages SET display_kind='async_delegation_complete' WHERE id=?").run(completion.lastInsertRowid)
  db.prepare("UPDATE messages SET content='{}' WHERE id=?").run(dispatch.lastInsertRowid)
  assert.equal(captureContinuation(path,pending),null);assert.equal(continuationCurrent(path,token,now),false)
}))

for (const gate of ['needs_you','check']) test(`a genuine ${gate} written after the latest compacted request still holds`,()=>fixture(async({db,path,say,list})=>{
  say('user','Ship the fix',sec-200,0);say('assistant',status(gate),sec-100)
  for(const machine of ['[Wizard follow-through] Findings','[supervisor update]\nBuild ended','[Wizard schedule] Run later','[Wizard heavy-work completion] Saved receipt','[Wizard heavy-work notice] Saved receipt','[CONTEXT COMPACTION — REFERENCE ONLY]']) say('user',machine,sec-50,0)
  say('user','A machine wakeup',sec-40,0,'process_wakeup:test')
  assert.equal(currentOwnerResult(db,sid),gate);assert.equal(ownerMovedOn(db,sid,sec-100),false)
  assert.equal(requestWatermark(db,sid)!.at,sec-200)
  db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)').run('deleg_owed',sid,sid,sid,'completed',sec-190,sec-20,'[]','dropped',JSON.stringify({results:[{summary:'Findings'}]}))
  assert.equal(findPendingFollowThroughs(path,{now}).length,0);assert.notEqual((await list()).status,'running')
  say('user','Changed my mind; do something else',sec-10,0)
  assert.equal(currentOwnerResult(db,sid),null);assert.equal(ownerMovedOn(db,sid,sec-20),true)
}))

test('a supervisor thread waiting on its builder stays in Working',()=>fixture(async({db,supervisor,path,ledger,say,list})=>{
  say('user','Please repair it',sec-300,0);say('assistant','The builder is checking it.',sec-100)
  supervisor.prepare('INSERT INTO builds VALUES(?,?,?,?,?)').run('build','review',builder,'running',JSON.stringify({created_at:(sec-200)*1000}))
  const waits=()=>readSupervisorBuildWaits(ledger,path,[sid],now)
  assert.equal(waits().get(sid).pending,1)
  assert.equal((await list()).status,'running');assert.equal((await list()).wizard_waiting_on,'helper')
  // A dispatch run ending while the builder waits on a helper is not build completion.
  supervisor.exec("UPDATE builds SET state='ended'");assert.equal(waits().get(sid).pending,1)
  // Legacy rows use the builder session start rather than extending the cap on each read.
  supervisor.exec("UPDATE builds SET data='{}'");assert.equal(waits().get(sid).pending,1)
  const before=readSupervisorWaitRevision(ledger)
  supervisor.exec("UPDATE builds SET state='reported'");assert.equal(waits().size,0);assert.notEqual((await list()).status,'running');assert.notEqual(readSupervisorWaitRevision(ledger),before)
  supervisor.exec("UPDATE builds SET state='running'");say('assistant',status('needs_you'),sec-50);assert.equal(waits().size,0)
  say('user','Approved, finish it',sec-40,0);assert.equal(waits().size,1)
  say('assistant',status('done'),sec-10);assert.equal(waits().size,1) // a premature done cannot settle an unfinished builder
  supervisor.exec("UPDATE builds SET state='ended'")
  db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run(builder,'assistant',status('done'),sec-15)
  assert.equal(waits().size,0) // builder answered, then parent integrated its answer
  say('user','Continue',sec-5,0);assert.equal(waits().size,1)
  supervisor.exec("UPDATE reviews SET state='closed'");assert.equal(waits().size,0)
  supervisor.exec("UPDATE reviews SET state='open'");assert.equal(readSupervisorBuildWaits(ledger,path,[sid],now+(SUPERVISOR_WAIT_CAP_SECONDS+1)*1000).size,0)
}))
