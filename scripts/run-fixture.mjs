import { createHermesFixture } from '../server/fixture.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const fixture = createHermesFixture({ expectedKey: 'local-fixture-only' })
const fixtureAddress = await listen(fixture)
const app = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${fixtureAddress.port}`, hermesKey: 'local-fixture-only', requireAccess: false })
const appAddress = await listen(app, '127.0.0.1', Number(process.env.WIZARD_FIXTURE_PORT || 0))
process.stdout.write(`Deterministic Wizard fixture: http://127.0.0.1:${appAddress.port}/wizard\n`)

async function stop() {
  app.closeAllConnections?.()
  await new Promise((resolve) => app.close(resolve))
  await fixture.closeFixture()
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
