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
  const registry = { agentsDir: root, list: () => [], read: () => agent, apiKey: () => 'fixture-runtime-key',
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

test('a cached routed queue follows the current sealed runtime after migration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'routed-migrate-'))
  const legacy = { id: 'fixture-agent', model: { provider: 'tinfoil', model: 'fixture-model' }, runtime: { isolation: '', port: 18001 } }
  let current = legacy
  const sent: string[] = [], disposers: Array<() => Promise<void>> = []
  const registry = { agentsDir: root, list: () => [], read: () => current, apiKey: () => 'fixture-auth',
    fetchAgent: async (agent: any, path: string) => {
      sent.push(agent.runtime.isolation)
      if (agent !== current) throw new TypeError('old TCP route is closed')
      return Response.json(path.startsWith('/api/sessions/') ? { model: 'fixture-model' } : { run_id: 'fixture-run', status: 'completed', output: 'synthetic' })
    } }
  try {
    const queues = createRoutedQueues({ registry, own: (f: any) => disposers.push(f), pollIntervalMs: 0 })
    const post = (key: string, agent: any) => queues.fetch(agent, '/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ session_id: 'wizard_' + key, input: 'synthetic' }) })
    assert.equal((await (await post('before', legacy)).json()).status, 'completed')
    current = { ...legacy, runtime: { ...legacy.runtime, isolation: 'restricted' } }
    const after = await (await post('after', current)).json()
    assert.equal(after.status, 'completed')
    assert.equal(sent.at(-1), 'restricted')
  } finally { for (const dispose of disposers) await dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('removing an agent never dispatches an already cached legacy runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'routed-removed-'))
  const agent = { id: 'fixture-agent', model: { model: 'fixture-model' } }
  let current: any = agent, calls = 0
  const disposers: Array<() => Promise<void>> = []
  const registry = { agentsDir: root, list: () => [], read: () => current, apiKey: () => 'fixture-auth', fetchAgent: async () => { calls++; return Response.json({ run_id: 'fixture-run', status: 'completed' }) } }
  try {
    const queues = createRoutedQueues({ registry, own: (f: any) => disposers.push(f), pollIntervalMs: 0 })
    const post = (id: string) => queues.fetch(agent, '/v1/runs', { method: 'POST', body: JSON.stringify({ session_id: 'wizard_' + id, input: 'synthetic', model: 'fixture-model' }) })
    assert.equal((await (await post('before')).json()).status, 'completed')
    const before = calls
    current = null
    assert.equal((await (await post('after')).json()).status, 'failed')
    assert.equal(calls, before)
  } finally { for (const dispose of disposers) await dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('a capacity-delayed routed watcher durably restores archive state at actual dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'routed-watch-'))
  const agent = { id: 'fixture-agent', model: { provider: 'local', model: 'fixture-model' } }
  const disposers: Array<() => Promise<void>> = [], calls: any[] = []
  let firstStatus = 'running', archived = true, sequence = 0
  const registry = { agentsDir: root, list: () => [], apiKey: () => 'fixture-runtime-key',
    fetchAgent: async (_agent: any, path: string, init: any = {}) => {
      if (path.startsWith('/api/sessions/') && init.method === 'PATCH') { archived = JSON.parse(init.body).archived; calls.push({ path, archived }); return Response.json({ archived }) }
      if (path.startsWith('/api/sessions/')) return Response.json({ session: { model: 'fixture-model', archived } })
      if (path === '/v1/runs' && init.method === 'POST') { archived = false; const run_id = `fixture-run-${++sequence}`; calls.push({ path, run_id }); return Response.json({ run_id, status: 'running' }, { status: 202 }) }
      if (path === '/v1/runs/fixture-run-1') return Response.json({ run_id: 'fixture-run-1', status: firstStatus })
      return Response.json({ run_id: 'fixture-run-2', status: 'running' })
    } }
  try {
    const queues = createRoutedQueues({ registry, own: (f: any) => disposers.push(f), pollIntervalMs: 0, maxActive: 1 })
    await queues.fetch(agent, '/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': 'blocking-run' }, body: JSON.stringify({ session_id: 'wizard_blocker', input: 'hold', model: 'fixture-model' }) })
    archived = true
    const watcher = await queues.fetch(agent, '/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': 'watcher-run', 'X-Wizard-Schedule-Kind': 'watch', 'X-Wizard-Watcher-Preserve': '1' }, body: JSON.stringify({ session_id: 'wizard_origin', input: 'check', model: 'fixture-model' }) })
    const watcherId = (await watcher.json()).run_id
    assert.equal(sequence, 1)
    assert.equal(archived, true)
    firstStatus = 'completed'
    await queues.fetch(agent, `/v1/runs/${watcherId}`)
    assert.equal(sequence, 2)
    assert.equal(archived, true)
    assert.deepEqual(calls.filter(call => 'archived' in call).map(call => call.archived), [true])
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
