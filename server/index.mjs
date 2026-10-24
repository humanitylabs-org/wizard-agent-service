import { defaultKeeperSocket } from './run-stream-keeper.mjs'
import { createCloudflareAccessVerifier, createTailnetIngress, createWizardServer } from './service.mjs'
import { containerGateway, createTailnetAccessVerifier, createSettingsTailnetVerifier } from './tailnet-access.mjs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { readSettings, wizardOsHome } from './wizard-os-settings.mjs'
import { readFileSync } from 'node:fs'

const secretFile = (path) => {
  if (!path) return ''
  try { return readFileSync(path, 'utf8').trim() } catch { return '' }
}

if (process.env.WIZARD_AGENT_PORT || process.env.WIZARD_AGENT_HOST) {
  process.stderr.write('WIZARD_AGENT_PORT/HOST are retired; remove them. Restricted agents use Unix sockets.\n')
  process.exit(1)
}

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
const list = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
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
// Owner proof: a secret the trusted front proxy adds only after it authenticated the owner. Behind such a
// gateway (auth mode none) it is what tells the owner's own client apart from every other local caller.
let ownerProof = ''
if (process.env.WIZARD_OWNER_PROOF_FILE) {
  try { ownerProof = readFileSync(process.env.WIZARD_OWNER_PROOF_FILE, 'utf8').trim() } catch {
    process.stderr.write('WIZARD_OWNER_PROOF_FILE is set but unreadable; the service was not started.\n')
    process.exit(1)
  }
  if (ownerProof.length < 32) {
    process.stderr.write('The owner proof secret must be at least 32 characters; the service was not started.\n')
    process.exit(1)
  }
}
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
  helmAttachmentsRoot: process.env.WIZARD_HELM_ATTACHMENTS_ROOT || '',
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
  runKeeperSocket: defaultKeeperSocket(process.env, homedir()),
  runQueueStatePath: process.env.WIZARD_RUN_QUEUE_STATE_PATH || resolve(process.env.HERMES_HOME || resolve(homedir(), '.hermes'), 'state', 'wizard-mobile', 'run-queue.sqlite3'),
  schedulerStatePath: process.env.WIZARD_SCHEDULER_STATE_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'schedules.sqlite3'),
  schedulerHermesHome: process.env.HERMES_HOME || '',
  schedulerEnabled: process.env.WIZARD_SCHEDULER === '1',
  schedulerTimezone: process.env.WIZARD_SCHEDULER_TIMEZONE || undefined,
  runQueueMaxActive: Number(process.env.WIZARD_MAX_ACTIVE_THREADS || 8),
  runQueueInteractiveReserve: process.env.WIZARD_INTERACTIVE_RESERVED_SLOTS === undefined ? undefined : Number(process.env.WIZARD_INTERACTIVE_RESERVED_SLOTS),
  // Disabled unless explicitly provisioned by the owner; no credentials in tool arguments.
  heavyStatePath: process.env.WIZARD_HEAVY_STATE_PATH || '',
  heavyToken: process.env.WIZARD_HEAVY_TOKEN || '',
  agentHeavy: process.env.WIZARD_AGENT_HEAVY || 'off',
  heavyRpcOrigin: process.env.WIZARD_HEAVY_RPC_ORIGIN || '',
  heavyWorker: {
    host: process.env.WIZARD_BUILD_HOST || process.env.WIZARD_HEAVY_SSH_HOST,
    script: process.env.WIZARD_HEAVY_REMOTE_SCRIPT,
    root: process.env.WIZARD_HEAVY_REMOTE_ROOT,
    lock: process.env.WIZARD_HEAVY_REMOTE_LOCK,
    python: process.env.WIZARD_HEAVY_REMOTE_PYTHON || '/opt/homebrew/bin/python3',
  },
  requireAccess,
  ownerProof,
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
  appManagerUrl: process.env.WIZARD_APP_MANAGER_URL || '',
  appIndexUrl: process.env.WIZARD_APP_INDEX_URL || undefined,
  appManagerToken: process.env.WIZARD_APP_MANAGER_TOKEN || '',
  // Installed apps: trusted Host names (DNS-rebinding fence), the separate apps origin, the hosts app upstreams may
  // use (a container Service names its host gateway) and, optionally, the tailnet logins that count as the owner.
  allowedHosts: list(process.env.WIZARD_ALLOWED_HOSTS),
  appsOrigin: process.env.WIZARD_APPS_ORIGIN || '',
  appUpstreamHosts: list(process.env.WIZARD_APP_UPSTREAM_HOSTS),
  appOwnerLogins: list(process.env.WIZARD_APP_OWNER_LOGINS),
  appTrustedProxyIps: list(process.env.WIZARD_APP_TRUSTED_PROXY_IPS),
  appManagerHosts: list(process.env.WIZARD_APP_MANAGER_HOSTS),
  appReservedPorts: [port, Number(process.env.WIZARD_APPS_PORT || 0)].filter(Boolean),
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
  // Resumable uploads and shares (server/uploads.mjs). Size is bounded only by free disk minus the reserve.
  uploadStatePath: process.env.WIZARD_UPLOAD_STATE_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'uploads.sqlite3'),
  uploadStagingDir: process.env.WIZARD_UPLOAD_STAGING_DIR || resolve(hermesHome, 'state', 'wizard-mobile', 'upload-staging'),
  ...(process.env.WIZARD_UPLOAD_RESERVE_BYTES ? { uploadReserveBytes: Number(process.env.WIZARD_UPLOAD_RESERVE_BYTES) } : {}),
  ...(process.env.WIZARD_UPLOAD_MAX_BYTES ? { uploadMaxBytes: Number(process.env.WIZARD_UPLOAD_MAX_BYTES) } : {}),
  kernelJobMap: process.env.WIZARD_KERNEL_JOB_MAP === '1',
  filesRoot: process.env.WIZARD_FILES_ROOT || '',
  // The owner's user-files root on this host (Runtipi's media/ folder on a Wizard OS box). When set, an
  // upload created with a destination is placed there, and the Files app can list it. Separate from
  // WIZARD_MEDIA_ROOT, which moves chat attachments, and from WIZARD_FILES_ROOT, the agent's view of it.
  userFilesRoot: process.env.WIZARD_USER_FILES_ROOT || '',
  chatPhotos: {
    enabled: process.env.WIZARD_CHAT_PHOTOS_ENABLED === '1',
    statePath: process.env.WIZARD_CHAT_PHOTOS_STATE_PATH || '',
    ownerId: process.env.WIZARD_CHAT_PHOTOS_OWNER_ID || '',
    singleOwner: process.env.WIZARD_CHAT_PHOTOS_SINGLE_OWNER === '1',
    maxBytes: Number(process.env.WIZARD_CHAT_PHOTOS_MAX_BYTES || 0),
    ownerLabel: process.env.WIZARD_CHAT_PHOTOS_OWNER_LABEL || '',
    agentLabel: process.env.WIZARD_CHAT_PHOTOS_AGENT_LABEL || '',

  },
  userFilesIndexPath: process.env.WIZARD_USER_FILES_INDEX_PATH || '',
  // My skin: <Files root>/Skins/My skin/skin.css (legacy My skin.css still works), using the user-files
  // root, else media root. WIZARD_MY_SKIN_PATH names another file; WIZARD_MY_SKIN=off turns the layer off.
  mySkinPath: process.env.WIZARD_MY_SKIN_PATH || '',
  ...(process.env.WIZARD_MY_SKIN === 'off' ? { mySkin: false } : {}),
  appsMcpAddress: process.env.WIZARD_APPS_MCP_ADDRESS || 'url',
  // How /wizard/ai-usage reaches AI connection apps: 'local' (loopback; alongside boxes run the
  // service with host networking) or 'internal' (app hostnames on the container network).
  // Defaults to 'internal' when WIZARD_APPS_MCP_ADDRESS is 'internal', else 'local'.
  ...(process.env.WIZARD_AI_CONNECTION_ADDRESS ? { aiConnectionAddress: process.env.WIZARD_AI_CONNECTION_ADDRESS } : {}),
  // Agent bridge: gateway token ($WIZARD_MCP_TOKEN or <WIZARD_OS_HOME>/mcp-token) and the per-thread app snapshots.
  wizardOsHome: osHome,
  ...(process.env.WIZARD_MCP_TOKEN ? { mcpToken: process.env.WIZARD_MCP_TOKEN } : {}),
  ...(process.env.WIZARD_AGENT_BRIDGE === 'off' ? { agentBridge: false } : {}),
  // 'gateway': the app gateway for container agents only; the main agent's runs, skills and kernel stay as with 'off'.
  ...(process.env.WIZARD_AGENT_BRIDGE === 'gateway' ? { agentBridge: 'gateway' } : {}),
  threadAppsStatePath: process.env.WIZARD_THREAD_APPS_STATE_PATH || resolve(hermesHome, 'state', 'wizard-mobile', 'thread-apps.json'),
  appsSkillsInline: process.env.WIZARD_APPS_SKILLS_INLINE === '1',
  // A second Agent Service on the same Hermes (a staging copy beside the daily driver) sets this to 'off',
  // so only one service ever starts automatic follow-through turns on the shared threads.
  followThrough: process.env.WIZARD_FOLLOW_THROUGH !== 'off',
  // Agents (spec/AGENTS.md): folders under <WIZARD_OS_HOME>/agents; containers via the host agent-runtime helper.
  ...(process.env.WIZARD_AGENTS === 'off' ? { agents: false } : {}),
  ...(process.env.WIZARD_AGENTS_DIR ? { agentsDir: process.env.WIZARD_AGENTS_DIR } : {}),
  agentRuntimeUrl: process.env.WIZARD_AGENT_RUNTIME_URL || '',
  maintenanceExternalPath: process.env.WIZARD_MAINTENANCE_LEASE_PATH || '',
  agentRuntimeToken: process.env.WIZARD_AGENT_RUNTIME_TOKEN || secretFile(process.env.WIZARD_AGENT_RUNTIME_TOKEN_FILE),
  agentDeliveryToken: process.env.WIZARD_AGENT_DELIVERY_TOKEN || secretFile(process.env.WIZARD_AGENT_DELIVERY_TOKEN_FILE),
  agentUpstreamMode: process.env.WIZARD_AGENT_UPSTREAM === 'network' ? 'network' : 'host',
  agentUpstreamHost: process.env.WIZARD_AGENT_UPSTREAM_HOST || '127.0.0.1',
  ...(process.env.WIZARD_AGENT_BASE_PORT ? { agentBasePort: Number(process.env.WIZARD_AGENT_BASE_PORT) } : {}),
  ...(process.env.WIZARD_MAIN_AGENT_LABEL ? { mainAgentLabel: process.env.WIZARD_MAIN_AGENT_LABEL } : {}),
  // The app gateway as an agent container reaches it (e.g. http://wizard-agent-service:8923/wizard/mcp).
  agentGatewayUrl: process.env.WIZARD_AGENT_GATEWAY_URL || '',
  // A dedicated read-only transport can be configured without enabling the app gateway.
  standardChatsUrl: process.env.WIZARD_STANDARD_CHATS_URL || '',
  // New restricted agents reach the Service through their own Unix socket, never a TCP agent port.
  agentIsolation: process.env.WIZARD_AGENT_ISOLATION === 'restricted' ? 'restricted' : '',
})
await server.agentSocketsReady
server.listen(port, host, () => process.stdout.write(`Wizard listening on ${host}:${port}\n`))
if (tailnetPort) {
  createTailnetIngress(server).listen(tailnetPort, host, () => process.stdout.write(`Wizard tailnet listener on ${host}:${tailnetPort}\n`))
}
// The apps origin listener (serve it on its own HTTPS port, e.g. `tailscale serve --https=8444`): app documents only.
const appsPort = Number(process.env.WIZARD_APPS_PORT || 0)
if (appsPort) {
  if (!process.env.WIZARD_APPS_ORIGIN) {
    process.stderr.write('WIZARD_APPS_PORT needs WIZARD_APPS_ORIGIN (the public origin that reaches it).\n')
    process.exit(1)
  }
  createServer(server.appsHandler).listen(appsPort, host, () => process.stdout.write(`Wizard apps origin listening on ${host}:${appsPort}\n`))
}
