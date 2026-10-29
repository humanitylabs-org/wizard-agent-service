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
