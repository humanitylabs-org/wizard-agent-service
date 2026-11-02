// Copy-only: node scripts/bench-chats-head-churn.mjs <base archive> <candidate archive> <scratch>
// Scratch must contain backed-up run-queue.sqlite3/heavy.sqlite3 and a bounded
// scoped-state.db (copied session shapes, synthetic messages; no live write handles).
// Instruments ONLY the two scratch archives. Never admits, resumes or starts a queue.
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { readFileSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [base, candidate, scratch] = process.argv.slice(2).map(resolvePath => resolve(resolvePath))
assert(base && candidate && scratch)
for (const path of [base, candidate]) assert(realpathSync(path).startsWith(`${realpathSync(scratch)}/`), 'instrument scratch archives only')
const home = join(scratch, 'churn-home'); mkdirSync(home, { recursive: true, mode: 0o700 })
process.env.HOME = process.env.HERMES_HOME = process.env.WIZARD_OS_HOME = home
const startedWall = Date.now()
let wall = startedWall
const actualNow = Date.now
Date.now = () => wall
const report = { cadence_seconds: 10, owner_touches_per_minute: 50, builds_per_scenario: 6, results: {} }
for (const [label, source] of [['before', base], ['after', candidate]]) {
  const file = join(source, 'server/service.mjs')
  let text = readFileSync(file, 'utf8')
  assert(!text.includes('benchmarkChurn'), 'use fresh archives')
  text = text.replace('    const checkCore = async () => {', `    options.benchmarkChurn?.({ buildHybrid, fullCore, hotIds,
      touch: () => { localRevision++ }, clear: () => { projector.clear(); messageMark = Number.NaN },
      setQueue: value => { runQueue = value }, setHeavy: rows => { heavyWork = { queue: { rows: () => rows } } } })
    const checkCore = async () => {`)
  assert(text.includes('options.benchmarkChurn'))
  writeFileSync(file, text)
  const { createWizardServer, listen, readCanonicalSessions, readPendingFirstSendSessions } = await import(pathToFileURL(file))
  const { DurableRunQueue } = await import(pathToFileURL(join(source, 'server/run-queue.mjs')))
  const state = join(scratch, 'scoped-state.db')
  const [first, second] = [await readCanonicalSessions(state), await readCanonicalSessions(state)]
  assert(first?.length && isDeepStrictEqual(first, second), 'two real canonical reads on scoped copy must be stable')
  const qdb = new DatabaseSync(join(scratch, 'run-queue.sqlite3'), { readOnly: true })
  const hdb = new DatabaseSync(join(scratch, 'heavy.sqlite3'), { readOnly: true })
  for (const db of [qdb, hdb]) assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  // Use the actual queue reader methods, without its write-capable constructor,
  // initialize(), timers, discovery or continuation machinery.
  const queue = Object.assign(Object.create(DurableRunQueue.prototype), { database: qdb, projectionInputs: new Map(), projectionDataVersion: -1 })
  const jobs = hdb.prepare("SELECT data FROM heavy_jobs WHERE agent_id='hermes'").all().map(row => JSON.parse(row.data))
  const pending = readPendingFirstSendSessions(state, queue.recentUnfinishedSessionIds(wall / 1000 - 7 * 86400))
  report.sessions = first.length; report.pending_first_send = pending.length
  report.stable_inputs = { canonical_rows: first.length, head_rows: Math.min(100, first.length), queue_session_stamps: queue.sessionStamps().size, heavy_jobs: jobs.length }
  assert.equal(queue.sessionStamps().size > 0, true)
  const rows = first
  let core, includePending = true
  const serviceHome = join(home, label); mkdirSync(serviceHome, { recursive: true })
  const server = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'synthetic-api-key', requireAccess: false,
    agents: false, agentBridge: false, followThrough: false, scheduler: false, joinedDelegation: 'off', wizardOsHome: serviceHome,
    hermesStatePath: state, canonicalSessionReader: () => rows, listCacheMode: 'on', listCacheCheckMs: 3600000,
    pendingFirstSendReader: ids => includePending ? readPendingFirstSendSessions(state, ids) : [],
    benchmarkChurn: value => { core = value },
    fetchImpl: async (url, init = {}) => {
      assert.equal(init.method ?? 'GET', 'GET', 'never admit/resume/cancel work')
      assert(new URL(url).pathname.endsWith('/messages'), 'only synthetic history reads allowed')
      return new Response(JSON.stringify({ data: [], has_more: false }), { headers: { 'Content-Type': 'application/json' } })
    } })
  core.setQueue(queue); core.setHeavy(jobs)
  await listen(server)
  try {
    const stamps = JSON.stringify([...queue.sessionStamps()]), heavy = JSON.stringify(jobs)
    report.results[label] = {}
    for (const [scenario, withPending, withTouches] of [['unchanged', false, false], ['context_only', false, true], ['pending_only', true, false], ['realistic_churn', true, true]]) {
      wall = startedWall; includePending = withPending; core.clear()
      await core.buildHybrid()
      const samples = []
      for (let i = 0; i < report.builds_per_scenario; i++) {
        // 8,8,9 touches per ten-second build = exactly 50 per simulated minute.
        const touches = withTouches ? [8, 8, 9][i % 3] : 0
        for (let n = 0; n < touches; n++) core.touch()
        wall += 10000
        const out = await core.buildHybrid()
        const full = await core.fullCore(rows)
        assert(isDeepStrictEqual(out.rows, full), `${label}/${scenario}: cached output differs from full real core`)
        samples.push({ head_reused: out.head_reused, head_projected: out.head_projected, head_ms: out.head_ms,
          head_extras: out.head_extras, head_blocked: out.head_blocked, rows: out.rows.length })
      }
      const median = key => {
        const values = samples.map(sample => sample[key]).sort((a, b) => a - b), middle = Math.floor(values.length / 2)
        return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
      }
      report.results[label][scenario] = { head_reused: median('head_reused'), head_projected: median('head_projected'), head_ms: median('head_ms'),
        equivalent: true, samples }
    }
    assert.equal(JSON.stringify([...queue.sessionStamps()]), stamps, 'copied run stamps are stable, not volatile')
    assert.equal(JSON.stringify(jobs), heavy, 'copied heavy stamps are stable, not volatile')
  } finally { await new Promise(done => server.close(done)); qdb.close(); hdb.close() }
}
Date.now = actualNow
console.log(JSON.stringify(report, null, 2))
