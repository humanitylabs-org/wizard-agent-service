// Synthetic-only isolated preview. No live Hermes, credentials, accounts or owner state are read.
// node qa/provider-access-preview.mjs STATE_DIR [PORT=9394]
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {DurableRunQueue,queueRequestHash} from '../server/run-queue.mjs'
import {createWizardServer,listen} from '../server/service.mjs'
const root=resolve(process.argv[2]||'')
if(!process.argv[2]) throw Error('Explicit isolated state directory required')
mkdirSync(root,{recursive:true,mode:0o700});mkdirSync(join(root,'os'),{recursive:true})
writeFileSync(join(root,'apps.json'),'[]')
const now=Date.now()/1000
const rows=[{id:'wizard_synthetic_signin_wait',source:'wizard-mobile',title:'Example: message saved during sign-in outage',message_count:0,wizard_pending_first_send:true,started_at:now,last_active:now,model:'synthetic-claude',provider:'anthropic',archived:false}]
const failure={status:'completed',output:'⚠️ Provider authentication failed: synthetic preview sign-in outage',usage:{input_tokens:0,output_tokens:0,total_tokens:0}}
const statePath=join(root,'queue.sqlite3')
const seed=new DurableRunQueue({statePath,pollIntervalMs:0,launch:async()=>({upstreamRunId:'synthetic-outage',payload:failure}),lookup:async()=>({payload:failure})})
const body=JSON.stringify({session_id:rows[0].id,input:'This is an example message. It is saved and will send automatically after the next successful request confirms the AI sign-in is working again.',model:'synthetic-claude',provider:'anthropic',require_model_lock:true})
await seed.admit({runtime:'direct',sessionId:rows[0].id,idempotencyKey:'synthetic-outage-example',requestHash:queueRequestHash('direct',body),body});await seed.close()
const fetchImpl=async(url,init={})=>{
 const u=new URL(url)
 if(u.pathname==='/api/sessions') return Response.json({data:rows,has_more:false})
 if(u.pathname.endsWith('/messages'))return Response.json({data:[],has_more:false})
 if(u.pathname==='/v1/capabilities')return Response.json({features:{}})
 if(u.pathname.startsWith('/v1/runs/'))return Response.json(failure)
 if(u.pathname==='/api/models')return Response.json({models:[{id:'synthetic-claude',provider:'anthropic',name:'Example AI'}]})
 if(u.pathname.startsWith('/api/sessions/'))return Response.json(rows[0])
 return Response.json({})
}
const server=createWizardServer({upstreamOrigin:'http://127.0.0.1:19876',hermesKey:'synthetic-preview-only',fetchImpl,requireAccess:false,hermesStatePath:'',agents:false,agentBridge:false,followThrough:false,joinedDelegation:'off',wizardOsHome:join(root,'os'),appsJsonPath:join(root,'apps.json'),canonicalSessionReader:async()=>rows,activeSessionReader:async()=>[],dispatchHealthReader:()=>true,runQueueStatePath:statePath,runQueuePollIntervalMs:1000,providerAccessRecovery:true})
await listen(server,'127.0.0.1',Number(process.argv[3]||9394))
console.log(JSON.stringify({preview:true,synthetic_only:true,port:Number(process.argv[3]||9394),session_id:rows[0].id,state:root}))
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)))
