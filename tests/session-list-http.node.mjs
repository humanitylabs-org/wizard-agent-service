import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createWizardServer,listen,isAllowedProxyRequest} from '../server/service.mjs';
const close=s=>new Promise(r=>s.close(r));
test('real proxy: compact window, legacy compatibility, deep search, detail, auth and reset', {timeout:20000}, async t=>{
 const root=mkdtempSync(join(tmpdir(),'slim-list-')); const servers=[];
 t.after(async()=>{for(const s of servers.reverse())await close(s);rmSync(root,{recursive:true,force:true})});
 const now=Date.now()/1000, full='A complete original request '+ 'long raw input **markdown** '.repeat(60)+' END-OF-REQUEST';
 const rows=Array.from({length:260},(_,i)=>({id:`wizard_synthetic_${i}`,source:'api_server',title:`Synthetic ${i}`,hidden:false,parent_session_id:null,message_count:4,last_active:now-20*86400-i,started_at:now-20*86400-i,archived:i%2===0,
   wizard_activity_at:now-20*86400-i,wizard_request_preview:full,latest_message:{role:'assistant',content:'clean preview '.repeat(50),timestamp:now-20*86400-i}}));
 rows.push({...rows[0],id:'wizard_failed',status:'failed',last_active:now,wizard_activity_at:now});
 const state=join(root,'state.db'),db=new DatabaseSync(state);
 db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,display_kind TEXT,finish_reason TEXT);');
 db.prepare('INSERT INTO messages VALUES(1,?,?,?,?,?,?)').run(rows[250].id,'user','historic needle-in-body only',now-50*86400,null,null);
 db.close();
 let writes=0;const up=createServer((req,res)=>{
   res.setHeader('Content-Type','application/json');const url=new URL(req.url,'http://fixture');
   if(req.method!=='GET'){writes++;res.writeHead(405);res.end('{}');return}
   const id=url.pathname.split('/')[3],row=rows.find(s=>s.id===id);
   if(url.pathname.endsWith('/messages')){res.end(JSON.stringify({data:[{id:2,role:'user',content:full,timestamp:now-20*86400},{id:3,role:'assistant',content:'Full answer',timestamp:now-20*86400+1,finish_reason:'stop',display_kind:'final'}],has_more:false}));return}
   if(row){res.end(JSON.stringify(row));return}
   if(url.pathname==='/api/sessions'){const off=Number(url.searchParams.get('offset')||0);res.end(JSON.stringify({data:rows.slice(off,off+100),has_more:off+100<rows.length}));return}
   res.end('{}');
 });servers.push(up);const u=await listen(up);mkdirSync(join(root,'os'));
 const options={upstreamOrigin:`http://127.0.0.1:${u.port}`,hermesKey:'synthetic-api-key',requireAccess:false,agents:false,agentBridge:false,followThrough:false,joinedDelegation:'off',wizardOsHome:join(root,'os'),hermesStatePath:state,canonicalSessionReader:()=>rows,runQueue:false};
 const svc=createWizardServer(options);servers.push(svc);const addr=await listen(svc),base=`http://127.0.0.1:${addr.port}/wizard/hermes/api/sessions`;
 const get=async suffix=>{const r=await fetch(base+suffix);return {status:r.status,body:await r.json()}};
 const legacy=await get('?limit=100');assert.equal(legacy.status,200);assert.equal(legacy.body.view,undefined);assert(legacy.body.data[0].latest_message);
 const w=await get('?view=list&window=archive-50&limit=100');assert.equal(w.status,200,JSON.stringify(w.body));assert.equal(w.body.list_version,1);assert.equal(w.body.archive_total,260);assert.equal(w.body.data.length,51);assert(w.body.data.some(x=>x.id==='wizard_failed'));for(const r of w.body.data){assert(r.preview.length<=140);assert(!('request' in r));assert(!('latest_message'in r));}
 const oldDetail=await get('/wizard_failed');assert.equal(oldDetail.status,200);assert.equal(oldDetail.body.wizard_retry_input,undefined);
 const detail=await get('/wizard_failed?view=detail');assert.equal(detail.status,200);assert.equal(detail.body.wizard_retry_input,full);assert(detail.body.wizard_retry_input.length>140);
 const searched=await get('?view=list&q=needle-in-body');assert.equal(searched.status,200);assert.equal(searched.body.search_total,1);assert.equal(searched.body.data[0].id,rows[250].id);assert.match(searched.body.data[0].searchSnippet,/needle-in-body/);
 const bad=await get('?view=list&window=archive-50&offset=100&snapshot=expired');assert.equal(bad.status,409);
 const denied=createWizardServer({...options,requireAccess:true,accessVerifier:async()=>null});servers.push(denied);const a=await listen(denied);
 const r=await fetch(`http://127.0.0.1:${a.port}/wizard/hermes/api/sessions?view=list&window=archive-50`);assert.equal(r.status,403);
 assert.equal(writes,0,'read-only service fixture never writes upstream');
});
test('new controls are opt-in and bounded, unrelated paths remain forbidden',()=>{
 for(const q of ['view=list&window=archive-50','view=list&q=needle','view=list&window=archive-50&cursor=id:50'])assert(isAllowedProxyRequest('GET','/api/sessions',new URLSearchParams(q)));
 for(const q of ['window=archive-50','view=list&window=anything','view=list&q='+ 'x'.repeat(301)])assert(!isAllowedProxyRequest('GET','/api/sessions',new URLSearchParams(q)));
 assert(!isAllowedProxyRequest('GET','/api/private',new URLSearchParams('view=list')));
});
