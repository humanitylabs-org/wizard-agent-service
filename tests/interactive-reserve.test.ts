import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash, isBackgroundContinuation } from '../server/run-queue.mjs'
const dirs: string[] = [], queues: any[] = []
afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d,{recursive:true,force:true}) })
const request = (id: string, continuation: any = null) => {
 const body = JSON.stringify({session_id:id,input:'An ordinary request; words never choose priority'})
 return { runtime:'direct',sessionId:id,idempotencyKey:id,body,requestHash:queueRequestHash('direct',body),continuation }
}
async function setup() {
 const dir=await mkdtemp(join(tmpdir(),'wizard-reserve-'));dirs.push(dir)
 const statePath=join(dir,'queue.sqlite3'), launches:string[]=[], states=new Map<string,string>()
 let dispatch=false
 const options={statePath,maxActive:4,reservedInteractive:2,pollIntervalMs:0,canDispatch:()=>dispatch,
  launch:async (r:any)=>{launches.push(r.sessionId);states.set(r.sessionId,'running');return {upstreamRunId:r.sessionId,status:'running',payload:{status:'running'}}},
  lookup:async(r:any)=>({payload:{status:states.get(r.sessionId)||'running'}})}
 const q=new DurableRunQueue(options);queues.push(q);await q.initialize()
 return {q,options,launches,states,enable:()=>{dispatch=true}}
}
it('protects two live question slots when background work saturates its share',async()=>{
 const s=await setup()
 for(let i=0;i<4;i++)await s.q.admit(request('bg'+i,{kind:'external-heavy',job_id:'job'+i}))
 s.enable();await s.q.tick(true);expect(s.launches).toEqual(['bg0','bg1'])
 await s.q.admit(request('question1'));await s.q.admit(request('question2'));await s.q.tick(true)
 expect(s.launches).toEqual(['bg0','bg1','question1','question2'])
 expect((await s.q.summary()).interactive_reserved).toBe(2)
 expect((await s.q.summary()).active).toBe(4)
})
it('prioritizes new human input ahead of already queued automatic completions',async()=>{
 const s=await setup();await s.q.admit(request('older-background',{delegation_id:'internal-helper'}));await s.q.admit(request('human'))
 s.enable();await s.q.tick(true);expect(s.launches).toEqual(['human','older-background'])
})
it('preserves reservation across restart and lets background work make progress',async()=>{
 const s=await setup();for(let i=0;i<3;i++)await s.q.admit(request('bg'+i,{kind:'external-heavy'}))
 s.enable();await s.q.tick(true);s.q.close();queues.splice(queues.indexOf(s.q),1)
 const reopened=new DurableRunQueue(s.options);queues.push(reopened);await reopened.initialize();expect(s.launches).toEqual(['bg0','bg1'])
 s.states.set('bg0','completed');await reopened.tick(true);expect(s.launches).toEqual(['bg0','bg1','bg2'])
})
it('keeps manual recovery interactive and ignores model-authored priority language',()=>{
 expect(isBackgroundContinuation({continuation:{kind:'background-recovery'}})).toBe(false)
 expect(isBackgroundContinuation({continuation:null,body:'background expensive slow build'})).toBe(false)
 expect(isBackgroundContinuation({continuation:{kind:'external-heavy'},body:'urgent fast question'})).toBe(true)
})
it('does not bypass provider backoff to fill a reserved slot',async()=>{
 const s=await setup();await s.q.admit(request('human'))
 s.q.database.prepare('INSERT INTO wizard_provider_backoff VALUES (?,?,?)').run(JSON.stringify(['direct','configured','configured']),Date.now()/1000+60,1)
 s.enable();await s.q.tick(true);expect(s.launches).toEqual([]);expect((await s.q.summary()).provider_waiting).toBe(1)
})
