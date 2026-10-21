import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: any[] = []; const dirs: string[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise(r => s.close(() => r(undefined))); for (const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true}) })
async function scene(now=Date.parse('2026-10-21T08:00:00Z')) {
  const dir=mkdtempSync(join(tmpdir(),'boom-http-'));dirs.push(dir)
  const server=createWizardServer({upstreamOrigin:'http://127.0.0.1:9',hermesKey:'fixture',requireAccess:false,agents:false,agentBridge:false,followThrough:false,joinedDelegation:'off',runQueue:false,boomerangStatePath:join(dir,'boom.db'),now:()=>now})
  servers.push(server);const a=await listen(server);return `http://127.0.0.1:${a.port}`
}
const payload={session_id:'wizard_synthetic_1',runtime:'direct',target_kind:'message',anchor_at:1792571400000,context:'Synthetic prompt',note:'Follow up',due_at:'2026-10-21T09:00:00Z',timezone:'Asia/Bangkok',client_request_id:'client-1'}
const json=(method:string,body?:any)=>({method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})

describe('boomerang HTTP API',()=>{
 it('creates, lists, reschedules, acknowledges and cancels without starting an agent run',async()=>{
  const base=await scene();let r=await fetch(base+'/wizard/v1/boomerangs',json('POST',payload));expect(r.status).toBe(201);const created=(await r.json()).reminder
  r=await fetch(base+'/wizard/v1/boomerangs');expect((await r.json()).reminders).toHaveLength(1)
  r=await fetch(`${base}/wizard/v1/boomerangs/${created.id}`,json('PATCH',{due_at:'2026-10-21T10:00:00Z',timezone:'Asia/Bangkok',note:'Edited note'}));expect((await r.json()).reminder).toMatchObject({due_at:'2026-10-21T10:00:00.000Z',note:'Edited note'})
  r=await fetch(`${base}/wizard/v1/boomerangs/${created.id}`,{method:'DELETE',headers:{'Sec-Fetch-Site':'cross-site'}});expect(r.status).toBe(403)
  r=await fetch(`${base}/wizard/v1/boomerangs/${created.id}`,{method:'DELETE'});expect((await r.json()).reminder.status).toBe('cancelled')
 })
 it('delivers one ntfy notification after due, survives repeated scans, and only deep-links context',async()=>{
  let now=Date.parse('2026-10-21T08:00:00Z');const notifications:any[]=[]
  const dir=mkdtempSync(join(tmpdir(),'boom-notify-'));dirs.push(dir)
  const server=createWizardServer({upstreamOrigin:'http://127.0.0.1:9',hermesKey:'fixture',requireAccess:false,agents:false,agentBridge:false,followThrough:false,joinedDelegation:'off',runQueue:false,boomerangStatePath:join(dir,'boom.db'),now:()=>now,boomerangNotifyOrigin:'http://notifications.invalid',boomerangNotifyTopic:'wizard',boomerangShellOrigin:'https://owner.example.invalid',boomerangPollIntervalMs:250,fetchImpl:async(url:any,init:any)=>{notifications.push({url:String(url),body:JSON.parse(init.body)});return new Response('',{status:200})}})
  servers.push(server);const a=await listen(server),base=`http://127.0.0.1:${a.port}`
  const due=new Date(now+1_000).toISOString();let r=await fetch(base+'/wizard/v1/boomerangs',json('POST',{...payload,due_at:due}));expect(r.status).toBe(201);const created=(await r.json()).reminder
  now+=2_000;await fetch(base+'/wizard/v1/boomerangs');await new Promise(r=>setTimeout(r,350));await fetch(base+'/wizard/v1/boomerangs')
  expect(notifications).toHaveLength(1);expect(notifications[0].url).toBe('http://notifications.invalid')
  expect(notifications[0].body.topic).toBe('wizard')
  expect(notifications[0].body.click).toBe(`https://owner.example.invalid/wizard-os-home/?session=wizard_synthetic_1&boomerang=${created.id}`)
  expect(JSON.stringify(notifications[0])).not.toMatch(/runs|submit|prompt=/)
 })
 it('exposes an owner-agent tool that sets an explicit durable reminder without executing it',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'boom-tool-'));dirs.push(dir);const apps=join(dir,'apps.json');writeFileSync(apps,'{"apps":[]}')
  const server=createWizardServer({upstreamOrigin:'http://127.0.0.1:9',hermesKey:'fixture',requireAccess:false,agents:false,followThrough:false,joinedDelegation:'off',runQueue:false,appsJsonPath:apps,wizardOsHome:dir,mcpToken:'owner-tool-token',bridgeWriteSkills:false,boomerangStatePath:join(dir,'boom.db'),now:()=>Date.parse('2026-10-21T08:00:00Z')})
  servers.push(server);const a=await listen(server),base=`http://127.0.0.1:${a.port}`,mcp=(method:string,params:any)=>fetch(base+'/wizard/mcp',{method:'POST',headers:{Authorization:'Bearer owner-tool-token','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json())
  const listed=await mcp('tools/list',{});expect(listed.result.tools.some((t:any)=>t.name==='boomerang_set')).toBe(true)
  const called=await mcp('tools/call',{name:'boomerang_set',arguments:{session_id:'wizard_synthetic_1',due_at:'2026-10-21T09:00:00+00:00',timezone:'Asia/Bangkok',target_kind:'message',anchor_at:1792571400000,note:'Agent-created',idempotency_key:'agent-fixture-1'}})
  expect(called.result.isError).not.toBe(true);const reminders=(await (await fetch(base+'/wizard/v1/boomerangs')).json()).reminders
  expect(reminders).toHaveLength(1);expect(reminders[0]).toMatchObject({target_kind:'message',note:'Agent-created',status:'scheduled'})
 })
 it('rejects past dates and cross-site writes',async()=>{
  const base=await scene();expect((await fetch(base+'/wizard/v1/boomerangs',json('POST',{...payload,due_at:'2026-10-21T07:00:00Z'}))).status).toBe(400)
  expect((await fetch(base+'/wizard/v1/boomerangs',{...json('POST',payload),headers:{'Content-Type':'application/json','Sec-Fetch-Site':'cross-site'}})).status).toBe(403)
 })
 it('rejects offset-less, impossible-calendar and invalid-zone reminders plus missing message anchors',async()=>{
  const base=await scene()
  for (const change of [
   {due_at:'2026-10-21T09:00:00'},
   {due_at:'2026-02-30T09:00:00Z'},
   {timezone:'Mars/Olympus'},
   {anchor_at:null},
  ]) expect((await fetch(base+'/wizard/v1/boomerangs',json('POST',{...payload,client_request_id:crypto.randomUUID(),...change}))).status).toBe(400)
 })
})
