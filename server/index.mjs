import { createCloudflareAccessVerifier, createWizardServer } from './service.mjs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { wizardOsHome } from './wizard-os-settings.mjs'

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
const osHome = wizardOsHome()
const joinedDelegation = process.env.WIZARD_JOINED_DELEGATION || 'require'
const router = process.env.WIZARD_ROUTER_URL && process.env.WIZARD_ROUTER_MODEL ? {
  url: process.env.WIZARD_ROUTER_URL, model: process.env.WIZARD_ROUTER_MODEL, key: process.env.WIZARD_ROUTER_KEY || '',
} : null
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
  threadStatusBackfillPath: process.env.WIZARD_THREAD_STATUS_BACKFILL_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'thread-status-backfill.json'),
  threadDispositionStatePath: process.env.WIZARD_THREAD_DISPOSITION_STATE_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'thread-dispositions.json'),
  threadTitleStatePath: process.env.WIZARD_THREAD_TITLE_STATE_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'thread-titles.json'),
  threadSeenStatePath: process.env.WIZARD_THREAD_SEEN_STATE_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'thread-seen.json'),
  voiceRecoveryManifestPath: process.env.WIZARD_VOICE_RECOVERY_MANIFEST_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'voice-recoveries.json'),
  dismissedFailureStatePath: process.env.WIZARD_DISMISSED_FAILURE_STATE_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'dismissed-failures.json'),
  runQueueStatePath: process.env.WIZARD_RUN_QUEUE_STATE_PATH || resolve(process.env.HERMES_HOME || resolve(homedir(), '.hermes'), 'state', 'wizard-mobile', 'run-queue.sqlite3'),
  runQueueMaxActive: Number(process.env.WIZARD_MAX_ACTIVE_THREADS || 8),
  requireAccess,
  helperContinueOrigins: (process.env.WIZARD_HELPER_CONTINUE_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  accessVerifier,
  operatorWorkerModel: 'glm-5-3',
  joinedDelegation,
  settingsPath: process.env.WIZARD_SETTINGS_PATH || resolve(osHome, 'settings.json'),
  appsJsonPath: process.env.WIZARD_APPS_JSON_PATH || resolve(osHome, 'apps.json'),
  launcherPath: process.env.WIZARD_LAUNCHER_PATH || resolve(osHome, 'launcher.json'),
  subjectsPath: process.env.WIZARD_SUBJECTS_PATH || resolve(osHome, 'subjects.json'),
  uxDir: process.env.WIZARD_UX_DIR || '',
  uxPrefix: process.env.WIZARD_UX_PREFIX || 'wizard-os-home',
  ...(process.env.WIZARD_STT_ENABLED === '0' ? { sttConfigured: false } : {}),
  router,
  // Resumable uploads and shares (server/uploads.mjs). Size is bounded only by free disk minus the reserve.
  uploadStatePath: process.env.WIZARD_UPLOAD_STATE_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'uploads.sqlite3'),
  uploadStagingDir: process.env.WIZARD_UPLOAD_STAGING_DIR || resolve(hermesHome, 'state', 'wizard-mobile', 'upload-staging'),
  ...(process.env.WIZARD_UPLOAD_RESERVE_BYTES ? { uploadReserveBytes: Number(process.env.WIZARD_UPLOAD_RESERVE_BYTES) } : {}),
  ...(process.env.WIZARD_UPLOAD_MAX_BYTES ? { uploadMaxBytes: Number(process.env.WIZARD_UPLOAD_MAX_BYTES) } : {}),
})
server.listen(port, host, () => process.stdout.write(`Wizard listening on ${host}:${port}\n`))
