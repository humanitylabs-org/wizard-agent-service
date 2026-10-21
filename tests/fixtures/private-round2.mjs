// Disposable real Agent Service + SQLite FTS fixture for browser acceptance on Thales.
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../../server/service.mjs'
const root=mkdtempSync(join(tmpdir(),'private-r2-')), now=Date.now()/1000
const makeRows=(aid)=>[{
 id:aid==='private'?'wizard_round2_private':'wizard_round2_standard',title:aid==='private'?'Private fixture':'Standard fixture',
 source:'wizard-mobile',started_at:now-300,last_active:now,message_count:4,
 latest_message:{role:'assistant',content:'Latest ordinary reply',timestamp:now},last_user_message:{role:'user',content:'Latest ordinary request',timestamp:now-1},
 messages:[{id:1,role:'user',content:aid==='private'?'A forgotten cobaltwatermelon secret':'Standard conversation',timestamp:now-300},
 {id:2,role:'assistant',content:'Earlier answer',timestamp:now-299},{id:3,role:'user',content:'Latest ordinary request',timestamp:now-1},{id:4,role:'assistant',content:'Latest ordinary reply',timestamp:now}]
}]
const mainRows=makeRows('hermes'), privateRows=makeRows('private')
async function api(rows) {
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x');let body='';for await(const chunk of req)body+=chunk
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}
  if(url.pathname==='/health')return send(200,{status:'ok'})
  if(url.pathname==='/api/model/options')return send(200,{provider:'anthropic',model:'claude-opus-5-5',providers:[{slug:'anthropic',name:'Claude',authenticated:true,models:['claude-opus-5-5']}]})
  if(url.pathname==='/api/sessions')return send(200,{data:rows.map(({messages,...s})=>s),has_more:false})
  const m=url.pathname.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/)
  if(m){const row=rows.find(r=>r.id===m[1]);if(!row)return send(404,{error:'not found'});if(m[2])return send(200,{data:row.messages,has_more:false});return send(200,{session:row})}
  return send(404,{error:'fixture_not_found'})
 });const address=await listen(server);return {server,origin:`http://127.0.0.1:${address.port}`,port:address.port}
}
const main=await api(mainRows), privateApi=await api(privateRows)
const dbpath=join(root,'state.db')
function history(path,rows){const db=new DatabaseSync(path);db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,source TEXT,parent_session_id TEXT,hidden INTEGER);CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL);CREATE VIRTUAL TABLE messages_fts USING fts5(content,content='messages',content_rowid='id');`);for(const row of rows){db.prepare('INSERT INTO sessions VALUES(?,?,?,?,0)').run(row.id,row.title,row.source,null);for(const msg of row.messages)db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(msg.id,row.id,msg.role,msg.content,msg.timestamp)}db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");db.close()}
history(dbpath,mainRows)
const service=createWizardServer({upstreamOrigin:main.origin,hermesKey:'fixture-key',requireAccess:false,agentBridge:false,
 uxDir:process.env.QA_UX_DIR,uxPrefix:'wizard-os-home',wizardOsHome:root,
 appsJsonPath:join(root,'apps.json'),settingsPath:join(root,'settings.json'),threadSeenStatePath:join(root,'seen.json'),followThrough:false,
 agentRuntime:{apply:async()=>({ok:true}),start:async()=>({ok:true}),stop:async()=>({ok:true})},agentBasePort:47650})
const addr=await listen(service,'127.0.0.1',9743),base=`http://127.0.0.1:${addr.port}`
const response=await fetch(base+'/wizard/v1/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'Private',model:{provider:'tinfoil',model:'glm-5-3'},permissions:{preset:'private',read_standard_chats:true}})})
if(response.status!==201)throw Error('create fixture agent '+response.status)
const file=join(root,'agents','private','agent.json'),agent=JSON.parse(readFileSync(file,'utf8'));agent.runtime.port=privateApi.port;writeFileSync(file,JSON.stringify(agent))
history(join(root,'agents','private','home','state.db'),privateRows)
console.log(JSON.stringify({ready:true,base,root}))
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{service.close();main.server.close();privateApi.server.close();process.exit(0)})
