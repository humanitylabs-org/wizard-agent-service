import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableRunQueue } from '../server/run-queue.mjs'
import { createRoutedQueues } from '../server/routed-run-queue.mjs'

test.each(['anthropic', 'tinfoil', 'local'])('routed queue pins the model but never switches the runtime to registry provider %s', async provider => {
  const root = mkdtempSync(join(tmpdir(), 'routed-provider-'))
  const agent = { id: 'fixture-agent', model: { provider, model: 'fixture-model' } }
  const disposers: Array<() => Promise<void>> = [], sent: any[] = []
  const registry = { agentsDir: root, list: () => [], apiKey: () => 'fixture-runtime-key',
    fetchAgent: async (_agent: any, path: string, init: any = {}) => {
      if (path.startsWith('/api/sessions/')) return Response.json({ session: { model: 'fixture-model', provider } })
      if (init.method === 'POST') { sent.push(JSON.parse(init.body)); return Response.json({ run_id: 'fixture-run', status: 'running' }, { status: 202 }) }
      return Response.json({ run_id: 'fixture-run', status: 'running' })
    } }
  try {
    const queues = createRoutedQueues({ registry, own: (f: any) => disposers.push(f), pollIntervalMs: 0 })
    const result = await queues.fetch(agent, '/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': 'fixture-key' }, body: JSON.stringify({ session_id: 'wizard_fixture', input: 'synthetic' }) })
    assert.equal(result.status, 202)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].model, 'fixture-model')
    assert.equal(sent[0].provider, undefined)
  } finally { for (const dispose of disposers) await dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('queue authority remains fixed across admission and restart', async () => {
  const root=mkdtempSync(join(tmpdir(),'routed-authority-'))
  const options={statePath:join(root,'queue.db'),agentId:'fixture-agent',pollIntervalMs:0,launch:async()=>({payload:{status:'running'},upstreamRunId:'fixture-run'}),lookup:async()=>({payload:{status:'running'}})}
  let queue
  try {
    queue=new DurableRunQueue(options);await queue.initialize()
    const input={runtime:'direct',sessionId:'wizard_fixture',idempotencyKey:'fixture-key',requestHash:'f'.repeat(64),body:JSON.stringify({session_id:'wizard_fixture',input:'synthetic'}),agent_id:'fixture-agent'}
    assert.equal((await queue.admit(input)).record.agent_id,'fixture-agent')
    await assert.rejects(()=>queue.admit({...input,idempotencyKey:'foreign-key',agent_id:'hermes'}),/invalid queue agent/)
    await queue.close();queue=null
    assert.throws(()=>new DurableRunQueue({...options,agentId:'hermes'}),/belongs to another agent/)
    queue=new DurableRunQueue(options);await queue.initialize()
    const replay=await queue.admit(input);assert.equal(replay.replayed,true);assert.equal(replay.record.agent_id,'fixture-agent')
  } finally {await queue?.close();rmSync(root,{recursive:true,force:true})}
})
test('main queue still rejects secondary agent admission by default', async()=>{
 const root=mkdtempSync(join(tmpdir(),'main-authority-'));let queue
 try{queue=new DurableRunQueue({statePath:join(root,'q.db'),pollIntervalMs:0,launch:async()=>({payload:{status:'running'}}),lookup:async()=>({payload:{status:'running'}})})
 await assert.rejects(()=>queue.admit({runtime:'direct',sessionId:'wizard_fixture',idempotencyKey:'fixture-key',requestHash:'a'.repeat(64),body:'{}',agent_id:'fixture-agent'}),/invalid queue agent/)
 }finally{await queue?.close();rmSync(root,{recursive:true,force:true})}
})
