// Copy-only benchmark. Arguments: base archive, candidate archive, scratch dir
// containing copied run-queue.sqlite3/heavy.sqlite3 (+ any WAL sidecars).
// Never pass serving directories: instrumentation is written ONLY in these archives.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [base, candidate, scratch] = process.argv.slice(2).map(p => resolve(p))
assert(base && candidate && scratch)
assert([base, candidate].every(p => realpathSync(p).startsWith(`${realpathSync(scratch)}/`)), 'archives must be inside scratch')
const home = join(scratch, 'fixture-home')
mkdirSync(home, { recursive: true, mode: 0o700 })
process.env.HOME = process.env.HERMES_HOME = process.env.WIZARD_OS_HOME = home
const copied = {}, stamps = new Map()
for (const [name, table] of [['run-queue.sqlite3', 'wizard_run_queue'], ['heavy.sqlite3', 'heavy_jobs']]) {
  // Only caller-provided COPIES are opened, never a live state.db or ledger.
  const db = new DatabaseSync(join(scratch, name))
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  copied[name] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  const records = name.startsWith('run-queue')
    ? db.prepare('SELECT session_id AS id, public_run_id, status, updated_at FROM wizard_run_queue WHERE agent_id=\'hermes\'').all()
    : db.prepare('SELECT session AS id, data FROM heavy_jobs WHERE agent_id=\'hermes\'').all()
  // Synthetic session identities carry real copied signature shapes, not owner text.
  for (let i = 0; i < records.length; i++) {
    const id = `wizard_bench_${i % 1100}`
    stamps.set(id, `${stamps.get(id) ?? ''}${JSON.stringify(records[i])}`)
  }
  db.close()
}
const state = join(scratch, `synthetic-state-${process.pid}.db`)
const db = new DatabaseSync(state)
db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, started_at REAL, last_activity_at REAL, message_count INTEGER);
  CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, finish_reason TEXT, active INTEGER);
  CREATE INDEX idx_messages_session_id ON messages(session_id);`)
const now = Date.now() / 1000 - 86400
const sessions = Array.from({ length: 1100 }, (_, i) => ({ id: `wizard_bench_${i}`, source: 'api_server', title: `Synthetic ${i}`, hidden: false,
  parent_session_id: null, message_count: 2, last_active: now - i, started_at: now - i }))
const messages = new Map()
const insertS = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)')
const insertM = db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)')
for (const s of sessions) {
  insertS.run(s.id, null, s.started_at, s.last_active, 2)
  const rows = [{ role: 'user', content: 'Synthetic owner request', timestamp: s.last_active - 1 },
    { role: 'assistant', content: 'Synthetic answer.\n[WIZARD_STATUS_V1] {"state":"done","title":"Synthetic","subject":"Benchmark"}', timestamp: s.last_active }]
  messages.set(s.id, rows)
  for (const m of rows) insertM.run(s.id, m.role, m.content, m.timestamp)
}
db.close()
const report = { sessions: sessions.length, changed: 20, samples: 7, copied, results: {} }
for (const [label, source] of [['before', base], ['after', candidate]]) {
  const serviceFile = join(source, 'server/service.mjs')
  const sourceText = readFileSync(serviceFile, 'utf8')
  assert(sourceText.includes('    const gate = () => {'), 'instrument only a known archived service')
  if (!sourceText.includes('options.benchmarkProjection?.')) writeFileSync(serviceFile, sourceText.replace('    const gate = () => {', '    options.benchmarkProjection?.({ projectBatch, fullCore })\n    const gate = () => {'))
  const { createWizardServer, listen } = await import(pathToFileURL(serviceFile))
  const { createHybridProjector } = await import(pathToFileURL(join(source, 'server/session-list-cache.mjs')))
  let core, historyReads = 0
  const server = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'synthetic-api-key', requireAccess: false,
    agents: false, agentBridge: false, followThrough: false, joinedDelegation: 'off', wizardOsHome: join(home, label), hermesStatePath: state,
    canonicalSessionReader: () => sessions, runQueue: false, listCacheMode: 'on', listCacheCheckMs: 3600000,
    benchmarkProjection: value => { core = value },
    fetchImpl: async (url, init = {}) => {
      assert.equal(init.method ?? 'GET', 'GET', 'no admission or continuation may run')
      const path = new URL(url).pathname
      const match = path.match(/^\/api\/sessions\/([^/]+)\/messages$/)
      assert(match, `unexpected external request: ${path}`)
      historyReads++
      return new Response(JSON.stringify({ data: messages.get(decodeURIComponent(match[1])) ?? [], has_more: false }), { headers: { 'Content-Type': 'application/json' } })
    } })
  await listen(server)
  try {
    const samples = []
    for (let sample = 0; sample < report.samples; sample++) {
      const projector = createHybridProjector({ now: () => 1000 })
      const rows = sessions.map(s => ({ ...s }))
      await projector.project({ sessions: rows, stamps, projectBatch: core.projectBatch })
      // Exactly twenty spread-out head changes, including both sides of preview row 48.
      for (let i = 0; i < 100; i += 5) rows[i].title = `Changed ${sample}:${i}`
      historyReads = 0
      const start = performance.now()
      const out = await projector.project({ sessions: rows, stamps, projectBatch: core.projectBatch })
      const elapsed = performance.now() - start
      const reads = historyReads
      // The same real full Service projection is the oracle for ALL 1,100 rows.
      const full = await core.fullCore(rows)
      assert.deepEqual(out.rows, full)
      samples.push({ build_ms: elapsed, head_ms: out.head_ms, head_reused: out.head_reused ?? 0,
        head_projected: out.head_projected ?? 100, projected: out.projected, history_reads: reads, equivalent: out.rows.length })
    }
    const median = key => samples.map(s => s[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]
    report.results[label] = { build_ms: median('build_ms'), head_ms: median('head_ms'), head_reused: median('head_reused'),
      head_projected: median('head_projected'), projected: median('projected'), history_reads: median('history_reads'),
      equivalence: 'all 1100 rows deep-equal full projection in all 7 samples', samples }
  } finally { await new Promise(r => server.close(r)) }
}
console.log(JSON.stringify(report, null, 2))
