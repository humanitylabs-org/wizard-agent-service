// Lightweight importer regression tests; no Docker, account or live Service access.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'hermes-import-test-'))
try {
  for (const name of ['home', 'hermes', 'wizard', 'tmp']) mkdirSync(join(root, name))
  const env = { ...process.env, HOME: join(root, 'home'), HERMES_HOME: join(root, 'hermes'),
    WIZARD_OS_HOME: join(root, 'wizard'), TMPDIR: join(root, 'tmp'), PYTHONDONTWRITEBYTECODE: '1' }
  const test = resolve('tests/test_hermes_import.py')
  const python = process.env.WIZARD_IMPORT_PYTHON
  const uv = !python && spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0
  const result = spawnSync(python || (uv ? 'uv' : 'python3'), uv
    ? ['run', '--no-project', '--with', 'PyYAML>=6.0.2,<7', 'python', test] : [test], { env, stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally { rmSync(root, { recursive: true, force: true }) }
