// Lightweight importer regression tests; no Docker, account or live Service access.
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
// Resolved: macOS temp folders sit behind symlinks (/var, /tmp -> /private/...), which the importer and recovery
// correctly refuse as symlink_path.
const root = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'hermes-import-test-')))
try {
  for (const name of ['home', 'hermes', 'wizard', 'tmp']) mkdirSync(join(root, name))
  const env = { ...process.env, HOME: join(root, 'home'), HERMES_HOME: join(root, 'hermes'),
    WIZARD_OS_HOME: join(root, 'wizard'), TMPDIR: join(root, 'tmp'), PYTHONDONTWRITEBYTECODE: '1' }
  const tests = [resolve('tests/test_import_tree.py'), resolve('tests/test_hermes_lock.py'), resolve('tests/test_history_schema.py'), resolve('tests/test_import_scan_preservation.py'), resolve('tests/test_hermes_import.py'), resolve('tests/test_restricted_import.py'), resolve('tests/test_hermes_recovery.py'),
    resolve('tests/test_restricted_rehearsal.py'), resolve('tests/test_agent_heavy_plugin.py'), resolve('tests/test_heavy_worker_sandbox.py'), resolve('tests/test_machines.py')]
  const python = process.env.WIZARD_IMPORT_PYTHON
  const uv = !python && spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0
  for (const test of tests) {
    const result = spawnSync(python || (uv ? 'uv' : 'python3'), uv
      ? ['run', '--no-project', '--with', 'PyYAML>=6.0.2,<7', '--with', 'python-dotenv>=1,<2', 'python', test] : [test], { env, stdio: 'inherit' })
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break }
  }
} finally { rmSync(root, { recursive: true, force: true }) }
