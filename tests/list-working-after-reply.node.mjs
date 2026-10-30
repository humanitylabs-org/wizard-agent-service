import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWizardServer,listen} from '../server/service.mjs';
const close=s=>new Promise(r=>s.close(r));
// A finished run must leave Working as soon as the browser reads its terminal status, not after the
// 30 s cached Hermes listing expires (seen live: reply on screen, thread still "Working" for ~28 s).
test('finished direct run refreshes the cached listing at once', {timeout:20000}, async t=>{
  const root=mkdtempSync(join(tmpdir(),'working-lag-')); const servers=[];
  t.after(async()=>{for(const s of servers.reverse())await close(s);rmSync(root,{recursive:true,force:true})});
  const now=Date.now()/1000; let running=true, reads=0;
  const row=()=>({id:'wizard_first',source:'api_server',title:'hi',hidden:false,parent_session_id:null,message_count:running?1:2,last_active:now,started_at:now,
    wizard_activity_at:now,status:running?'running':'completed',latest_message:{role:running?'user':'assistant',content:running?'hi':'Hello!',timestamp:now}});
  const up=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json'); const url=new URL(req.url,'http://fixture');
    if(req.method==='POST'&&url.pathname==='/v1/runs'){res.end(JSON.stringify({run_id:'run_1',status:'queued',session_id:'wizard_first'}));return}
    if(url.pathname==='/v1/runs/run_1'){res.end(JSON.stringify({run_id:'run_1',status:running?'running':'completed',session_id:'wizard_first',output:'Hello!'}));return}
    res.end('{}');
  });servers.push(up);const u=await listen(up);mkdirSync(join(root,'os'));
  const svc=createWizardServer({upstreamOrigin:`http://127.0.0.1:${u.port}`,hermesKey:'k',requireAccess:false,agents:false,agentBridge:false,followThrough:false,joinedDelegation:'off',
    wizardOsHome:join(root,'os'),canonicalSessionReader:async()=>{reads++;return [row()]},runQueue:false});
  servers.push(svc);const base=`http://127.0.0.1:${(await listen(svc)).port}`;
  const post=await fetch(base+'/wizard/hermes/v1/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:'hi',session_id:'wizard_first'})});
  assert.equal(post.status,200,await post.text());
  const list=async()=>(await (await fetch(base+'/wizard/hermes/api/sessions?limit=100')).json()).data.find(r=>r.id==='wizard_first');
  assert.notEqual((await list()).status,'completed');
  running=false; const before=reads;
  const run=await (await fetch(base+'/wizard/hermes/v1/runs/run_1')).json(); assert.equal(run.status,'completed');
  await new Promise(r=>setTimeout(r,300));
  assert(reads>before,'the terminal run status re-reads the Hermes listing');
  assert.equal((await list()).status,'completed');
});
// A listing read already in flight when the run ends may have captured the "running" row. Joining
// it would store that stale row for another 30 s, so the terminal status must wait and read again.
test('finished direct run re-reads after a listing read already in flight', {timeout:20000}, async t=>{
  const root=mkdtempSync(join(tmpdir(),'working-lag-'));const servers=[];
  t.after(async()=>{for(const s of servers.reverse())await close(s);rmSync(root,{recursive:true,force:true})});
  const now=Date.now()/1000;let running=true,reads=0,hold=null;
  const row=()=>({id:'wizard_first',source:'api_server',title:'hi',hidden:false,parent_session_id:null,message_count:running?1:2,last_active:now,started_at:now,
    wizard_activity_at:now,status:running?'running':'completed',latest_message:{role:running?'user':'assistant',content:running?'hi':'Hello!',timestamp:now}});
  const up=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');const url=new URL(req.url,'http://fixture');
    if(req.method==='POST'&&url.pathname==='/v1/runs'){res.end(JSON.stringify({run_id:'run_1',status:'queued',session_id:'wizard_first'}));return}
    if(url.pathname==='/v1/runs/run_1'){res.end(JSON.stringify({run_id:'run_1',status:running?'running':'completed',session_id:'wizard_first',output:'Hello!'}));return}
    res.end('{}');
  });servers.push(up);const u=await listen(up);mkdirSync(join(root,'os'));
  const svc=createWizardServer({upstreamOrigin:`http://127.0.0.1:${u.port}`,hermesKey:'k',requireAccess:false,agents:false,agentBridge:false,followThrough:false,joinedDelegation:'off',
    wizardOsHome:join(root,'os'),runQueue:false,canonicalSessionReader:async()=>{reads++;const seen=row();if(hold)await hold;return [seen]}});
  servers.push(svc);const base=`http://127.0.0.1:${(await listen(svc)).port}`;
  const post=await fetch(base+'/wizard/hermes/v1/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:'hi',session_id:'wizard_first'})});
  assert.equal(post.status,200,await post.text());
  const list=async()=>(await (await fetch(base+'/wizard/hermes/api/sessions?limit=100')).json()).data.find(r=>r.id==='wizard_first');
  assert.notEqual((await list()).status,'completed');
  // A rename starts a listing read; it captures the running row and is held open.
  let release;hold=new Promise(r=>{release=r});const before=reads;
  const patch=await fetch(base+'/wizard/hermes/api/sessions/wizard_first',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({title:'hi again'})});
  assert.equal(patch.status,200);
  for(let n=0;n<50&&reads===before;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(reads,before+1,'the held read started before the run ended');
  running=false;
  const run=await (await fetch(base+'/wizard/hermes/v1/runs/run_1')).json();assert.equal(run.status,'completed');
  hold=null;release();
  for(let n=0;n<50&&reads<before+2;n++)await new Promise(r=>setTimeout(r,10));
  await new Promise(r=>setTimeout(r,100));
  assert.equal(reads,before+2,'a fresh read follows the held one');
  assert.equal((await list()).status,'completed');
});
// Fresh-mode box (no state.db, runs go through the durable queue as wizardq_ ids): the new chat is
// left out of the listing while it has no messages, and nothing re-read the cached listing when the
// queued run finished, so the reply was on screen while the thread stayed "Starting…"/Working until
// the 30 s cache expired (seen live on the demo: reply at 00:20:07, Working until 00:20:53).
test('finished queued run refreshes the cached listing at once', {timeout:20000}, async t=>{
  const root=mkdtempSync(join(tmpdir(),'working-lag-'));const servers=[];
  t.after(async()=>{for(const s of servers.reverse())await close(s);rmSync(root,{recursive:true,force:true})});
  const now=Date.now()/1000;let done=false,reads=0;
  const row=()=>({id:'wizard_fresh',source:'api_server',title:'hi',hidden:false,parent_session_id:null,message_count:2,last_active:now,started_at:now,
    latest_message:{role:'assistant',content:'Hello!',timestamp:now}});
  const up=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');const url=new URL(req.url,'http://fixture');
    if(req.method==='POST'&&url.pathname==='/v1/runs'){for await(const _ of req);res.end(JSON.stringify({run_id:'run_q',status:'running',session_id:'wizard_fresh'}));return}
    if(url.pathname==='/v1/runs/run_q'){res.end(JSON.stringify({run_id:'run_q',status:done?'completed':'running',session_id:'wizard_fresh',output:done?'Hello!':''}));return}
    res.end('{}');
  });servers.push(up);const u=await listen(up);mkdirSync(join(root,'os'));
  const svc=createWizardServer({upstreamOrigin:`http://127.0.0.1:${u.port}`,hermesKey:'fixture-hermes-key',requireAccess:false,agents:false,agentBridge:false,followThrough:false,joinedDelegation:'off',
    requireJoinedDelegationCapability:false,wizardOsHome:join(root,'os'),runQueueStatePath:join(root,'queue.sqlite3'),runQueuePollIntervalMs:0,
    activeSessionReader:async()=>[],dispatchHealthReader:()=>true,
    // The Hermes HTTP listing skips a thread with no messages; it lists it once the reply is in.
    canonicalSessionReader:async()=>{reads++;return done?[row()]:[]}});
  servers.push(svc);const base=`http://127.0.0.1:${(await listen(svc)).port}`;
  const list=async()=>{const j=await (await fetch(base+"/wizard/hermes/api/sessions?limit=100")).json();if(!j.data)throw new Error(JSON.stringify(j));return j.data.find(r=>r.id==="wizard_fresh")};
  assert.equal(await list(),undefined);
  const post=await fetch(base+'/wizard/hermes/v1/runs',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':'wos-key-1'},body:JSON.stringify({input:'hi',session_id:'wizard_fresh'})});
  const admitted=await post.json();assert.ok([200,202].includes(post.status),JSON.stringify(admitted));
  assert.match(admitted.run_id,/^wizardq_/);
  assert.equal(await list(),undefined);
  done=true;
  let run;for(let n=0;n<40;n++){run=await (await fetch(base+`/wizard/hermes/v1/runs/${admitted.run_id}`)).json();if(run.status==='completed')break;await new Promise(r=>setTimeout(r,25))}
  assert.equal(run.status,'completed');
  let item;for(let n=0;n<10&&!item;n++){item=await list();if(!item)await new Promise(r=>setTimeout(r,100))}
  assert.ok(item,`the finished thread is listed within 1 s (listing reads: ${reads})`);
  assert.equal(item.wizard_last_run_idempotency_key,'wos-key-1');
  assert.ok(!['queued','running'].includes(item.status),`status ${item.status}`);
  // The Chats list view (what the UI's Working hold releases on) agrees.
  const view=(await (await fetch(base+'/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100&offset=0&include_children=false&overrides=%7B%7D')).json()).data.find(r=>r.id==='wizard_fresh');
  assert.equal(view?.lastRunKey,'wos-key-1');
  assert.equal(view?.lastRunStatus,'completed');
  assert.ok(!['queued','running','submitting'].includes(view?.status),`list view status ${view?.status}`);
});
