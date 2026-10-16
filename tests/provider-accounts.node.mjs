import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionRow } from '../server/ai-usage.mjs'

const identity = { id: 'chatgpt', name: 'ChatGPT' }
const payload = accounts => ({contract:'wizard.ai-connection/1', provider:'chatgpt', status:'connected', accounts})
const account = id => ({id, name:`Subscription ${id}`, email:'a***@e***', usage:{fetchedAt:'2026-10-16T12:00:00Z', limits:[{id:'week',label:'Weekly',usedPercent:20}], paid:null}})

test('keeps independent account bars, no aggregate', () => {
  const row=connectionRow(identity,payload([account('a'),account('b')]),Date.now)
  assert.equal(row.accountCount,2)
  assert.deepEqual(row.limits,[])
  assert.deepEqual(row.accounts.map(a=>a.id),['chatgpt:a','chatgpt:b'])
  assert.equal(row.accounts[0].limits[0].remainingPercent,80)
})
test('empty authoritative pool does not expose singleton numbers', () => {
  const row=connectionRow(identity,{...payload([]),usage:{limits:[{usedPercent:90}]}},Date.now)
  assert.deepEqual(row.accounts,[])
  assert.equal(row.accountCount,0)
  assert.notEqual(row.fetchedAt,null)
})
test('duplicates and unsafe ids are excluded; missing usage is unavailable', () => {
  const row=connectionRow(identity,payload([account('a'),account('a'),account('../secret'),{id:'b'}]),Date.now)
  assert.equal(row.accountCount,2)
  assert.equal(row.accounts[1].status,'unavailable')
  assert.equal(row.accounts[1].limits.length,0)
})
