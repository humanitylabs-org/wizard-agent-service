import { createCloudflareAccessVerifier, createTailnetIngress, createWizardServer } from './service.mjs'
import { containerGateway, createSettingsTailnetVerifier } from './tailnet-access.mjs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { readSettings, wizardOsHome } from './wizard-os-settings.mjs'

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
// Who may use the service: 'tailscale' (Tailscale Serve identity, the Wizard OS default), 'cloudflare'
// (Cloudflare Access JWTs) or 'none' (box-only, e.g. behind a gateway that checks identity itself).
// Unset keeps the earlier behaviour: tailscale when WIZARD_TAILNET_ORIGIN is set, else WIZARD_REQUIRE_CF_ACCESS.
const authMode = process.env.WIZARD_AUTH_MODE
  || (process.env.WIZARD_TAILNET_ORIGIN ? 'tailscale' : process.env.WIZARD_REQUIRE_CF_ACCESS === '0' ? 'none' : 'cloudflare')
if (!['tailscale', 'cloudflare', 'none'].includes(authMode)) {
  process.stderr.write('WIZARD_AUTH_MODE must be tailscale, cloudflare or none; the service was not started.\n')
  process.exit(1)
}
const requireAccess = authMode !== 'none'
// Hermes state.db fallback (read-only) for the reads stock Hermes does not serve over HTTP; off unless set.
// spec/AGENT_BRIDGE.md "Agent adapter" lists them.
const hermesStatePath = process.env.WIZARD_HERMES_STATE_PATH || ''
const hermesHome = process.env.HERMES_HOME || resolve(homedir(), '.hermes')
const osHome = wizardOsHome()
const joinedDelegation = process.env.WIZARD_JOINED_DELEGATION || 'require'
const router = process.env.WIZARD_ROUTER_URL && process.env.WIZARD_ROUTER_MODEL ? {
  url: process.env.WIZARD_ROUTER_URL, model: process.env.WIZARD_ROUTER_MODEL, key: process.env.WIZARD_ROUTER_KEY || '',
} : null
const settingsPath = process.env.WIZARD_SETTINGS_PATH || resolve(osHome, 'settings.json')
// The Serve listener: Tailscale Serve (https://<box>.<tailnet>.ts.net/) forwards here, and only here. Every
// request on it is verified as the owner's tailnet identity, whatever WIZARD_AUTH_MODE says about the
// box-local listener above. Unset: no tailnet listener (computer-only use).
const tailnetPort = process.env.WIZARD_TAILNET_PORT ? Number(process.env.WIZARD_TAILNET_PORT) : 0
if (process.env.WIZARD_TAILNET_PORT && (!Number.isInteger(tailnetPort) || tailnetPort < 1 || tailnetPort > 65535 || tailnetPort === port)) {
  process.stderr.write('WIZARD_TAILNET_PORT must be a free TCP port other than WIZARD_PORT; the service was not started.\n')
  process.exit(1)
}
let server
// In a container, Tailscale Serve on the box reaches the published 127.0.0.1 port and the request arrives
// from the container network's gateway; on a bare box it arrives from loopback. Origin and owner login come
// from WIZARD_TAILNET_ORIGIN / WIZARD_TAILNET_LOGIN, else from settings access.tailscale (written by
// "Connect your phone"), read per request.
const tailnetVerifier = authMode === 'tailscale' || tailnetPort ? createSettingsTailnetVerifier({
  origin: process.env.WIZARD_TAILNET_ORIGIN,
  logins: process.env.WIZARD_TAILNET_LOGIN,
  settings: () => readSettings(settingsPath).settings.access.tailscale,
  proxyPeers: [...['127.0.0.1', '::1'], ...(container ? [process.env.WIZARD_TAILNET_PROXY_PEER || containerGateway()] : [])].filter(Boolean),
  // Opening the shared address from another app (a cross-site top-level navigation) may land on these entry pages.
  appPaths: [...new Set(['/', '/wizard', '/wizard/', `/${String(process.env.WIZARD_UX_PREFIX || 'wizard-os-home').replace(/^\/+|\/+$/gu, '')}/`])],
  onVerified: (request) => server?.phoneSetup?.noteOwnerRequest(request),
}) : null
const accessVerifier = authMode === 'tailscale' ? tailnetVerifier : authMode === 'cloudflare' ? createCloudflareAccessVerifier({
  teamDomain: process.env.WIZARD_ACCESS_TEAM_DOMAIN,
  audience: process.env.WIZARD_ACCESS_AUDIENCE,
  jwksUrl: process.env.WIZARD_ACCESS_JWKS_URL,
}) : undefined
server = createWizardServer({
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
  helperContinueOrigins: (process.env.WIZARD_HELPER_CONTINUE_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  accessVerifier,
  ...(tailnetVerifier ? { tailnetVerifier } : {}),
  tailnetShellOrigin: process.env.WIZARD_TAILNET_SHELL_ORIGIN || '',
  privateAccessSocket: process.env.WIZARD_PRIVATE_ACCESS_SOCKET || '',
  tailnetAccessPinned: Boolean(tailnetVerifier?.pinned),
  operatorWorkerModel: 'glm-5-3',
  joinedDelegation,
  settingsPath,
  appsJsonPath: process.env.WIZARD_APPS_JSON_PATH || resolve(osHome, 'apps.json'),
  launcherPath: process.env.WIZARD_LAUNCHER_PATH || resolve(osHome, 'launcher.json'),
  subjectsPath: process.env.WIZARD_SUBJECTS_PATH || resolve(osHome, 'subjects.json'),
  uxDir: process.env.WIZARD_UX_DIR || '',
  // Headless Agent Service behind a separate shell container: keep the shell's sidecar API paths.
  uxApiCompat: process.env.WIZARD_UX_API_COMPAT === '1',
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
if (tailnetPort) {
  createTailnetIngress(server).listen(tailnetPort, host, () => process.stdout.write(`Wizard tailnet listener on ${host}:${tailnetPort}\n`))
}
