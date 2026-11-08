import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readUndeliveredHelperReceipts, findIdleUndeliveredHelperReceipts, RECEIPT_PREFIX } from '../server/delegation-receipts.mjs'
import { startDelegationFollowThrough, findPendingFollowThroughs } from '../server/delegation-follow-through.mjs'
import { readHermesSessionTruth } from '../server/session-truth.mjs'
const now = Date.now()
function fixture({ delivery = 'dropped', final = '', lease = false, consumed = false, age = 30 } = {}) {
 const path = join(mkdtempSync(join(tmpdir(), 'wz-lost-')), 'state.db'); const db = new DatabaseSync(path)
 db.exec(`CREATE TABLE sessions(id TEXT, started_at REAL); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1, tool_calls TEXT, display_kind TEXT, finish_reason TEXT);
 CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
 CREATE TABLE async_delegations(delegation_id TEXT, origin_session_id TEXT, parent_session_id TEXT, state TEXT, delivery_state TEXT, result_json TEXT, dispatched_at REAL, completed_at REAL);`)
 db.prepare('INSERT INTO sessions VALUES (?,?)').run('wizard_a',now/1000-100)
 const add = db.prepare('INSERT INTO messages(session_id,role,content,timestamp,finish_reason) VALUES(?,?,?,?,?)')
 add.run('wizard_a','user','Ship the approved fix',now/1000-90,'')
 add.run('wizard_a','assistant', final || 'The review is running; I will finish when it returns.', now/1000-10, 'stop')
 if(consumed) add.run('wizard_a','user', RECEIPT_PREFIX+'deleg_a\nReal findings',now/1000-5,'')
 db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?)').run('deleg_a','wizard_a','wizard_a','completed',delivery,JSON.stringify({results:[{task_index:0,status:'completed',summary:'MUST-FIX: the skin text role is incorrect',tool_trace:[{secret:'NEVER RECOVER TRACES'}]}]}),now/1000-60,now/1000-age)
 if(lease) db.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run('wizard_a',now/1000+60)
 db.close(); return path
}
test('recovers dropped review which completed before the parent handoff',()=>{const rows=readUndeliveredHelperReceipts(fixture(),{now});assert.equal(rows.length,1);assert.match(rows[0].input,/MUST-FIX/);assert.ok(!rows[0].input.includes('NEVER RECOVER'));assert.equal(rows[0].key,'wizard-helper-receipt-deleg_a')})
test('pending receipt also recoverable without any completion message',()=>assert.equal(findIdleUndeliveredHelperReceipts(fixture({delivery:'pending'}),{now}).length,1))
test('projection stays agent-owned while completed result remains undelivered',()=>{const truth=readHermesSessionTruth(fixture(),['wizard_a'],now/1000).get('wizard_a');assert.equal(truth.helperResultUnanswered,true)})
test('active parent is never concurrently resumed',()=>assert.equal(findIdleUndeliveredHelperReceipts(fixture({lease:true}),{now}).length,0))
test('recovery is not replayed after transcript persistence',()=>assert.equal(readUndeliveredHelperReceipts(fixture({consumed:true}),{now}).length,0))
for (const state of ['needs_you','check']) test(`preserves newer ${state} owner gate`,()=>{const final=`Finished\n[WIZARD_STATUS_V1]{"state":"${state}","ask":"Outcome"}[/WIZARD_STATUS_V1]`;assert.equal(readUndeliveredHelperReceipts(fixture({final}),{now}).length,0)})
test('a FYI handoff does not settle unfinished work',()=>{const final='Still working\n[WIZARD_STATUS_V1]{"state":"fyi","ask":"No action needed; I own the rest"}[/WIZARD_STATUS_V1]';assert.equal(readUndeliveredHelperReceipts(fixture({final}),{now}).length,1)})
test('delivered results do not cause recovery',()=>assert.equal(readUndeliveredHelperReceipts(fixture({delivery:'delivered'}),{now}).length,0))
test('real watcher admits result once, retries a failed admission, respects disabled mode',async()=>{
 const path=fixture(); const calls=[];let on=false;let fail=true
 const w=startDelegationFollowThrough({sessionDbPath:path,intervalMs:60000,enabled:async()=>on,admit:async(s,i,k)=>{if(fail){fail=false;throw Error('503')}calls.push({s,i,k})}})
 try {await w.tick();assert.equal(calls.length,0);on=true;await w.tick();await w.tick();await w.tick();assert.equal(calls.length,1);assert.match(calls[0].i,/MUST-FIX/);assert.equal(calls[0].k,'wizard-helper-receipt-deleg_a')}finally{w.stop()}
})
const status = state => `Outcome\n[WIZARD_STATUS_V1]{"state":"${state}","ask":"Decide the release"}[/WIZARD_STATUS_V1]`
for (const state of ['needs_you','check']) test(`preserves ${state} before a late helper completion`,()=>{
 const path=fixture({final:status(state),age:1});assert.equal(readUndeliveredHelperReceipts(path,{now}).length,0)
 assert.ok(!readHermesSessionTruth(path,['wizard_a'],now/1000).get('wizard_a').helperResultUnanswered)
})
for (const state of ['done','needs_you','check']) test(`late original delivery after recovery cannot reopen ${state}, including restart`,async()=>{
 const path=fixture({consumed:true,final:status(state)});const db=new DatabaseSync(path)
 db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_a','user','[ASYNC DELEGATION BATCH COMPLETE — deleg_a] Late original findings',now/1000)
 db.close();assert.equal(findPendingFollowThroughs(path,{now}).length,0)
 assert.ok(!readHermesSessionTruth(path,['wizard_a'],now/1000).get('wizard_a').helperResultUnanswered)
 for(let n=0;n<2;n++){let calls=0;const w=startDelegationFollowThrough({sessionDbPath:path,intervalMs:60000,enabled:async()=>true,admit:async()=>{calls++}});try{await w.tick();assert.equal(calls,0)}finally{w.stop()}}
})
test('ordinary and recovered delivery use identical keys and saved-result input',()=>{
 const path=fixture();const recovered=readUndeliveredHelperReceipts(path,{now})[0];const db=new DatabaseSync(path)
 db.prepare("UPDATE async_delegations SET delivery_state='delivered'").run()
 db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_a','user','[ASYNC DELEGATION BATCH COMPLETE — deleg_a] Original findings',now/1000)
 db.close();const original=findPendingFollowThroughs(path,{now})[0];assert.equal(original.key,recovered.key);assert.equal(original.input,recovered.input)
})
test('two same-parent receipts cannot admit a second turn after first admission acquires lease',async()=>{
 const path=fixture();const db=new DatabaseSync(path);db.exec("INSERT INTO async_delegations SELECT 'deleg_b',origin_session_id,parent_session_id,state,delivery_state,result_json,dispatched_at,completed_at+1 FROM async_delegations")
 let calls=0;const w=startDelegationFollowThrough({sessionDbPath:path,intervalMs:60000,enabled:async()=>true,admit:async()=>{calls++;db.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run('wizard_a',Date.now()/1000+60)}})
 try{await w.tick();await w.tick();assert.equal(calls,1)}finally{w.stop();db.close()}
})
test('a newer genuine request releases the previous owner gate',()=>{
 const path=fixture({final:status('needs_you'),age:1});const db=new DatabaseSync(path)
 db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_a','user','Approved, ship it',now/1000-1)
 db.close();assert.equal(readUndeliveredHelperReceipts(path,{now}).length,1)
})
test('a consumed receipt alone suppresses late original delivery without a status marker',()=>{
 const path=fixture({consumed:true});const db=new DatabaseSync(path)
 db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_a','user','[ASYNC DELEGATION BATCH COMPLETE — deleg_a] Late original',now/1000)
 db.close();assert.equal(findPendingFollowThroughs(path,{now}).length,0);assert.ok(!readHermesSessionTruth(path,['wizard_a'],now/1000).get('wizard_a').helperResultUnanswered)
})

test('a done final written while the reviewer still ran gets its findings back',()=>{
 const final='Shipped. Independent review is running.\n[WIZARD_STATUS_V1]{"state":"done","ask":"Shipped"}[/WIZARD_STATUS_V1]'
 const path=fixture({final,age:1});assert.equal(findIdleUndeliveredHelperReceipts(path,{now}).length,1)
 assert.equal(readHermesSessionTruth(path,['wizard_a'],now/1000).get('wizard_a').helperResultUnanswered,true)
})
test('agent reading the saved result itself counts as consumed; prose naming it does not',()=>{
 const p1=fixture();let db=new DatabaseSync(p1)
 db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_a','tool','{"delegation_id":"deleg_a","status":"completed","results":[{"summary":"Saved findings"}]}',now/1000-5);db.close()
 assert.equal(readUndeliveredHelperReceipts(p1,{now}).length,0)
 const p2=fixture();db=new DatabaseSync(p2)
 db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_a','assistant','Review deleg_a is running',now/1000-5);db.close()
 assert.equal(readUndeliveredHelperReceipts(p2,{now}).length,1)
})
test('once the owner has replied after the helper finished, the stale result never auto-resumes',()=>{
 const path=fixture({final:status('needs_you'),age:20});const db=new DatabaseSync(path)
 db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_a','user','Actually, change the layout instead',now/1000-4)
 db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_a','assistant','Layout changed.\\n[WIZARD_STATUS_V1]{"state":"done","ask":"Done"}[/WIZARD_STATUS_V1]',now/1000-2)
 db.close();assert.equal(findIdleUndeliveredHelperReceipts(path,{now}).length,0)
 assert.ok(!readHermesSessionTruth(path,['wizard_a'],now/1000).get('wizard_a').helperResultUnanswered)
})
test('a machine cross-thread note after completion is not the owner moving on',()=>{
 const path=fixture({age:20});const db=new DatabaseSync(path)
 db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_a','user','[Wizard follow-through] Cross-thread note from another thread',now/1000-4)
 db.close();assert.equal(readUndeliveredHelperReceipts(path,{now}).length,1)
})
test('automatic resumption is only for fresh results (2 h)',()=>{
 const fresh=fixture({age:90*60});const db=new DatabaseSync(fresh)
 db.prepare("UPDATE messages SET timestamp=? WHERE role='user'").run(now/1000-2*3600);db.close()
 assert.equal(readUndeliveredHelperReceipts(fresh,{now}).length,1)
 assert.equal(readUndeliveredHelperReceipts(fixture({age:3*3600}),{now}).length,0)
})
