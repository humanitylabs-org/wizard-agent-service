import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createWizardServer, listen } from '../server/service.mjs'
const dir = new URL('./api-fixture/',import.meta.url).pathname
mkdirSync(dir,{recursive:true})
const state=dir+'state.db', apps=dir+'apps.json', launcher=dir+'launcher.json'
writeFileSync(apps,JSON.stringify({apps:[{id:'future-installed-app',name:'Future App'}]}))
writeFileSync(launcher,JSON.stringify({links:[{id:'topics',name:'Topics',url:'/topics/'}]}))
const db = new DatabaseSync(state)
db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL);
CREATE TABLE messages(session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER, display_metadata TEXT);
CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
INSERT INTO sessions VALUES('wizard_probe',1);`)
const add=db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,1,?)')
add.run('wizard_probe','user',null,'Read app',null,10,null)
add.run('wizard_probe','assistant','stop','Published app output','final',20,JSON.stringify({app_id:'topics'}))
let admitted=null
const upstream=createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json')
 if(req.url.startsWith('/api/sessions?')){res.end(JSON.stringify({data:[{id:'wizard_probe',source:'wizard-mobile',title:'Original source title',message_count:2,last_active:20,extra:'keep'}]}));return}
 if(req.url.endsWith('/messages')){res.statusCode=503;res.end('{}');return}
 if(req.url==='/v1/runs' && req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;admitted=JSON.parse(raw);res.statusCode=202;res.end(JSON.stringify({run_id:'run_light_probe',status:'running',session_id:'wizard_probe'}));return}
 res.end('{}')
})
const ua=await listen(upstream)
const proxy=createWizardServer({upstreamOrigin:`http://127.0.0.1:${ua.port}`,hermesKey:'fixture-key',requireAccess:false,joinedDelegation:'off',hermesStatePath:state,sessionDbPath:state,appsJsonPath:apps,launcherPath:launcher,followThrough:false,archivedSessionReader:()=>[]})
const pa=await listen(proxy), origin=`http://127.0.0.1:${pa.port}`
let assertions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
try{
 const list=async()=>{const r=await fetch(origin+'/wizard/hermes/api/sessions?limit=100');check(r.status,200);return (await r.json()).data[0]}
 const first=await list();check(first.wizard_app_id,'topics');check(first.source,'wizard-mobile');check(first.extra,'keep')
 add.run('wizard_probe','user',null,'Unrelated next question',null,30,null)
 check((await list()).wizard_app_id,undefined)
 add.run('wizard_probe','assistant','stop','Unrelated answer','final',40,null)
 check((await list()).wizard_app_id,undefined)
 const run=await fetch(origin+'/wizard/hermes/v1/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:'wizard_probe',input:'Do work'})})
 check(run.status,202);check(admitted.instructions.includes('future-installed-app'),true);check(admitted.instructions.includes('"id":"usuals","name":"Food"'),true)
 console.log(JSON.stringify({placement:'VPS lightweight HTTP module probe only; no npm suite/browser/build',passed_assertions:assertions,status:200,stock_run_admission:202}))
}finally{db.close();await new Promise(r=>proxy.close(r));await new Promise(r=>upstream.close(r));rmSync(dir,{recursive:true,force:true})}
