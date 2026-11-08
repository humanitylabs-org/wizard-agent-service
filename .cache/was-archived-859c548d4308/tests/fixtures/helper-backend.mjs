// Explicit test-only sources/transports. Never imported by service code.
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { createWizardServer, listen } from '../../server/service.mjs'
export const sid='wizard_review'
export async function fixture(fn) {
 const dir=mkdtempSync(join(tmpdir(),'helper-lifecycle-')),path=join(dir,'state.db'),db=new DatabaseSync(path),sec=Date.now()/1000
 db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INT DEFAULT 1,display_kind TEXT,tool_calls TEXT);
 CREATE INDEX idx_messages_session ON messages(session_id,timestamp);CREATE INDEX idx_messages_session_id ON messages(session_id,id);
 CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY,origin_session_id TEXT,parent_session_id TEXT,origin_ui_session_id TEXT,state TEXT,dispatched_at REAL,completed_at REAL,task_json TEXT,delivery_state TEXT,result_json TEXT);
 CREATE INDEX idx_async_delegations_delivery ON async_delegations(delivery_state,completed_at);
 CREATE TABLE sessions(id TEXT PRIMARY KEY,started_at REAL,model TEXT,model_config TEXT);CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL);`)
 const message=(role,content,at=sec-100)=>db.prepare('INSERT INTO messages(session_id,role,content,timestamp)VALUES(?,?,?,?)').run(sid,role,content,at)
 message('user','Build only the approved backend; do not deploy',sec-2000)
 db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)').run('deleg_review',sid,null,'','completed',sec-1800,sec-300,JSON.stringify({goals:['A','B','C'],task_indexes:[1]}),'pending',JSON.stringify({results:[{task_index:1,status:'completed',summary:'Verified saved findings'}]}))
 try {await fn({dir,path,db,sec,message})}finally{db.close();rmSync(dir,{recursive:true,force:true})}
}
export async function withServer(path,fn,opts={}) {
 let launches=0;const bodies=[]
 const upstream=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json')
  if(req.url==='/v1/capabilities'){await opts.capability?.();res.end('{}');return}
  if(req.method==='POST'&&req.url==='/v1/runs'){let text='';for await(const c of req)text+=c;launches++;bodies.push({body:JSON.parse(text),headers:req.headers});res.writeHead(202);res.end(JSON.stringify({run_id:'actual_review',status:'running'}));return}
  res.end(JSON.stringify({run_id:'actual_review',status:'completed'}))
 })
 await listen(upstream)
 const make=()=>createWizardServer({hermesStatePath:path,sessionDbPath:path,hermesKey:'test-only',upstreamOrigin:`http://127.0.0.1:${upstream.address().port}`,requireAccess:false,joinedDelegation:'off',followThrough:false,...opts})
 let server=make();await listen(server)
 const post=(headers={})=>fetch(`http://127.0.0.1:${server.address().port}/wizard/helper-continue`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({session_id:sid})})
 // fetch forbids overriding Host; raw HTTP is required for a non-vacuous rebinding probe.
 const postRaw=(headers={})=>new Promise((resolve,reject)=>{
  const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path:'/wizard/helper-continue',method:'POST',headers:{'content-type':'application/json',...headers}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(text)}))
  });req.on('error',reject);req.end(JSON.stringify({session_id:sid}))
 })
 try{await fn({post,postRaw,get launches(){return launches},bodies,get server(){return server},async restart(){await new Promise(r=>server.close(r));server=make();await listen(server)}})}finally{await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r))}
}
