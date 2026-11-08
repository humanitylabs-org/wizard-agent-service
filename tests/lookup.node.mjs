// AI Look up endpoint: contract validation, stream shape, bad input, model identity, privacy refusals, no persistence.
// Synthetic text only; the "broker" is a local fake that speaks the Wisdom /lookup NDJSON contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { LOOKUP_MODEL, SYSTEM, parseLookup, completion, passageOf } from '../server/lookup.mjs'

const TOKEN = 'fixture-token-not-a-secret-0123456789'
const ANSWER = 'The Timaeus is a late dialogue in which Plato describes a divine craftsman shaping the cosmos from pre-existing chaos.'

function fakeBroker(script) {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (b) => { raw += b })
    req.on('end', async () => {
      const call = { path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null }
      calls.push(call)
      if (req.url === '/cancel') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"cancelled":true}'); return }
      await script(call, req, res)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })))
}
const ndjson = (res, events) => { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); for (const e of events) res.write(`${JSON.stringify(e)}\n`); res.end() }
const good = (_c, _q, res) => ndjson(res, [{ type: 'delta', text: 'The Timaeus is a late dialogue ' }, { type: 'delta', text: 'in which Plato describes a divine craftsman shaping the cosmos from pre-existing chaos.' }, { type: 'done', text: ANSWER, model: LOOKUP_MODEL }])

async function boot(brokerScript, { env = {}, requireAccess = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'lookup-state-'))
  const broker = await fakeBroker(brokerScript)
  const server = createWizardServer({ requireAccess, agentBridge: false, followThrough: false,
    lookupEnv: { WIZARD_LOOKUP_URL: broker.url, WIZARD_LOOKUP_TOKEN: TOKEN, ...env } })
  const address = await listen(server)
  const close = async () => { await new Promise((r) => server.close(r)); await new Promise((r) => broker.server.close(r)); rmSync(home, { recursive: true, force: true }) }
  return { port: address.port, broker, close, home }
}
function post(port, body, { headers = {}, raw = false, path = '/wizard/v1/lookup/stream' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = []; const times = []
      res.on('data', (b) => { chunks.push(b.toString()); times.push(Date.now()) })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: chunks.join(''), chunks, times }))
    })
    req.on('error', reject); req.end(raw ? body : JSON.stringify(body))
  })
}
const lines = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
const ok = { text: "Plato's Timaeus", before: 'The demiurge in ', after: ' is a craftsman god.', frame: 'Philosopher', agent: 'main' }

test('streams NDJSON deltas then exactly one validated done with the fast model', async () => {
  const t = await boot(good)
  try {
    const r = await post(t.port, ok)
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /application\/x-ndjson/)
    assert.equal(r.headers['cache-control'], 'no-store')
    const events = lines(r.text)
    assert.deepEqual(events.map((e) => e.type), ['delta', 'delta', 'done'])
    assert.equal(events.at(-1).model, LOOKUP_MODEL)
    assert.equal(events.at(-1).text, ANSWER)
    // The broker got Wisdom's exact lookup contract, the exact fast model and nothing else.
    const call = t.broker.calls.find((c) => c.path === '/lookup')
    assert.equal(call.auth, `Bearer ${TOKEN}`)
    assert.equal(call.body.model, 'claude-haiku-4-5')
    assert.equal(call.body.system, SYSTEM)
    assert.equal(call.body.web_enabled, false)
    assert.deepEqual(call.body.source_links_not_read, [])
    assert.equal(call.body.quote, "Plato's Timaeus")
    assert.equal(call.body.sources.length, 1)
    assert.equal(call.body.sources[0].kind, 'chapter_excerpt')
    assert.equal(call.body.sources[0].text, "The demiurge in Plato's Timaeus is a craftsman god.")
    assert.equal(call.body.messages.length, 1)
    assert.ok(call.body.messages[0].content.length <= 400)
    assert.match(call.body.run_id, /^[a-f0-9]{32}$/)
    // The token is never echoed to the browser.
    assert.ok(!r.text.includes(TOKEN) && !JSON.stringify(r.headers).includes(TOKEN))
  } finally { await t.close() }
})

test('deltas are forwarded as they arrive, not buffered until the end', async () => {
  const t = await boot(async (_c, _q, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(`${JSON.stringify({ type: 'delta', text: 'First part ' })}\n`)
    await new Promise((r) => setTimeout(r, 400))
    res.write(`${JSON.stringify({ type: 'done', text: ANSWER, model: LOOKUP_MODEL })}\n`); res.end()
  })
  try {
    const r = await post(t.port, ok)
    assert.ok(r.times.length >= 2 && r.times.at(-1) - r.times[0] >= 300, 'first delta arrived well before done')
  } finally { await t.close() }
})

test('bad input is a plain 400 before any inference', async () => {
  const t = await boot(good)
  try {
    const bad = [{}, { text: '' }, { text: '   ' }, { text: '???' }, { text: 'x'.repeat(129) }, { text: 'a b c d e f g h i' },
      { text: 'ok', before: 'y'.repeat(1601) }, { text: 'ok', extra: 1 }, { text: 'ok', frame: 'a\nb' }, { text: 'ok', agent: 'Bad Agent' }, { text: 'ok\u0000x' }, { text: 5 }]
    for (const body of bad) {
      const r = await post(t.port, body)
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60))
      assert.equal(JSON.parse(r.text).error, 'invalid_request')
    }
    assert.equal((await post(t.port, '{nope', { raw: true })).status, 400)
    assert.equal((await post(t.port, '{}', { raw: true, headers: { 'content-type': 'text/plain' } })).status, 415)
    assert.equal((await post(t.port, JSON.stringify({ text: 'ok', before: 'z'.repeat(20000) }), { raw: true })).status, 413)
    assert.equal(t.broker.calls.length, 0, 'the broker was never called')
  } finally { await t.close() }
})

test('only the nearest 800 characters each side reach the model', () => {
  const parsed = parseLookup({ text: 'term', before: `${'a'.repeat(900)}END`, after: `START${'b'.repeat(900)}` })
  assert.equal(parsed.before.length, 800); assert.ok(parsed.before.endsWith('END'))
  assert.equal(parsed.after.length, 800); assert.ok(parsed.after.startsWith('START'))
  assert.ok(passageOf(parsed).length <= 1604)
})

test('the wrong model, a bad completion or a broker error is an error line or 503, never a fallback', async () => {
  for (const events of [
    [{ type: 'done', text: ANSWER, model: 'claude-sonnet-5' }],
    [{ type: 'done', text: '## Heading\n- list', model: LOOKUP_MODEL }],
    [{ type: 'done', text: 'Plato', model: LOOKUP_MODEL }],
    [{ type: 'delta', text: 'Partial answer that never' }],
    [{ type: 'delta', text: 'x' }, { type: 'weird' }],
  ]) {
    const t = await boot((_c, _q, res) => ndjson(res, events))
    try {
      const r = await post(t.port, ok)
      const out = lines(r.text)
      assert.equal(out.at(-1).type, 'error', JSON.stringify(events))
      assert.ok(!out.some((e) => e.type === 'done'))
      assert.ok(!r.text.includes('claude'), 'no raw broker diagnostics')
    } finally { await t.close() }
  }
  const down = await boot((_c, _q, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"secret broker detail"}') })
  try {
    const r = await post(down.port, ok)
    assert.equal(r.status, 503); assert.ok(!r.text.includes('secret broker detail'))
  } finally { await down.close() }
})

test('unconfigured is a 503; private agents and incognito threads are refused before any cloud call', async () => {
  const off = await boot(good, { env: { WIZARD_LOOKUP_URL: '', WIZARD_LOOKUP_TOKEN: '' } })
  try { assert.equal((await post(off.port, ok)).status, 503); assert.equal(off.broker.calls.length, 0) } finally { await off.close() }
  const t = await boot(good)
  try {
    const r = await post(t.port, { ...ok, session: 'incog_abc123' })
    assert.equal(r.status, 403); assert.equal(JSON.parse(r.text).error, 'private_thread')
    assert.equal(t.broker.calls.length, 0)
  } finally { await t.close() }
})

test('a closed client cancels the broker run and frees the slot', async () => {
  const t = await boot(async (call, req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(`${JSON.stringify({ type: 'delta', text: 'Starting ' })}\n`)
    await new Promise((r) => setTimeout(r, 4000)); res.end()
  })
  try {
    await new Promise((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port: t.port, path: '/wizard/v1/lookup/stream', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.once('data', () => { req.destroy(); resolve() })
      })
      req.on('error', () => {}); req.end(JSON.stringify(ok))
    })
    const started = Date.now()
    while (Date.now() - started < 3000 && !t.broker.calls.some((c) => c.path === '/cancel')) await new Promise((r) => setTimeout(r, 50))
    const cancel = t.broker.calls.find((c) => c.path === '/cancel')
    assert.ok(cancel, 'broker /cancel called')
    assert.equal(cancel.body.run_id, t.broker.calls.find((c) => c.path === '/lookup').body.run_id)
  } finally { await t.close() }
})

test('no persistence: nothing is written under the state directory', async () => {
  const t = await boot(good)
  try {
    await post(t.port, ok)
    assert.deepEqual(readdirSync(t.home), [])
    // And structurally: the module imports no filesystem, database or logging.
    const source = readFileSync(new URL('../server/lookup.mjs', import.meta.url), 'utf8')
    assert.ok(!/node:(fs|sqlite)|console\.|process\.stderr|process\.stdout/u.test(source))
  } finally { await t.close() }
})

test('completion rules', () => {
  assert.equal(completion('A short but valid plain sentence here.', 'term'), 'A short but valid plain sentence here.')
  for (const bad of ['', 'Too short', 'x'.repeat(701), 'line one\nline two here ok', '**bold** answer text here', 'See https://example.com for more', '- list item here ok ok']) {
    assert.throws(() => completion(bad, 'term'), undefined, bad)
  }
})
