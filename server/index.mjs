import { createCloudflareAccessVerifier, createWizardServer } from './service.mjs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const key = process.env.WIZARD_HERMES_API_KEY
if (!key) {
  process.stderr.write('WIZARD_HERMES_API_KEY is required; the service was not started.\n')
  process.exit(1)
}

const host = process.env.WIZARD_HOST || '127.0.0.1'
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  process.stderr.write('WIZARD_HOST must be a loopback address.\n')
  process.exit(1)
}

const port = Number(process.env.WIZARD_PORT || 8787)
const requireAccess = process.env.WIZARD_REQUIRE_CF_ACCESS !== '0'
const hermesStatePath = process.env.WIZARD_HERMES_STATE_PATH || (process.env.HOME ? resolve(process.env.HOME, '.hermes/state.db') : '')
const hermesHome = process.env.HERMES_HOME || resolve(homedir(), '.hermes')
const accessVerifier = requireAccess ? createCloudflareAccessVerifier({
  teamDomain: process.env.WIZARD_ACCESS_TEAM_DOMAIN,
  audience: process.env.WIZARD_ACCESS_AUDIENCE,
  jwksUrl: process.env.WIZARD_ACCESS_JWKS_URL,
}) : undefined
const server = createWizardServer({
  distDir: process.env.WIZARD_STATIC_DIR || '.ui-live',
  upstreamOrigin: process.env.HERMES_ORIGIN || 'http://127.0.0.1:8642',
  helmOrigin: process.env.WIZARD_HELM_ORIGIN || 'http://127.0.0.1:8836',
  hermesStatePath,
  sessionDbPath: hermesStatePath,
  canonicalSessionListing: true,
  helmDbPath: process.env.WIZARD_HELM_DB_PATH || (process.env.HOME ? resolve(process.env.HOME, '.hermes/data/apps/helm/helm.db') : ''),
  hermesKey: key,
  sttOrigin: process.env.WIZARD_STT_ORIGIN || 'http://127.0.0.1:8864',
  inboxOrigin: process.env.WIZARD_INBOX_ORIGIN || 'http://127.0.0.1:8941',
  inboxToken: process.env.WIZARD_INBOX_INTERNAL_TOKEN || '',
  inboxTrustedRoot: process.env.WIZARD_INBOX_TRUSTED_ROOT || '',
  inboxDbPath: process.env.WIZARD_INBOX_DB_PATH || resolve(hermesHome, 'data/apps/wizard-inbox/inbox.sqlite3'),
  agentArtifactDir: process.env.WIZARD_AGENT_ARTIFACT_DIR || resolve(hermesHome, 'data/apps/wizard-mobile/agent-artifacts'),
  agentArtifactRoots: process.env.WIZARD_AGENT_ARTIFACT_ROOTS
    ? process.env.WIZARD_AGENT_ARTIFACT_ROOTS.split(':')
    : [resolve(hermesHome, 'cache/images'), resolve(hermesHome, 'media/images'), resolve(hermesHome, 'workspace')],
  operatorWorkerStatePath: process.env.WIZARD_OPERATOR_STATE_PATH || '',
  runQueueStatePath: process.env.WIZARD_RUN_QUEUE_STATE_PATH || resolve(process.env.HERMES_HOME || resolve(homedir(), '.hermes'), 'state', 'wizard-mobile', 'run-queue.sqlite3'),
  runQueueMaxActive: Number(process.env.WIZARD_MAX_ACTIVE_THREADS || 8),
  requireAccess,
  accessVerifier,
  operatorWorkerModel: 'glm-5-3',
})
server.listen(port, host, () => process.stdout.write(`Wizard listening on ${host}:${port}\n`))
