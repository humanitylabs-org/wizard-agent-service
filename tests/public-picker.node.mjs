import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelSelections } from '../server/model-selection.mjs'
import { LockedRunBridge, selectLockedRoute, runtimeMatches } from '../server/locked-run-bridge.mjs'
const A = { model: 'fixture-alpha', provider: 'fixture-one' }
const B = { model: 'fixture-beta', provider: 'fixture-two' }
const sid = 'wizard_synthetic_selection'
const message = (route = A, version = 7) => ({ session_id: sid, input: 'Reply OK', ...route, selection_version: version, require_model_lock: true })
const choice = (route = B, version = 7, id = 'pick-one') => ({ ...route, selection_version: version, selection_request_id: id })
const seeded = () => new ModelSelections({ sessionRoute: () => ({ ...A, version: 7 }) })
const conflict = error => error.status === 409 && error.payload.error.code.startsWith('model_selection_')
const frame = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
const stream = route => new Response(frame('run.started', { run_id: 'run_synthetic', runtime: { ...route, model_lock: 'accepted' } }) + frame('run.completed', { runtime: { ...route, model_lock: 'confirmed' } }), { headers: { 'Content-Type': 'text/event-stream' } })
const request = (value, key = 'synthetic-key', extra = {}) => ({ method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(value), ...extra })

for (const [name, requested] of [['another family', B], ['same model different provider', { ...A, provider: B.provider }], ['unrelated family', { model: 'fixture-gamma', provider: A.provider }]]) {
  test(`stale ${name} is a visible conflict, never a substitute`, () => {
    assert.throws(() => seeded().capture(message(requested)), conflict)
  })
}
test('same route with old revision conflicts; missing-revision legacy route match is allowed', () => {
  const s = seeded()
  assert.throws(() => s.capture(message(A, 6)), conflict)
  const legacy = message(); delete legacy.selection_version
  assert.equal(s.capture(legacy).model, A.model)
  assert.throws(() => s.capture({ ...legacy, provider: B.provider }), conflict)
})
test('new chats accept explicitly selected drafts and resolved defaults without a phantom lock', () => {
  for (const route of [A, B]) {
    const s = new ModelSelections()
    assert.equal(s.capture(message(route, 0)).model, route.model)
    assert.equal(s.current(sid).version, 1)
  }
})
test('new-chat stale version zero cannot overwrite the first established choice', () => {
  const s = new ModelSelections(); s.capture(message(A, 0))
  assert.throws(() => s.capture(message(B, 0)), conflict)
})
test('deliberate change is CAS, a stale device cannot change it back', async () => {
  const s = seeded(); let applied = 0
  const b = await s.change(sid, choice(), async () => { applied++; return B })
  assert.equal(b.version, 8)
  await assert.rejects(s.change(sid, choice(A, 7, 'stale-device'), async () => { applied++; return A }), conflict)
  assert.equal(applied, 1); assert.throws(() => s.capture(message(A, 7)), conflict)
  assert.equal(s.capture(message(B, 8)).provider, B.provider)
})
test('pending picker prevents sends and competing picker changes', async () => {
  const s = seeded(); let release
  const pending = s.change(sid, choice(), () => new Promise(resolve => { release = resolve }))
  assert.throws(() => s.capture(message()), conflict)
  await assert.rejects(s.change(sid, choice(A, 7, 'other'), async () => A), conflict)
  release(B); await pending
})
test('proven picker rejection restores and returns the exact prior choice for recovery', async () => {
  const s = seeded()
  await assert.rejects(s.change(sid, choice(), () => { throw Object.assign(new Error('synthetic pre-execution rejection'), { selectionNotApplied: true }) }), error => {
    assert.equal(error.status, 409); assert.equal(error.payload.error.code, 'model_selection_not_applied')
    assert.equal(error.payload.selection.model, A.model); assert.equal(error.payload.selection.provider, A.provider); assert.equal(error.payload.selection.version, 7)
    return true
  })
  assert.equal(s.pending.size, 0); assert.equal(s.capture(message()).selection_version, 7)
})
test('lost response replays the same picker request without applying it twice', async () => {
  const s = seeded(); let applies = 0
  const apply = async () => { applies++; return B }
  const first = await s.change(sid, choice(), apply)
  assert.deepEqual(await s.change(sid, choice(), apply), first)
  assert.equal(applies, 1)
})
test('unknown picker outcome survives restart fail-closed and same-request recovery works', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-selection-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const options = { statePath: join(dir, 'selection.json'), sessionRoute: () => ({ ...A, version: 7 }) }
  let s = new ModelSelections(options)
  await assert.rejects(s.change(sid, choice(), async () => { throw new TypeError('Connection lost') }))
  s = new ModelSelections(options)
  assert.throws(() => s.capture(message(A, 7)), conflict)
  const recovered = await s.change(sid, choice(), async () => B)
  assert.equal(recovered.state, 'confirmed'); assert.equal(recovered.version, 8)
})
test('an unexpected picker ACK remains indeterminate, not an acknowledged substitute', async () => {
  const s = seeded()
  await assert.rejects(s.change(sid, choice(), async () => A), conflict)
  assert.equal(s.current(sid).state, 'pending')
  assert.throws(() => s.capture(message(A, 7)), conflict)
})
test('native runtime lock rewrites cannot move the deliberate-choice revision', async () => {
  let native = { ...A, version: 7 }
  const s = new ModelSelections({ sessionRoute: () => native })
  s.capture(message())
  await s.change(sid, choice(), async () => B)
  native = { ...A, version: 999999 }
  assert.equal(s.current(sid).model, B.model); assert.equal(s.current(sid).version, 8)
})
test('admission lost/replayed after picker change retains exact route and starts once', async () => {
  const calls = []
  const b = new LockedRunBridge({ isPublicSession: () => true, origin: 'http://synthetic', sessionRoute: () => ({ ...A, version: 7 }), fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return stream(A) } })
  const body = message(); await b.fetch('http://synthetic/v1/runs', request(body)); await Promise.all([...b.streams])
  await b.selections.change(sid, choice(), async () => B)
  const replay = await b.fetch('http://synthetic/v1/runs', request(body))
  assert.equal(replay.headers.get('Idempotency-Replayed'), 'true'); assert.equal(calls.length, 1)
  assert.equal((await replay.json()).runtime.model, A.model)
})
test('pending admission replay after picker change joins the original launch', async () => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const calls = []
  const b = new LockedRunBridge({ isPublicSession: () => true, origin: 'http://synthetic', sessionRoute: () => ({ ...A, version: 7 }), fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(init.body)); entered()
    return new Promise(resolve => { release = () => resolve(stream(A)) })
  } })
  const body = message(), first = b.fetch('http://synthetic/v1/runs', request(body))
  await started; await b.selections.change(sid, choice(), async () => B)
  const replay = b.fetch('http://synthetic/v1/runs', request(body))
  release()
  const [original, repeated] = await Promise.all([first, replay])
  assert.equal(repeated.headers.get('Idempotency-Replayed'), 'true')
  assert.deepEqual(await repeated.json(), await original.json()); assert.equal(calls.length, 1)
  await Promise.all([...b.streams])
})
test('durable completed admission replay after bridge reload and later picker starts once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-replay-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const calls = [], options = { statePath: join(dir, 'admissions.json'), isPublicSession: () => true, origin: 'http://synthetic', sessionRoute: () => ({ ...A, version: 7 }), fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return stream(A) } }
  let b = new LockedRunBridge(options)
  const body = message(), original = await (await b.fetch('http://synthetic/v1/runs', request(body))).json()
  await Promise.all([...b.streams]); assert.equal([...b.entries.values()][0].state, 'completed')
  b = new LockedRunBridge(options); await b.selections.change(sid, choice(), async () => B)
  const replay = await b.fetch('http://synthetic/v1/runs', request(body))
  assert.equal(replay.headers.get('Idempotency-Replayed'), 'true')
  assert.deepEqual(await replay.json(), original); assert.equal(calls.length, 1)
})
for (const [field, value] of [['input', 'Different synthetic message'], ['model', B.model], ['provider', B.provider]]) {
  test(`same idempotency key with changed ${field} rejects without another launch`, async () => {
    let calls = 0
    const b = new LockedRunBridge({ isPublicSession: () => true, origin: 'http://synthetic', sessionRoute: () => ({ ...A, version: 7 }), fetchImpl: async () => { calls++; return stream(A) } })
    await b.fetch('http://synthetic/v1/runs', request(message())); await Promise.all([...b.streams])
    await b.selections.change(sid, choice(), async () => B)
    await assert.rejects(b.fetch('http://synthetic/v1/runs', request({ ...message(), [field]: value })), error => error.status === 422)
    assert.equal(calls, 1)
  })
}
test('the same idempotency key in another session cannot reuse the first session admission', async () => {
  const calls = []
  const b = new LockedRunBridge({ isPublicSession: () => true, origin: 'http://synthetic', sessionRoute: () => ({ ...A, version: 7 }), fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return stream(A) } })
  await b.fetch('http://synthetic/v1/runs', request(message()))
  const response = await b.fetch('http://synthetic/v1/runs', request({ ...message(), session_id: sid + '_other' }))
  assert.equal(response.headers.get('Idempotency-Replayed'), null)
  assert.equal((await response.json()).session_id, sid + '_other')
  assert.deepEqual(calls.map(c => c.session_id), [sid, sid + '_other']); await Promise.all([...b.streams])
})
for (const headers of [{}, { 'Idempotency-Key': '' }]) test('missing/empty public locked idempotency key is 400: ' + JSON.stringify(headers), async () => {
  let calls = 0
  const b = new LockedRunBridge({ isPublicSession: () => true, origin: 'http://synthetic', sessionRoute: () => ({ ...A, version: 7 }), fetchImpl: async () => { calls++; return stream(A) } })
  await assert.rejects(b.fetch('http://synthetic/v1/runs', { ...request(message()), headers }), error => error.status === 400)
  assert.equal(calls, 0)
})
test('trusted unselected queue custody stays unselected even after a later picker', async () => {
  const calls = []
  const b = new LockedRunBridge({ isPublicSession: () => true, origin: 'http://synthetic', fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ run_id: 'unselected_native', status: 'running' })) } })
  await b.selections.change(sid, choice(B, 0), async () => B)
  const body = { session_id: sid, input: 'Unselected at original admission' }
  const response = await b.fetch('http://synthetic/v1/runs', request(body, 'unselected', { wizardAdmittedRoute: true }))
  assert.equal((await response.json()).status, 'running')
  assert.deepEqual(calls, [{ url: 'http://synthetic/v1/runs', body }])
  await assert.rejects(b.fetch('http://synthetic/v1/runs', request({ ...body, require_model_lock: true }, 'missing-route', { wizardAdmittedRoute: true })), error => error.status === 400)
  assert.equal(calls.length, 1)
})
test('trusted admitted queue message retains its route after a later intentional switch', async () => {
  const calls = []
  const b = new LockedRunBridge({ isPublicSession: () => true, origin: 'http://synthetic', sessionRoute: () => ({ ...A, version: 7 }), fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return stream(A) } })
  b.selections.capture(message()); await b.selections.change(sid, choice(), async () => B)
  await b.fetch('http://synthetic/v1/runs', request(message(), 'durably-admitted', { wizardAdmittedRoute: true }))
  assert.equal(calls[0].model, A.model); assert.equal(calls[0].require_model_lock, true)
  await Promise.all([...b.streams])
})
test('a caller cannot forge admitted custody in the JSON body; stale send does zero native calls', async () => {
  let calls = 0
  const b = new LockedRunBridge({ isPublicSession: () => true, origin: 'http://synthetic', sessionRoute: () => ({ ...A, version: 7 }), fetchImpl: async () => { calls++; return stream(A) } })
  await b.selections.change(sid, choice(), async () => B)
  await assert.rejects(b.fetch('http://synthetic/v1/runs', request({ ...message(), wizardAdmittedRoute: true })), conflict)
  assert.equal(calls, 0)
})
test('guidance retains immutable admitted revision across a pending and completed picker', async () => {
  const s=seeded(),captured=message(),guidance={input:'Additional synthetic guidance',...A,selection_version:7}
  let release
  const pending=s.change(sid,choice(),()=>new Promise(resolve=>{release=resolve}))
  s.assertQueuedGuidance(sid,guidance,captured)
  assert.throws(()=>s.capture(message()),conflict,'pending still fences NEW admissions')
  assert.throws(()=>s.assertQueuedGuidance(sid,{...guidance,...B},captured),conflict)
  assert.throws(()=>s.assertQueuedGuidance(sid,{...guidance,selection_version:8},captured),conflict)
  release(B);await pending
  s.assertQueuedGuidance(sid,guidance,captured)
  assert.throws(()=>s.assertQueuedGuidance(sid,{input:'Missing admitted selection'},captured),conflict)
})
test('actual provider contradiction is not excused by requested metadata', () => {
  assert.equal(runtimeMatches({ ...B, model: A.model, requested: A }, A), false)
})
