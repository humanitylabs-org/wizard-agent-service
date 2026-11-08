// Child process for scripts/upload-large-acceptance.mjs: the real server/index.mjs options, port 0,
// prints "LISTENING <port>" so the harness can measure this process's RSS on its own.
import { createWizardServer, listen } from '../server/service.mjs'

const server = createWizardServer({
  upstreamOrigin: process.env.HERMES_ORIGIN,
  hermesKey: process.env.WIZARD_HERMES_API_KEY,
  requireAccess: false,
  joinedDelegation: 'off',
  followThrough: false,
  agentBridge: false,
  sttConfigured: false,
  mediaRoot: process.env.WIZARD_MEDIA_ROOT,
  mediaAgentRoot: process.env.WIZARD_MEDIA_AGENT_ROOT,
  mediaIndexPath: `${process.env.HERMES_HOME}/state/media-files.json`,
  uploadStatePath: process.env.WIZARD_UPLOAD_STATE_PATH,
  ...(process.env.WIZARD_UPLOAD_RESERVE_BYTES ? { uploadReserveBytes: Number(process.env.WIZARD_UPLOAD_RESERVE_BYTES) } : {}),
  runQueueStatePath: `${process.env.HERMES_HOME}/state/run-queue.sqlite3`,
  runQueuePollIntervalMs: 0,
  activeSessionReader: async () => [],
  dispatchHealthReader: () => true,
})
const address = await listen(server, '127.0.0.1', 0)
process.stdout.write(`LISTENING ${address.port}\n`)
process.on('SIGTERM', () => server.close(() => process.exit(0)))
