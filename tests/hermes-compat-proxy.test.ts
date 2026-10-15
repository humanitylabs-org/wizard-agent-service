import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
const servers: any[] = [], dirs: string[] = []
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)) }; await Promise.all(dirs.splice(0).map(d => rm(d,{recursive:true,force:true}))) })
async function fixture(handler: any) {
  const root=await mkdtemp(join(tmpdir(),'compat-proxy-'));dirs.push(root)
  const upstream=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;res.setHeader('Content-Type','application/json');if(req.url==='/v1/capabilities'){res.end(JSON.stringify({features:{run_unknown_resolution:true}}));return}await handler(req,res,text)});servers.push(upstream)
  const up=await listen(upstream)
  const start=async()=>{const s=createWizardServer({upstreamOrigin:`http://127.0.0.1:${up.port}`,hermesKey:'isolated',requireAccess:false,agentBridge:false,followThrough:false,joinedDelegation:'off',wizardOsHome:root,runQueueStatePath:join(root,'q.db'),runQueuePollIntervalMs:0,dispatchHealthReader:()=>true,activeSessionReader:()=>[],canonicalSessionReader:()=>[],appsJsonPath:join(root,'apps.json'),settingsPath:join(root,'settings.json'),threadTitleStatePath:join(root,'titles.json')});servers.push(s);const a=await listen(s);return {s,base:`http://127.0.0.1:${a.port}/wizard/hermes`}}
  return {root,start,...await start()}
}
const post=(body:any,key?:string)=>({method:'POST',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)})
it.each(['permission_denied','idempotency_key_conflict','admission_conflict'])('HTTP admission %s becomes a durable failed receipt, not capacity',async code=>{
  let calls=0;const f=await fixture((req,res)=>{if(req.url==='/v1/runs'){calls++;res.statusCode=409;res.end(JSON.stringify({error:{code,message:'refused'}}))}else res.end('{}')})
  const receipt=await (await fetch(f.base+'/v1/runs',post({session_id:'wizard_contract',input:'hello'},'stable'))).json();expect(receipt.status).toBe('failed');expect(receipt.error.code).toBe(code);expect(receipt.safe_error).toBeTruthy();
  await fetch(f.base+'/v1/runs/'+receipt.run_id);expect(calls).toBe(1)
})
it('ambiguous wire dispatch freezes decorated bytes across WAS restart and rejects guidance clearly',async()=>{
  const attempts:any[]=[];const f=await fixture((req,res,text)=>{if(req.url==='/v1/runs'){attempts.push({text,key:req.headers['idempotency-key']});if(attempts.length===1){res.destroy();return}res.statusCode=202;res.end(JSON.stringify({run_id:'actual-run',status:'running'}))}else res.end(JSON.stringify({status:'running'}))})
  const item=await (await fetch(f.base+'/v1/runs',post({session_id:'wizard_contract',input:'hello'},'stable'))).json();expect(item.status).toBe('queued');expect(attempts).toHaveLength(1)
  f.s.closeAllConnections();await new Promise(r=>f.s.close(r));servers.splice(servers.indexOf(f.s),1)
  const again=await f.start();const refused=await fetch(again.base+'/v1/runs/'+item.run_id+'/steer',post({input:'change it'}));expect(refused.status).toBe(409);expect((await refused.json()).error.code).toBe('dispatch_already_attempted')
  const db=new DatabaseSync(join(f.root,'q.db'));db.exec('UPDATE wizard_run_queue SET retry_after=0');db.close()
  await fetch(again.base+'/v1/runs/'+item.run_id);expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0])
})
it('canonical clarify passes exact identity and preserves upstream conflict without new admission',async()=>{
 const seen:any[]=[];const f=await fixture((req,res,text)=>{seen.push({url:req.url,body:JSON.parse(text||'{}')});res.statusCode=409;res.end(JSON.stringify({error:{code:'stale_generation'}}))})
 const body={request_id:'shown',execution_generation:7,answer:'blue'};const r=await fetch(f.base+'/v1/runs/run-a/clarify',post(body));expect(r.status).toBe(409);expect((await r.json()).error.code).toBe('stale_generation');expect(seen).toEqual([{url:'/v1/runs/run-a/clarify',body}])
})
