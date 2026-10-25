import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export const supervisorAssets = [
  ['hermes-plugin/wizard-supervisor-tools', 'plugins/wizard-supervisor-tools'],
  ['skills/reporter', 'skills/reporter'],
  ['skills/supervisor', 'skills/supervisor'],
]
const files = path => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]).sort()
export const SUPERVISOR_ASSET_HASH = createHash('sha256').update(supervisorAssets.flatMap(([src]) => files(join(root, src))).filter(f => !f.includes('__pycache__')).map(f => readFileSync(f)).reduce((a,b) => Buffer.concat([a,b]), Buffer.alloc(0))).digest('hex')

/** Install only the three Service-owned namespaces, never config or owner memory.
 * Called for managed agents; for host/main profiles it is an explicit release step. */
export function installSupervisorAssets(home) {
  for (const [source, target] of supervisorAssets) {
    const path = join(home, target)
    // Never traverse agent-planted symlinks in a managed home (restricted homes use managed/).
    for (const p of [home, dirname(path), path]) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('supervisor_asset_symlink')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    cpSync(join(root, source), path, { recursive: true, force: true, filter: p => !p.includes('__pycache__') && !p.endsWith('.pyc') })
  }
  return { home, hash: SUPERVISOR_ASSET_HASH, assets: supervisorAssets.map(([, dest]) => dest) }
}
