import test from 'node:test'
import assert from 'node:assert/strict'
import { kinds } from '../qa/agent-parity/fixture.mjs'
import { runCheck } from '../qa/agent-parity/checks.mjs'

for (const kind of kinds) test(`head-row owner-write parity / ${kind}`, { timeout: 30000 }, async () => {
  const cell = await runCheck(kind, 'head-row-owner-write-parity')
  assert.equal(cell.status, 'pass', cell.reason)
  assert.equal(cell.evidence, 'fixture HTTP boundary')
})
