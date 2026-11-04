// Owner-run acceptance only: atomically seed one synthetic failed receipt, read detail, remove exact targets.
// No provider call is made. Requires explicit flag because this writes a synthetic session/receipt to live state.
// node scripts/retry-saved-live-proof.mjs ORIGIN QUEUE_DB --allow-synthetic-live-state
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {queueRequestHash} from '../server/run-queue.mjs'
const [origin,statePath,permission]=process.argv.slice(2)
if(permission!=='--allow-synthetic-live-state'||!statePath||!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin||''))throw Error('Explicit loopback origin, queue database and --allow-synthetic-live-state required')
const sid='wizard_synthetic_retry_'+randomUUID().replaceAll('-',''),id='wizardq_'+randomUUID().replaceAll('-','')
const input='Synthetic Retry acceptance: this saved first message never reached the AI.'
const body=JSON.stringify({session_id:sid,input,model:'synthetic-no-provider-call',provider:'synthetic-no-provider-call',require_model_lock:true})
const payload={status:'failed',last_event:'run.failed',error:{type:'provider_preflight_failed'},safe_error:'Synthetic sign-in outage. Your message is saved.'}
const api=async(path,init={})=>{const r=await fetch(origin+'/wizard/hermes'+path,{...init,headers:{'Content-Type':'application/json',...init.headers}});if(!r.ok)throw Error(path+' returned '+r.status);return r.json().catch(()=>({}))}
let db,created=false,receipt=false
try {
 await api('/api/sessions',{method:'POST',body:JSON.stringify({id:sid,source:'wizard-mobile',title:'Synthetic Retry acceptance'})});created=true
 db=new DatabaseSync(statePath);db.exec('PRAGMA busy_timeout=5000')
 const now=Date.now()/1000
 // Insert terminal in one statement: the running queue can never dispatch this fixture.
 db.prepare(`INSERT INTO wizard_run_queue(public_run_id,runtime,session_id,idempotency_key,request_hash,body,status,payload_json,created_at,updated_at,terminal_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,'direct',sid,'synthetic-proof-'+id,queueRequestHash('direct',body),body,'failed',JSON.stringify(payload),now,now,now);receipt=true
 const detail=await api('/api/sessions/'+encodeURIComponent(sid)+'?view=detail')
 const row=detail.session||detail
 assert.equal(row.message_count,0);assert.equal(row.wizard_retry_input,input);assert.equal(row.wizard_retry_run_id,id);assert.equal(row.status,'failed')
 console.log(JSON.stringify({status:'PASS',synthetic_session:sid,detail_endpoint:origin+'/wizard/hermes/api/sessions/'+sid+'?view=detail',message_count:row.message_count,saved_request:row.wizard_retry_input,saved_run_reference:row.wizard_retry_run_id,provider_calls:0}))
} finally {
 if(receipt){db.prepare('DELETE FROM wizard_run_queue WHERE public_run_id=? AND session_id=?').run(id,sid);assert(!db.prepare('SELECT 1 FROM wizard_run_queue WHERE public_run_id=?').get(id))}
 db?.close()
 if(created)await api('/api/sessions/'+encodeURIComponent(sid),{method:'DELETE'})
}
