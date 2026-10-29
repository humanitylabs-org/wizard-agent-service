// Forum fixture ONLY. Runs the shipped Service/module against a real broker, over a
// private Unix socket. The host HTTPS owner-session proxy is separate from this process.
import { createWizardServer } from '../../server/service.mjs'
import { sharedVaultRegistration } from '../../server/shared-vault-bootstrap.mjs'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Export the exact fixture bootstrap so the fast regression uses the real registry,
// owner registration and per-agent gateway, without Docker or an existing owner home.
export async function createStagingServer(root) {
  return createWizardServer({ upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'synthetic-only-upstream-key',
    requireAccess: false, ownerProof: readFileSync(root + '/service-private/proof', 'utf8'),
    hermesHome: root + '/main-hermes',
    wizardOsHome: root + '/os', agentsDir: root + '/agents', agents: true, agentIsolation: 'restricted',
    agentBridge: 'gateway', followThrough: false, joinedDelegation: 'off',
    settingsPath: root + '/os/settings.json', appsJsonPath: root + '/os/apps.json', launcherPath: root + '/os/launcher.json',
    threadSeenStatePath: root + '/os/seen.json', threadDispositionStatePath: root + '/os/dispositions.json',
    appOwnerRoutes: await sharedVaultRegistration(root + '/service-private/owner.json'),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.SV_STAGE_ROOT
  if (!root?.startsWith('/srv/work/')) throw Error('isolated_forum_root_required')
  const server = await createStagingServer(root)
  await server.agentSocketsReady
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(root + '/service-private/service.sock', resolve)
  })
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
