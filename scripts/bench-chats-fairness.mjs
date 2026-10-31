// Synthetic, copy-only fairness acceptance. Never connects to the live service,
// Voice Core, real transports, private agents, or a live database.
// Usage: node scripts/bench-chats-fairness.mjs BASE CANDIDATE SCRATCH
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import { createHook } from 'node:async_hooks'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { truthFixture, instrumentProjection } from '../tests/fixtures/chats-truth.mjs'

const [base, candidate, scratch] = process.argv.slice(2).map(value => resolve(value))
assert(base && candidate && scratch)
const home = join(scratch, 'isolated-home')
mkdirSync(home, { recursive: true, mode: 0o700 })
process.env.HOME = process.env.HERMES_HOME = process.env.WIZARD_OS_HOME = home
const sessionCount = Number(process.env.FAIRNESS_SESSIONS || 1100)
const minRequests = Number(process.env.FAIRNESS_MIN_REQUESTS || 30)
const f = truthFixture(join(scratch, 'fixture'), sessionCount)
// Freeze semantic timestamps across revisions. perf_hooks uses real elapsed time;
// the production worker receives this same semantic now in every request.
const originalDateNow = Date.now
Date.now = () => f.sec * 1000
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const percentile = (samples, p) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1] ?? 0
// Voice Core must not share the Service loop: otherwise direct latency would
// inherit its stalls too, hiding proxy overhead in the subtraction.
const stub = new Worker(new URL('../tests/fixtures/fairness-core.mjs', import.meta.url), { workerData: { messages: f.messages } })
const [{ port }] = await once(stub, 'message')
const stubOrigin = `http://127.0.0.1:${port}`
const report = { sessions: f.sessions.length,
  fixture: 'Synthetic canonical sessions, receipts and follow-ups. Real Service snapshot rebuild/self-check, voice HTTP proxy, durable run admissions and speed meter; isolated stub Voice Core delays 20ms. Only requests started during rebuild/check enter percentiles.',
  thresholds: { event_loop_p99_ms: 100, voice_overhead_p95_ms: 150, post_runs_p95_ms: 300, differences: 0 }, results: {} }
let oracle
async function timed(url, init) {
  const at = performance.now(), response = await fetch(url, init), payload = await response.json()
  assert(response.ok, `${response.status}: ${JSON.stringify(payload)}`)
  return { ms: performance.now() - at, payload }
}
try {
  for (const [label, source] of [['before', base], ['after', candidate]]) {
    const archive = join(scratch, `instrumented-${label}`)
    const run = await instrumentProjection(source, archive, f, { serviceOptions: {
      listEvidenceWorker: true, sttOrigin: stubOrigin, upstreamOrigin: stubOrigin, fetchImpl: (url, init) => {
        assert.equal(new URL(url).origin, stubOrigin, 'all transports must stay on the synthetic stub'); return fetch(url, init)
      },
      runQueueStatePath: join(archive, 'queue.sqlite3'), runQueuePollIntervalMs: 0,
      activeSessionReader: () => [], dispatchHealthReader: () => true, joinedDelegation: 'unchecked',
    } })
    const delay = monitorEventLoopDelay({ resolution: 5 })
    let maxCallback = 0, enteredAt = 0, workDone = false
    const hook = createHook({ before() { enteredAt = performance.now() }, after() {
      if (enteredAt) maxCallback = Math.max(maxCallback, performance.now() - enteredAt)
      enteredAt = 0
    } })
    const direct = [], proxy = [], overhead = [], sends = [], loads = [], errors = []
    const guardedLoad = fn => { const load = fn().catch(error => { errors.push(error); workDone = true }); loads.push(load) }
    try {
      await timed(`${run.origin}/wizard/health`)
      // Establish both connections and STT model discovery before CPU contention.
      const request = () => ({ method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('synthetic-only') })
      await timed(`${stubOrigin}/v1/audio/transcriptions`, request())
      await timed(`${run.origin}/wizard/voice/transcribe`, request())
      // Seed subject/space catalogs outside the measurement, as on an existing
      // install. The measured rebuild explicitly clears BOTH projection caches.
      await run.core.snapshot()
      delay.enable(); hook.enable(); await pause(15)
      const at = performance.now()
      guardedLoad(async () => {
        let n = 0
        while (!workDone && n++ < 5000) {
          const [a, b] = await Promise.all([timed(`${stubOrigin}/v1/audio/transcriptions`, request()), timed(`${run.origin}/wizard/voice/transcribe`, request())])
          assert.equal(b.payload.text, 'Synthetic voice message.')
          direct.push(a.ms); proxy.push(b.ms); overhead.push(b.ms - a.ms)
          await pause(10)
        }
      })
      guardedLoad(async () => {
        let n = 0
        while (!workDone && n++ < 5000) {
          const response = await timed(`${run.origin}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `fairness_${label}_${n}` },
            body: JSON.stringify({ session_id: `wizard_fairness_send_${n}`, input: 'Synthetic test only' }) })
          assert(response.payload.run_id)
          sends.push(response.ms)
          await pause(15)
        }
      })
      await new Promise(resolve => setImmediate(resolve))
      const [rows] = await Promise.all([run.core.rebuild(), run.core.check()])
      const workMs = performance.now() - at
      workDone = true
      // Sample the delayed callback after the last synchronous projector returns.
      await pause(15)
      hook.disable(); delay.disable()
      await Promise.all(loads)
      if (errors.length) throw errors[0]
      const stats = (await timed(`${run.origin}/wizard/list-cache`)).payload
      assert(Array.isArray(rows)); assert.equal(rows.length, sessionCount)
      if (!oracle) oracle = rows
      else assert.deepEqual(rows, oracle, 'every output field must equal the unmodified base at the same semantic time')
      assert.equal(stats.check_differences, 0)
      report.results[label] = { work_ms: workMs, rebuild_ms: stats.last_build_ms, check_ms: stats.last_check_ms,
        event_loop_p99_ms: delay.percentile(99) / 1e6, max_main_callback_ms: maxCallback,
        direct_voice_p95_ms: percentile(direct, .95), proxy_voice_p95_ms: percentile(proxy, .95), voice_overhead_p95_ms: percentile(overhead, .95),
        post_runs_p95_ms: percentile(sends, .95), voice_samples: proxy.length, run_samples: sends.length,
        check_differences: stats.check_differences, rows_deep_equal: true, evidence: stats.evidence ?? null,
        projection_slices: stats.projection_slices ?? null, speed_routes: stats.speed.routes }
      writeFileSync(join(scratch, 'fairness.json'), JSON.stringify(report, null, 2) + '\n')
      assert(proxy.length >= minRequests && sends.length >= minRequests, 'not enough requests actually overlapped list work')
    } finally { workDone = true; hook.disable(); delay.disable(); await Promise.all(loads); await run.close() }
  }
  const after = report.results.after
  assert(after.evidence?.worker_reads > 0 && after.evidence.fallbacks === 0, 'real projection must use the worker, not silently fall back')
  assert(after.event_loop_p99_ms < report.thresholds.event_loop_p99_ms, `event-loop p99 ${after.event_loop_p99_ms}`)
  assert(after.voice_overhead_p95_ms < report.thresholds.voice_overhead_p95_ms, `voice overhead ${after.voice_overhead_p95_ms}`)
  assert(after.post_runs_p95_ms < report.thresholds.post_runs_p95_ms, `POST runs p95 ${after.post_runs_p95_ms}`)
  report.acceptance = sessionCount === 1100 && minRequests >= 30 ? 'PASS (strict thresholds, no CI relaxation)' : 'SMOKE ONLY (not the 1100-session acceptance)'
  writeFileSync(join(scratch, 'fairness.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  Date.now = originalDateNow
  const exited = once(stub, 'exit'); stub.postMessage('close'); await exited
}
