import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { upstreamError } from '../server/hermes-compat.mjs'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const request = (sessionId: string, key = sessionId, continuation: any = null, provider = 'ready') => {
  const body = JSON.stringify({session_id: sessionId, input: 'A test request', provider})
  return {runtime:'direct', sessionId, idempotencyKey:key, body, requestHash:queueRequestHash('direct',body), continuation}
}
function setup(extra: any = {}) {
  const root = mkdtempSync(join(tmpdir(),'compat-resource-'))
  cleanup.push(() => rmSync(root,{recursive:true,force:true}))
  const options = {statePath:join(root,'queue.db'), pollIntervalMs:0, maxActive:4, reservedInteractive:2, ...extra}
  const open = () => { const q = new DurableRunQueue(options); cleanup.push(() => q.close()); return q }
  return {open, options}
}

it('unknown releases capacity without bypassing reservation or the same-session fence, including restart', async () => {
  const launches: string[] = [], states = new Map<string,string>()
  let enabled = false
  const s = setup({canDispatch:()=>enabled, activeSessionIds:()=>launches.includes('head')&&states.get('head')==='unknown'?['held']:[],
    launch:async (r:any) => { launches.push(r.idempotencyKey); return {upstreamRunId:r.idempotencyKey,payload:{status:states.get(r.idempotencyKey)||'running'}} },
    lookup:async (r:any) => ({payload:{status:states.get(r.idempotencyKey)||'running'}})})
  let q = s.open()
  states.set('head','unknown')
  await q.admit(request('held','head',{kind:'external-heavy'}))
  enabled = true; await q.tick(true)
  await q.admit(request('held','follower'))
  for (const key of ['bg1','bg2','bg3']) await q.admit(request(key,key,{kind:'external-heavy'}))
  expect(launches).toEqual(['head','bg1','bg2'])
  expect((await q.summary()).active).toBe(2)
  q.close(); q = s.open(); await q.initialize()
  await q.admit(request('human'))
  await q.admit(request('manual','manual',{kind:'background-recovery'}))
  expect(launches).toEqual(['head','bg1','bg2','human','manual'])
  expect(q.byIdempotencyKey('direct','bg3').waitingReason).toBe('interactive_reserve')
  expect(q.byIdempotencyKey('direct','follower').status).toBe('queued')
  states.set('head','interrupted'); states.set('human','completed')
  await q.tick(true)
  expect(launches.filter(k=>k==='follower')).toHaveLength(1)
  expect(launches.filter(k=>k==='head')).toHaveLength(1)
  expect(launches).not.toContain('bg3')
})

it.each(['permission_denied','idempotency_key_conflict','admission_conflict'])(
  'permanent %s cannot create a provider cooldown even with Retry-After', async code => {
    const calls:string[]=[]
    const s=setup({launch:async(r:any)=>{
      calls.push(r.idempotencyKey)
      if(r.idempotencyKey==='refused') throw upstreamError(409,JSON.stringify({error:{code}}),'7200')
      return {upstreamRunId:r.idempotencyKey,payload:{status:'completed'}}
    },lookup:async()=>({})})
    const q=s.open(), result=await q.admit(request('refused','refused',{kind:'external-heavy'}))
    expect(result.record.status).toBe('failed')
    expect(result.record.payload.error.code).toBe(code)
    expect(q.database.prepare('SELECT * FROM wizard_provider_backoff').all()).toEqual([])
    await q.admit(request('human')); await q.tick(true)
    expect(calls).toEqual(['refused','human'])
  })

it.each([7200,'7200','http-date'])(
  'Retry-After %s persists across restart and reserved manual input cannot bypass its scope', async retryAfter => {
    const calls:string[]=[]
    const s=setup({launch:async(r:any)=>{
      calls.push(r.idempotencyKey)
      if(JSON.parse(r.body).provider==='busy') throw upstreamError(429,'{}',retryAfter === 'http-date' ? new Date(Date.now()+7200_000).toUTCString() : retryAfter)
      return {upstreamRunId:r.idempotencyKey,payload:{status:'completed'}}
    },lookup:async()=>({})})
    let q=s.open()
    const result=await q.admit(request('automatic','automatic',{kind:'external-heavy'},'busy'))
    expect(result.record.retryAfter-Date.now()/1000).toBeGreaterThan(7198)
    const deadline=q.database.prepare('SELECT retry_after FROM wizard_provider_backoff').get().retry_after
    q.close(); q=s.open(); await q.initialize()
    await q.admit(request('manual','manual',{kind:'background-recovery'},'busy'))
    await q.admit(request('human','human',null,'ready'))
    expect(calls).toEqual(['automatic','human'])
    expect(q.byIdempotencyKey('direct','manual').waitingReason).toBe('provider_busy')
    expect(q.database.prepare('SELECT retry_after FROM wizard_provider_backoff').get().retry_after).toBe(deadline)
  })
