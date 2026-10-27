import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Transform } from 'node:stream'
import { createIncognito } from '../server/incognito.mjs'
import { createPrincipalResolver } from '../server/principals.mjs'
import { isAllowedProxyRequest } from '../server/service.mjs'
const proof = 'owner-proof-synthetic-'.repeat(3)
const key = 'ephemeral-synthetic-key-'.repeat(3)
const agent = { id: 'synthetic', label: 'Synthetic private', privacy: 'private', model: { provider: 'tinfoil', model: 'synthetic-model', allowed_models: ['synthetic-model'] }, permissions: { files: 'none' } }
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
async function rig(t, opts = {}) {
  const calls = [], messages = [], stopped = [], durable = [], principals = createPrincipalResolver({ ownerProof: proof, agentForToken: x => x === 'agent-token' ? 'synthetic' : '' })
  let now = 0, runNo = 0
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ path, init })
    if (path === '/api/sessions') return Response.json({ id: JSON.parse(init.body).id }, { status: 201 })
    if (path === '/v1/runs') {
      const value = JSON.parse(init.body); messages.push(value)
      return Response.json({ run_id: 'run-' + (++runNo), session_id: value.session_id, status: 'running' }, { status: 202 })
    }
    if (path.endsWith('/events')) return new Response('event: delta\ndata: {"text":"synthetic-stream"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    if (/\/v1\/runs\/run-\d+$/.test(path)) return Response.json({ run_id: path.split('/').pop(), session_id: messages.at(-1).session_id, status: 'completed', output: opts.leak ? key : messages.map(x => x.input).join(' | ') })
    return Response.json({ error: 'unexpected' }, { status: 500 })
  }
  const runtime = { incognitoStart: async () => ({ origin: 'http://127.0.0.1:23456', key, history_search: opts.history || 'available' }), incognitoStop: async (agent, data) => { stopped.push(data.session_id) }, incognitoLease: async () => ({ ok: true }) }
  const registry = { read: id => id === agent.id ? { ...agent, ...opts.agent } : null,
    pin: (...a) => durable.push(a), noteRun: (...a) => durable.push(a), observeSessions: (...a) => durable.push(a) }
  const manager = createIncognito({ registry, runtime, fetchImpl, now: () => now, leaseMs: 1000, maxMs: 3000,
    proxyContext: { sendJson: json, isAllowedProxyRequest, mainSecrets: [], secretGuard: secrets => new Transform({ transform(c, _e, cb) { cb(null, secrets.some(s => c.includes(s)) ? Buffer.from('') : c) } }),
      readJson: async req => { let s = ''; for await (const x of req) s += x; return JSON.parse(s) } } })
  const server = createServer(async (req, res) => {
    try { await principals.attach(req); if (!await manager.handle(new URL(req.url, 'http://fixture'), req, res)) json(res, 404, {}) }
    catch (e) { json(res, e.status || 500, { error: e.code || e.message }) }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await manager.close(); await new Promise(r => server.close(r)) })
  const base = `http://127.0.0.1:${server.address().port}/wizard/v1/agents/synthetic/incognito`
  const request = (suffix = '', method = 'GET', data, auth = true, extra = {}) => fetch(base + suffix, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-wizard-owner-proof': proof } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) })
  const start = async () => { const r = await request('', 'POST', {}); assert.equal(r.status, 201, await r.clone().text()); return (await r.json()).session_id }
  return { request, start, calls, messages, stopped, durable, manager, setNow: n => { now = n } }
}
test('history-search metadata is explicit and the source fallback configuration is not replaced', async t => {
  for (const history of ['available', 'unavailable']) {
    const s = await rig(t, { history, agent: { model: { ...agent.model, fallback: 'source-configured' } } });
    const response = await s.request('', 'POST', {}); assert.equal(response.status, 201);
    const value = await response.json(); assert.equal(value.history_search, history);
    assert.equal(Object.hasOwn(value, 'key'), false); assert.equal(Object.hasOwn(value, 'origin'), false);
  }
})
test('owner-only private mode; no query/header/agent-credential switch', async t => {
  const s = await rig(t)
  assert.equal((await s.request('', 'POST', {}, false)).status, 403)
  assert.equal((await s.request('', 'POST', {}, false, { authorization: 'Bearer agent-token' })).status, 403)
  assert.equal((await s.request('?incognito=true', 'POST', {})).status, 400)
  assert.equal((await s.request('', 'POST', { session_id: 'ordinary' })).status, 400)
  assert.equal((await s.request('', 'POST', {}, true, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal(s.calls.length, 0)
})
test('normal and public-provider agents fail closed before target creation', async t => {
  for (const record of [{ privacy: 'standard' }, { model: { provider: 'openai', model: 'synthetic' } }]) {
    const s = await rig(t, { agent: record }); const r = await s.request('', 'POST', {}); assert.equal(r.status, 409); assert.equal((await r.json()).error, record.privacy === 'standard' ? 'incognito_private_only' : 'confidential_provider_required'); assert.equal(s.calls.length, 0)
  }
})
test('multi-turn target reuse, separate run stream, no persistent registry hooks or tool/provider overrides', async t => {
  const s = await rig(t), id = await s.start()
  assert.match(id, /^incog_[a-f0-9]{32}$/)
  assert.equal((await s.request('', 'POST', {})).status, 409)
  for (const input of ['synthetic-first', 'synthetic-second']) {
    const r = await s.request('/' + id + '/v1/runs', 'POST', { input }); assert.equal(r.status, 202)
    const run = (await r.json()).run_id
    const read = await s.request('/' + id + '/v1/runs/' + run); assert.equal(read.status, 200)
    assert.match((await read.json()).output, /synthetic-first/)
    const stream = await s.request('/' + id + '/v1/runs/' + run + '/events'); assert.match(await stream.text(), /synthetic-stream/)
  }
  assert.equal(s.messages.length, 2)
  assert.ok(s.messages.every(x => x.session_id === id && /Memory, fact and skill writes inside this RAM home are allowed/.test(x.instructions) && /wait for an explicit yes/.test(x.instructions)))
  assert.deepEqual(s.durable, [])
  for (const body of [{ input: 'x', tools: ['memory'] }, { input: 'x', provider: 'openai' }, { input: 'x', wizard_file_ids: ['fake'] }]) assert.equal((await s.request('/' + id + '/v1/runs', 'POST', body)).status, 400)
  assert.equal((await s.request('/' + id + '/api/sessions')).status, 404)
  assert.equal((await s.request('/' + id + '/v1/runs/other-run')).status, 404)
  assert.equal((await s.request('/' + id, 'DELETE')).status, 200)
  assert.equal((await s.request('/' + id + '/v1/runs', 'POST', { input: 'x' })).status, 410)
  assert.ok(s.stopped.includes(id))
  assert.equal((await s.request('/' + id, 'DELETE')).status, 200)
})
test('browser heartbeats do not keep an owner-idle chat alive past the configured idle limit', async t => {
  const s = await rig(t), id = await s.start()
  for (const stamp of [500, 1000, 1500, 2000, 2500]) {
    s.setNow(stamp); assert.equal((await s.request('/' + id + '/lease', 'POST', {})).status, 200)
  }
  s.setNow(3001); await s.manager.sweep(); assert.ok(s.stopped.includes(id))
})
test('new owner message activity renews the idle limit instead of imposing an absolute cutoff', async t => {
  const s = await rig(t), id = await s.start()
  for (const stamp of [500, 1000, 1500, 2000, 2500]) {
    s.setNow(stamp); assert.equal((await s.request('/' + id + '/lease', 'POST', {})).status, 200)
  }
  const admission = await s.request('/' + id + '/v1/runs', 'POST', { input: 'synthetic activity before the idle deadline' }); assert.equal(admission.status, 202)
  s.setNow(3001); await s.manager.sweep(); assert.ok(!s.stopped.includes(id))
})
test('ephemeral API key never passes the shared proxy response guard', async t => {
  const s = await rig(t, { leak: true }), id = await s.start()
  const admission = await (await s.request('/' + id + '/v1/runs', 'POST', { input: 'synthetic' })).json()
  const reply = await s.request('/' + id + '/v1/runs/' + admission.run_id)
  assert.equal(reply.status, 502); assert.ok(!(await reply.text()).includes(key))
})
test('expired/restarted service cannot reopen targets; forgotten sessions are destroyed', async t => {
  const s = await rig(t), id = await s.start()
  s.setNow(1001); await s.manager.sweep()
  assert.ok(s.stopped.includes(id))
  assert.equal((await s.request('/' + id + '/lease', 'POST', {})).status, 410)
  const fresh = await rig(t)
  assert.equal((await fresh.request('/' + id + '/v1/runs/run-1')).status, 410)
  const second = await fresh.start(); await fresh.manager.close()
  assert.ok(fresh.stopped.includes(second))
})
