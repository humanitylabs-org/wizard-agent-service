import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const reportDir = mkdtempSync(join(tmpdir(), 'parity-gate-'))
// A serial whole-matrix process budget with real headroom (the matrix runs about 2 min on CI, the job has 15), not a
// per-contract latency assertion: run.mjs fails a single hung cell by name after its own per-cell budget (issue 637).
const budgetMs = Number(process.env.PARITY_RUN_TIMEOUT_MS) || 600_000
const started = Date.now()
const result = spawnSync(process.execPath, [join(root, 'qa/agent-parity/run.mjs'), '--fixture-only', '--report-dir', reportDir], { encoding: 'utf8', timeout: budgetMs, maxBuffer: 64 * 1024 * 1024, env: process.env })
const elapsed = Date.now() - started
let report
try {
  report = JSON.parse(readFileSync(join(reportDir, 'matrix.json'), 'utf8'))
  assert.equal(report.completed, true)
} catch (error) {
  let last = ''
  try { last = readFileSync(join(reportDir, 'cells.jsonl'), 'utf8').trim().split('\n').filter(Boolean).at(-1) || '' } catch {}
  const why = result.error?.code === 'ETIMEDOUT' ? `killed after ${elapsed} ms (budget ${budgetMs} ms)` : error.message
  throw new Error(`Parity runner did not complete: ${why}; last finished cell: ${last ? JSON.parse(last).feature + '/' + JSON.parse(last).kind : 'none'}\n${result.stderr}\n${result.stdout}`)
} finally { rmSync(reportDir, { recursive: true, force: true }) }
// So creep is visible long before the budget: the run's time and its slowest cells, in the CI log.
const slowest = [...report.cells].filter(c => typeof c.duration_ms === 'number').sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 8)
console.log(`# parity matrix ${elapsed} ms of ${budgetMs} ms budget; slowest cells: ${slowest.map(c => `${c.feature}/${c.kind} ${c.duration_ms} ms`).join(', ')}`)
const manifest = JSON.parse(readFileSync(join(root, 'qa/agent-parity/features.json'), 'utf8'))
for (const feature of manifest.features.filter(f => f.fixture)) {
  for (const kind of manifest.runtime_kinds) {
    test(`${feature.id} / ${kind}`, () => {
      const cell = report.cells.find(c => c.feature === feature.id && c.kind === kind)
      assert.ok(cell, 'missing cell')
      const exemption = feature.policy_exemptions.find(e => e.kind === kind)
      assert.equal(cell.status, exemption ? 'policy-exempt' : 'pass', cell.reason)
      if (exemption) {
        assert.equal(cell.policy, exemption.policy)
        assert.notEqual(cell.evidence, 'not-run', 'exemptions must execute their per-kind fixture')
      }
    })
  }
}
test('server parity coverage is complete (unimplemented is not policy-exempt)', () => {
  const missing = manifest.features.filter(f => f.layer === 'server' && !f.fixture).map(f => f.id)
  assert.deepEqual(missing, [], `Missing per-kind fixture contracts: ${missing.join(', ')}`)
})
test('matrix includes every declared feature and kind exactly once', () => {
  const ids = report.cells.map(c => JSON.stringify([c.feature, c.kind]))
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(report.cells.length, manifest.features.length * manifest.runtime_kinds.length)
  assert.equal(report.summary.pass + report.summary.fail + report.summary['policy-exempt'], report.cells.length)
  const exemptions = manifest.features.flatMap(f => f.policy_exemptions.map(e => [f.id, e.kind]))
  assert.deepEqual(report.cells.filter(c => c.status === 'policy-exempt').map(c => [c.feature, c.kind]), exemptions)
  assert.equal(result.status, 0, 'the executable matrix must finish without failed fixtures')
})
