// Agents (wizard-os spec/AGENTS.md): more than one agent on a box.
//
// The registry is the folder `<agentsDir>/<id>/agent.json` (schema 1). The main agent is the host Hermes the
// Service already talks to and is always listed as `hermes`. Every other agent runs in its own container with its
// own Hermes home (`<id>/home`, its HERMES_HOME), its own API key (`<id>/runtime.key`) and its own model route.
// The Service never touches Docker: a runtime driver (agent-runtime helper on the host, see ops/agent-runtime)
// installs, starts and stops the container.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readSettings } from './wizard-os-settings.mjs'
import { migrateJson, threadKey, threadReference } from './thread-reference.mjs'

export const AGENT_SCHEMA = 1
export const MAIN_AGENT_ID = 'hermes'
const ID_RE = /^[a-z][a-z0-9-]{0,30}$/u
const RESERVED = new Set([MAIN_AGENT_ID, 'main', 'default', 'new', 'options'])
export const FILES_LEVELS = ['none', 'own', 'shared-read', 'shared-write']
export const OTHER_AGENTS_LEVELS = ['none', 'titles', 'search', 'read']
export const HARNESSES = [{ id: 'hermes', label: 'Hermes' }]
// Harness toolsets that send content off the box. Everything not granted is disabled in the agent's config.
export const OUTSIDE_TOOLS = [
  { id: 'web', label: 'Web search and pages' },
  { id: 'search', label: 'Web search' },
  { id: 'browser', label: 'Browser' },
  { id: 'x_search', label: 'X search' },
  { id: 'vision', label: 'Image understanding (public model)' },
  { id: 'video', label: 'Video understanding (public model)' },
  { id: 'image_gen', label: 'Image generation' },
  { id: 'video_gen', label: 'Video generation' },
  { id: 'tts', label: 'Text to speech' },
  { id: 'delegation', label: 'Helpers on a public model' },
  { id: 'connections', label: 'Remote connectors' },
  { id: 'homeassistant', label: 'Home Assistant' },
  { id: 'spotify', label: 'Spotify' },
]
const OUTSIDE_IDS = new Set(OUTSIDE_TOOLS.map((tool) => tool.id))
// Toolsets that touch files; `files: none` turns them off as well.
const FILE_TOOLSETS = ['file', 'terminal', 'code_execution']
// Tinfoil chat models an agent may be allowed to use.
export const TINFOIL = {
  id: 'tinfoil', label: 'Tinfoil (confidential)', confidential: true,
  models: [{ id: 'glm-5-3', label: 'GLM 5.3' }, { id: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash' }],
}
// Hermes must leave its default reasoning effort off these Tinfoil models' requests: DeepSeek V4.1 Flash on Tinfoil
// rejects "medium" (HTTP 400 chat_template_kwargs). Written into the agent's config.yaml as model_overrides.
export const TINFOIL_NO_REASONING = new Set(['deepseek-v4-1-flash'])
export const LOCAL = { id: 'local', label: 'This box (local model)', confidential: true, models: [] }
// Providers that the AI Accounts app signs in. Offered for standard agents only.
const AI_ACCOUNTS = new Map([['anthropic', 'Claude (AI Accounts)'], ['openai-codex', 'ChatGPT (AI Accounts)']])
export const PRESETS = [
  {
    id: 'private', label: 'Private',
    summary: 'Confidential model only, no fallback, no outside tools, only its own files, no apps.',
    privacy: 'private',
    permissions: { outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [], other_agents: 'none' },
  },
  {
    id: 'standard', label: 'Standard',
    summary: 'Hermes defaults: outside tools on, shared files, apps you pick.',
    privacy: 'standard',
    permissions: { outside_tools: OUTSIDE_TOOLS.map((tool) => tool.id), files: 'shared-write', wizard_apps: [], agent_apps: [], other_agents: 'none' },
  },
]
const PRESET = new Map(PRESETS.map((preset) => [preset.id, preset]))
export const DEFAULT_APPEARANCE = { private: { glyph: 'lock', hue: 160 }, standard: { glyph: 'spark', hue: 265 } }
const GLYPH_RE = /^[a-z][a-z0-9-]{0,23}$/u

export class AgentError extends Error {
  constructor(status, error, check, detail) {
    super(detail || error)
    this.status = status
    this.error = error
    this.check = check
    this.detail = detail
  }
  get payload() { return { error: this.error, check: this.check, ...(this.detail ? { detail: this.detail } : {}) } }
}
const fail = (status, error, check, detail) => { throw new AgentError(status, error, check, detail) }

function cleanLabel(value, fallback = '') {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ').trim().slice(0, 40) : ''
  return text || fallback
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJsonAtomic(path, value, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(tmp, path)
}

function writeTextAtomic(path, text, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

export function isConfidentialProvider(provider) {
  return provider === TINFOIL.id || provider === LOCAL.id
}

function normalizeAppearance(value, privacy) {
  const base = DEFAULT_APPEARANCE[privacy] ?? DEFAULT_APPEARANCE.standard
  const glyph = typeof value?.glyph === 'string' && GLYPH_RE.test(value.glyph) ? value.glyph : base.glyph
  const hue = Number.isInteger(value?.hue) && value.hue >= 0 && value.hue < 360 ? value.hue : base.hue
  return { glyph, hue }
}

function idList(value, check) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64 || !value.every((item) => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(item))) {
    fail(400, 'invalid_permissions', check)
  }
  return [...new Set(value)]
}

/** Merge a permissions patch onto a base, validating every field. */
export function normalizePermissions(base, patch = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'invalid_permissions', 'agent.permissions')
  const out = { ...base }
  const outside = idList(patch.outside_tools, 'agent.permissions.outside_tools')
  if (outside) {
    const unknown = outside.filter((id) => !OUTSIDE_IDS.has(id))
    if (unknown.length) fail(400, 'invalid_permissions', 'agent.permissions.outside_tools', `unknown outside tool: ${unknown[0]}`)
    out.outside_tools = outside
  }
  if (patch.files !== undefined) {
    if (!FILES_LEVELS.includes(patch.files)) fail(400, 'invalid_permissions', 'agent.permissions.files')
    out.files = patch.files
  }
  const wizardApps = idList(patch.wizard_apps, 'agent.permissions.wizard_apps')
  if (wizardApps) out.wizard_apps = wizardApps
  const agentApps = idList(patch.agent_apps, 'agent.permissions.agent_apps')
  if (agentApps) out.agent_apps = agentApps
  if (patch.other_agents !== undefined) {
    if (!OTHER_AGENTS_LEVELS.includes(patch.other_agents)) fail(400, 'invalid_permissions', 'agent.permissions.other_agents')
    out.other_agents = patch.other_agents
  }
  return out
}

/** The private preset's walls hold whatever the owner adjusts, unless they downgrade the agent on purpose. */
function assertPrivateWalls(agent) {
  if (agent.privacy !== 'private') return
  if (!isConfidentialProvider(agent.model.provider)) fail(409, 'confidential_provider_required', 'agent.confidential_provider')
  if (agent.model.fallback) fail(409, 'fallback_not_allowed', 'agent.fallback')
}

function validateModel(model, providers, { privacy, confirmDowngrade = false } = {}) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) fail(400, 'invalid_model', 'agent.model')
  const provider = providers.find((item) => item.id === model.provider)
  if (!provider) fail(400, 'unknown_provider', 'agent.model.provider')
  if (privacy === 'private' && !provider.confidential && !confirmDowngrade) fail(409, 'confidential_provider_required', 'agent.confidential_provider')
  const known = provider.models.map((item) => item.id)
  if (typeof model.model !== 'string' || !known.includes(model.model)) fail(400, 'unknown_model', 'agent.model.model')
  let allowed = model.allowed_models === undefined ? [model.model] : model.allowed_models
  if (!Array.isArray(allowed) || !allowed.length || !allowed.every((id) => typeof id === 'string' && known.includes(id))) {
    fail(400, 'invalid_allowed_models', 'agent.model.allowed_models')
  }
  allowed = [...new Set(allowed)]
  if (!allowed.includes(model.model)) fail(400, 'invalid_allowed_models', 'agent.model.allowed_models')
  const fallback = model.fallback === true
  return { provider: provider.id, model: model.model, allowed_models: allowed, fallback }
}

export function publicAgent(agent, status = { status: 'stopped', status_detail: '' }, defaultAgentId = MAIN_AGENT_ID) {
  return {
    id: agent.id,
    label: agent.label,
    harness: agent.harness,
    privacy: agent.privacy,
    appearance: agent.appearance,
    model: { provider: agent.model.provider, model: agent.model.model, allowed_models: [...agent.model.allowed_models], fallback: agent.model.fallback },
    permissions: { ...agent.permissions, outside_tools: [...agent.permissions.outside_tools], wizard_apps: [...agent.permissions.wizard_apps], agent_apps: [...agent.permissions.agent_apps] },
    status: status.status,
    status_detail: status.status_detail ?? '',
    is_default: agent.id === defaultAgentId,
    ...(agent.role === 'recovery' ? { role: 'recovery' } : {}),
    // Lets clients order several private agents the way the Agent Service routes a model to them (agentForModel).
    created_at: Number.isFinite(agent.created_at) ? agent.created_at : null,
  }
}

/**
 * Unified Chats routing: the agent that owns a model picked in the owner's Chats. Only a confidential provider's
 * model routes away from the main agent, and only to a private agent that allows it. Several candidates: the oldest
 * agent wins (created_at, then id), so the choice is the same on every request.
 */
export function agentForModel(agents, route) {
  const model = typeof route?.model === 'string' ? route.model.trim() : ''
  const provider = typeof route?.provider === 'string' ? route.provider.trim() : ''
  if (!model || !isConfidentialProvider(provider)) return null
  return agents
    .filter((agent) => agent && agent.role !== 'recovery' && agent.id !== MAIN_AGENT_ID && agent.privacy === 'private'
      && agent.model?.provider === provider && Array.isArray(agent.model.allowed_models) && agent.model.allowed_models.includes(model))
    .sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || String(a.id).localeCompare(String(b.id)))[0] ?? null
}

export function threadAgent(agent) {
  return { id: agent.id, label: agent.label, privacy: agent.privacy, appearance: agent.appearance, ...(agent.role === 'recovery' ? { role: 'recovery' } : {}) }
}

/** Validate a stored agent.json. Returns null for anything that is not a schema-1 agent (e.g. other experiments). */
export function parseAgentFile(value, id) {
  if (!value || typeof value !== 'object' || value.schema !== AGENT_SCHEMA || value.id !== id || !ID_RE.test(id) || id === MAIN_AGENT_ID) return null
  if (value.harness !== 'hermes' || !['private', 'standard'].includes(value.privacy)) return null
  if (value.role !== undefined && value.role !== 'standard') return null
  const model = value.model
  if (!model || typeof model.provider !== 'string' || typeof model.model !== 'string' || !Array.isArray(model.allowed_models)) return null
  const permissions = value.permissions
  if (!permissions || typeof permissions !== 'object') return null
  const runtime = value.runtime
  if (!runtime || runtime.kind !== 'container' || typeof runtime.app_id !== 'string' || !Number.isInteger(runtime.port)) return null
  try {
    const { preset, ...fields } = permissions
    return {
      ...value,
      label: cleanLabel(value.label, id),
      appearance: normalizeAppearance(value.appearance, value.privacy),
      model: { provider: model.provider, model: model.model, allowed_models: model.allowed_models.filter((m) => typeof m === 'string'), fallback: model.fallback === true },
      permissions: {
        preset: PRESET.has(preset) ? preset : 'standard',
        ...normalizePermissions({ outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [], other_agents: 'none' }, fields),
      },
    }
  } catch { return null }
}

function yamlString(value) { return JSON.stringify(String(value)) }

/** The apps an agent may use through the app gateway (#58): its Wizard apps plus its agent apps. */
export function agentAppIds(agent) {
  return new Set([...(agent?.permissions?.wizard_apps ?? []), ...(agent?.permissions?.agent_apps ?? [])])
}

/**
 * Whether the agent's harness gets the box's app gateway (/wizard/mcp). A standard agent always does (apps added
 * later appear without a restart); a private agent only once the owner ticks an app for it.
 */
/** What a restricted agent's harness calls: its edge sidecar, which forwards to the Service's agent-only listener. */
export const RESTRICTED_GATEWAY_URL = 'http://edge:8923/wizard/mcp'
const UPLINK_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/28$/u

/**
 * The restricted runtime has no Tinfoil attestation sidecar yet, so an agent on Tinfoil cannot run there. Refuse the
 * combination up front instead of starting an agent whose model route does not exist.
 */
export function assertIsolationSupports(agent) {
  if (agent.runtime?.isolation === 'restricted' && agent.model?.provider === TINFOIL.id) {
    fail(409, 'restricted_provider_unsupported', 'agent.runtime.isolation', 'the restricted runtime has no Tinfoil attestation sidecar yet')
  }
}

export function wantsGateway(agent, gatewayUrl) {
  if (!gatewayUrl) return false
  return agent.privacy === 'standard' || agentAppIds(agent).size > 0
}

/** Harness config for a container Hermes. The file is Service-owned; the owner edits the agent through the API. */
export function hermesConfigYaml(agent, { tinfoilUrl = '', contextLength = 0, gatewayUrl = '' } = {}) {
  // The attestation proxy sidecar, named per agent (agent_runtime.py service_names).
  tinfoilUrl = tinfoilUrl || `http://agent-${agent.id}-tinfoil:3301/v1`
  const granted = new Set(agent.permissions.outside_tools)
  const disabled = OUTSIDE_TOOLS.map((tool) => tool.id).filter((id) => !granted.has(id))
  if (agent.permissions.files === 'none') disabled.push(...FILE_TOOLSETS)
  const lines = [
    '# Managed by the Wizard OS Agent Service from agents/<id>/agent.json. Change the agent in the Agents app;',
    '# edits here are overwritten.',
    'model:',
    `  default: ${yamlString(agent.model.model)}`,
  ]
  if (agent.model.provider === TINFOIL.id) {
    lines.push('  provider: custom', `  base_url: ${yamlString(tinfoilUrl)}`, '  api_key: ${TINFOIL_API_KEY}')
    if (contextLength > 0) lines.push(`  context_length: ${Math.floor(contextLength)}`)
  } else if (agent.model.provider === LOCAL.id) {
    lines.push('  provider: custom', '  base_url: ${WIZARD_LOCAL_MODEL_URL}', '  api_key: ${WIZARD_LOCAL_MODEL_KEY}')
  } else {
    lines.push(`  provider: ${yamlString(agent.model.provider)}`)
  }
  if (!agent.model.fallback) lines.push('fallback_providers: []')
  // Per-model capability patches for the agent's own (custom) Tinfoil route, only for models it may use.
  const overrides = agent.model.provider === TINFOIL.id
    ? [...TINFOIL_NO_REASONING].filter((id) => (agent.model.allowed_models ?? [agent.model.model]).includes(id)) : []
  if (overrides.length) {
    lines.push('model_overrides:', '  custom:', ...overrides.flatMap((id) => [`    ${yamlString(id)}:`, '      supports_reasoning: false']))
  }
  lines.push('agent:', `  disabled_toolsets: [${disabled.map(yamlString).join(', ')}]`)
  // agent.disabled_toolsets is applied last for every platform, the API server included (hermes_cli/tools_config).
  // The app gateway serves this agent only the apps on its own list (#58), keyed by its own gateway token.
  // No gateway and no shared skills for an agent without one: nothing outside its own home is reachable.
  if (wantsGateway(agent, gatewayUrl)) {
    lines.push('mcp_servers:', '  wizard:', `    url: ${yamlString(gatewayUrl)}`, '    headers:', '      Authorization: "Bearer ${WIZARD_MCP_TOKEN}"')
  } else if (!agentAppIds(agent).size) lines.push('mcp_servers: {}')
  lines.push('memory:', '  memory_enabled: true', '  user_profile_enabled: true')
  return `${lines.join('\n')}\n`
}

export function agentEnvFile({ apiKey, gatewayKey = '' }) {
  return [
    '# Managed by the Wizard OS Agent Service. Secrets for this agent only; the runtime adds provider keys below.',
    `API_SERVER_KEY=${apiKey}`,
    'API_SERVER_HOST=0.0.0.0',
    'API_SERVER_PORT=8642',
    ...(gatewayKey ? [`WIZARD_MCP_TOKEN=${gatewayKey}`] : []),
    '',
  ].join('\n')
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export const GRANT_SCOPES = ['titles', 'search', 'read']
/** #59: a private agent is never a readable source. */
const sealed = (detail) => fail(409, 'private_agent_sealed', 'agent.private_sealed', detail)

/**
 * The registry. `runtime` is the driver ({ apply(id), start(id), stop(id) } -> Promise), or null when the box
 * has none (then creating or starting an agent fails with check `agent.runtime`).
 */
export function createAgentRegistry(options = {}) {
  const agentsDir = resolve(String(options.agentsDir))
  const fetchImpl = options.fetchImpl ?? fetch
  const runtime = options.runtime ?? null
  const upstreamMode = options.upstreamMode === 'network' ? 'network' : 'host'
  const upstreamHost = options.upstreamHost || '127.0.0.1'
  const basePort = Number.isInteger(options.basePort) ? options.basePort : 18650
  const mainLabel = cleanLabel(options.mainLabel, 'Hermes')
  const mainProviders = options.mainProviders ?? (async () => [])
  const appsJsonPath = options.appsJsonPath ? resolve(String(options.appsJsonPath)) : ''
  const now = options.now ?? (() => Date.now())
  const startingGraceMs = options.startingGraceMs ?? 180_000
  const threadsPath = join(agentsDir, '.threads.json')
  const idempotencyPath = join(agentsDir, '.idempotency.json')
  // #58: the main agent's app lists (absent = every installed app, its access before #58) and the apps already
  // offered to agents, so an app that appears in apps.json later is added to standard agents only.
  const mainPath = join(agentsDir, '.main-agent.json')
  const appsSeenPath = join(agentsDir, '.apps-seen.json')
  // #59: agent-data grants (reader -> source); a private source is refused.
  const grantsPath = join(agentsDir, '.agent-grants.json')
  const gatewayUrl = typeof options.gatewayUrl === 'string' ? options.gatewayUrl : ''
  // Restricted runtime (wizard-app-store runtimes/restricted-agent): new container agents get their own uplink and
  // sandbox networks and reach the Service only through their edge sidecar, which forwards to the agent-only listener.
  const isolation = options.isolation === 'restricted' ? 'restricted' : ''
  const restricted = (agent) => agent?.runtime?.isolation === 'restricted'
  const gatewayUrlFor = (agent) => (restricted(agent) ? RESTRICTED_GATEWAY_URL : gatewayUrl)
  const appsChanged = () => { try { options.onAppsChanged?.() } catch { /* the gateway re-reads on its next call */ } }
  const statusCache = new Map()

  const listIds = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) : [])
  // The main agent is standard with every installed app ticked until the owner unticks one (#58, no regression).
  const mainApps = () => {
    const stored = readJson(mainPath)
    if (stored && stored.schema === 1) return { wizard_apps: listIds(stored.wizard_apps), agent_apps: listIds(stored.agent_apps) }
    const { wizardApps, agentApps } = installedApps()
    return { wizard_apps: wizardApps.map((app) => app.id), agent_apps: agentApps.map((app) => app.id) }
  }
  const mainAgent = () => ({
    schema: AGENT_SCHEMA, id: MAIN_AGENT_ID, label: readJson(mainPath)?.role === 'recovery' ? `${mainLabel} (system)` : mainLabel, harness: 'hermes', privacy: 'standard',
    ...(readJson(mainPath)?.role === 'recovery' ? { role: 'recovery' } : {}),
    appearance: normalizeAppearance(options.mainAppearance, 'standard'),
    model: { provider: 'host', model: '', allowed_models: [], fallback: true },
    permissions: { preset: 'standard', outside_tools: OUTSIDE_TOOLS.map((tool) => tool.id), files: 'shared-write', ...mainApps(), other_agents: 'none' },
    runtime: { kind: 'external' },
  })

  const folder = (id) => join(agentsDir, id)
  const readRaw = (id) => {
    if (id === MAIN_AGENT_ID) return mainAgent()
    if (typeof id !== 'string' || !ID_RE.test(id)) return null
    return parseAgentFile(readJson(join(folder(id), 'agent.json')), id)
  }
  const folderIds = () => {
    try { return readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() } catch { return [] }
  }
  const read = (id) => { syncApps(); return readRaw(id) }
  const canStartAgent = (id) => {
    const agent = readRaw(id)
    return Boolean(agent && agent.role !== 'recovery' && ['external', 'container'].includes(agent.runtime?.kind))
  }
  const defaultAgentId = () => readSettings(options.settingsPath, { canStartAgent }).settings.agents.default_agent_id
  const list = () => {
    syncApps()
    return [mainAgent(), ...folderIds().map(readRaw).filter(Boolean)]
  }

  // ---- #58: new apps join standard agents, never private ones ----
  let appsSignature = null
  function appsJsonSignature() {
    try { const st = statSync(appsJsonPath); return `${st.mtimeMs}:${st.size}:${st.ino}` } catch { return 'missing' }
  }
  function appKinds() {
    const { wizardApps, agentApps } = installedApps()
    return new Map([...wizardApps.map((app) => [app.id, 'wizard_apps']), ...agentApps.map((app) => [app.id, 'agent_apps'])])
  }
  /** Runs when apps.json changed: apps not seen before are ticked for every standard agent (the main one too). */
  function syncApps() {
    if (!appsJsonPath) return
    const signature = appsJsonSignature()
    if (signature === appsSignature) return
    appsSignature = signature
    if (signature === 'missing') return
    const kinds = appKinds()
    const current = [...kinds.keys()].sort()
    const seenFile = readJson(appsSeenPath)
    const seen = new Set(seenFile?.schema === 1 ? listIds(seenFile.apps) : current)
    const fresh = current.filter((id) => !seen.has(id))
    try {
      if (fresh.length) {
        for (const id of folderIds()) {
          const agent = readRaw(id)
          if (!agent || agent.privacy !== 'standard') continue
          const next = structuredClone(agent)
          for (const app of fresh) if (!agentAppIds(next).has(app)) next.permissions[kinds.get(app)].push(app)
          if (JSON.stringify(next.permissions) === JSON.stringify(agent.permissions)) continue
          writeHarnessFiles(next)
          writeJsonAtomic(join(folder(id), 'agent.json'), next, 0o600)
        }
        queueMicrotask(appsChanged)
        const stored = readJson(mainPath)
        if (stored?.schema === 1) {
          const apps = { wizard_apps: listIds(stored.wizard_apps), agent_apps: listIds(stored.agent_apps) }
          for (const app of fresh) if (!apps.wizard_apps.includes(app) && !apps.agent_apps.includes(app)) apps[kinds.get(app)].push(app)
          writeJsonAtomic(mainPath, { ...stored, schema: 1, ...apps })
        }
      }
      if (fresh.length || seenFile?.schema !== 1 || current.length !== seen.size || current.some((id) => !seen.has(id))) {
        mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
        writeJsonAtomic(appsSeenPath, { schema: 1, apps: current })
      }
    } catch { appsSignature = null }   // retry on the next read
  }

  /**
   * The app ids an agent may use through the gateway (#58). Unknown agent → empty. The main agent with no stored
   * choice → null (every app, exactly the gateway's behaviour before #58).
   */
  function allowedApps(agentId) {
    if (readRaw(agentId)?.role === 'recovery') return new Set()
    if (agentId === MAIN_AGENT_ID && readJson(mainPath)?.schema !== 1) { syncApps(); return null }
    const agent = read(agentId)
    return agent ? agentAppIds(agent) : new Set()
  }

  /** Which agents can use an app (the app's settings sheet / the install picker, #58). */
  function appAgents(appId) {
    const kind = appKinds().get(appId)
    if (!kind) fail(404, 'app_not_found', 'app.id')
    return {
      app_id: appId, kind,
      agents: list().filter(agent => agent.role !== 'recovery').map((agent) => ({ ...threadAgent(agent), enabled: agentAppIds(agent).has(appId), is_default: agent.id === defaultAgentId() })),
    }
  }

  /** Sets exactly which agents can use an app: ticked agents gain it, unticked agents lose it. */
  async function setAppAgents(appId, body) {
    const kind = appKinds().get(appId)
    if (!kind) fail(404, 'app_not_found', 'app.id')
    const ids = body?.agents
    if (!Array.isArray(ids) || ids.length > 64 || !ids.every((id) => typeof id === 'string')) fail(400, 'invalid_request', 'app.agents')
    const wanted = new Set(ids)
    const all = list().filter(agent => agent.role !== 'recovery')
    for (const id of wanted) if (!all.some((agent) => agent.id === id)) fail(404, 'agent_not_found', 'agent.id', id)
    for (const agent of all) {
      const has = agentAppIds(agent).has(appId)
      if (has === wanted.has(agent.id)) continue
      const lists = { wizard_apps: [...agent.permissions.wizard_apps], agent_apps: [...agent.permissions.agent_apps] }
      if (wanted.has(agent.id)) lists[kind].push(appId)
      else for (const key of ['wizard_apps', 'agent_apps']) lists[key] = lists[key].filter((id) => id !== appId)
      await update(agent.id, { permissions: lists })
    }
    return appAgents(appId)
  }

  // ---- #59: private agents are sealed ----
  const grants = () => {
    const stored = readJson(grantsPath)
    return Array.isArray(stored?.grants) ? stored.grants.filter((grant) => grant && typeof grant.id === 'string') : []
  }
  function addGrant(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'grant.body')
    if ((body.kind ?? 'agent-data') !== 'agent-data') fail(400, 'unknown_grant_kind', 'grant.kind')
    const reader = read(String(body.reader ?? ''))
    if (!reader) fail(404, 'agent_not_found', 'grant.reader')
    const source = read(String(body.source ?? ''))
    if (!source) fail(404, 'agent_not_found', 'grant.source')
    if (reader.role === 'recovery' || source.role === 'recovery') fail(409, 'recovery_agent_sealed', 'agent.recovery_sealed')
    if (source.privacy === 'private') sealed(`${source.id} is private; nothing can read it`)
    if (reader.id === source.id) fail(400, 'invalid_grant', 'grant.source')
    const scope = body.scope ?? 'titles'
    if (!GRANT_SCOPES.includes(scope)) fail(400, 'invalid_grant', 'grant.scope')
    const current = grants()
    const existing = current.find((grant) => grant.reader === reader.id && grant.source === source.id)
    const grant = { id: existing?.id ?? `grant_${randomBytes(6).toString('hex')}`, kind: 'agent-data', reader: reader.id, source: source.id, scope, created_at: Math.floor(now() / 1000) }
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
    writeJsonAtomic(grantsPath, { schema: 1, grants: [...current.filter((item) => item.id !== grant.id), grant] })
    return grant
  }
  function removeGrant(grantId) {
    const current = grants()
    if (!current.some((grant) => grant.id === grantId)) fail(404, 'grant_not_found', 'grant.id')
    writeJsonAtomic(grantsPath, { schema: 1, grants: current.filter((grant) => grant.id !== grantId) })
  }
  /**
   * What a reader may read of other agents: its `other_agents` level over every standard agent, plus explicit
   * grants. A private agent is never a source, whatever a stored grant or level says (#59).
   */
  function readableSources(readerId) {
    const reader = read(readerId)
    if (!reader || reader.role === 'recovery') return []
    const agents = list().filter(agent => agent.role !== 'recovery')
    const out = new Map()
    if (reader.permissions.other_agents !== 'none') {
      for (const agent of agents) if (agent.id !== reader.id && agent.privacy === 'standard') out.set(agent.id, reader.permissions.other_agents)
    }
    for (const grant of grants()) {
      if (grant.reader !== reader.id) continue
      const source = agents.find((agent) => agent.id === grant.source)
      if (!source || source.privacy !== 'standard' || source.id === reader.id) continue
      out.set(source.id, grant.scope)
    }
    return [...out.entries()].map(([source, scope]) => ({ source, scope }))
  }

  /** The agent whose own gateway token this is ('' when none). The main agent's token is the bridge's own. */
  function agentForGatewayToken(token) {
    if (!token) return ''
    for (const id of folderIds()) {
      const key = gatewayKey(id)
      if (key && safeEqual(key, token) && readRaw(id)) return id
    }
    return ''
  }
  const serviceState = (id) => readJson(join(folder(id), 'service-state.json')) ?? {}
  const writeServiceState = (id, patch) => {
    const next = { ...serviceState(id), ...patch }
    writeJsonAtomic(join(folder(id), 'service-state.json'), next)
    statusCache.delete(id)
    return next
  }
  const apiKey = (id) => {
    try { return readFileSync(join(folder(id), 'runtime.key'), 'utf8').trim() } catch { return '' }
  }
  const gatewayKey = (id) => {
    try { return readFileSync(join(folder(id), 'gateway.key'), 'utf8').trim() } catch { return '' }
  }
  const upstream = (agent) => {
    if (agent.id === MAIN_AGENT_ID) return null
    // A restricted agent is reached only through its edge relay, published on host loopback at its port.
    if (restricted(agent)) return `http://${upstreamHost}:${agent.runtime.port}`
    if (upstreamMode === 'network') {
      const url = new URL(String(agent.runtime.api || ''))
      if (url.protocol !== 'http:' || url.hostname !== agent.runtime.app_id || url.username || url.password || url.pathname !== '/') {
        throw new AgentError(502, 'agent_unreachable', 'agent.runtime.api')
      }
      return url.origin
    }
    return `http://${upstreamHost}:${agent.runtime.port}`
  }

  async function probe(agent, { fresh = false } = {}) {
    const cached = statusCache.get(agent.id)
    if (!fresh && cached && now() - cached.at < 3000) return cached.value
    const state = serviceState(agent.id)
    let value
    let healthy = false
    try {
      const response = await fetchImpl(`${upstream(agent)}/health`, { redirect: 'error', signal: AbortSignal.timeout(1500) })
      await response.body?.cancel().catch(() => undefined)
      healthy = response.ok
    } catch { healthy = false }
    if (healthy) value = { status: 'running', status_detail: '' }
    else if (state.desired === 'stopped') value = { status: 'stopped', status_detail: '' }
    else if (state.last_error) value = { status: 'error', status_detail: String(state.last_error).slice(0, 200) }
    else if (Number(state.started_at) && now() - Number(state.started_at) < startingGraceMs) value = { status: 'starting', status_detail: '' }
    else value = { status: 'error', status_detail: 'not_responding' }
    statusCache.set(agent.id, { at: now(), value })
    return value
  }

  async function status(agent, { fresh = false } = {}) {
    if (agent.id === MAIN_AGENT_ID) return options.mainStatus ? await options.mainStatus() : { status: 'running', status_detail: '' }
    return probe(agent, { fresh })
  }

  async function providers() {
    const out = [TINFOIL]
    if (Array.isArray(options.localModels) && options.localModels.length) out.push({ ...LOCAL, models: options.localModels.map((id) => ({ id, label: id })) })
    let main = []
    try { main = await mainProviders() } catch { main = [] }
    for (const item of Array.isArray(main) ? main : []) {
      const id = item?.slug ?? item?.id
      if (!AI_ACCOUNTS.has(id) || item.authenticated === false) continue
      const models = (Array.isArray(item.models) ? item.models : []).map((m) => (typeof m === 'string' ? m : m?.id)).filter((m) => typeof m === 'string' && m.length < 120).slice(0, 12)
      if (models.length) out.push({ id, label: AI_ACCOUNTS.get(id), confidential: false, models: models.map((m) => ({ id: m, label: m })) })
    }
    return out
  }

  function installedApps() {
    const apps = readJson(appsJsonPath)?.apps
    const wizardApps = []
    const agentApps = []
    for (const app of Array.isArray(apps) ? apps : []) {
      const id = typeof app?.id === 'string' ? app.id : ''
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) continue
      if (app.type === 'agent' || app.category === 'agent' || id.startsWith('agent-')) continue
      if (Array.isArray(app.provides) && app.provides.includes('shell')) continue
      const entry = { id, label: cleanLabel(app.name, id), summary: typeof app.summary === 'string' ? app.summary.slice(0, 160) : '', has_tools: Boolean(app.mcp) }
      const hasView = typeof app.view === 'string' || typeof app.view?.url === 'string'
      if (hasView) wizardApps.push(entry)
      else if (app.mcp) agentApps.push(entry)
    }
    return { wizardApps, agentApps }
  }

  async function agentOptions() {
    const { wizardApps, agentApps } = installedApps()
    return {
      harnesses: HARNESSES,
      providers: await providers(),
      presets: PRESETS.map((preset) => ({ id: preset.id, label: preset.label, summary: preset.summary, privacy: preset.privacy, permissions: preset.permissions })),
      wizard_apps: wizardApps,
      agent_apps: agentApps,
      outside_tools: OUTSIDE_TOOLS,
      files: FILES_LEVELS,
      other_agents: OTHER_AGENTS_LEVELS,
    }
  }

  function slugFor(label) {
    const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 24) || 'agent'
    const start = /^[a-z]/u.test(base) ? base : `agent-${base}`.slice(0, 24)
    let id = RESERVED.has(start) ? `${start}-agent` : start
    for (let n = 2; existsSync(folder(id)); n += 1) id = `${start}-${n}`
    return id
  }

  /** The lowest free /28 pair (uplink 10.250.x.y, sandbox 10.251.x.y); index 0 is left to conformance runs. */
  function nextNetwork() {
    const used = new Set(list().map((agent) => agent.runtime?.network?.uplink).filter((value) => typeof value === 'string'))
    for (let index = 1; index < 4096; index += 1) {
      const suffix = `${index >> 4}.${(index & 15) << 4}/28`
      if (!used.has(`10.250.${suffix}`)) return { uplink: `10.250.${suffix}`, sandbox: `10.251.${suffix}` }
    }
    fail(503, 'network_exhausted', 'agent.runtime.network')
  }

  /** The uplink subnet an agent's edge connects from ('' = this agent has no agent-only network). */
  function agentUplink(id) {
    const agent = read(id)
    const uplink = restricted(agent) ? agent.runtime?.network?.uplink : ''
    return typeof uplink === 'string' && UPLINK_RE.test(uplink) ? uplink : ''
  }

  /** Whether an agent runs in the restricted runtime (its key is then bound to the agent-only listener). */
  function agentRestricted(id) {
    try { return restricted(read(id)) } catch { return false }
  }

  function nextPort() {
    const used = new Set(list().map((agent) => agent.runtime?.port).filter(Number.isInteger))
    let port = basePort
    while (used.has(port)) port += 1
    return port
  }

  function writeHarnessFiles(agent, { rotateKey = false } = {}) {
    const dir = folder(agent.id)
    // A restricted agent owns its home (uid 10000, see ops/agent-runtime/restricted-agent): the Service writes the
    // files it manages to managed/, and the runtime driver copies them in before every start.
    const home = join(dir, restricted(agent) ? 'managed' : 'home')
    mkdirSync(home, { recursive: true, mode: 0o700 })
    if (restricted(agent)) mkdirSync(join(dir, 'home'), { recursive: true, mode: 0o700 })
    let key = rotateKey ? '' : apiKey(agent.id)
    if (!key) {
      key = randomBytes(32).toString('base64url')
      writeTextAtomic(join(dir, 'runtime.key'), `${key}\n`)
    }
    // The agent's own app-gateway token: the gateway serves this agent only its own apps (#58).
    let gateway = gatewayKey(agent.id)
    if (!gateway) {
      gateway = randomBytes(32).toString('base64url')
      writeTextAtomic(join(dir, 'gateway.key'), `${gateway}\n`)
    }
    // Provider keys (TINFOIL_API_KEY) are added by the runtime driver on the host; the Service never holds them.
    const agentGateway = gatewayUrlFor(agent)
    writeTextAtomic(join(home, '.env'), agentEnvFile({ apiKey: key, gatewayKey: wantsGateway(agent, agentGateway) ? gateway : '' }))
    writeTextAtomic(join(home, 'config.yaml'), hermesConfigYaml(agent, { tinfoilUrl: options.tinfoilUrl, contextLength: options.contextLength, gatewayUrl: agentGateway }))
  }

  const idempotency = () => readJson(idempotencyPath) ?? {}

  async function create(body, { idempotencyKey = '' } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'agent.body')
    if (body.role !== undefined && body.role !== 'standard') fail(409, 'invalid_agent_role', 'agent.role')
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    if (idempotencyKey) {
      if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey)) fail(400, 'invalid_idempotency_key', 'agent.idempotency_key')
      const seen = idempotency()[idempotencyKey]
      if (seen) {
        if (seen.hash !== requestHash) fail(409, 'idempotency_key_reused', 'agent.idempotency_key')
        const existing = read(seen.id)
        if (existing) return { agent: existing, replayed: true }
      }
    }
    if (!runtime) fail(503, 'runtime_unavailable', 'agent.runtime', 'this box has no agent runtime')
    const label = cleanLabel(body.label)
    if (!label) fail(400, 'label_required', 'agent.label')
    if ((body.harness ?? 'hermes') !== 'hermes') fail(400, 'unknown_harness', 'agent.harness')
    const presetId = body.permissions?.preset ?? 'standard'
    const preset = PRESET.get(presetId)
    if (!preset) fail(400, 'unknown_preset', 'agent.permissions.preset')
    const { preset: _ignored, ...overrides } = body.permissions ?? {}
    const permissions = { preset: preset.id, ...normalizePermissions(preset.permissions, overrides) }
    const model = validateModel(body.model, await providers(), { privacy: preset.privacy })
    if (preset.privacy === 'private' && model.fallback) fail(409, 'fallback_not_allowed', 'agent.fallback')
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
    const id = slugFor(label)
    const agent = {
      schema: AGENT_SCHEMA, id, label, harness: 'hermes', privacy: preset.privacy,
      appearance: normalizeAppearance(body.appearance, preset.privacy),
      model, permissions,
      runtime: {
        kind: 'container', app_id: `agent-${id}`, api: `http://agent-${id}:8642`, port: nextPort(), image: options.image || '',
        ...(isolation ? { isolation, network: nextNetwork() } : {}),
      },
      created_at: Math.floor(now() / 1000),
    }
    assertPrivateWalls(agent)
    assertIsolationSupports(agent)
    mkdirSync(folder(id), { recursive: false, mode: 0o700 })
    try {
      writeHarnessFiles(agent)
      writeJsonAtomic(join(folder(id), 'agent.json'), agent, 0o600)
    } catch (error) {
      rmSync(folder(id), { recursive: true, force: true })
      throw error
    }
    if (idempotencyKey) {
      const map = idempotency()
      map[idempotencyKey] = { hash: requestHash, id, at: now() }
      writeJsonAtomic(idempotencyPath, map)
    }
    writeServiceState(id, { desired: 'running', started_at: now(), last_error: '' })
    try { await runtime.apply(id) } catch (error) { writeServiceState(id, { last_error: runtimeError(error) }) }
    return { agent: read(id), replayed: false }
  }

  async function update(id, body) {
    const agent = read(id)
    if (!agent) fail(404, 'agent_not_found', 'agent.id')
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'agent.body')
    if (id === MAIN_AGENT_ID) {
      if (body.role !== undefined) {
        if (!['standard', 'recovery'].includes(body.role)) fail(400, 'invalid_agent_role', 'agent.role')
        if (Object.keys(body).some(key => key !== 'role')) fail(400, 'invalid_request', 'agent.body')
        if (body.role === 'recovery' && defaultAgentId() === MAIN_AGENT_ID) fail(409, 'recovery_cannot_be_default', 'agent.role')
        if (body.role === 'recovery' && options.isBindingTarget?.(MAIN_AGENT_ID)) fail(409, 'recovery_agent_bound', 'agent.recovery_sealed')
        if (body.role === 'recovery' && grants().some(grant => grant.reader === MAIN_AGENT_ID || grant.source === MAIN_AGENT_ID)) fail(409, 'recovery_agent_granted', 'agent.recovery_sealed')
        mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
        writeJsonAtomic(mainPath, { schema: 1, ...mainApps(), role: body.role })
        appsChanged()
        return read(id)
      }
      if (agent.role === 'recovery') fail(409, 'recovery_agent_sealed', 'agent.recovery_sealed')
      // Only which apps the main agent can use is set here (#58); the rest is configured in Hermes itself.
      const keys = Object.keys(body)
      const permKeys = Object.keys(body.permissions ?? {})
      if (keys.some((key) => key !== 'permissions') || !permKeys.length || permKeys.some((key) => !['wizard_apps', 'agent_apps'].includes(key))) {
        fail(409, 'main_agent_read_only', 'agent.main', 'the main agent is configured in Hermes itself; only its apps are set here')
      }
      const apps = normalizePermissions(agent.permissions, body.permissions)
      mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
      writeJsonAtomic(mainPath, { ...readJson(mainPath), schema: 1, wizard_apps: apps.wizard_apps, agent_apps: apps.agent_apps })
      appsChanged()
      return read(id)
    }
    if (body.role !== undefined && body.role !== 'standard') fail(409, 'invalid_agent_role', 'agent.role')
    if (agent.privacy === 'private') {
      // #59: nothing turns a private agent into something another agent can read.
      if (body.privacy !== undefined && body.privacy !== 'private') sealed('a private agent stays private')
      for (const key of ['readable_by', 'shared_with', 'sources']) if (body.permissions?.[key] !== undefined || body[key] !== undefined) sealed('a private agent is never a source')
      // An explicit downgrade would open its history to a public provider and to other agents: refused before
      // anything else. (Without it, a public provider is refused as before: agent.confidential_provider.)
      if (body.confirm_downgrade === true) sealed('a private agent cannot move to a public model')
    } else if (body.privacy !== undefined && body.privacy !== agent.privacy) fail(409, 'privacy_fixed', 'agent.privacy')
    const next = structuredClone(agent)
    if (body.label !== undefined) {
      next.label = cleanLabel(body.label)
      if (!next.label) fail(400, 'label_required', 'agent.label')
    }
    if (body.appearance !== undefined) next.appearance = normalizeAppearance(body.appearance, next.privacy)
    if (body.permissions !== undefined) {
      const { preset, ...rest } = body.permissions ?? {}
      if (preset !== undefined && preset !== agent.permissions.preset) fail(409, 'preset_fixed', 'agent.permissions.preset', 'adjust fields instead of switching preset')
      next.permissions = { preset: agent.permissions.preset, ...normalizePermissions(agent.permissions, rest) }
    }
    if (body.model !== undefined) {
      const confirm = body.confirm_downgrade === true
      next.model = validateModel({ ...agent.model, ...body.model, allowed_models: body.model?.allowed_models ?? (body.model?.model && body.model.model !== agent.model.model ? undefined : agent.model.allowed_models) }, await providers(), { privacy: agent.privacy, confirmDowngrade: confirm })
      if (agent.privacy === 'private' && !isConfidentialProvider(next.model.provider)) {
        // #59: a downgrade would open the private agent's history to other agents. It stays private; move what the
        // owner approves into a standard agent instead (the private agent publishes copies, spec/AGENTS.md 6).
        sealed('a private agent cannot move to a public model')
      }
    }
    assertPrivateWalls(next)
    assertIsolationSupports(next)
    const harnessChanged = JSON.stringify([agent.model, agent.permissions]) !== JSON.stringify([next.model, next.permissions])
    if (JSON.stringify([...agentAppIds(agent)]) !== JSON.stringify([...agentAppIds(next)])) queueMicrotask(appsChanged)
    if (harnessChanged) writeHarnessFiles(next)
    writeJsonAtomic(join(folder(id), 'agent.json'), next, 0o600)
    if (harnessChanged && runtime && serviceState(id).desired !== 'stopped') {
      writeServiceState(id, { started_at: now(), last_error: '' })
      try { await runtime.apply(id) } catch (error) { writeServiceState(id, { last_error: runtimeError(error) }) }
    }
    return read(id)
  }

  async function setRunning(id, running) {
    const agent = read(id)
    if (!agent) fail(404, 'agent_not_found', 'agent.id')
    if (id === MAIN_AGENT_ID) fail(409, 'main_agent_read_only', 'agent.main')
    if (!runtime) fail(503, 'runtime_unavailable', 'agent.runtime')
    writeServiceState(id, running ? { desired: 'running', started_at: now(), last_error: '' } : { desired: 'stopped', last_error: '' })
    try { await (running ? runtime.start(id) : runtime.stop(id)) } catch (error) { writeServiceState(id, { last_error: runtimeError(error) }) }
    return agent
  }

  // Qualified pins. A legacy id->agent entry already contains an explicit agent: preserve it, not today's default.
  migrateJson(threadsPath, value => {
    if (value.schema === 2) return value
    if (value.schema !== 1 || !value.threads || typeof value.threads !== 'object') throw new Error('Invalid thread pins')
    return { schema: 2, threads: Object.fromEntries(Object.entries(value.threads).map(([id, agent]) => {
      const pair = threadReference(id, typeof agent === 'string' && agent ? agent : MAIN_AGENT_ID)
      return [threadKey(pair.agent_id, id), pair]
    })) }
  })
  let pinsCache = null
  const pins = () => {
    if (!pinsCache) pinsCache = readJson(threadsPath)?.threads ?? {}
    return pinsCache
  }
  function pinnedAgents(sessionId) {
    return Object.values(pins()).filter(row => row.session_id === sessionId).map(row => row.agent_id)
  }
  function pinnedAgent(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return ''
    const ids = pinnedAgents(sessionId)
    if (ids.length > 1) fail(409, 'ambiguous_thread', 'agent.ambiguous_thread')
    return ids[0] ?? ''
  }
  function pin(sessionId, agentId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !readRaw(agentId)) return
    const current = pins()
    const key = threadKey(agentId, sessionId)
    if (current[key]) return
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
    const next = { ...current, [key]: threadReference(sessionId, agentId) }
    writeJsonAtomic(threadsPath, { schema: 2, threads: next })
    pinsCache = next
  }
  const runsPath = join(agentsDir, '.run-threads.json')
  const runs = new Map(Object.entries(readJson(runsPath)?.runs ?? {}))
  function noteRun(runId, agentId, sessionId = '') {
    if (typeof runId !== 'string' || !runId) return
    const rows = runs.get(runId) ?? []
    if (rows.some(row => row.agent_id === agentId && row.session_id === sessionId)) return
    if (!sessionId || !readRaw(agentId)) return
    const next = new Map(runs)
    next.set(runId, [...rows.filter(row => row.agent_id !== agentId), { run_id: runId, ...threadReference(sessionId, agentId) }])
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
    writeJsonAtomic(runsPath, { schema: 1, runs: Object.fromEntries(next) })
    runs.set(runId, next.get(runId))
  }
  const runAgents = runId => (runs.get(runId) ?? []).map(row => row.agent_id)

  return {
    agentsDir, list, read, status, upstream, apiKey, agentOptions, providers, create, update, setRunning,
    pinnedAgent, pinnedAgents, pin, runAgents, runAgent: runId => { const ids = runAgents(runId); if (ids.length > 1) fail(409, 'ambiguous_thread', 'agent.ambiguous_thread'); return ids[0] ?? '' }, noteRun, defaultAgentId, canStartAgent,
    agentForModel: (route) => agentForModel(list(), route),
    syncApps, allowedApps, appAgents, setAppAgents, agentForGatewayToken, agentUplink, agentRestricted,
    grants, addGrant, removeGrant, readableSources,
    publicAgent: async (agent) => publicAgent(agent, await status(agent), defaultAgentId()),
    threadAgent: (agentOrId) => {
      const agent = typeof agentOrId === 'string' ? read(agentOrId) : agentOrId
      return agent ? threadAgent(agent) : null
    },
  }
}

function runtimeError(error) {
  const text = String(error?.code || error?.message || 'runtime_failed')
  return /^[a-z0-9_.:-]{1,80}$/iu.test(text) ? text : 'runtime_failed'
}

/** HTTP client for the host agent-runtime helper (ops/agent-runtime). Bounded symbolic errors only. */
export function createRuntimeClient({ url, token, fetchImpl = fetch, timeoutMs = 600_000 }) {
  const base = new URL(String(url))
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(base.hostname) && !/^[a-z][a-z0-9-]*$/u.test(base.hostname)) {
    throw new Error('agent runtime must be a loopback or box-network http address')
  }
  const call = async (method, path, payload = {}) => {
    let response
    try {
      response = await fetchImpl(new URL(path, base), {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(payload) : undefined,
      })
    } catch { throw Object.assign(new Error('runtime_unreachable'), { code: 'runtime_unreachable' }) }
    let reply = {}
    try { reply = await response.json() } catch { reply = {} }
    if (!response.ok) {
      const code = typeof reply?.error === 'string' && /^[a-z0-9_.:-]{1,80}$/iu.test(reply.error) ? reply.error : `runtime_http_${response.status}`
      throw Object.assign(new Error(code), { code })
    }
    return reply
  }
  return {
    apply: (id) => call('POST', `/agents/${encodeURIComponent(id)}/apply`),
    start: (id) => call('POST', `/agents/${encodeURIComponent(id)}/start`),
    stop: (id) => call('POST', `/agents/${encodeURIComponent(id)}/stop`),
    deliver: (id, payload) => call('POST', `/agents/${encodeURIComponent(id)}/deliver`, payload),
  }
}
