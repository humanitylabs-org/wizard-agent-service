import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { createRoutedPresentation } from '../server/routed-presentation.mjs'
import { SubjectCatalog } from '../server/thread-subjects.mjs'
import { createSpaceFiling } from '../server/thread-spaces.mjs'
import { readUiPreferences, updateUiPreferences } from '../server/ui-preferences.mjs'
const dirs:string[]=[],servers:any[]=[]
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(r))));dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}))})
const home=()=>{const p=mkdtempSync(join(tmpdir(),'space-http-'));dirs.push(p);return p}
const space=(id:string,agent?:string)=>({id,name:id,threads:[],createdAt:'2026-10-24T00:00:00Z',...(agent?{agent}:{})})
const tag=(space:string)=>`Finished\n[WIZARD_STATUS_V1]${JSON.stringify({state:'done',ask:'Finished',space})}[/WIZARD_STATUS_V1]`
it('real service HTTP instructions and completed status file without inference, preserves membership and rejects foreign/unknown spaces',async()=>{
 const dir=home();let received:any,output=tag('launch')
 const upstream=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST'){let raw='';for await(const b of req)raw+=b;received=JSON.parse(raw);res.statusCode=202;res.end(JSON.stringify({run_id:'synthetic',status:'running',session_id:'synthetic_thread'}));return}if(req.url?.startsWith('/v1/runs/')){res.end(JSON.stringify({run_id:'synthetic',session_id:'synthetic_thread',status:'completed',output}));return}res.end('{}')});servers.push(upstream);const u:any=await listen(upstream)
 const server=createWizardServer({upstreamOrigin:`http://127.0.0.1:${u.port}`,hermesKey:'fixture',wizardOsHome:dir,requireAccess:false,agentBridge:false,followThrough:false,joinedDelegation:'off'});servers.push(server);const a:any=await listen(server),base=`http://127.0.0.1:${a.port}`
 const prefs=base+'/wizard/v1/ui-preferences',run=base+'/wizard/hermes/v1/runs'
 expect((await fetch(prefs,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({spaces:[space('launch'),space('phil','philosopher')],pinnedChats:['keep']})})).status).toBe(200)
 expect((await fetch(run,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session_id:'synthetic_thread',input:'Synthetic fixture'})})).status).toBe(202)
 expect(received.instructions).toContain('"id":"launch","name":"launch"');expect(received.instructions).not.toContain('"id":"phil"');expect(received.instructions).toContain('never invent Spaces')
 expect((await fetch(run+'/synthetic')).status).toBe(200)
 let saved:any=await(await fetch(prefs)).json();expect(saved.spaces[0].threads).toEqual(['synthetic_thread']);expect(saved.pinnedChats).toEqual(['keep'])
 await fetch(run+'/synthetic');saved=await(await fetch(prefs)).json();expect(saved.spaces[0].threads).toEqual(['synthetic_thread'])
 for(const id of ['unknown','phil']){output=tag(id);await fetch(run+'/synthetic')}
 saved=await(await fetch(prefs)).json();expect(saved.spaces[1].threads).toEqual([])
})
it('routed presentation injects only selected agent’s catalogue, applies status and keeps private namespaces isolated',async()=>{
 const dir=home(),path=join(dir,'ui-preferences.json');updateUiPreferences(path,{spaces:[space('launch'),space('phil','philosopher')]})
 const p=createRoutedPresentation({registry:{agentsDir:join(dir,'agents'),fetchAgent:async()=>new Response(JSON.stringify({session:{id:'same-id',title:'Reading',title_source:'user'}}))},subjects:new SubjectCatalog(''),spaces:createSpaceFiling(path)})
 const agent={id:'philosopher'};const note=await p.runNote(agent,'same-id',{});expect(note).toContain('"id":"phil"');expect(note).not.toContain('launch')
 await p.project(agent,{id:'same-id',title:'Reading',title_source:'user'},{state:'done',ask:'Read',space:'phil'},20,{})
 await p.project(agent,{id:'same-id',title:'Reading',title_source:'user'},{state:'done',ask:'Read',space:'launch'},20,{})
 expect(readUiPreferences(path).spaces.map(s=>s.threads)).toEqual([[],['same-id']])
})
