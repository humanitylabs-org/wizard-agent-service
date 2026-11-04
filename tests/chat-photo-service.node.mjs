import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn) { for(let i=0;i<120;i++){ if(await fn())return; await pause(100) };throw new Error('condition timed out') }
test('full service accepted user and completed assistant hooks project both roles; history delivers same bytes', {timeout:25000}, async t=>{
 const root=mkdtempSync(join(tmpdir(),'photo-service-')); const servers=[]
 t.after(async()=>{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));rmSync(root,{recursive:true,force:true})})
 const statePath=join(root,'history.db'), db=new DatabaseSync(statePath), sid='wizard_123_abc'
 db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,user_id TEXT,chat_id TEXT,chat_type TEXT,profile_name TEXT,hidden INTEGER,parent_session_id TEXT,title TEXT,model_config TEXT,origin_json TEXT,created_source TEXT,transport_profile TEXT,archived INTEGER,message_count INTEGER,started_at REAL,last_activity_at REAL,last_activity_description TEXT,pinned INTEGER);
 CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,display_kind TEXT,tool_calls TEXT,_compressed_summary INTEGER,platform_message_id TEXT,active INTEGER,finish_reason TEXT);
 CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL);
 INSERT INTO sessions VALUES('${sid}','api_server',NULL,NULL,NULL,'default',0,NULL,'Owner conversation','{}',NULL,'human',NULL,0,1,1,1,'',0);`)
 const picture=join(root,'photo.png'), bytes=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');writeFileSync(picture,bytes)
 const insert=(id,role,content)=>db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,NULL,NULL,0,NULL,1,?)').run(id,sid,role,content,Date.now()/1000,role==='assistant'?'stop':null)
 const session=()=>db.prepare('SELECT * FROM sessions WHERE id=?').get(sid)
 let completed=false
 const upstream=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');res.setHeader('Content-Type','application/json')
  if(req.headers.authorization!=='Bearer fixture-key'){res.writeHead(401);res.end('{}');return}
  if(url.pathname===`/api/sessions/${sid}`){res.end(JSON.stringify(session()));return}
  if(url.pathname==='/api/sessions'){res.end(JSON.stringify({data:[session()]}));return}
  if(url.pathname===`/api/sessions/${sid}/messages`){res.end(JSON.stringify({data:db.prepare('SELECT * FROM messages').all()}));return}
  if(req.method==='POST'&&url.pathname==='/v1/runs'){
   for await(const _ of req){};insert(1,'user',`[Image attached at: ${picture}]`)
   res.writeHead(202);res.end(JSON.stringify({run_id:'actual_photo_run',session_id:sid,status:'running'}));return
  }
  if(url.pathname==='/v1/runs/actual_photo_run'){
   if(completed&&!db.prepare('SELECT 1 FROM messages WHERE id=2').get())insert(2,'assistant',`MEDIA:${picture}`)
   res.end(JSON.stringify({run_id:'actual_photo_run',session_id:sid,status:completed?'completed':'running'}));return
  }
  if(url.pathname==='/v1/capabilities'){res.end('{}');return}
  res.writeHead(404);res.end('{}')
 });servers.push(upstream);const addr=await listen(upstream)
 const osHome=join(root,'os');mkdirSync(osHome);mkdirSync(join(osHome,'agents'));const metadata=join(root,'producer');mkdirSync(metadata,{mode:0o700})
 const stateFile=join(metadata,'state.json'),media=join(root,'media')
 const wizard=createWizardServer({upstreamOrigin:`http://127.0.0.1:${addr.port}`,hermesKey:'fixture-key',requireAccess:false,requireJoinedDelegationCapability:false,
  wizardOsHome:osHome,hermesStatePath:statePath,agentArtifactDir:join(root,'artifacts'),agentArtifactRoots:[root],userFilesRoot:media,followThrough:false,
  runQueueStatePath:join(root,'queue.sqlite3'),runQueuePollIntervalMs:100,activeSessionReader:async()=>[],dispatchHealthReader:()=>true,canonicalSessionReader:async()=>[session()],
  chatPhotos:{enabled:true,singleOwner:true,ownerId:'123',ownerLabel:'Owner',agentLabel:'Agent',statePath:stateFile,maxBytes:1024*1024}})
 servers.push(wizard);const w=await listen(wizard),base=`http://127.0.0.1:${w.port}`
 await until(()=>existsSync(stateFile))
 const response=await fetch(`${base}/wizard/hermes/v1/runs`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'photo-owner-turn'},body:JSON.stringify({session_id:sid,input:'An image'})})
 const run=await response.json();assert.equal(response.status,202,JSON.stringify(run))
 const manifest=join(media,'.wizard/photo-provenance.json')
 await until(()=>existsSync(manifest)&&JSON.parse(readFileSync(manifest)).files[0]?.sources.some(s=>s.role==='user'))
 completed=true
 await until(async()=>{await fetch(`${base}/wizard/hermes/v1/runs/${run.run_id}`);return JSON.parse(readFileSync(manifest)).files[0].sources.some(s=>s.role==='assistant')})
 const history=await fetch(`${base}/wizard/hermes/api/sessions/${sid}/messages`);const payload=await history.text();assert.equal(history.status,200);assert.match(payload,/helm_attachments/)
 await until(()=>JSON.parse(readFileSync(stateFile)).event_counts.delivered_history>0)
 const state=JSON.parse(readFileSync(stateFile)),files=JSON.parse(readFileSync(manifest)).files
 assert.ok(state.event_counts.accepted_user>0);assert.ok(state.event_counts.completed_assistant>0)
 assert.equal(files.length,1);assert.deepEqual(new Set(files[0].sources.map(s=>s.role)),new Set(['user','assistant']))
 assert.deepEqual(readFileSync(join(media,files[0].path)),bytes)
 db.close()
})
