import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abortKeeperStream, createRunStreamKeeper, keeperFetch, keeperUnavailable } from '../server/run-stream-keeper.mjs'
import { LockedRunBridge } from '../server/locked-run-bridge.mjs'

const frame = (name, p) => `event: ${name}\ndata: ${JSON.stringify(p)}\n\n`
const listen = (server, at) => new Promise(r => server.listen(at, () => r(server.address())))
const close = server => new Promise(r => { server.closeAllConnections?.(); server.close(r) })
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Fake Hermes: streams a turn slowly and records whether the stream was cut before the end
// (which is exactly when real Hermes would interrupt the agent).
function fakeHermes(steps = 6, gapMs = 60) {
  const runs = []
  const server = createServer((req, res) => {
    const run = { path: req.url, headers: req.headers, body: '', finished: false, cut: false }
    runs.push(run)
    req.on('data', c => { run.body += c })
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.on('close', () => { if (!run.finished) run.cut = true })
      res.write(frame('run.started', { run_id: 'run_synthetic', runtime: { model_lock: 'accepted', requested: { model: 'm', provider: 'p' } } }))
      for (let i = 0; i < steps && !run.cut; i++) { await sleep(gapMs); res.write(frame('message.delta', { delta: `part ${i} ` })) }
      if (run.cut) return
      run.finished = true
      res.end(frame('run.completed', { runtime: { model: 'm', provider: 'p' } }))
    })
  })
  return { server, runs }
}

async function setup(t, hermesOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-'))
  const hermes = fakeHermes(...(hermesOptions || []))
  const port = (await listen(hermes.server, 0)).port
  const keeper = createRunStreamKeeper({ origin: `http://127.0.0.1:${port}` })
  const socket = join(dir, 'keeper.sock')
  await listen(keeper.server, socket)
  t.after(async () => { await close(keeper.server); await close(hermes.server); rmSync(dir, { recursive: true, force: true }) })
  return { hermes, keeper, socket, port }
}

test('relays the Hermes stream and request unchanged', async (t) => {
  const { hermes, socket } = await setup(t, [2, 10])
  const response = await keeperFetch(socket, { path: '/api/sessions/wizard_synthetic/chat/stream',
    headers: { Authorization: 'Bearer synthetic-api-key', 'Content-Type': 'application/json', Cookie: 'dropped' }, body: '{"message":"synthetic"}' })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /run\.started[\s\S]*part 1[\s\S]*run\.completed/)
  assert.equal(hermes.runs[0].body, '{"message":"synthetic"}')
  assert.equal(hermes.runs[0].headers.authorization, 'Bearer synthetic-api-key')
  assert.equal(hermes.runs[0].headers.cookie, undefined)
})

test('Agent Service leaving mid-reply does not cut the Hermes stream (the restart case)', async (t) => {
  const { hermes, keeper, socket } = await setup(t)
  const response = await keeperFetch(socket, { path: '/api/sessions/wizard_synthetic/chat/stream', headers: {}, body: '{}' })
  const reader = response.body.getReader()
  await reader.read()  // reply has started
  await reader.cancel()  // the Agent Service process goes away
  await sleep(100)
  assert.equal(hermes.runs[0].cut, false)
  assert.equal(keeper.streams.size, 1)
  assert.equal([...keeper.streams.values()][0].detached, true)
  for (let i = 0; i < 40 && !hermes.runs[0].finished; i++) await sleep(50)
  assert.equal(hermes.runs[0].finished, true, 'Hermes completed the turn')
  assert.equal(keeper.streams.size, 0)
})

test('a deliberate abort still stops the turn in Hermes', async (t) => {
  const { hermes, keeper, socket } = await setup(t)
  const response = await keeperFetch(socket, { path: '/api/sessions/wizard_synthetic/chat/stream', headers: {}, body: '{}' })
  const reader = response.body.getReader()
  await reader.read()
  assert.equal(await abortKeeperStream(socket, response.keeperStream), true)
  await sleep(150)
  assert.equal(hermes.runs[0].cut, true)
  assert.equal(hermes.runs[0].finished, false)
  assert.equal(keeper.streams.size, 0)
})

test('only Hermes session chat streams are accepted', async (t) => {
  const { socket } = await setup(t)
  const response = await keeperFetch(socket, { path: '/v1/admin/anything', headers: {}, body: '{}' })
  assert.equal(response.status, 400)
})

test('Hermes down: the failure reads as never-sent, like a direct connect error', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-'))
  const keeper = createRunStreamKeeper({ origin: 'http://127.0.0.1:9' })
  const socket = join(dir, 'k.sock'); await listen(keeper.server, socket)
  t.after(async () => { await close(keeper.server); rmSync(dir, { recursive: true, force: true }) })
  await assert.rejects(keeperFetch(socket, { path: '/api/sessions/wizard_synthetic/chat/stream', headers: {}, body: '{}' }),
    (error) => error.cause?.code === 'ECONNREFUSED')
})

test('no keeper running: the bridge streams directly and says so once', async () => {
  const missing = join(tmpdir(), 'no-such-keeper-' + process.pid + '.sock')
  await assert.rejects(keeperFetch(missing, { path: '/api/sessions/x/chat/stream', headers: {}, body: '{}' }), (e) => keeperUnavailable(e))
  const logs = []; const direct = []
  const bridge = new LockedRunBridge({ origin: 'http://127.0.0.1:8642', keeperSocket: missing, log: (l) => logs.push(l),
    fetchImpl: async (url) => { direct.push(url); return new Response('ok') } })
  await bridge.openStream('/api/sessions/x/chat/stream', { method: 'POST', headers: {}, body: '{}' })
  await bridge.openStream('/api/sessions/x/chat/stream', { method: 'POST', headers: {}, body: '{}' })
  assert.deepEqual(direct, ['http://127.0.0.1:8642/api/sessions/x/chat/stream', 'http://127.0.0.1:8642/api/sessions/x/chat/stream'])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /unavailable/)
})

test('locked send through the keeper: accepted, completed, and survives the caller leaving', async (t) => {
  const { hermes, socket } = await setup(t)
  const bridge = new LockedRunBridge({ origin: 'http://127.0.0.1:1', keeperSocket: socket, log: () => {},
    fetchImpl: async () => { throw new Error('direct path must not be used') } })
  const response = await bridge.fetch('http://127.0.0.1:1/v1/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic-key' },
    body: JSON.stringify({ session_id: 'wizard_synthetic', input: 'synthetic text', model: 'm', provider: 'p', require_model_lock: true }) })
  assert.equal(response.status, 202)
  assert.equal((await response.json()).run_id, 'run_synthetic')
  assert.match(hermes.runs[0].path, /^\/api\/sessions\/wizard_synthetic\/chat\/stream$/)
  for (let i = 0; i < 40 && !hermes.runs[0].finished; i++) await sleep(50)
  assert.equal(hermes.runs[0].finished, true)
})
