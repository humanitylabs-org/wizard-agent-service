import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createSpacesTools } from '../server/spaces-tools.mjs'
import { createSpaceFiling } from '../server/thread-spaces.mjs'
import { createAgentBridge } from '../server/agent-bridge.mjs'
import { loadAgentSessionRows } from '../server/agents-http.mjs'
import { createWizardServer, listen } from '../server/service.mjs'
import { readUiPreferences, updateUiPreferences } from '../server/ui-preferences.mjs'
import { hermesConfigYaml } from '../server/agents.mjs'
const dirs:string[]=[], servers:any[]=[]
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(r))));dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}))})
function scene() {
 const dir=mkdtempSync(join(tmpdir(),'spaces-tools-'));dirs.push(dir);const path=join(dir,'ui-preferences.json')
 const space=(id:string,agent?:string)=>({id,name:id,threads:[],createdAt:'2026-10-24T00:00:00Z',...(agent?{agent}:{})})
 updateUiPreferences(path,{compact:true,spaces:[space('main'),space('phil','philosopher'),space('secret','private')]})
 const calls:any[]=[]
 const rows:any={hermes:[{id:'main-thread',title:'Launch'}],philosopher:[{id:'phil-thread',title:'Plato',subject:'Wisdom',latest_message:{content:'never return content'}},{id:'archived-thread',title:'Old wisdom',archived:true}],private:[{id:'private-thread',title:'PRIVATE_CANARY'}]}
 const tools=createSpacesTools({path,loadThreads:async(id:string)=>{calls.push(id);return rows[id]||[]},threadExists:async(id:string,thread:string)=>{calls.push([id,thread]);return (rows[id]||[]).some((r:any)=>r.id===thread)}})
 const call=async(name:string,args:any={},id='philosopher')=>{const r=await tools.call(name,args,id);return r.isError?r:JSON.parse(r.content[0].text)}
 return {dir,path,tools,call,calls,rows}
}
it('lists legacy main and only caller Spaces, including private; run notes never expose private catalogue',async()=>{
 const s=scene();expect((await s.call('spaces_list')).spaces).toEqual([{id:'phil',name:'phil',count:0}]);expect((await s.call('spaces_list',{},'hermes')).spaces[0].id).toBe('main');expect((await s.call('spaces_list',{},'private')).spaces[0].id).toBe('secret')
 const filing=createSpaceFiling(s.path);expect(filing.runNote('hermes')).not.toContain('secret');expect(filing.runNote('philosopher')).not.toContain('secret');expect(filing.runNote('private')).toContain('"id":"secret"')
})
it('creates forced caller scope, reuses names, adds/removes idempotently and deletes without touching other Spaces/prefs',async()=>{
 const s=scene(),before=readUiPreferences(s.path)
 const created=await s.call('spaces_create',{name:'Reading'});const id=created.space.id
 expect((await s.call('spaces_create',{name:'reading'})).space.id).toBe(id)
 for(let i=0;i<2;i++)expect((await s.call('spaces_add',{space_id:id,thread_ids:['phil-thread','phil-thread']})).space.count).toBe(1)
 for(let i=0;i<2;i++)expect((await s.call('spaces_remove',{space_id:id,thread_ids:['phil-thread']})).space.count).toBe(0)
 expect(readUiPreferences(s.path).spaces.at(-1).agent).toBe('philosopher')
 await s.call('spaces_delete',{space_id:id});expect(readUiPreferences(s.path)).toEqual(before)
})
it('rejects identity spoofing, foreign/missing Spaces identically and foreign threads before writes',async()=>{
 const s=scene(),before=readFileSync(s.path,'utf8')
 expect((await s.call('spaces_create',{name:'x',agent:'hermes'})).isError).toBe(true)
 for(const name of ['spaces_add','spaces_remove','spaces_delete']){
  const args=(id:string)=>({space_id:id,...(name==='spaces_delete'?{}:{thread_ids:['phil-thread']})})
  expect(await s.call(name,args('secret'))).toEqual(await s.call(name,args('absent')))
 }
 for(const thread of ['private-thread','main-thread','missing'])for(const name of ['spaces_add','spaces_remove']) expect((await s.call(name,{space_id:'phil',thread_ids:[thread]})).isError).toBe(true)
 expect(s.calls.every(c=>!Array.isArray(c)||c[0]==='philosopher')).toBe(true)
 expect(readFileSync(s.path,'utf8')).toBe(before)
})
it('metadata search includes archives, IDs and subjects, pages, never exposes content or private titles outside their own scope',async()=>{
 const s=scene();const page=await s.call('spaces_search_threads',{query:'wisdom',limit:1});expect(page).toMatchObject({total:2,has_more:true});expect(JSON.stringify(page)).not.toContain('never return content');expect((await s.call('spaces_search_threads',{query:'wisdom',offset:1})).threads[0].archived).toBe(true)
 expect((await s.call('spaces_search_threads',{query:'phil-thread'})).total).toBe(1)
 expect((await s.call('spaces_search_threads',{query:'PRIVATE_CANARY'})).total).toBe(0)
 expect((await s.call('spaces_search_threads',{},'private')).threads[0].title).toBe('PRIVATE_CANARY');expect(s.calls).not.toContain('hermes')
})
it('concurrent membership checks and status filing preserve every addition and other agents',async()=>{
 const s=scene();s.rows.philosopher.push({id:'second',title:'Second'})
 await Promise.all([s.call('spaces_add',{space_id:'phil',thread_ids:['phil-thread']}),s.call('spaces_add',{space_id:'phil',thread_ids:['second']})])
 createSpaceFiling(s.path).apply('philosopher','status-thread',{space:'phil'})
 expect(readUiPreferences(s.path).spaces[1].threads).toEqual(['phil-thread','second','status-thread']);expect(readUiPreferences(s.path).spaces[2].threads).toEqual([])
})
it('gateway lists built-ins without ticked apps and binds calls to authenticated identity, not params',async()=>{
 const s=scene();writeFileSync(join(s.dir,'apps.json'),'{"apps":[]}')
 const bridge=createAgentBridge({appsJsonPath:join(s.dir,'apps.json'),writeSkills:false,watchIntervalMs:0,token:'main-token',agentForToken:(t:string)=>t==='phil-token'?'philosopher':t==='priv-token'?'private':'',appsFor:()=>new Set(),builtins:s.tools})
 try{
  for(const id of ['hermes','philosopher','private','archimedes-new'])expect((await bridge.listTools(id)).map((t:any)=>t.name)).toEqual(expect.arrayContaining(['spaces_list','spaces_create','spaces_add','spaces_remove','spaces_search_threads']))
  const {createServer}=await import('node:http');const server=createServer((req,res)=>void bridge.handle(req,res));servers.push(server);const a:any=await listen(server)
  const r=await fetch(`http://127.0.0.1:${a.port}`,{method:'POST',headers:{authorization:'Bearer phil-token','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'spaces_list',arguments:{}}})});expect(JSON.parse((await r.json()).result.content[0].text).spaces).toEqual([{id:'phil',name:'phil',count:0}])
 }finally{bridge.close()}
})
it('shared session census reads only caller runtime and its own archives beyond 100, skips hidden/child threads',async()=>{
 const s=scene(),dir=join(s.dir,'philosopher','home');mkdirSync(dir,{recursive:true});const db=new DatabaseSync(join(dir,'state.db'))
 db.exec('CREATE TABLE sessions(id TEXT,source TEXT,model TEXT,title TEXT,started_at REAL,ended_at REAL,end_reason TEXT,message_count INTEGER,parent_session_id TEXT,last_activity_at REAL,pinned INTEGER,archived INTEGER,hidden INTEGER)')
 const insert=db.prepare("INSERT INTO sessions VALUES (?,'cli','','old',1,2,'',2,NULL,2,0,1,0)");for(let i=0;i<120;i++)insert.run('old-'+i);db.close()
 const calls:any[]=[];const ctx={registry:{agentsDir:s.dir,fetchAgent:async(agent:any,path:string)=>{calls.push([agent.id,path]);return new Response(JSON.stringify({data:[{id:'live',title:'Live'}],has_more:false}))}}}
 const rows=await loadAgentSessionRows(ctx,{id:'philosopher'},{archiveLimit:100000,requireComplete:true});expect(rows).toHaveLength(121);expect(calls).toHaveLength(1);expect(calls[0][0]).toBe('philosopher')
})
it('real service composition always lists Spaces built-ins on routed gateway, including private no-app config',async()=>{
 const s=scene();writeFileSync(join(s.dir,'apps.json'),'{"apps":[]}')
 const server=createWizardServer({wizardOsHome:s.dir,appsJsonPath:join(s.dir,'apps.json'),agentBridge:'gateway',mcpToken:'main-token',requireAccess:false,followThrough:false,agentGatewayUrl:'http://gateway/wizard/mcp',agentRuntime:{apply:async()=>({ok:true}),start:async()=>({ok:true}),stop:async()=>({ok:true})}});servers.push(server);const a:any=await listen(server)
 for(const id of ['philosopher','private','archimedes-new']){
  const created = await fetch(`http://127.0.0.1:${a.port}/wizard/v1/agents`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:id,harness:'hermes',model:{provider:'tinfoil',model:'glm-5-3'},permissions:{preset:id==='private'?'private':'standard',read_standard_chats:false}}) }); expect(created.status).toBe(201)
  const actualId=(await created.json()).agent.id
  const token=readFileSync(join(s.dir,'agents',actualId,'gateway.key'),'utf8').trim()
  const r=await fetch(`http://127.0.0.1:${a.port}/wizard/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});expect(r.status).toBe(200);const value=await r.json();expect(value.result.tools.map((t:any)=>t.name)).toContain('spaces_add')
 }
 const cfg=hermesConfigYaml({id:'private',privacy:'private',model:{provider:'anthropic',model:'claude-opus-5-5'},permissions:{wizard_apps:[],agent_apps:[]},runtime:{kind:'container'}} as any,{gatewayUrl:'http://gateway/wizard/mcp'});expect(cfg).toContain('  wizard:');expect(cfg).not.toContain('standard_chats:')
})
