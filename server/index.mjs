import { createCloudflareAccessVerifier, createWizardServer } from './service.mjs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { wizardOsHome } from './wizard-os-settings.mjs'

const key = process.env.WIZARD_HERMES_API_KEY
if (!key) {
  process.stderr.write('WIZARD_HERMES_API_KEY is required; the service was not started.\n')
  process.exit(1)
}

// Inside a Wizard OS container (WIZARD_CONTAINER=1) the service listens on the container's own interface;
// the compose file publishes that port on the box's 127.0.0.1 only. Everywhere else it stays loopback.
const container = process.env.WIZARD_CONTAINER === '1'
const host = process.env.WIZARD_HOST || (container ? '0.0.0.0' : '127.0.0.1')
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !(container && host === '0.0.0.0')) {
  process.stderr.write('WIZARD_HOST must be a loopback address (0.0.0.0 only inside a Wizard OS container).\n')
  process.exit(1)
}

const port = Number(process.env.WIZARD_PORT || 8787)
const requireAccess = process.env.WIZARD_REQUIRE_CF_ACCESS !== '0'
// Hermes state.db fallback (read-only) for the reads stock Hermes does not serve over HTTP; off unless set.
// spec/AGENT_BRIDGE.md "Agent adapter" lists them.
const hermesStatePath = process.env.WIZARD_HERMES_STATE_PATH || ''
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
  // Wizard OS box: attachments go into the shared user-files folder; the agent sees it at WIZARD_MEDIA_AGENT_ROOT.
  mediaRoot: process.env.WIZARD_MEDIA_ROOT || '',
  mediaAgentRoot: process.env.WIZARD_MEDIA_AGENT_ROOT || process.env.WIZARD_MEDIA_ROOT || '',
  mediaIndexPath: process.env.WIZARD_MEDIA_INDEX_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'media-files.json'),
  kernelJobMap: process.env.WIZARD_KERNEL_JOB_MAP === '1',
  filesRoot: process.env.WIZARD_FILES_ROOT || '',
  appsMcpAddress: process.env.WIZARD_APPS_MCP_ADDRESS || 'url',
  // Agent bridge: gateway token ($WIZARD_MCP_TOKEN or <WIZARD_OS_HOME>/mcp-token) and the per-thread app snapshots.
  wizardOsHome: osHome,
  ...(process.env.WIZARD_MCP_TOKEN ? { mcpToken: process.env.WIZARD_MCP_TOKEN } : {}),
  ...(process.env.WIZARD_AGENT_BRIDGE === 'off' ? { agentBridge: false } : {}),
  threadAppsStatePath: process.env.WIZARD_THREAD_APPS_STATE_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'thread-apps.json'),
  appsSkillsInline: process.env.WIZARD_APPS_SKILLS_INLINE === '1',
  // A second Agent Service on the same Hermes (a staging copy beside the daily driver) sets this to 'off',
  // so only one service ever starts automatic follow-through turns on the shared threads.
  followThrough: process.env.WIZARD_FOLLOW_THROUGH !== 'off',
})
server.listen(port, host, () => process.stdout.write(`Wizard listening on ${host}:${port}\n`))
