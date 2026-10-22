import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableRunQueue } from '../server/run-queue.mjs'

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
