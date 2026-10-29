import test from 'node:test'
import assert from 'node:assert/strict'
import { projectListSlices } from '../server/session-list-cache.mjs'

test('cooperative list projection preserves every row, order and head enrichment while yielding the HTTP loop',async()=>{
  const source=Array.from({length:237},(_,i)=>({id:`synthetic-${i}`})), seen=[], flags=[]
  let turns=0, running=true
  const tick=()=>{if(running){turns++;setImmediate(tick)}};setImmediate(tick)
  try {
    const result=await projectListSlices(source,async(rows,head)=>{seen.push(rows.length);flags.push(head);return rows.map(r=>({...r,enriched:head}))},true)
    assert.deepEqual(result,source.map(r=>({...r,enriched:true})))
    assert.ok(seen.every(n=>n<=20));assert.ok(flags.every(Boolean));assert.ok(turns>=seen.length)
  } finally {running=false}
})
test('archive slices do not turn on expensive head enrichment or duplicate boundaries',async()=>{
  const source=Array.from({length:101},(_,i)=>({id:`archive-${i}`}))
  assert.deepEqual(await projectListSlices(source,async(rows,head)=>{assert.equal(head,false);return rows},false),source)
  assert.deepEqual(await projectListSlices([],()=>{throw Error('empty batch')},true),[])
})
