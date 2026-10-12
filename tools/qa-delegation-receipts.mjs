import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readUndeliveredHelperReceipts, findIdleUndeliveredHelperReceipts, RECEIPT_PREFIX } from '../server/delegation-receipts.mjs'
import { startDelegationFollowThrough } from '../server/delegation-follow-through.mjs'
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
for (const state of ['done','needs_you','check']) test(`preserves newer ${state} owner result`,()=>{const final=`Finished\n[WIZARD_STATUS_V1]{"state":"${state}","ask":"Outcome"}[/WIZARD_STATUS_V1]`;assert.equal(readUndeliveredHelperReceipts(fixture({final}),{now}).length,0)})
test('a FYI handoff does not settle unfinished work',()=>{const final='Still working\n[WIZARD_STATUS_V1]{"state":"fyi","ask":"No action needed; I own the rest"}[/WIZARD_STATUS_V1]';assert.equal(readUndeliveredHelperReceipts(fixture({final}),{now}).length,1)})
test('delivered results do not cause recovery',()=>assert.equal(readUndeliveredHelperReceipts(fixture({delivery:'delivered'}),{now}).length,0))
test('real watcher admits result once, retries a failed admission, respects disabled mode',async()=>{
 const path=fixture(); const calls=[];let on=false;let fail=true
 const w=startDelegationFollowThrough({sessionDbPath:path,intervalMs:60000,enabled:async()=>on,admit:async(s,i,k)=>{if(fail){fail=false;throw Error('503')}calls.push({s,i,k})}})
 try {await w.tick();assert.equal(calls.length,0);on=true;await w.tick();await w.tick();await w.tick();assert.equal(calls.length,1);assert.match(calls[0].i,/MUST-FIX/);assert.equal(calls[0].k,'wizard-helper-receipt-deleg_a')}finally{w.stop()}
})
