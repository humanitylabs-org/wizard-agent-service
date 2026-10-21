import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal(), execFile: (...args: any[]) => { const cb = args.at(-1); cb(null, 't-123456789abc\n', ''); return { stdin: {on() {}, end() {}}, on() {} } } }))
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer } from '../server/service.mjs'
import { createAgentRegistry } from '../server/agents.mjs'
import { normalizeSettings } from '../server/wizard-os-settings.mjs'
import { ThreadSeenStore } from '../server/thread-seen.mjs'
import { ThreadDispositionStore } from '../server/thread-dispositions.mjs'
import { DurableRunQueue } from '../server/run-queue.mjs'
import { threadKey } from '../server/thread-reference.mjs'
import { archivedMainDir } from './support/archived-main'
// These compare against archived main and spawn helpers; under CI load they exceed the 5 s default.
vi.setConfig({ testTimeout: 60_000 })

const proof = 'fixture-owner-proof-not-a-real-secret'
const owner = { 'X-Wizard-Owner-Proof': proof }
const cleanup: (() => any)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
async function scene({ queued = false, manifest = null as any } = {}) {
  // Run only the fresh-box snapshot against an archived contract base to prove byte compatibility.
  const makeServer = process.env.WAS_S2C_BASELINE ? (await import(/* @vite-ignore */ `${process.env.WAS_S2C_BASELINE}/server/service.mjs`)).createWizardServer : createWizardServer
  const dir = mkdtempSync(join(tmpdir(), 'default-agent-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const settingsPath = join(dir, 'settings.json'), agentsDir = join(dir, 'agents')
  const manifestPath = join(dir, 'voice-manifest.json')
  if (manifest) writeFileSync(manifestPath, JSON.stringify(manifest))
  const appsJsonPath = join(dir, 'apps.json')
  writeFileSync(appsJsonPath, JSON.stringify({ schema: 1, apps: [{ id: 'notes', name: 'Notes', agent_binding: true, status: 'running', view: { url: '/notes/' }, mcp: { url: 'http://127.0.0.1:9876/mcp' } }] }))
  const fixtureDbPath = join(dir, 'main.sqlite'); const fixtureDb = new DatabaseSync(fixtureDbPath); fixtureDb.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('wizard_old')"); fixtureDb.close()
  const calls: any[] = [], histories = new Map<string, Set<string>>([['hermes', new Set(['wizard_old'])]])
  const dispatch = { healthy: false }
  const ports = new Map<number, string>([[1, 'hermes']]), status = new Map<string, string>(), generations = new Map<string, number>()
  const runtime = {
    inspect: async (id: string) => ({status: status.get(id) ?? 'running', generation: `${id}:${generations.get(id) ?? 0}:${status.get(id) ?? 'running'}`}),
    census: async (id: string) => ({...await runtime.inspect(id), ids: [...histories.get(id)!]}),
    apply: async (id: string) => { const config = JSON.parse(readFileSync(join(agentsDir, id, 'agent.json'), 'utf8')); ports.set(config.runtime.port, id); histories.set(id, new Set()); status.set(id, 'running'); return {} },
    status: async (id: string) => ({ status: status.get(id) ?? 'running', status_detail: '' }),
    start: async (id: string) => { generations.set(id, (generations.get(id) ?? 0) + 1); status.set(id, 'running'); return {} }, stop: async (id: string) => { status.set(id, 'stopped'); return { ok: true, census: await runtime.census(id) } },
  }
  const fetchImpl = async (url: any, init: any = {}) => {
    const u = new URL(String(url)), agent = ports.get(Number(u.port))
    if (u.host === "127.0.0.1:7") { if (u.pathname === "/helm/api/state") return json({archived_threads:[{id:"t-123456789abc",status:"processed"}],threads:[]}); throw new Error("unexpected fake helm path "+u.pathname) }; if (!agent) throw new Error("network forbidden: "+url)
    const method = init.method || 'GET', body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ agent, method, path: u.pathname, body })
    if (status.get(agent) === 'stopped') return json({ error: 'offline' }, 503)
    if (u.pathname === '/v1/capabilities') return json({ features: {} })
    if (u.pathname === '/health') return json({ status: 'ok' })
    if (u.pathname === '/api/sessions' && method === 'POST') { const id = body.id || 'wizard_generated'; histories.get(agent)!.add(id); return json({ session: { id, source: 'wizard-mobile', title: 'Chat' } }, 201) }
    if (u.pathname === '/api/sessions') return json({ data: [...histories.get(agent)!].map(id => ({ id, source: 'wizard-mobile', title: id, message_count: 1 })), has_more: false })
    if (u.pathname.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(u.pathname.split('/')[3])
      if (!histories.get(agent)!.has(id)) return json({ error: 'not_found' }, 404)
      if (u.pathname.endsWith('/messages')) return json({ data: [{ id: 'm1', session_id: id, role: 'assistant', content: agent }] })
      return json({ session: { id, source: 'wizard-mobile', title: agent } })
    }
    if (u.pathname === '/v1/runs' && method === 'POST') { histories.get(agent)!.add(body.session_id); return json({ run_id: `run_${agent}`, session_id: body.session_id, status: 'queued' }, 202) }
    return json({ error: 'not_found' }, 404)
  }
  const serverOptions: any = { upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture', fetchImpl, agentsDir, agentRuntime: runtime,
    agentUpstreamMode: 'localhost', agentTinfoilUrl: 'http://127.0.0.1:9/v1', settingsPath, appsJsonPath, wizardOsHome: dir,
    requireAccess: false, ownerProof: proof, agentBridge: false, followThrough: false, voiceRouting: false, mySkin: false, joinedDelegation: 'prefer',
    hermesStatePath: fixtureDbPath, voiceRecoveryManifestPath: manifestPath, helmOrigin: "http://127.0.0.1:7", helmThreadIdResolver: async () => "t-123456789abc",
    ...(queued ? { runQueueStatePath: join(dir, 'queue.sqlite'), runQueuePollIntervalMs: 0, dispatchHealthReader: () => dispatch.healthy, activeSessionReader: () => [] } : {}),
    threadSeenStatePath: join(dir, 'seen.json'), threadDispositionStatePath: join(dir, 'dispositions.json') }; const service = makeServer(serverOptions)
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { service.close(() => resolve()); service.closeAllConnections() }))
  const base = `http://127.0.0.1:${(service.address() as any).port}`
  const call = async (path: string, method = 'GET', body?: any, headers: any = owner) => fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const create = async (label: string, privacy = 'standard') => {
    const r = await call('/wizard/v1/agents', 'POST', { label, harness: 'hermes', permissions: { preset: privacy }, model: { provider: 'tinfoil', model: 'glm-5-3' } })
    const value = await r.json(); expect([r.status, value.error]).toEqual([201, undefined]); return value.agent
  }
  return { dir, settingsPath, agentsDir, base, call, create, calls, histories, status, dispatch, manifestPath, serverOptions, service, generations }
}

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { migrateJson, qualifyRawThreadRecords } from '../server/thread-reference.mjs'
import { withStoreLock, atomicStoreWrite, restoreStoreSet, INVENTORY_NAME, BACKUP_SUFFIX, migrationEntry, validateBackup } from '../server/store-migration.mjs'
const restart = async (s:any) => {
  await new Promise<void>(resolve => { s.service.close(()=>resolve()); s.service.closeAllConnections() })
  const server=createWizardServer(s.serverOptions)
  s.service = server
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  cleanup.push(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()}))
  const base=`http://127.0.0.1:${(server.address() as any).port}`
  return async(path:string, method='GET', body?:any, headers:any={})=>fetch(base+path,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})
}

it('R3_STALE_EXTERNAL: an externally changed and stopped private history is claimable is refused with a stale catalog', async () => {
  const s=await scene(), hidden=await s.create('Hidden','private'),id='wizard_unobserved_external'
  // Creation censused an empty runtime. These mutations emulate runtime-local work
  // and an external lifecycle operator, not any client metadata store.
  s.histories.get(hidden.id)!.add(id);s.status.set(hidden.id,'stopped')
  const call=await restart(s),catalog=JSON.parse(readFileSync(join(s.agentsDir,'.session-catalog.json'),'utf8')).agents[hidden.id]
  const offset=s.calls.length,r=await call('/wizard/hermes/api/sessions?agent=hermes','POST',{id},{}),body=await r.json()
  console.log('R3_STALE_EXTERNAL',JSON.stringify({catalog,status:r.status,mainNowContains:s.histories.get('hermes')!.has(id),privateContains:s.histories.get(hidden.id)!.has(id),forwarded:s.calls.slice(offset).filter(r=>r.method==='POST').map(r=>r.agent)}))
  expect(r.status).toBe(503);expect(s.histories.get('hermes')!.has(id)).toBe(false);expect(s.histories.get(hidden.id)!.has(id)).toBe(true)
})

it('R3_STOP_RACE: a session created between pre-stop census and actual stop cannot be claimed',async()=>{
 const s=await scene(),hidden=await s.create('Hidden','private'),id='wizard_stop_race'
 s.serverOptions.agentRuntime.stop=async(agentId:string)=>{s.histories.get(agentId)!.add(id);s.status.set(agentId,'stopped');return {ok:true,census:await s.serverOptions.agentRuntime.census(agentId)}}
 const stopped=await s.call('/wizard/v1/agents/'+hidden.id+'/stop','POST',{})
 const catalog=JSON.parse(readFileSync(join(s.agentsDir,'.session-catalog.json'),'utf8')).agents[hidden.id]
 const r=await s.call('/wizard/hermes/api/sessions?agent=hermes','POST',{id},{})
 console.log('R3_STOP_RACE',JSON.stringify({stopped:stopped.status,catalog,claim:r.status,mainNowContains:s.histories.get('hermes')!.has(id)}))
 expect(r.status).toBe(404);expect(catalog.complete).toBe(true);expect(catalog.seal).toBeTruthy();expect(catalog.ids).toContain(id);expect(s.histories.get('hermes')!.has(id)).toBe(false)
})

it('R3_CATALOG_PRIVACY: anonymous list/detail/settings do not expose private census contents',async()=>{
 const s=await scene(),hidden=await s.create('Hidden','private'),id='wizard_catalog_private'
 s.histories.get(hidden.id)!.add(id);await s.call('/wizard/hermes/api/sessions?agent='+hidden.id)
 s.status.set(hidden.id,'stopped')
 const rows=[]
 for(const path of ['/wizard/v1/agents','/wizard/v1/settings','/wizard/v1/bootstrap','/wizard/hermes/api/sessions?agent='+hidden.id,'/wizard/hermes/api/sessions?agent=missing','/wizard/hermes/api/sessions/'+id,'/wizard/hermes/api/sessions/wizard_absent']){
  const r=await s.call(path,'GET',undefined,{}),text=await r.text();rows.push({path,status:r.status,text})
  expect(text).not.toContain(id);expect(text).not.toContain(hidden.id)
 }
 expect(rows[3].status).toBe(404);expect(rows[4].status).toBe(404);expect(rows[3].text).toBe(rows[4].text);expect(rows[5].status).toBe(rows[6].status);expect(rows[5].text).toBe(rows[6].text)
 console.log('R3_CATALOG_PRIVACY',JSON.stringify(rows.map(({path,status})=>({path,status}))))
})

it('R3_SETTINGS_VARIANTS: non-owner agents shapes and malformed guesses are independent of hidden default value',async()=>{
 const s=await scene(),a=await s.create('Hidden A','private'),b=await s.create('Hidden B','private')
 const bodies=[{}, {agents:{}}, {agents:{default_agent_id:a.id}}, {agents:{default_agent_id:'missing'}}, {agents:{default_agent_id:null}}, {agents:{default_agent_id:{bad:true}}}, {agents:[]}, {agents:null}, {agents:{default_agent_id:a.id,extra:'safe'}}]
 const outcomes=[]
 for(const saved of [a.id,b.id]){
  await s.call('/wizard/v1/settings','PUT',{agents:{default_agent_id:saved}})
  const row=[];for(const body of bodies){const r=await s.call('/wizard/v1/settings','PUT',body,{});row.push([r.status,await r.json()])};outcomes.push(row)
  expect(JSON.parse(readFileSync(s.settingsPath,'utf8')).agents.default_agent_id).toBe(saved)
 }
 expect(outcomes[0]).toEqual(outcomes[1]);console.log('R3_SETTINGS_VARIANTS',JSON.stringify({cases:bodies.length,statuses:outcomes[0].map(r=>r[0]),identical:true}))
})

it('R3_WORKER_CLOSE: service lease survives asynchronous heavy writer shutdown',async()=>{
 const {DurableHeavyQueue}=await import('../server/heavy-queue.mjs')
 const s=await scene({queued:true});await new Promise<void>(resolve=>{s.service.close(()=>resolve());s.service.closeAllConnections()})
 const heavyPath=join(s.dir,'heavy.sqlite')
 const seed=new DurableHeavyQueue({statePath:heavyPath,intervalMs:0,transport:async()=>({}),current:async()=>false,continuation:async()=>({})})
 const job=seed.submit({sessionId:'wizard_old',origin:'fixture-origin',key:'fixture',watermark:null,spec:{cwd:'/Volumes/ThalesMedia/fixture',argv:['true'],timeout_seconds:1}});await seed.close()
 let enter:()=>void=()=>{},finish:(x:any)=>void=()=>{},finished=false
 const entered=new Promise<void>(resolve=>{enter=resolve})
 Object.assign(s.serverOptions,{heavyStatePath:heavyPath,heavyToken:'fixture-heavy-token-at-least-32-characters',heavyPollIntervalMs:1,heavyTransport:async()=>{enter();const out=await new Promise(resolve=>{finish=resolve});finished=true;return out}})
 const call=await restart(s);await entered
 // Get the new server's close via an independent on-close listener recorded by restart.
 // All fixture servers close using registered cleanup; the latest entry owns this server.
 const close=cleanup.pop()!;await close()
 const before = readFileSync(heavyPath)
 let exit = 0; try { execFileSync(process.execPath,[join(process.cwd(),'scripts/restore-agent-pairs.mjs'),'--service-stopped',s.dir,s.agentsDir],{stdio:'pipe'}) } catch(e:any) { exit=e.status }
 expect(exit).toBe(2);expect(readFileSync(heavyPath)).toEqual(before)
 let error='',restored:string[]=[];try{restored=restoreStoreSet([s.dir,s.agentsDir],{serviceStopped:true})}catch(e:any){error=e.message}
 console.log('R3_WORKER_CLOSE',JSON.stringify({transportFinished:finished,restoreAllowed:!error,restored:restored.map(p=>p.split('/').at(-1)),error}))
 finish({job_id:job.job_id,state:'queued',reason:'',receipt:null})
 await new Promise(resolve=>setTimeout(resolve,20))
 expect(error).toContain('exclusive writer ownership unavailable');expect(restored).toEqual([])
 await s.service.drained
 expect(restoreStoreSet([s.dir,s.agentsDir],{serviceStopped:true})).toContain(heavyPath)
})

it.each(['changed', 'unknown', 'running', 'unsupported'])('sealed negative evidence fails closed when lifecycle is %s', async mode => {
 const s=await scene(), secondary=await s.create('Secondary'), id='wizard_unseen'
 await s.call('/wizard/v1/agents/'+secondary.id+'/stop','POST',{})
 if(mode==='changed') s.generations.set(secondary.id,100)
 if(mode==='unknown') s.serverOptions.agentRuntime.inspect=async()=>({status:'stopped'})
 if(mode==='running') s.serverOptions.agentRuntime.inspect=async()=>({status:'running',generation:'unexpected'})
 if(mode==='unsupported') delete s.serverOptions.agentRuntime.inspect
 const call=await restart(s),r=await call('/wizard/hermes/api/sessions?agent=hermes','POST',{id})
 expect(r.status).toBe(503);expect(s.histories.get('hermes')!.has(id)).toBe(false)
})
it('a persisted seal is usable only while its stopped runtime generation still matches',async()=>{
 const s=await scene(), secondary=await s.create('Secondary')
 await s.call('/wizard/v1/agents/'+secondary.id+'/stop','POST',{})
 const call=await restart(s),r=await call('/wizard/hermes/api/sessions?agent=hermes','POST',{id:'wizard_fresh'})
 expect(r.status).toBe(201)
})
it('a driver without an offline census cannot seal online negative evidence',async()=>{
 const s=await scene(), secondary=await s.create('Secondary')
 s.serverOptions.agentRuntime.stop=async(id:string)=>{s.status.set(id,'stopped');return {ok:true}}
 delete s.serverOptions.agentRuntime.census
 await s.call('/wizard/v1/agents/'+secondary.id+'/stop','POST',{})
 const r=await s.call('/wizard/hermes/api/sessions?agent=hermes','POST',{id:'wizard_fresh'})
 expect(r.status).toBe(503)
})

it('construction failure holds its lease until initialized queue writers drain',async()=>{
 const s=await scene()
 await new Promise<void>(resolve=>{s.service.close(()=>resolve());s.service.closeAllConnections()});await s.service.drained
 let started!:()=>void,finish!:()=>void
 const began=new Promise<void>(resolve=>{started=resolve}),pending=new Promise<any[]>(resolve=>{finish=()=>resolve([])})
 const options={...s.serverOptions,runQueueStatePath:join(s.dir,'failed-queue.sqlite'),activeSessionReader:()=>{started();return pending},chatPhotos:{enabled:true}}
 expect(()=>createWizardServer(options)).toThrow(/chat photos require/)
 await began
 expect(()=>restoreStoreSet([s.dir,s.agentsDir],{serviceStopped:true})).toThrow(/exclusive writer ownership/)
 finish()
 for(let i=0;i<100;i++) {
   try { restoreStoreSet([s.dir,s.agentsDir],{serviceStopped:true});return } catch(e:any) {if(!e.message.includes('exclusive writer ownership'))throw e}
   await new Promise(resolve=>setTimeout(resolve,5))
 }
 throw new Error('construction teardown never released lease')
})

it('alias restore sets use one identity and refuse a live alias without mutation',async()=>{
 const s=await scene();await s.create('Secondary');const alias=join(s.dir,'restore-alias');symlinkSync(s.dir,alias,'dir')
 const path=join(s.agentsDir,'.session-catalog.json'),before=readFileSync(path)
 expect(()=>restoreStoreSet([s.dir,alias,s.agentsDir],{serviceStopped:true})).toThrow(/exclusive writer ownership/)
 expect(readFileSync(path)).toEqual(before)
 await new Promise<void>(resolve=>{s.service.close(()=>resolve());s.service.closeAllConnections()});await s.service.drained
 const restored=restoreStoreSet([alias,s.dir,s.agentsDir],{serviceStopped:true})
 expect(restored.length).toBeGreaterThan(0);expect(new Set(restored).size).toBe(restored.length)
})

it('R3_ALIAS_STARTUP: valid configured directory aliases share the same filesystem lease',async()=>{
 const {symlinkSync}=await import('node:fs');const rows=[]
 for(const baseline of [archivedMainDir(),'']){
  if(baseline)process.env.WAS_S2C_BASELINE=baseline;else delete process.env.WAS_S2C_BASELINE
  try{
   const s=await scene();await new Promise<void>(resolve=>{s.service.close(()=>resolve());s.service.closeAllConnections()})
   const alias=join(s.dir,'alias');symlinkSync(s.dir,alias,'dir');s.serverOptions.wizardOsHome=alias
   const factory=baseline?(await import(/* @vite-ignore */ `${baseline}/server/service.mjs`)).createWizardServer:createWizardServer
   let error='',started=false
   try{const server=factory(s.serverOptions);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));started=true;await new Promise<void>(resolve=>server.close(()=>resolve()))}catch(e:any){error=e.message}
   rows.push({baseline:!!baseline,started,error})
  }finally{delete process.env.WAS_S2C_BASELINE}
 }
 console.log('R3_ALIAS_STARTUP',JSON.stringify(rows));expect(rows.every(r=>r.started)).toBe(true);expect(rows.every(r=>!r.error)).toBe(true)
})
