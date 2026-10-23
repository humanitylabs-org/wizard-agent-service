import { createHermesFixture } from '../server/fixture.mjs'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

const fixture = createHermesFixture({ expectedKey: 'local-fixture-only' })
const fixtureAddress = await listen(fixture)
const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`
const scratch = mkdtempSync(join(tmpdir(), 'wizard-service-fixture-'))
const files = join(scratch, 'files'); mkdirSync(files)
const app = createWizardServer({ upstreamOrigin: fixtureOrigin, helmOrigin: fixtureOrigin, hermesKey: 'local-fixture-only', requireAccess: false,
  userFilesRoot: files, skinsStateDir: join(scratch, 'skins'), settingsPath: join(scratch, 'settings.json'), wizardOsHome: join(scratch, 'os'),
  // Synthetic Store is empty; this fixture must never publish to a real relay.
  skins: { relays: [], blossom: 'https://127.0.0.1/fixture-offline' },
})
const appAddress = await listen(app, '127.0.0.1', Number(process.env.WIZARD_FIXTURE_PORT || 0))
process.stdout.write(`Deterministic Wizard fixture: http://127.0.0.1:${appAddress.port}/wizard\n`)

async function stop() {
  app.closeAllConnections?.()
  await new Promise((resolve) => app.close(resolve))
  await fixture.closeFixture()
  rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
