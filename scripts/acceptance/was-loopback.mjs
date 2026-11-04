// Disposable loopback-only WAS for exact-upstream acceptance. Never uses owner state.
import { createWizardServer, listen } from '../../server/service.mjs'
import { join } from 'node:path'
import { DurableRunQueue, queueRequestHash } from '../../server/run-queue.mjs'
const home = process.env.ACCEPTANCE_HOME
if (!home || !process.env.ACCEPTANCE_UPSTREAM?.startsWith('http://127.0.0.1:')) throw Error('isolated acceptance configuration required')
// Fixture-only local receipt import, representing an admission already known before restart.
const seed = new DurableRunQueue({ statePath: join(home, 'wizard-queue.db'), pollIntervalMs: 0, canDispatch: () => false, launch: async () => { throw Error('fixture never dispatches') }, lookup: async () => { throw Error('fixture never polls') } })
const body = JSON.stringify({ session_id: 'api-session', input: 'HEAD' })
const { record } = await seed.admit({ runtime: 'direct', sessionId: 'api-session', idempotencyKey: 'run-a', requestHash: queueRequestHash('direct', body), body, trustedPaths: [] })
seed.database.prepare("UPDATE wizard_run_queue SET upstream_run_id=?,status='running',dispatch_attempted=1 WHERE public_run_id=?").run(process.env.ACCEPTANCE_SEED_RUN, record.publicRunId)
seed.close()
const svc = createWizardServer({ upstreamOrigin: process.env.ACCEPTANCE_UPSTREAM, hermesKey: 'checkpoint-two-api-key',
  requireAccess: false, agentBridge: false, wizardOsHome: home, runQueueStatePath: join(home, 'wizard-queue.db'),
  joinedDelegation: 'off', followThrough: false, activeSessionReader: () => [], dispatchHealthReader: () => true,
  appsJsonPath: join(home, 'apps.json'), launcherPath: join(home, 'launcher.json'), settingsPath: join(home, 'settings.json'),
  threadTitleStatePath: join(home, 'titles.json'), threadSeenStatePath: join(home, 'seen.json'),
})
const addr = await listen(svc)
console.log(JSON.stringify({ origin: `http://127.0.0.1:${addr.port}`, seed_public_run: record.publicRunId }))
process.on('SIGTERM', () => svc.close(() => process.exit(0)))
