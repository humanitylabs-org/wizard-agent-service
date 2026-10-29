import test from 'node:test'
import assert from 'node:assert/strict'
import { RunEventLog, nativeRunEvent } from '../server/run-event-log.mjs'
import { LockedRunBridge } from '../server/locked-run-bridge.mjs'

const route = { model: 'claude-opus-5-5', provider: 'anthropic' }
const ack = { model: '', provider: '', requested: route, model_lock: 'accepted' }
const frame = (name, p) => `event: ${name}\ndata: ${JSON.stringify(p)}\n\n`
const parse = text => text.split('\n\n').filter(Boolean).map(block => ({
  id: block.match(/^id: (.+)$/m)?.[1], event: block.match(/^event: (.+)$/m)?.[1],
  data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] || 'null'),
}))
async function collect(iter) { let out = ''; for await (const f of iter) out += f; return out }

test('session-stream frames map to the native /v1/runs event vocabulary', () => {
  assert.deepEqual(nativeRunEvent('assistant.delta', { delta: 'Hi', message_id: 'm' }), ['message.delta', { delta: 'Hi' }])
  assert.deepEqual(nativeRunEvent('tool.started', { tool_name: 'terminal', preview: 'df -h' }), ['tool.started', { tool: 'terminal', preview: 'df -h' }])
  assert.deepEqual(nativeRunEvent('tool.failed', { tool_name: 'terminal' }), ['tool.completed', { tool: 'terminal', duration: 0, error: true }])
  assert.deepEqual(nativeRunEvent('tool.progress', { tool_name: '_thinking', delta: 'hmm' }), ['reasoning.available', { text: 'hmm' }])
  assert.equal(nativeRunEvent('message.started', {}), null)
  const [name, fields] = nativeRunEvent('run.completed', { messages: [{ big: 1 }], usage: { input_tokens: 1 }, session_id: 's', seq: 9 })
  assert.equal(name, 'run.completed'); assert.equal(fields.messages, undefined); assert.deepEqual(fields.usage, { input_tokens: 1 })
})

test('replay, Last-Event-ID resume and terminal end', async () => {
  const log = new RunEventLog()
  log.open('run_a')
  log.record('run_a', 'tool.started', { tool_name: 'terminal', preview: 'ls' })
  log.record('run_a', 'assistant.delta', { delta: 'Done' })
  const live = collect(log.frames('run_a', -1))
  setTimeout(() => log.record('run_a', 'run.completed', { usage: {} }), 10)
  const all = parse(await live)
  assert.deepEqual(all.map(e => e.event), ['tool.started', 'message.delta', 'run.completed'])
  assert.deepEqual(all.map(e => e.id), ['1', '2', '3'])
  const resumed = parse(await collect(log.frames('run_a', 2)))
  assert.deepEqual(resumed.map(e => e.event), ['run.completed'])
  assert.equal(log.record('run_a', 'assistant.delta', { delta: 'late' }), null)
})

test('detach ends a waiting subscriber; unknown runs yield nothing', async () => {
  const log = new RunEventLog()
  log.open('run_b')
  const live = collect(log.frames('run_b'))
  setTimeout(() => log.detach('run_b'), 10)
  assert.equal(await live, '')
  assert.equal(await collect(log.frames('run_missing')), '')
})

test('abort signal releases a waiting subscriber', async () => {
  const log = new RunEventLog(); log.open('run_c')
  const controller = new AbortController()
  const live = collect(log.frames('run_c', -1, controller.signal))
  setTimeout(() => controller.abort(), 10)
  assert.equal(await live, '')
  assert.equal(log.runs.get('run_c').listeners.size, 0)
})

test('finished runs are pruned after retention', () => {
  let t = 0
  const log = new RunEventLog({ retainMs: 1000, now: () => t })
  log.open('run_d'); log.record('run_d', 'run.completed', {})
  t = 5000; log.open('run_e')
  assert.equal(log.has('run_d'), false); assert.equal(log.has('run_e'), true)
})

test('locked bridge records the live chat/stream frames under the native run id', async () => {
  const body = frame('run.started', { run_id: 'run_live', runtime: ack })
    + frame('tool.started', { tool_name: 'terminal', preview: 'df -h' })
    + frame('tool.completed', { tool_name: 'terminal' })
    + frame('assistant.delta', { delta: 'Disk is fine.' })
    + frame('run.completed', { runtime: { model: route.model, provider: route.provider }, messages: [] })
  const bridge = new LockedRunBridge({ origin: 'http://127.0.0.1:8865',
    fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }) })
  const r = await bridge.fetch('http://127.0.0.1:8865/v1/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' },
    body: JSON.stringify({ session_id: 'wizard_x', input: 'check disk', ...route, require_model_lock: true }) })
  assert.equal((await r.json()).run_id, 'run_live')
  await Promise.allSettled([...bridge.streams])
  assert.equal(bridge.isLockedRun('run_live'), true)
  const events = parse(await collect(bridge.events.frames('run_live')))
  assert.deepEqual(events.map(e => e.event), ['tool.started', 'tool.completed', 'message.delta', 'run.completed'])
  assert.equal(events[0].data.tool, 'terminal'); assert.equal(events[2].data.delta, 'Disk is fine.')
})

test('a terminal frame recorded while the reader is suspended at a yield is still delivered', async () => {
  const log = new RunEventLog(); log.open('run_race')
  log.record('run_race', 'tool.started', { tool_name: 'terminal' })
  const iter = log.frames('run_race')
  const first = await iter.next()
  assert.match(first.value, /tool\.started/)
  log.record('run_race', 'assistant.delta', { delta: 'last words' })
  log.record('run_race', 'run.completed', {})
  const rest = []
  for (let step = await iter.next(); !step.done; step = await iter.next()) rest.push(step.value)
  assert.deepEqual(rest.map(f => f.match(/^event: (.+)$/m)[1]), ['message.delta', 'run.completed'])
})

test('a detach while suspended still delivers frames recorded before it', async () => {
  const log = new RunEventLog(); log.open('run_det')
  log.record('run_det', 'tool.started', { tool_name: 'a' })
  const iter = log.frames('run_det')
  await iter.next()
  log.record('run_det', 'tool.completed', { tool_name: 'a' })
  log.detach('run_det')
  const step = await iter.next()
  assert.match(step.value, /tool\.completed/)
  assert.equal((await iter.next()).done, true)
})
