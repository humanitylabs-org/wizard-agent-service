import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {proxyToAgent} from '../server/agents-http.mjs';import {isAllowedProxyRequest,listen} from '../server/service.mjs';import {createPrincipalResolver} from '../server/principals.mjs';
// James, 24 Oct 2026: the Philosopher showed one thread and no Archive. Stock Hermes never lists archived rows,
// so an agent's window listing must add them from that agent's own state.db, like the main list does.
test('an agent list window includes the agent\'s archived threads from its own state.db',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-archive-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'philosopher','home'),{recursive:true});
 const now=Date.now()/1000, db=new DatabaseSync(join(dir,'philosopher','home','state.db'));
 db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL, ended_at REAL, end_reason TEXT,
   message_count INTEGER, parent_session_id TEXT, last_activity_at REAL, pinned INTEGER, archived INTEGER, hidden INTEGER)`);
 const ins=db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
 ins.run('wizard_live','api_server','','Live thread',now,null,null,4,null,now,0,0,0);
 ins.run('wizard_old_1','api_server','','Nagarjuna on emptiness',now-500,null,null,9,null,now-400,0,1,0);
 ins.run('wizard_old_2','api_server','','Steel-man argument',now-900,null,null,24,null,now-800,0,1,0);
 ins.run('wizard_hidden','api_server','','Hidden QA',now-900,null,null,3,null,now-800,0,1,1);
 ins.run('wizard_empty','api_server','','Empty',now-900,null,null,0,null,now-800,0,1,0);
 db.close();
 const ctx={isAllowedProxyRequest,mainSecrets:['synthetic-main-secret'],isThreadVisible:s=>!s.hidden,
  registry:{apiKey:()=>'synthetic-agent-token',fetchAgent:(agent,path,init)=>ctx.fetchImpl(`http://${agent.id}.invalid${path}`,init),upstream:agent=>`http://${agent.id}.invalid`,threadAgent:a=>({id:a.id,privacy:'standard'}),read:id=>({id,privacy:'standard'}),pin:()=>{},agentsDir:dir},
  sendJson:(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))},
  fetchImpl:async url=>{const u=new URL(url);
   const value=u.pathname==='/api/sessions'?{data:[{id:'wizard_live',source:'api_server',title:'Live thread',archived:false,last_active:now,started_at:now}],has_more:false}:{};
   return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});}};
 const owner=createPrincipalResolver();
 const server=createServer(async(req,res)=>{const u=new URL(req.url,'http://fixture');try{await owner.attach(req);
  await proxyToAgent(ctx,{agent:{id:'philosopher'},method:'GET',upstreamPath:u.pathname,searchParams:u.searchParams,request:req,response:res});}
  catch(e){res.writeHead(e.status||500);res.end(String(e.message))}});
 const address=await listen(server);t.after(()=>new Promise(r=>server.close(r)));
 const r=await fetch(`http://127.0.0.1:${address.port}/api/sessions?view=list&window=archive-50`);if(r.status!==200)console.log("BODY",await r.clone().text());assert.equal(r.status,200);
 const body=await r.json(), ids=body.data.map(s=>s.id);
 assert.equal(body.archive_total,2);
 assert.deepEqual(ids.sort(),['wizard_live','wizard_old_1','wizard_old_2']);
 assert(body.data.every(s=>s.agent==='philosopher'));
});
