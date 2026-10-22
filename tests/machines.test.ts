import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

it('Machines privacy/Unix/registry/receiver regressions run in the normal suite with isolated state', () => {
  const root = mkdtempSync(join(tmpdir(), 'wm-test-'))
  const paths = Object.fromEntries(['HOME', 'HERMES_HOME', 'WIZARD_OS_HOME', 'TMPDIR'].map(key => [key, join(root, key)]))
  Object.values(paths).forEach(path => mkdirSync(path, { recursive: true }))
  try {
    const child = spawnSync('python3', ['tests/test_machines.py'], {
      env: { ...process.env, ...paths, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 20_000,
    })
    expect(child.error, `${child.stdout}\n${child.stderr}`).toBeUndefined()
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0)
    expect(child.stderr).toContain('Ran 12 tests')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 25_000)
