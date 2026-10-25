import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const reportDir = mkdtempSync(join(tmpdir(), 'parity-gate-'))
// This is a serial whole-matrix process budget, not a per-contract latency assertion.
const result = spawnSync(process.execPath, [join(root, 'qa/agent-parity/run.mjs'), '--fixture-only', '--report-dir', reportDir], { encoding: 'utf8', timeout: 180000, env: process.env })
let report
try {
  report = JSON.parse(readFileSync(join(reportDir, 'matrix.json'), 'utf8'))
  assert.equal(report.completed, true)
} catch (error) {
  throw new Error(`Parity runner did not complete: ${error.message}\n${result.stderr}\n${result.stdout}`)
} finally { rmSync(reportDir, { recursive: true, force: true }) }
const manifest = JSON.parse(readFileSync(join(root, 'qa/agent-parity/features.json'), 'utf8'))
for (const feature of manifest.features.filter(f => f.fixture)) {
  for (const kind of manifest.runtime_kinds) {
    test(`${feature.id} / ${kind}`, () => {
      const cell = report.cells.find(c => c.feature === feature.id && c.kind === kind)
      assert.ok(cell, 'missing cell')
      assert.equal(cell.status, 'pass', cell.reason)
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
  assert.equal(report.summary['policy-exempt'], 0, 'these fixtures use allowed grants; no feature is exempt')
})
