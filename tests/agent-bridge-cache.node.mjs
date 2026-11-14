import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// Issue 435 (from draft PR 342 by Archimedes): tools/list cache hints are only given for a complete discovery.
// QA_SOURCE_ROOT points the same fixture at another checkout, for failing-first runs against main.
const source = process.env.QA_SOURCE_ROOT ? pathToFileURL(join(resolve(process.env.QA_SOURCE_ROOT), 'server/agent-bridge.mjs')) : new URL('../server/agent-bridge.mjs', import.meta.url)
const { createAgentBridge } = await import(source.href)
const DAY = 24 * 60 * 60 * 1000
const tool = { name: 'echo', description: 'Synthetic echo', inputSchema: { type: 'object', properties: {} } }
const app = (id, status = 'running') => ({ id, name: id, status, provides: ['test'], mcp: { url: `https://${id}.invalid/mcp` } })

function fixture(t, { apps = [app('hello')], appsFor = () => null, recheckMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-cache-'))
  const path = join(root, 'apps.json')
  let revision = 0
  const registry = list => { const next = path + '.next'; writeFileSync(next, JSON.stringify({ apps: list, revision: ++revision })); renameSync(next, path) }
  registry(apps)
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const failures = new Set(), empty = new Set(), malformed = new Set(), paginated = new Set(), invalidNames = new Set(), calls = []
  let beforeList = null
  const bridge = createAgentBridge({ appsJsonPath: path, osHome: root, token: 'synthetic-main', writeSkills: false, watchIntervalMs: 0,
    agentForToken: token => token === 'synthetic-secondary' ? 'secondary' : '', appsFor, ...(recheckMs ? { recheckMs } : {}),
    fetchImpl: async (url, options) => {
      const message = JSON.parse(options.body), id = new URL(url).hostname.split('.')[0]
      calls.push([id, message.method])
      if (message.method === 'tools/list') {
        if (beforeList) { const fn = beforeList; beforeList = null; await fn() }
        if (failures.has(id)) throw new Error('synthetic unavailable app')
      }
      const result = message.method === 'tools/list' ? (malformed.has(id) ? {} : { tools: empty.has(id) ? [] : invalidNames.has(id) ? [{ ...tool, name: 'not valid' }] : [tool], ...(paginated.has(id) ? { nextCursor: 'synthetic-next' } : {}) }) : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'synthetic' }] } : {}
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  t.after(() => { bridge.close(); rmSync(root, { recursive: true, force: true }) })
  const rpc = async (method = 'tools/list', token = 'synthetic-main', params = {}) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
    const request = { method: 'POST', headers: { authorization: `Bearer ${token}` }, async *[Symbol.asyncIterator]() { yield body } }
    let text, status
    await bridge.handle(request, { writeHead(code) { status = code }, end(value) { text = value } })
    assert.equal(status, 200)
    const result = JSON.parse(text); assert.equal(result.error, undefined)
    return result.result
  }
  // A real MCP session: initialize (Mcp-Session-Id), an open GET event stream, then calls on that session.
  const session = async (token = 'synthetic-main', { stream = true } = {}) => {
    const post = async (message, sid) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }))
      const request = { method: 'POST', headers: { authorization: `Bearer ${token}`, ...(sid ? { 'mcp-session-id': sid } : {}) }, async *[Symbol.asyncIterator]() { yield body } }
      let text, headers = {}
      await bridge.handle(request, { writeHead(code, h = {}) { headers = h }, end(value) { text = value } })
      return { headers, result: JSON.parse(text).result }
    }
    const sid = (await post({ method: 'initialize', params: {} })).headers['Mcp-Session-Id']
    const frames = []
    const closers = []
    const attach = () => bridge.handle({ method: 'GET', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid }, on(event, fn) { if (event === 'close') closers.push(fn) } },
      { writeHead() {}, write(frame) { frames.push(frame) }, end() {} })
    if (stream) attach()
    t.after(() => { for (const fn of closers) fn() })
    const changed = () => frames.filter(f => f.includes('notifications/tools/list_changed')).length
    return { sid, changed, attach, list: async () => (await post({ method: 'tools/list', params: {} }, sid)).result,
      call: async (name, args = {}) => (await post({ method: 'tools/call', params: { name, arguments: args } }, sid)).result }
  }
  return { bridge, rpc, session, failures, empty, malformed, paginated, invalidNames, calls, registry, advance: ms => { now += ms }, beforeList: fn => { beforeList = fn } }
}

function healthy(value) {
  assert.equal(value.cacheScope, 'private')
  assert.equal(value.ttlMs, DAY, `a complete discovery is cacheable for a day, received ${value.ttlMs}`)
}

test('healthy discovery is private, cacheable for a day, and reuses the gateway cache', async t => {
  const f = fixture(t); const first = await f.rpc(); healthy(first)
  assert.ok(first.tools.some(t => t.name === 'hello__echo'))
  f.advance(20_000); healthy(await f.rpc())
  assert.equal(f.calls.filter(([, method]) => method === 'tools/list').length, 1)
  assert.ok(Array.isArray(await f.bridge.listTools()), 'existing public API remains an array')
})

test('failed discovery and its cached retry response cannot be cached; recovery can', async t => {
  const f = fixture(t); f.failures.add('hello')
  assert.equal((await f.rpc()).ttlMs, 0)
  f.failures.clear(); assert.equal((await f.rpc()).ttlMs, 0)
  f.advance(10_001); healthy(await f.rpc())
})

test('a failed refresh may retain old tools but never certifies them fresh', async t => {
  const f = fixture(t); await f.rpc(); f.advance(60_001); f.failures.add('hello')
  const stale = await f.rpc(); assert.ok(stale.tools.some(t => t.name === 'hello__echo')); assert.equal(stale.ttlMs, 0)
  assert.equal((await f.rpc()).ttlMs, 0)
})

test('successful empty discovery is complete; malformed discovery is not', async t => {
  const f = fixture(t); f.empty.add('hello'); healthy(await f.rpc())
  f.advance(60_001); f.malformed.add('hello'); assert.equal((await f.rpc()).ttlMs, 0)
})

test('non-running visible apps do not certify a complete discovery', async t => {
  const f = fixture(t, { apps: [app('hello', 'starting')] }); assert.equal((await f.rpc()).ttlMs, 0)
})

test('a stopped app cannot certify an otherwise fresh cached list', async t => {
  const f = fixture(t); healthy(await f.rpc()); f.registry([app('hello', 'stopped')]); f.bridge.refresh()
  assert.equal((await f.rpc()).ttlMs, 0)
})

test('a downstream first page is not complete discovery', async t => {
  const f = fixture(t); f.paginated.add('hello')
  assert.equal((await f.rpc()).ttlMs, 0); assert.equal((await f.rpc()).ttlMs, 0)
})

test('filtered invalid names do not certify a complete discovery', async t => {
  const f = fixture(t); f.invalidNames.add('hello')
  assert.equal((await f.rpc()).ttlMs, 0); assert.equal((await f.rpc()).ttlMs, 0)
})

test('an inaccessible failing app does not poison another agent, and calls recheck grants', async t => {
  let allowed = new Set(['hello'])
  const f = fixture(t, { apps: [app('hello'), app('other')], appsFor: id => id === 'secondary' ? allowed : null })
  f.failures.add('other')
  assert.equal((await f.rpc()).ttlMs, 0)
  const secondary = await f.rpc('tools/list', 'synthetic-secondary'); healthy(secondary)
  assert.ok(!secondary.tools.some(t => t.name.startsWith('other__')))
  allowed = new Set()
  const denied = await f.rpc('tools/call', 'synthetic-secondary', { name: 'hello__echo', arguments: {} }); assert.equal(denied.isError, true)
  assert.ok(!f.calls.some(([, method]) => method === 'tools/call'))
})

test('an access change during discovery returns no revoked app tool and no reusable snapshot', async t => {
  let allowed = new Set(['hello'])
  const f = fixture(t, { appsFor: () => allowed }); f.beforeList(() => { allowed = new Set() })
  const result = await f.rpc(); assert.equal(result.ttlMs, 0); assert.ok(!result.tools.some(t => t.name.startsWith('hello__')))
})

test('registry replacement during discovery returns no old tools and does not warm the new cache', async t => {
  const f = fixture(t); f.beforeList(() => { f.registry([app('replacement')]); f.bridge.refresh() })
  const result = await f.rpc(); assert.equal(result.ttlMs, 0); assert.ok(!result.tools.some(t => t.name.startsWith('hello__')))
  const next = await f.rpc(); healthy(next); assert.ok(next.tools.some(t => t.name === 'replacement__echo'))
})

// Issue 623: an app whose tools were missing from a session's tools/list (failing, slow or empty at that moment)
// must reach that session again: tools/list_changed when its tools come back, and wizard_apps says what is going on.
const waitFor = async (fn, ms = 2000) => { const end = performance.now() + ms; while (!fn()) { if (performance.now() > end) return false; await new Promise(r => setTimeout(r, 5)) } return true }

test('a session served without a failing app is told tools/list_changed once the app answers again', async t => {
  const f = fixture(t, { recheckMs: [5] }); f.failures.add('hello')
  const s = await f.session()
  const first = await s.list(); assert.ok(!first.tools.some(t => t.name === 'hello__echo')); assert.equal(first.ttlMs, 0)
  assert.equal(s.changed(), 0)
  f.failures.clear(); f.advance(10_001)
  assert.ok(await waitFor(() => s.changed() === 1), 'the background recheck announces the returned tools')
  const again = await s.list(); assert.ok(again.tools.some(t => t.name === 'hello__echo')); healthy(again)
  await new Promise(r => setTimeout(r, 40)); assert.equal(s.changed(), 1, 'no repeat once the session re-listed')
})

test('another caller discovering the tools tells the stale session; an up-to-date session is not told', async t => {
  const f = fixture(t, { recheckMs: [60_000] }); f.failures.add('hello')
  const stale = await f.session(); await stale.list()
  f.failures.clear(); f.advance(10_001)
  const fresh = await f.session(); assert.ok((await fresh.list()).tools.some(t => t.name === 'hello__echo'))
  assert.equal(stale.changed(), 1); assert.equal(fresh.changed(), 0)
})

test('an app answering with no tools first and its tools later reaches the session', async t => {
  const f = fixture(t, { recheckMs: [5] }); f.empty.add('hello')
  const s = await f.session(); assert.ok(!(await s.list()).tools.some(t => t.name === 'hello__echo'))
  f.empty.clear(); f.advance(60_001)
  assert.ok(await waitFor(() => s.changed() === 1), 'an empty answer from a running app is rechecked')
})

test('wizard_apps says plainly when tools are temporarily unavailable and when they are back but not listed yet', async t => {
  const f = fixture(t, { recheckMs: [60_000] }); f.failures.add('hello')
  const s = await f.session(); await s.list()
  const down = (await s.call('wizard_apps')).content[0].text
  assert.match(down, /hello \(hello\), running: .*Tools: temporarily unavailable .*not an access setting.*Retry in a minute\./u)
  f.failures.clear(); f.advance(10_001)
  const back = (await s.call('wizard_apps')).content[0].text
  assert.match(back, /Tools: mcp__wizard__hello__echo\. They are not in your current tool list yet; it is being refreshed now: search tools again, then retry the call\./u)
  assert.equal(s.changed(), 1, 'wizard_apps re-announces the list to this session')
  await s.list()
  assert.match((await s.call('wizard_apps')).content[0].text, /Tools: mcp__wizard__hello__echo\.$/mu)
  assert.equal(s.changed(), 1)
})

test('a stopped app is reported as stopped, not as an access problem', async t => {
  const f = fixture(t, { apps: [app('hello', 'stopped')] })
  const s = await f.session(); await s.list()
  assert.match((await s.call('wizard_apps')).content[0].text, /Tools: none while it is stopped\./u)
})

test('a notice that found no open stream is delivered when the session attaches one', async t => {
  const f = fixture(t, { recheckMs: [60_000] }); f.failures.add('hello')
  const s = await f.session('synthetic-main', { stream: false }); await s.list()
  f.failures.clear(); f.advance(10_001)
  await (await f.session()).list() // another caller discovers the tools while s has no stream
  assert.equal(s.changed(), 0)
  s.attach(); assert.equal(s.changed(), 1)
})
