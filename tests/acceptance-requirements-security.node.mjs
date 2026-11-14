import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const minimumSafeVersion = [1, 45, 2]

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

test('acceptance environment pins a patched OpenTelemetry API', () => {
  const requirements = readFileSync('scripts/acceptance/requirements.txt', 'utf8')
  const match = requirements.match(/^opentelemetry-api==(\d+)\.(\d+)\.(\d+)$/m)

  assert.ok(match, 'opentelemetry-api must remain exactly pinned in the frozen acceptance environment')
  const pinnedVersion = match.slice(1).map(Number)
  assert.ok(
    compareVersions(pinnedVersion, minimumSafeVersion) >= 0,
    `opentelemetry-api ${pinnedVersion.join('.')} is affected by GHSA-mf5v-w3w3-f6cg`,
  )
})
