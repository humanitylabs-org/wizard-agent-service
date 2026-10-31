import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeedMeter, createSlowTickLogger, routeTemplate } from '../server/speed-meter.mjs'
import { createHybridProjector } from '../server/session-list-cache.mjs'

test('Wizard v1 fixed endpoints do not collapse bootstrap and workspace latency into one id bucket', () => {
  for (const endpoint of ['bootstrap', 'workspaces', 'system-jobs', 'setup', 'skins', 'pages'])
    assert.equal(routeTemplate(`/wizard/v1/${endpoint}`), `/wizard/v1/${endpoint}`)
  assert.equal(routeTemplate('/wizard/v1/owner-secret?token=discarded'), '/wizard/v1/:id')
  assert.equal(routeTemplate('/wizard/v1/pages/owner-secret'), '/wizard/v1/pages/:id')
  assert.equal(routeTemplate('/wizard/v1/sessions/bootstrap'), '/wizard/v1/sessions/:id')
  assert.equal(routeTemplate('/elsewhere/bootstrap'), '/:id/:id')
})
test('speed meter groups ids and queries, separates headless clients and hosts, and bounds route counters', t => {
  let time = 0
  const meter = createSpeedMeter({ now: () => time, maxRoutes: 4 })
  t.after(() => meter.close())
  const request = (url, headers = {}) => ({ method: 'GET', url, headers: { host: 'box.local', ...headers } })
  const a = meter.begin(request('/api/sessions/first/messages?secret=discarded'))
  time = 12; a(); a()
  const b = meter.begin(request('/api/sessions/second/messages')); time = 20; b()
  const c = meter.begin(request('/api/sessions/third/messages', { 'user-agent': 'Synthetic HeadlessChrome/123' })); c()
  const d = meter.begin(request('/api/sessions/fourth/messages', { 'x-forwarded-host': 'phone.local', forwarded: 'for=192.0.2.1;host="phone.local"' })); d()
  for (let n = 0; n < 10; n++) meter.begin(request('/unknown/' + n, { host: 'arbitrary-' + n }))()
  const { routes, event_loop } = meter.stats()
  assert.equal(Object.keys(routes).length, 4)
  const normal = Object.entries(routes).find(([key]) => key.includes('/api/sessions/:id/messages') && key.includes('other') && !key.includes('phone.local'))[1]
  assert.deepEqual(normal, { count: 2, total_ms: 20 })
  assert.equal(routes['[overflow]'].count, 10)
  assert.doesNotMatch(JSON.stringify(routes), /first|second|third|fourth|secret|192\.0\.2\.1/)
  assert.match(JSON.stringify(routes), /HeadlessChrome/)
  assert.equal(routeTemplate('/api/sessions/health/messages'), '/api/sessions/:id/messages')
  for (const field of ['delay_p50_ms', 'delay_p99_ms', 'utilization', 'window_ms']) assert(Number.isFinite(event_loop[field]))
  assert(event_loop.utilization >= 0 && event_loop.utilization <= 1)
  normal.count = 99
  assert.equal(meter.stats().routes[Object.keys(routes).find(key => routes[key] === normal)].count, 2)
})
test('speed meter stays bounded when many distinct routes enter before any completes', t => {
  const meter = createSpeedMeter({ maxRoutes: 4 })
  t.after(() => meter.close())
  const pending = Array.from({ length: 100 }, (_, n) => meter.begin({ url: '/wizard/health', headers: { host: `synthetic-${n}` } }))
  for (const done of pending) done()
  const routes = meter.stats().routes
  assert.equal(Object.keys(routes).length, 4)
  assert.equal(Object.values(routes).reduce((sum, row) => sum + row.count, 0), 100)
})
test('speed meter samples and resets a bounded event-loop window and closes its timer', async t => {
  const meter = createSpeedMeter({ windowMs: 40 })
  t.after(() => meter.close())
  await new Promise(resolve => setTimeout(resolve, 90))
  const sample = meter.stats().event_loop
  assert(sample.window_ms >= 35)
  assert(sample.delay_p50_ms >= 0 && sample.delay_p99_ms >= sample.delay_p50_ms)
  meter.close()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(meter.stats().event_loop, sample)
})
test('slow queue ticks log the queue id and duration only above 50 ms once per minute', () => {
  let time = 0
  const logs = []
  const done = createSlowTickLogger('run-queue:synthetic', { now: () => time, log: line => logs.push(line) })
  time = 50; done(0); assert.equal(logs.length, 0)
  time = 51; done(0); assert.equal(logs.length, 1)
  time = 100; done(0); assert.equal(logs.length, 1)
  time = 60_051; done(time - 75); assert.equal(logs.length, 2)
  assert.match(logs[1], /"queue":"run-queue:synthetic","duration_ms":75/)
})
test('session list speed meter reports separate head and hot projection timings without changing rows', async () => {
  const p = createHybridProjector({ batchSize: 1 })
  const sessions = [{ id: 'head' }, { id: 'hot' }]
  const result = await p.project({ sessions, projectBatch: async rows => rows })
  assert.deepEqual(result.rows, sessions)
  assert(Number.isFinite(result.head_ms) && result.head_ms >= 0)
  assert(Number.isFinite(result.hot_ms) && result.hot_ms >= 0)
})
