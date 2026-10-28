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
      const privateOnly = feature.id === 'private-incognito' && feature.fixture === 'private-incognito-policy'
      assert.equal(cell.status, privateOnly ? 'policy-exempt' : 'pass', cell.reason)
      if (privateOnly) assert.equal(cell.reason, 'private agent only, by owner decision')
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
  // Only the named owner decision is exempt, backed by an executable 409
  // refusal assertion for each standard runtime kind. No other gap is waived.
  assert.deepEqual(report.cells.filter(c => c.status === 'policy-exempt').map(c => [c.feature, c.kind]),
    manifest.runtime_kinds.map(kind => ['private-incognito', kind]))
  assert.equal(report.summary['policy-exempt'], manifest.runtime_kinds.length)
  assert.equal(result.status, 0, 'the executable matrix must finish without failed fixtures')
})
