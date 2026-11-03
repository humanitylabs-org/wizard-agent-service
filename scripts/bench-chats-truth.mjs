// Copy-only benchmark: base source, candidate source, scratch (all instrumentation
// and databases stay below scratch). Provide copied run-queue/heavy DBs plus WALs.
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { truthFixture, instrumentProjection } from '../tests/fixtures/chats-truth.mjs'

const [base, candidate, scratch] = process.argv.slice(2).map(resolvePath => resolve(resolvePath))
assert(base && candidate && scratch)
const home = join(scratch, 'isolated-home')
mkdirSync(home, { recursive: true, mode: 0o700 })
process.env.HOME = process.env.HERMES_HOME = process.env.WIZARD_OS_HOME = home
const stamps = new Map(), copied = {}
for (const [name, table] of [['run-queue.sqlite3', 'wizard_run_queue'], ['heavy.sqlite3', 'heavy_jobs']]) {
  const path = join(scratch, name)
  assert(realpathSync(path).startsWith(`${realpathSync(scratch)}/`))
  const db = new DatabaseSync(path)
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  copied[name] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  const records = name.startsWith('run-queue')
    ? db.prepare("SELECT session_id,public_run_id,status,updated_at FROM wizard_run_queue WHERE agent_id='hermes'").all()
    : db.prepare("SELECT session,data FROM heavy_jobs WHERE agent_id='hermes'").all()
  for (let i = 0; i < records.length; i++) {
    const id = `wizard_truth_${i % 1100}`
    stamps.set(id, `${stamps.get(id) ?? ''}${JSON.stringify(records[i])}`)
  }
  db.close()
}
const f = truthFixture(join(scratch, 'fixture'), 1100)
const originalNow = Date.now
Date.now = () => f.sec * 1000
const report = { sessions: 1100, head: 100, hot: 25, samples: 3, copied, results: {} }
let oracle
try {
  for (const [label, source] of [['before', base], ['after', candidate]]) {
    const run = await instrumentProjection(source, join(scratch, `instrumented-${label}`), f)
    const { createHybridProjector } = await import(pathToFileURL(join(source, 'server/session-list-cache.mjs')))
    const samples = []
    try {
      const full = await run.core.fullCore(f.sessions)
      if (!oracle) oracle = full
      else assert.deepEqual(full, oracle)
      for (let i = 0; i < report.samples; i++) {
        const hybrid = createHybridProjector({ now: () => f.sec * 1000 })
        await hybrid.project({ sessions: f.sessions, stamps, projectBatch: run.core.projectBatch })
        const rows = f.sessions.map(row => ({ ...row }))
        // Preserve exactly 100 head + 25 hot projections, independent of inherited
        // head reuse: explicit reuseHead=false isolates evidence-reader savings.
        const hot = new Set(rows.slice(1050, 1075).map(s => s.id))
        run.reset()
        const at = performance.now()
        const out = await hybrid.project({ sessions: rows, hot, stamps, reuseHead: false, projectBatch: run.core.projectBatch })
        const measured = { build_ms: performance.now() - at, projected: out.projected, ...run.probe }
        assert.deepEqual(out.rows, oracle)
        samples.push(measured)
      }
      run.reset()
      const at = performance.now()
      assert.deepEqual(await run.core.fullCore(f.sessions), oracle)
      const fullMeasurement = { build_ms: performance.now() - at, ...run.probe }
      const median = key => samples.map(row => row[key]).sort((a, b) => a - b)[1]
      report.results[label] = { median: Object.fromEntries(Object.keys(samples[0]).map(key => [key, median(key)])), full: fullMeasurement, samples }
    } finally { await run.close() }
    writeFileSync(join(scratch, 'benchmark.json'), JSON.stringify(report, null, 2) + '\n')
  }
  report.equivalence = 'All 1100 rows deep-equal the original real Service projector, including helper receipts and follow-ups; 3 hybrid samples per revision.'
  writeFileSync(join(scratch, 'benchmark.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { Date.now = originalNow }
