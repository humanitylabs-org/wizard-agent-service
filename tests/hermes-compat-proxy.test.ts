import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
const servers: any[] = [], dirs: string[] = []
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)) }; await Promise.all(dirs.splice(0).map(d => rm(d,{recursive:true,force:true}))) })
async function fixture(handler: (req: any, res: any, text: string) => any, options: any = {}, capabilities: any = null) {
  const root=await mkdtemp(join(tmpdir(),'compat-proxy-'));dirs.push(root)
  const upstream=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;res.setHeader('Content-Type','application/json');if(req.url==='/v1/capabilities'){if(capabilities){await capabilities(req,res);return}res.end(JSON.stringify({features:{run_unknown_resolution:true}}));return}await handler(req,res,text)});servers.push(upstream)
  const up=await listen(upstream)
  const start=async(overrides: any = {})=>{const s=createWizardServer({upstreamOrigin:`http://127.0.0.1:${up.port}`,hermesKey:'isolated',requireAccess:false,agentBridge:false,followThrough:false,joinedDelegation:'off',wizardOsHome:root,runQueueStatePath:join(root,'q.db'),operatorWorkerStatePath:join(root,'workers.json'),runQueuePollIntervalMs:0,dispatchHealthReader:()=>true,activeSessionReader:()=>[],canonicalSessionReader:()=>[],appsJsonPath:join(root,'apps.json'),settingsPath:join(root,'settings.json'),threadTitleStatePath:join(root,'titles.json'),...options,...overrides});servers.push(s);const a=await listen(s);return {s,base:`http://127.0.0.1:${a.port}/wizard/hermes`}}
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
  const attemptedDb=new DatabaseSync(join(f.root,'q.db'));expect(attemptedDb.prepare('SELECT dispatch_attempted FROM wizard_run_queue').get()?.dispatch_attempted).toBe(1);attemptedDb.close()
  expect((await fetch(f.base+'/v1/runs/'+item.run_id+'/stop',post({}))).status).toBe(409)
  f.s.closeAllConnections();await new Promise(r=>f.s.close(r));servers.splice(servers.indexOf(f.s),1)
  const again=await f.start();const refused=await fetch(again.base+'/v1/runs/'+item.run_id+'/steer',post({input:'change it'}));expect(refused.status).toBe(409);expect((await refused.json()).error.code).toBe('dispatch_already_attempted')
  const db=new DatabaseSync(join(f.root,'q.db'));db.exec('UPDATE wizard_run_queue SET retry_after=0');db.close()
  await fetch(again.base+'/v1/runs/'+item.run_id);expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0])
})
it('canonical clarify passes exact identity and preserves upstream conflict without new admission',async()=>{
 const seen:any[]=[];const f=await fixture((req,res,text)=>{seen.push({url:req.url,body:JSON.parse(text||'{}')});res.statusCode=409;res.end(JSON.stringify({error:{code:'stale_generation'}}))})
 const body={request_id:'shown',execution_generation:7,answer:'blue'};const r=await fetch(f.base+'/v1/runs/run-a/clarify',post(body));expect(r.status).toBe(409);expect((await r.json()).error.code).toBe('stale_generation');expect(seen).toEqual([{url:'/v1/runs/run-a/clarify',body}])
})
it('capability preflight failure before a run POST remains editable and cancellable', async () => {
  const runPosts: string[] = []
  const f = await fixture((req: any, res: any, text: string) => {
    if (req.method === 'POST' && req.url === '/v1/runs') runPosts.push(text)
    res.end('{}')
  }, { dispatchHealthReader: () => false }, (_req: any, res: any) => res.destroy())
  const item = await (await fetch(f.base+'/v1/runs', post({session_id:'wizard_preflight',input:'hello'}, 'preflight'))).json()
  f.s.closeAllConnections();await new Promise(r=>f.s.close(r));servers.splice(servers.indexOf(f.s),1)
  const again = await f.start({joinedDelegation:'require',dispatchHealthReader:()=>true})
  const base = again.base
  await fetch(base+'/v1/runs/'+item.run_id)
  expect(item.status).toBe('queued')
  expect(runPosts).toEqual([])
  const db = new DatabaseSync(join(f.root,'q.db'))
  expect(db.prepare('SELECT dispatch_attempted, dispatch_body FROM wizard_run_queue').get()).toMatchObject({dispatch_attempted:0,dispatch_body:null})
  db.close()
  expect((await fetch(base+'/v1/runs/'+item.run_id+'/steer', post({input:'before delivery'}))).status).toBe(202)
  const stopped = await fetch(base+'/v1/runs/'+item.run_id+'/stop', post({}))
  expect(stopped.status).toBe(202)
  expect((await stopped.json()).status).toBe('cancelled')
  expect(runPosts).toEqual([])
})
it.each(['worker-ack-lost', 'parent-rejected'])('Operator %s retry preserves one worker across model changes and restart', async failure => {
  const workers = new Map<string,string>()
  const workerAttempts: any[] = [], parentAttempts: any[] = []
  const workerBoundaryMarkers: any[] = []
  const f = await fixture((req: any, res: any, text: string) => {
    const body = JSON.parse(text || '{}')
    if (req.url === '/v1/runs' || req.url.endsWith('/chat/stream')) {
      const attempt = {text,key:req.headers['idempotency-key']}
      const accept = (runId: string) => {
        res.setHeader('Content-Type','text/event-stream')
        res.end('event: run.started\ndata: '+JSON.stringify({run_id:runId,runtime:{model:body.model,provider:body.provider,model_lock:'accepted'}})+'\n\n')
      }
      if (body.session_id.startsWith('wizardopw_')) {
        workerAttempts.push(attempt)
        const boundaryDb = new DatabaseSync(join(f.root,'q.db'))
        workerBoundaryMarkers.push(boundaryDb.prepare('SELECT dispatch_attempted FROM wizard_run_queue').get()?.dispatch_attempted)
        boundaryDb.close()
        const previous = workers.get(attempt.key)
        if (previous && previous !== text) {res.statusCode=409;res.end(JSON.stringify({error:{code:'idempotency_key_conflict'}}));return}
        workers.set(attempt.key,text)
        if (failure==='worker-ack-lost' && workerAttempts.length===1) {res.destroy();return}
        accept('worker-one');return
      }
      parentAttempts.push(attempt)
      if (failure==='parent-rejected' && parentAttempts.length===1) {res.statusCode=503;res.end('{}');return}
      accept('ack-one');return
    }
    if (req.url.startsWith('/api/sessions')) { res.end('{}'); return }
    res.end(JSON.stringify({status:'running'}))
  }, {operatorWorkerModel:'original-worker-model'})
  const base = f.base.replace('/wizard/hermes','/wizard/operator')
  const item = await (await fetch(base+'/v1/runs',post({session_id:'wizardop_user_compat',input:'Research this fully.'},'operator-stable'))).json()
  expect(item.status).toBe('queued')
  expect(workerAttempts).toHaveLength(1)
  expect(workerBoundaryMarkers).toEqual([1])
  const db = new DatabaseSync(join(f.root,'q.db'))
  expect(db.prepare('SELECT dispatch_attempted FROM wizard_run_queue').get()?.dispatch_attempted).toBe(1)
  const frozen = db.prepare('SELECT worker_dispatch_body, dispatch_body FROM wizard_run_queue').get()!
  expect(JSON.parse(String(frozen.worker_dispatch_body)).model).toBe('original-worker-model')
  if (failure==='worker-ack-lost') expect(frozen.dispatch_body).toBeNull()
  db.close()
  expect((await fetch(base+'/v1/runs/'+item.run_id+'/steer',post({input:'cannot mutate a started worker'}))).status).toBe(409)
  expect((await fetch(base+'/v1/runs/'+item.run_id+'/stop',post({}))).status).toBe(409)
  f.s.closeAllConnections();await new Promise(r=>f.s.close(r));servers.splice(servers.indexOf(f.s),1)
  const again = await f.start({operatorWorkerModel:'changed-worker-model'})
  const retryDb = new DatabaseSync(join(f.root,'q.db'));retryDb.exec('UPDATE wizard_run_queue SET retry_after=0');retryDb.close()
  const result = await (await fetch(again.base.replace('/wizard/hermes','/wizard/operator')+'/v1/runs/'+item.run_id)).json()
  const finalDb = new DatabaseSync(join(f.root,'q.db'))
  expect(finalDb.prepare('SELECT worker_dispatch_body FROM wizard_run_queue').get()?.worker_dispatch_body).toBe(frozen.worker_dispatch_body)
  finalDb.close()
  expect(workerAttempts).toHaveLength(1)
  expect(workerAttempts[0].key).toBe('operator-worker-'+item.run_id)
  expect(workers.size).toBe(1)
  expect(new Set(workerAttempts.map(a=>JSON.parse(a.text).session_id)).size).toBe(1)
  if (failure==='parent-rejected') {
    expect(result.status).toBe('running')
    expect(parentAttempts).toHaveLength(2);expect(parentAttempts[1]).toEqual(parentAttempts[0])
  } else {
    // Preserve the existing native bridge's uncertain-send refusal (422); never replay it.
    expect(result.status).toBe('failed');expect(parentAttempts).toHaveLength(0)
  }
})
