// Channel emoji from a model (wizard-ux issue 1605): the one-emoji check, the route's contract and its failure answers.
// Synthetic names only; the "broker" is a local fake speaking the lookup broker's NDJSON contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { createWizardServer, listen } from '../server/service.mjs'
import { SYSTEM, oneEmoji, parseChannelEmoji } from '../server/channel-emoji-ask.mjs'
import { SYSTEM as LOOKUP_SYSTEM } from '../server/lookup.mjs'

const TOKEN = 'fixture-token-not-a-secret-0123456789'
const ndjson = (res, events) => { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); for (const e of events) res.write(`${JSON.stringify(e)}\n`); res.end() }
const answer = (text, model = 'claude-haiku-4-5') => (_c, _q, res) => ndjson(res, [{ type: 'delta', text }, { type: 'done', text, model }])

function fakeBroker(script) {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (b) => { raw += b })
    req.on('end', async () => {
      const call = { path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null }
      calls.push(call)
      if (req.url === '/cancel') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return }
      await script(call, req, res)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })))
}
async function boot(script, env = {}) {
  const broker = await fakeBroker(script)
  const server = createWizardServer({ requireAccess: false, agentBridge: false, followThrough: false,
    lookupEnv: { WIZARD_LOOKUP_URL: broker.url, WIZARD_LOOKUP_TOKEN: TOKEN, ...env } })
  const { port } = await listen(server)
  const close = async () => { await new Promise((r) => server.close(r)); await new Promise((r) => broker.server.close(r)) }
  const post = async (body, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}/wizard/v1/channel-emoji`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) } }
  return { broker, close, post }
}

test('1605: the one-emoji check takes exactly one emoji and nothing else', () => {
  for (const ok of ['🎯', '💰', '🎙️', '✈️', '🏋️', '👨‍👩‍👧', '🇳🇱', '👍🏽', ' 📈 ', '\n🧭\n']) assert.equal(oneEmoji(ok), ok.trim(), JSON.stringify(ok))
  for (const bad of ['', ' ', 'OK', '🎯🎯', '🎯 Goals', 'Goals 🎯', '"🎯"', '🎯.', ':dart:', '1', '#', 'é', '💬', '#️⃣', '🎯\n💡', 'Here is one: 🎯', null, 7, undefined, '🎯'.repeat(20)]) {
    assert.equal(oneEmoji(bad), '', JSON.stringify(bad))
  }
})

test('1605: the request is a channel name of up to 60 characters and an optional agent id', () => {
  assert.deepEqual(parseChannelEmoji({ name: ' Quarterly OKRs ', agent: 'hermes' }), { name: 'Quarterly OKRs', agent: 'hermes' })
  assert.deepEqual(parseChannelEmoji({ name: 'Zzzqx' }), { name: 'Zzzqx', agent: '' })
  for (const bad of [null, [], {}, { name: '' }, { name: '   ' }, { name: '???' }, { name: 'x'.repeat(61) }, { name: 'a\nb' }, { name: 5 }, { name: 'ok', agent: 'Bad Agent' }, { name: 'ok', extra: 1 }]) {
    assert.throws(() => parseChannelEmoji(bad), /./, JSON.stringify(bad))
  }
})

test('1605: a name gets one emoji from the fast model, with its own prompt and the name only', async () => {
  const t = await boot(answer('🎯'))
  try {
    const r = await t.post({ name: 'Quarterly OKRs', agent: 'hermes' })
    assert.equal(r.status, 200); assert.deepEqual(r.json, { emoji: '🎯' })
    const call = t.broker.calls.find((c) => c.path === '/lookup')
    assert.equal(call.auth, `Bearer ${TOKEN}`)
    assert.equal(call.body.model, 'claude-haiku-4-5'); assert.equal(call.body.web_enabled, false)
    assert.equal(call.body.system, SYSTEM); assert.notEqual(SYSTEM, LOOKUP_SYSTEM, 'its own system prompt')
    assert.equal(call.body.quote, 'Quarterly OKRs'); assert.equal(call.body.sources[0].text, 'Quarterly OKRs')
    assert.ok(!JSON.stringify(r.json).includes(TOKEN))
  } finally { await t.close() }
})

test('1605: an answer that is not exactly one emoji, the wrong model or a broker error is a 503, never a guess', async () => {
  for (const script of [answer('🎯 Goals'), answer('Target'), answer('🎯🎯'), answer('💬'), answer('🎯', 'claude-sonnet-5'),
    (_c, _q, res) => ndjson(res, [{ type: 'delta', text: '🎯' }]),
    (_c, _q, res) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"secret detail"}') }]) {
    const t = await boot(script)
    try {
      const r = await t.post({ name: 'Quarterly OKRs', agent: 'hermes' })
      assert.equal(r.status, 503); assert.equal(r.json.error, 'channel_emoji_unavailable')
      assert.ok(!JSON.stringify(r.json).includes('secret detail'))
    } finally { await t.close() }
  }
})

test('1605: no broker configured is a 503 with no call; bad input is a 400 before any call', async () => {
  const off = await boot(answer('🎯'), { WIZARD_LOOKUP_URL: '', WIZARD_LOOKUP_TOKEN: '' })
  try { const r = await off.post({ name: 'Quarterly OKRs' }); assert.equal(r.status, 503); assert.equal(off.broker.calls.length, 0) } finally { await off.close() }
  const t = await boot(answer('🎯'))
  try {
    for (const bad of [{}, { name: '' }, { name: 'x'.repeat(61) }, { name: 'ok', agent: 'Bad Agent' }, { name: 'ok', thread: 'x' }]) assert.equal((await t.post(bad)).status, 400, JSON.stringify(bad))
    assert.equal((await t.post('{nope')).status, 400)
    assert.equal((await t.post('{}', { 'content-type': 'text/plain' })).status, 415)
    assert.equal(t.broker.calls.length, 0)
  } finally { await t.close() }
})

test('1605: a slow model is cut off at the deadline and its broker run cancelled', async () => {
  const { createChannelEmoji } = await import('../server/channel-emoji-ask.mjs')
  const broker = await fakeBroker(async (_c, _q, res) => { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); await new Promise((r) => setTimeout(r, 1500)); res.end() })
  try {
    const ce = createChannelEmoji({ env: { WIZARD_LOOKUP_URL: broker.url, WIZARD_LOOKUP_TOKEN: TOKEN }, deadlineMs: 200 })
    const started = Date.now()
    assert.equal(await ce.ask('Quarterly OKRs'), '')
    assert.ok(Date.now() - started < 1400, 'gave up at the deadline')
    assert.ok(broker.calls.some((c) => c.path === '/cancel'))
  } finally { await new Promise((r) => broker.server.close(r)) }
})

test('1605: nothing is stored or logged', () => {
  const source = readFileSync(new URL('../server/channel-emoji-ask.mjs', import.meta.url), 'utf8')
  assert.ok(!/node:(fs|sqlite)|console\.|process\.stderr|process\.stdout/u.test(source))
})
