// An explicit, disabled-by-default source-packaged owner extension.
// No import paths, code, origins or secret paths are accepted from app metadata.
import { openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync, constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { principalOf } from './principals.mjs'

export function privateBootstrapFile(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || realpathSync(path) !== resolve(path)) throw Error('unsafe_app_owner_config')
  const parent = lstatSync(dirname(path))
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw Error('unsafe_app_owner_config')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077) || s.size > 16384) throw Error('unsafe_app_owner_config')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}
export async function sharedVaultRegistration(configPath) {
  if (!configPath) return []
  if (!process.getuid || process.getuid() === 0) throw Error('app_owner_unprivileged_service_required')
  const seal = JSON.parse(readFileSync(new URL('./vendor/shared-vault/source.json', import.meta.url), 'utf8'))
  const bytes = readFileSync(new URL('./vendor/shared-vault/service_owner_route.mjs', import.meta.url))
  if (createHash('sha256').update(bytes).digest('hex') !== seal.sha256) throw Error('app_owner_module_integrity')
  // Fixed source-package URL only, after integrity admission. The immutable Service
  // image/source tree is the code trust boundary, not arbitrary installed app data.
  const { sharedVaultOwnerRoute } = await import('./vendor/shared-vault/service_owner_route.mjs')
  const cfg = JSON.parse(privateBootstrapFile(configPath))
  if (Object.keys(cfg).sort().join(',') !== 'brokerOrigin,ownerTokenFile,publicOrigin') throw Error('invalid_app_owner_config')
  const ownerToken = () => {
    const token = privateBootstrapFile(cfg.ownerTokenFile).trim()
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw Error('invalid_app_owner_token')
    return token
  }
  ownerToken() // Startup fails closed, and each use rechecks rotated file permissions.
  return [{ appId: 'shared-vault', routes: ['GET status', 'POST connect', 'POST grant', 'POST revoke', 'POST disconnect'],
    handle: sharedVaultOwnerRoute({ principalOf, publicOrigin: cfg.publicOrigin, brokerOrigin: cfg.brokerOrigin, ownerToken }) }]
}
