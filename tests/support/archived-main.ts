// The archived main release (859c548) that S2c must stay compatible with, for side-by-side
// comparisons and the rollback rehearsal. WAS_ROLLBACK_BASE_DIR wins (Thales stages one); otherwise
// the tree is extracted once from git into .cache/ (gitignored) so the archived modules resolve the
// repo's own node_modules. CI fetches the commit (quality.yml). With neither available the caller
// skips, unless REQUIRE_ROLLBACK_REHEARSAL=1 makes that a failure.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ARCHIVED_MAIN = '859c548d43081a5e28a37680e796d07041971601'
let cached: string | null | undefined

export function archivedMainDir(): string | undefined {
  if (cached !== undefined) return cached ?? undefined
  if (process.env.WAS_ROLLBACK_BASE_DIR) return (cached = process.env.WAS_ROLLBACK_BASE_DIR)
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), cache = join(repo, '.cache')
  const target = join(cache, `was-archived-${ARCHIVED_MAIN.slice(0, 12)}`)
  if (existsSync(join(target, 'server', 'service.mjs'))) return (cached = target)
  try {
    execFileSync('git', ['cat-file', '-e', `${ARCHIVED_MAIN}^{commit}`], { cwd: repo, stdio: 'pipe' })
  } catch {
    if (process.env.REQUIRE_ROLLBACK_REHEARSAL === '1') throw new Error(`Archived main ${ARCHIVED_MAIN} is required: set WAS_ROLLBACK_BASE_DIR or fetch the commit`)
    cached = null
    return undefined
  }
  mkdirSync(cache, { recursive: true })
  const staging = mkdtempSync(join(cache, 'was-archived-tmp-'))
  const archive = execFileSync('git', ['archive', ARCHIVED_MAIN], { cwd: repo, maxBuffer: 256 * 1024 * 1024 })
  execFileSync('tar', ['-xf', '-', '-C', staging], { input: archive })
  try { renameSync(staging, target) } catch { rmSync(staging, { recursive: true, force: true }) } // another worker won the race
  return (cached = target)
}
