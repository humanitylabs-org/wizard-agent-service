#!/usr/bin/env node
// Run the ordinary test command with no access to the developer's Hermes/home.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'wizard-tests-isolated-'))
try {
  const env = { ...process.env, VITEST_MAX_WORKERS: '1' }
  for (const key of ['HOME', 'HERMES_HOME', 'WIZARD_OS_HOME', 'TMPDIR']) {
    env[key] = join(root, key.toLowerCase())
    mkdirSync(env[key], { mode: 0o700 })
  }
  // Never inherit an enabled scheduler or live Hermes database path into tests.
  env.WIZARD_SCHEDULER = '0'
  delete env.WIZARD_HERMES_STATE_PATH
  const result = spawnSync('npm', ['test'], { env, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
