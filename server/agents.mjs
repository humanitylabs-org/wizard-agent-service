// Agents (wizard-os spec/AGENTS.md): more than one agent on a box.
//
// The registry is the folder `<agentsDir>/<id>/agent.json` (schema 1). The main agent is the host Hermes the
// Service already talks to and is always listed as `hermes`. Container agents have their own Hermes home and
// runtime driver; file-provisioned profile agents share the host gateway under /p/<profile> with their own key.
// Each non-main agent's API key is stored at `<id>/runtime.key`.
// The Service never touches Docker: a runtime driver (agent-runtime helper on the host, see ops/agent-runtime)
// installs, starts and stops the container.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readSettings } from './wizard-os-settings.mjs'
import { fetchAgentIngress } from './agent-ingress.mjs'
import { migrateJson, atomicStoreWrite, threadKey, threadReference, validAgentId } from './thread-reference.mjs'

export const AGENT_SCHEMA = 1
export const MAIN_AGENT_ID = 'hermes'
const ID_RE = /^[a-z][a-z0-9-]{0,30}$/u
const RESERVED = new Set([MAIN_AGENT_ID, 'main', 'default', 'new', 'options'])
export const FILES_LEVELS = ['none', 'own', 'shared-read', 'shared-write']
export const OTHER_AGENTS_LEVELS = ['none', 'titles', 'search', 'read']
export const HARNESSES = [{ id: 'hermes', label: 'Hermes' }]
import { installSupervisorAssets, SUPERVISOR_ASSET_HASH } from './supervisor-assets.mjs'
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
  models: [{ id: 'glm-5-3', label: 'GLM 5.3', images: false }, { id: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash', images: true }],
}
/** False only for a model its provider rejects image input for (Tinfoil GLM 5.3: HTTP 400 "not a multimodal model"). */
export function agentModelSeesImages(agent) {
  if (agent?.model?.provider !== TINFOIL.id) return true
  return TINFOIL.models.find((model) => model.id === agent.model.model)?.images !== false
}
/**
 * A Tinfoil agent whose own model is text-only gets an image-capable Tinfoil model from its own allowed list as its
 * eyes: Hermes' vision_analyze runs on it (auxiliary.vision) through the same attested proxy, so images never leave
 * the confidential route. Null when the agent sees images itself or has no allowed vision model.
 */
export function agentVisionHelper(agent) {
  if (agent?.model?.provider !== TINFOIL.id || agentModelSeesImages(agent)) return null
  if (agent.permissions?.files === 'none') return null
  const allowed = new Set(agent.model.allowed_models ?? [agent.model.model])
  return TINFOIL.models.find((model) => model.images && allowed.has(model.id))?.id ?? null
}
// Hermes must leave its default reasoning effort off these Tinfoil models' requests: DeepSeek V4.1 Flash on Tinfoil
// rejects "medium" (HTTP 400 chat_template_kwargs). Written into the agent's config.yaml as model_overrides.
export const TINFOIL_NO_REASONING = new Set(['deepseek-v4-1-flash'])
export const LOCAL = { id: 'local', label: 'This box (local model)', confidential: true, models: [] }
// Providers that the AI Accounts app signs in. Offered for standard agents only.
const AI_ACCOUNTS = new Map([['anthropic', 'Claude (AI Accounts)'], ['openai-codex', 'ChatGPT (AI Accounts)']])
// An agent container reaches Claude through the box's one Claude sign-in (the Claude app's shared login volume,
// mounted at /claude by the agent runtime) and the Hermes image's Claude Code subscription provider; it never gets
// an Anthropic API key. Model ids use that provider's catalogue spelling (claude-fable-5-1, not claude-fable-5.1).
export const CLAUDE_AGENT_PROVIDER = 'claude-subscription-directsdk-experimental'
export const claudeModelId = (id) => (/^claude-/u.test(id) ? id.replace(/\./gu, '-') : id)
// Hermes' always-loaded memory files: an agent may raise their budgets (e.g. a long user profile), within bounds.
export const MEMORY_LIMITS = { user_chars: [500, 12000], notes_chars: [500, 12000] }
export function normalizeMemory(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_memory', 'agent.memory')
  const out = {}
  for (const [key, [min, max]] of Object.entries(MEMORY_LIMITS)) {
    if (value[key] === undefined) continue
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) fail(400, 'invalid_memory', `agent.memory.${key}`)
    out[key] = value[key]
  }
  for (const key of Object.keys(value)) if (!(key in MEMORY_LIMITS)) fail(400, 'invalid_memory', `agent.memory.${key}`)
  return Object.keys(out).length ? out : undefined
}
export const PRESETS = [
  {
    id: 'private', label: 'Private',
    summary: 'Confidential model only, no fallback, no outside tools, only its own files; only apps tagged private.',
    privacy: 'private',
    permissions: { outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [], other_agents: 'none', shared_with_agents: false },
  },
  {
    id: 'standard', label: 'Standard',
    summary: 'Hermes defaults: outside tools on, shared files, apps you pick.',
    privacy: 'standard',
    permissions: { outside_tools: OUTSIDE_TOOLS.map((tool) => tool.id), files: 'shared-write', wizard_apps: [], agent_apps: [], other_agents: 'read', shared_with_agents: true },
  },
]
const PRESET = new Map(PRESETS.map((preset) => [preset.id, preset]))
/**
 * Slots whose apps a private agent gets by default (#58 exception, James 23 Oct): the private agent's only way to hand
 * work to a standard agent is the owner-gated redaction app (Airlock), so it starts ticked for every private agent and
 * joins existing private agents when installed. The owner can untick it later; nothing re-adds it.
 */
export const PRIVATE_DEFAULT_SLOTS = Object.freeze(['transcript-redaction'])
// James, 23 Oct 2026: "The whole point of Mizel was to be fully private so no public agent can read its transcripts."
// …"Rather than each app needing to declare itself, let's just make an optional one that tags it as private."
// An app is private when its wizard.md says `privacy: private` (registry field `privacy`). Apps installed before the
// tag existed are recognised by the slots they provide, so Mizel and Airlock stay private unchanged.
export const PRIVATE_DATA_SLOTS = Object.freeze(['meeting-transcripts', 'meeting-recording', ...PRIVATE_DEFAULT_SLOTS])
export const isPrivateApp = (app) => app?.privacy === 'private'
  || (Array.isArray(app?.provides) && app.provides.some((slot) => PRIVATE_DATA_SLOTS.includes(slot)))
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

// Agent/app files are read for every thread in a Chats list (several reads per row). Parse each
// file once per on-disk version (inode, size, mtime) and hand out copies, so callers that edit the
// result never touch the cache.
const jsonCache = new Map()
function readJson(path) {
  let stamp
  try { const st = statSync(path); stamp = `${st.ino}:${st.size}:${st.mtimeMs}` } catch { jsonCache.delete(path); return null }
  const hit = jsonCache.get(path)
  if (hit && hit.stamp === stamp) return hit.value === null ? null : structuredClone(hit.value)
  let value = null
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { value = null }
  if (jsonCache.size > 512) jsonCache.delete(jsonCache.keys().next().value)
  jsonCache.set(path, { stamp, value })
  return value === null ? null : structuredClone(value)
}

function writeJsonAtomic(path, value, mode = 0o600) {
  atomicStoreWrite(path, `${JSON.stringify(value, null, 2)}\n`, { inventory: /\.(?:threads|run-threads|session-catalog)\.json$/u.test(path) })
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

/** Owner-visible notes only; never accept absolute, hidden or parent paths. */
export function normalizeNotesDir(value) {
  if (value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > 200 || !value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/u.test(part) && !part.startsWith('.')) || value.includes('\\')) fail(400, 'invalid_notes_dir', 'agent.notes_dir')
  return value
}

/** Merge a permissions patch onto a base, validating every field. */
export function normalizePermissions(base, patch = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'invalid_permissions', 'agent.permissions')
  const out = { read_standard_chats: false, ...base }
  if (patch.read_standard_chats !== undefined) {
    if (typeof patch.read_standard_chats !== 'boolean') fail(400, 'invalid_permissions', 'agent.permissions.read_standard_chats')
    out.read_standard_chats = patch.read_standard_chats
  }
  if (patch.shared_with_agents !== undefined) {
    if (typeof patch.shared_with_agents !== 'boolean') fail(400, 'invalid_permissions', 'agent.permissions.shared_with_agents')
    out.shared_with_agents = patch.shared_with_agents
  }
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
  if (agent.imported && [...(agent.permissions.wizard_apps || []), ...(agent.permissions.agent_apps || [])]
    .some((id) => /^privacy(?:[.-]?com)?$/iu.test(id))) fail(409, 'import_sensitive_app_denied', 'agent.permissions')
  if (agent.permissions.read_standard_chats && agent.privacy !== 'private') fail(409, 'private_permission_required', 'agent.permissions.read_standard_chats')
  if (agent.privacy !== 'private') return
  if (agent.permissions.shared_with_agents === true) sealed('a private agent is never a source')
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
    ...(agent.notes_dir ? { notes_dir: agent.notes_dir } : {}),
    permissions: { ...agent.permissions, outside_tools: [...agent.permissions.outside_tools], wizard_apps: [...agent.permissions.wizard_apps], agent_apps: [...agent.permissions.agent_apps] },
    status: status.status,
    status_detail: status.status_detail ?? '',
    is_default: agent.id === defaultAgentId,
    ...(agent.hidden === true ? { hidden: true } : {}),
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
  if (value.hidden !== undefined && typeof value.hidden !== 'boolean') return null
  if (value.harness !== 'hermes' || !['private', 'standard'].includes(value.privacy)) return null
  if (value.role !== undefined && value.role !== 'standard') return null
  const model = value.model
  if (!model || typeof model.provider !== 'string' || typeof model.model !== 'string' || !Array.isArray(model.allowed_models)) return null
  const permissions = value.permissions
  if (!permissions || typeof permissions !== 'object') return null
  const runtime = value.runtime
  if (!runtime || !['container', 'profile'].includes(runtime.kind)) return null
  if (runtime.kind === 'container' && (typeof runtime.app_id !== 'string' || !Number.isInteger(runtime.port))) return null
  if (runtime.kind === 'profile' && (typeof runtime.profile !== 'string' || !ID_RE.test(runtime.profile))) return null
  try {
    const { preset, ...fields } = permissions
    return {
      ...value,
      ...(value.notes_dir === undefined ? {} : { notes_dir: normalizeNotesDir(value.notes_dir) }),
      label: cleanLabel(value.label, id),
      appearance: normalizeAppearance(value.appearance, value.privacy),
      model: { provider: model.provider, model: model.model, allowed_models: model.allowed_models.filter((m) => typeof m === 'string'), fallback: model.fallback === true },
      permissions: {
        preset: PRESET.has(preset) ? preset : 'standard',
        ...normalizePermissions({ outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [], other_agents: 'none', shared_with_agents: value.privacy !== 'private' }, fields),
        ...(value.privacy === 'private' ? { shared_with_agents: false } : {}),
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
 * later appear without a restart). Every private agent also gets its own scoped Spaces tools without ticking apps.
 */
/** What a restricted agent's harness calls: its edge sidecar, forwarding only to its own Service socket. */
export const RESTRICTED_GATEWAY_URL = 'http://edge:8923/wizard/mcp'

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
  return true // Own Spaces are built-in, including private agents with no ticked apps.
}

const standardChatsEndpoint = (gatewayUrl, explicit = '') => {
  if (explicit) {
    const url = new URL(explicit)
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/wizard/standard-chats/mcp' || url.search || url.hash) fail(500,'invalid_standard_chats_transport','agent.standard_chats_url')
    return url.href
  }
  if (!gatewayUrl) return ''
  const url = new URL(gatewayUrl); url.pathname = '/wizard/standard-chats/mcp'; url.search = ''; url.hash = ''; return url.href
}

/** Harness config for a container Hermes. The file is Service-owned; the owner edits the agent through the API. */
export function hermesConfigYaml(agent, { tinfoilUrl = '', contextLength = 0, gatewayUrl = '', standardChatsUrl = '' } = {}) {
  // The attestation proxy sidecar, named per agent (agent_runtime.py service_names).
  tinfoilUrl = tinfoilUrl || `http://agent-${agent.id}-tinfoil:3301/v1`
  const granted = new Set(agent.permissions.outside_tools)
  const visionHelper = agentVisionHelper(agent)
  // The Tinfoil vision helper is confidential, not a public model: its image tool stays on.
  if (visionHelper) granted.add('vision')
  const disabled = OUTSIDE_TOOLS.map((tool) => tool.id).filter((id) => !granted.has(id))
  if (agent.permissions.files === 'none') disabled.push(...FILE_TOOLSETS)
  const lines = [
    '# Managed by the Wizard OS Agent Service from agents/<id>/agent.json. Change the agent in the Agents app;',
    '# edits here are overwritten.',
    `# Supervisor assets: ${SUPERVISOR_ASSET_HASH}`,
    'model:',
    `  default: ${yamlString(agent.model.model)}`,
  ]
  if (agent.model.provider === TINFOIL.id) {
    lines.push('  provider: custom', `  base_url: ${yamlString(tinfoilUrl)}`, '  api_key: ${TINFOIL_API_KEY}')
    if (contextLength > 0) lines.push(`  context_length: ${Math.floor(contextLength)}`)
  } else if (agent.model.provider === LOCAL.id) {
    lines.push('  provider: custom', '  base_url: ${WIZARD_LOCAL_MODEL_URL}', '  api_key: ${WIZARD_LOCAL_MODEL_KEY}')
  } else if (agent.model.provider === 'anthropic') {
    lines.push(`  provider: ${yamlString(CLAUDE_AGENT_PROVIDER)}`)
  } else {
    lines.push(`  provider: ${yamlString(agent.model.provider)}`)
  }
  // Stock Hermes redacts sk-ant-oat... tool results before session/trajectory
  // persistence. Pin its supported secure setting for the restricted grant.
  if (agent.runtime?.isolation === 'restricted' && agent.privacy === 'standard' && agent.model.provider === 'anthropic') {
    lines.push('security:', '  redact_secrets: true')
  }
  if (visionHelper) {
    lines.push('auxiliary:', '  vision:', '    provider: custom', `    model: ${yamlString(visionHelper)}`,
      `    base_url: ${yamlString(tinfoilUrl)}`, '    key_env: TINFOIL_API_KEY')
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
  const standardUrl = standardChatsEndpoint(gatewayUrl,standardChatsUrl)
  if (wantsGateway(agent, gatewayUrl) || (agent.privacy === 'private' && agent.permissions.read_standard_chats === true && standardUrl)) {
    lines.push('mcp_servers:')
    if (gatewayUrl) lines.push('  wizard:', `    url: ${yamlString(gatewayUrl)}`, '    headers:', '      Authorization: "Bearer ${WIZARD_MCP_TOKEN}"')
    if (agent.privacy === 'private' && agent.permissions.read_standard_chats === true) {
      lines.push('  standard_chats:', `    url: ${yamlString(standardUrl)}`, '    headers:', '      Authorization: "Bearer ${WIZARD_MCP_TOKEN}"')
    }
  } else if (!agentAppIds(agent).size) lines.push('mcp_servers: {}')
  lines.push('memory:', '  provider: holographic', '  memory_enabled: true', '  user_profile_enabled: true')
  if (agent.memory?.user_chars) lines.push(`  user_char_limit: ${agent.memory.user_chars}`)
  if (agent.memory?.notes_chars) lines.push(`  memory_char_limit: ${agent.memory.notes_chars}`)
  // Stock Hermes ships this provider in the pinned runtime image. Keep state in
  // this agent's persisted home, never the image layer or the Service's home.
  lines.push('plugins:', '  enabled: [holographic]', '  hermes-memory-store:',
    '    db_path: "$HERMES_HOME/memory_store.db"', '    auto_extract: false')
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
  // Host profiles share the main gateway, not the container transport/port allocator.
  const mainUpstreamOrigin = options.mainUpstreamOrigin || ''
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
  const standardUrlFor = agent => standardChatsEndpoint(gatewayUrlFor(agent),restricted(agent) ? '' : options.standardChatsUrl || '')
  const assertStandardTransport = agent => { if (agent.permissions.read_standard_chats && !standardUrlFor(agent)) fail(409,'standard_chats_unconfigured','agent.permissions.read_standard_chats') }
  const appsChanged = () => { try { options.onAppsChanged?.() } catch { /* the gateway re-reads on its next call */ } }
  const statusCache = new Map()

  const listIds = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) : [])
  // The main agent is standard with every installed standard app ticked until the owner unticks one (#58, no
  // regression). Private apps are never implied: they need a tick (James, 23 Oct 2026).
  const mainApps = () => {
    const stored = readJson(mainPath)
    if (stored && stored.schema === 1) return { wizard_apps: listIds(stored.wizard_apps), agent_apps: listIds(stored.agent_apps) }
    const { wizardApps, agentApps } = installedApps()
    const hidden = privateApps()
    const open = (app) => !hidden.has(app.id)
    return { wizard_apps: wizardApps.filter(open).map((app) => app.id), agent_apps: agentApps.filter(open).map((app) => app.id) }
  }
  // Resolved for every thread in a Chats list: rebuild only when .main-agent.json or apps.json changes.
  let mainMemo = { key: null, value: null }
  const fileStamp = (path) => { try { const st = statSync(path); return `${st.ino}:${st.size}:${st.mtimeMs}` } catch { return '-' } }
  const mainAgent = () => {
    const key = `${fileStamp(mainPath)}|${appsJsonPath ? fileStamp(appsJsonPath) : ''}|${mainLabel}`
    if (mainMemo.key !== key) mainMemo = { key, value: buildMainAgent() }
    return structuredClone(mainMemo.value)
  }
  const buildMainAgent = () => ({
    schema: AGENT_SCHEMA, id: MAIN_AGENT_ID, hidden: readJson(mainPath)?.hidden === true, label: readJson(mainPath)?.role === 'recovery' ? `${mainLabel} (system)` : mainLabel, harness: 'hermes', privacy: 'standard',
    ...(readJson(mainPath)?.role === 'recovery' ? { role: 'recovery' } : {}),
    appearance: normalizeAppearance(options.mainAppearance, 'standard'),
    model: { provider: 'host', model: '', allowed_models: [], fallback: true },
    permissions: { preset: 'standard', outside_tools: OUTSIDE_TOOLS.map((tool) => tool.id), files: 'shared-write', ...mainApps(), other_agents: readJson(mainPath)?.other_agents ?? 'read', shared_with_agents: readJson(mainPath)?.shared_with_agents !== false },
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
  /**
   * Runs when apps.json changed. A new app joins one place only (James, 23 Oct 2026: "the user should have to enable
   * things manually"): a standard app joins the main agent; a private app joins private agents. Every other agent
   * starts unticked; the owner ticks it in the app's settings sheet.
   */
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
    // Apps already seen that have since become private (a privacy: private tag or a private-data slot added by an
    // update). Recorded classifications start with this release: an older seen file adopts today's classes without
    // revoking anything, since its grants cannot be told apart from explicit ticks.
    const privateNow = privateApps()
    const seenPrivate = seenFile?.schema === 1 && Array.isArray(seenFile.private) ? new Set(listIds(seenFile.private)) : null
    const turnedPrivate = seenPrivate ? current.filter((id) => seen.has(id) && privateNow.has(id) && !seenPrivate.has(id)) : []
    try {
      if (fresh.length) {
        const privateFresh = privateApps()
        for (const id of folderIds()) {
          const agent = readRaw(id)
          if (!agent || agent.imported || agent.runtime.kind === "profile" || agent.runtime?.admission === 'importing') continue
          if (agent.privacy !== 'private') continue
          const joining = fresh.filter((app) => privateFresh.has(app))
          if (!joining.length) continue
          const next = structuredClone(agent)
          for (const app of joining) if (!agentAppIds(next).has(app)) next.permissions[kinds.get(app)].push(app)
          if (JSON.stringify(next.permissions) === JSON.stringify(agent.permissions)) continue
          if (agent.privacy === 'private') {
            // Its first app gives a private agent the gateway, which needs a harness restart: go through update().
            const { wizard_apps, agent_apps } = next.permissions
            queueMicrotask(() => { update(id, { permissions: { wizard_apps, agent_apps } }).catch(() => undefined) })
            continue
          }
          writeHarnessFiles(next)
          writeJsonAtomic(join(folder(id), 'agent.json'), next, 0o600)
        }
        queueMicrotask(appsChanged)
        const stored = readJson(mainPath)
        if (stored?.schema === 1) {
          const apps = { wizard_apps: listIds(stored.wizard_apps), agent_apps: listIds(stored.agent_apps) }
          for (const app of fresh) if (!privateFresh.has(app) && !apps.wizard_apps.includes(app) && !apps.agent_apps.includes(app)) apps[kinds.get(app)].push(app)
          writeJsonAtomic(mainPath, { ...stored, schema: 1, ...apps })
        }
      }
      if (turnedPrivate.length) {
        // A grant made while the app was standard was never consent to private data: take it back from the main
        // agent and every non-private agent. Private agents keep theirs; the owner can tick any agent again.
        const turned = new Set(turnedPrivate)
        for (const id of folderIds()) {
          const agent = readRaw(id)
          if (!agent || agent.privacy === 'private' || agent.runtime.kind === 'profile' || agent.runtime?.admission === 'importing') continue
          const wizard_apps = listIds(agent.permissions.wizard_apps).filter((app) => !turned.has(app))
          const agent_apps = listIds(agent.permissions.agent_apps).filter((app) => !turned.has(app))
          if (wizard_apps.length === listIds(agent.permissions.wizard_apps).length && agent_apps.length === listIds(agent.permissions.agent_apps).length) continue
          const next = structuredClone(agent)
          next.permissions.wizard_apps = wizard_apps
          next.permissions.agent_apps = agent_apps
          writeHarnessFiles(next)
          writeJsonAtomic(join(folder(id), 'agent.json'), next, 0o600)
        }
        const stored = readJson(mainPath)
        if (stored?.schema === 1) {
          writeJsonAtomic(mainPath, { ...stored, wizard_apps: listIds(stored.wizard_apps).filter((app) => !turned.has(app)), agent_apps: listIds(stored.agent_apps).filter((app) => !turned.has(app)) })
        }
        queueMicrotask(appsChanged)
      }
      const privateList = current.filter((id) => privateNow.has(id))
      if (fresh.length || seenFile?.schema !== 1 || current.length !== seen.size || current.some((id) => !seen.has(id))
        || !seenPrivate || privateList.length !== seenPrivate.size || privateList.some((id) => !seenPrivate.has(id))) {
        mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
        writeJsonAtomic(appsSeenPath, { schema: 1, apps: current, private: privateList })
      }
    } catch { appsSignature = null }   // retry on the next read
  }

  /**
   * The app ids an agent may use through the gateway (#58). Unknown agent → empty. The main agent with no stored
   * choice → every app except private ones (null when none is private: the gateway before #58).
   */
  function allowedApps(agentId) {
    if (readRaw(agentId)?.role === 'recovery') return new Set()
    if (agentId === MAIN_AGENT_ID && readJson(mainPath)?.schema !== 1) {
      syncApps()
      const hidden = privateApps()
      return hidden.size ? new Set([...appKinds().keys()].filter((app) => !hidden.has(app))) : null
    }
    const agent = read(agentId)
    return agent ? agentAppIds(agent) : new Set()
  }

  /** Which agents can use an app (the app's settings sheet / the install picker, #58). */
  function appAgents(appId) {
    const kind = appKinds().get(appId)
    if (!kind) fail(404, 'app_not_found', 'app.id')
    const privateApp = privateApps().has(appId)
    const all = list().filter(agent => agent.role !== 'recovery')
    return {
      app_id: appId, kind, privacy: privateApp ? 'private' : 'standard',
      // A private app on a box with no private agent: the install sheet offers to set one up (James, 23 Oct 2026).
      ...(privateApp ? { needs_private_agent: !all.some((agent) => agent.privacy === 'private') } : {}),
      agents: all.map((agent) => ({ ...threadAgent(agent), enabled: agentAppIds(agent).has(appId), is_default: agent.id === defaultAgentId() })),
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
    if (!source.permissions.shared_with_agents) fail(409, 'agent_not_shared', 'agent.not_shared')
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
      for (const agent of agents) if (agent.id !== reader.id && agent.privacy === 'standard' && agent.permissions.shared_with_agents) out.set(agent.id, reader.permissions.other_agents)
    }
    for (const grant of grants()) {
      if (grant.reader !== reader.id) continue
      const source = agents.find((agent) => agent.id === grant.source)
      if (!source || source.privacy !== 'standard' || !source.permissions.shared_with_agents || source.id === reader.id) continue
      if (GRANT_SCOPES.indexOf(grant.scope) > GRANT_SCOPES.indexOf(out.get(source.id))) out.set(source.id, grant.scope)
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
    if (agent.runtime.kind === 'profile') {
      if (!mainUpstreamOrigin) throw new AgentError(503, 'agent_not_ready', 'agent.runtime.origin')
      return `${new URL(mainUpstreamOrigin).origin}/p/${agent.runtime.profile}`
    }
    // Restricted agents have no TCP origin. Every caller must use fetchAgent.
    if (restricted(agent)) return null
    if (upstreamMode === 'network') {
      const url = new URL(String(agent.runtime.api || ''))
      if (url.protocol !== 'http:' || url.hostname !== agent.runtime.app_id || url.username || url.password || url.pathname !== '/') {
        throw new AgentError(502, 'agent_unreachable', 'agent.runtime.api')
      }
      return url.origin
    }
    return `http://${upstreamHost}:${agent.runtime.port}`
  }

  function fetchAgent(agent, path, init = {}) {
    if (restricted(agent)) {
      const socketPath = join(folder(agent.id), 'gateway', 'ingress.sock')
      if (agent.runtime.ingress_socket && agent.runtime.ingress_socket !== socketPath) throw new Error('agent ingress path mismatch')
      return fetchAgentIngress(socketPath, path, init)
    }
    return fetchImpl(`${upstream(agent)}${path}`, init)
  }

  async function probe(agent, { fresh = false } = {}) {
    const cached = statusCache.get(agent.id)
    if (!fresh && cached && now() - cached.at < 3000) return cached.value
    const state = agent.runtime.kind === 'profile' ? {} : serviceState(agent.id)
    let value
    let healthy = false
    try {
      const headers = agent.runtime.kind === 'profile' ? { Authorization: `Bearer ${apiKey(agent.id)}` } : {}
      const response = await fetchAgent(agent, '/health', { headers, redirect: 'error', signal: AbortSignal.timeout(1500) })
      await response.body?.cancel().catch(() => undefined)
      healthy = response.ok
    } catch { healthy = false }
    if (healthy) value = { status: 'running', status_detail: state.last_error === 'claude_login_missing' ? 'claude_login_missing' : '' }
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
      let models = (Array.isArray(item.models) ? item.models : []).map((m) => (typeof m === 'string' ? m : m?.id)).filter((m) => typeof m === 'string' && m.length < 120).slice(0, 12)
      if (id === 'anthropic') models = [...new Set(models.map(claudeModelId))]
      if (models.length) out.push({ id, label: AI_ACCOUNTS.get(id), confidential: false, models: models.map((m) => ({ id: m, label: m })) })
    }
    return out
  }

  /** Installed private apps (tagged `privacy: private`, or providing a private-data slot). Private agents get them by default. */
  function privateApps() {
    const apps = readJson(appsJsonPath)?.apps
    return new Set((Array.isArray(apps) ? apps : []).filter(isPrivateApp).map((app) => app.id))
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
      import_capabilities: options.importCapabilities?.() ?? { socket_prepare: false, heavy_enabled: false, heavy_sandbox: false },
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

  /** Whether an agent runs in the restricted runtime (its key is then bound to its own Unix socket). */
  function agentRestricted(id) {
    try { return restricted(read(id)) } catch { return false }
  }

  function nextPort() {
    const used = new Set(list().map((agent) => agent.runtime?.port).filter(Number.isInteger))
    let port = basePort
    while (used.has(port)) port += 1
    return port
  }

  /** True when the agent's managed config.yaml is not what this release would write (a new release changed it). */
  function harnessStale(agent) {
    if (agent.runtime.kind === 'profile') return false
    const home = join(folder(agent.id), restricted(agent) ? 'managed' : 'home')
    const expected = hermesConfigYaml(agent, { tinfoilUrl: options.tinfoilUrl, contextLength: options.contextLength, gatewayUrl: gatewayUrlFor(agent), standardChatsUrl: standardUrlFor(agent) })
    // Compare against the stamp of what the Service last wrote: Hermes itself may normalise config.yaml on start.
    const stamp = createHash('sha256').update(expected).digest('hex')
    try { return readFileSync(join(folder(agent.id), 'config.sha256'), 'utf8').trim() !== stamp } catch { return existsSync(home) }
  }

  function writeHarnessFiles(agent, { rotateKey = false } = {}) {
    if (agent.runtime.kind === 'profile') fail(409, 'profile_agent_read_only', 'agent.runtime')
    // Imported agents keep their full memory/settings/auth. Their host driver merges
    // only Wizard-owned fields on start/apply; a fresh generated config would erase
    // their memory backend and provider login. Keys already exist from admission.
    if (agent.imported?.schema === 1 && agent.imported?.format === 'hermes') {
      if (rotateKey || !apiKey(agent.id) || !gatewayKey(agent.id)) fail(409, 'import_keys_unavailable', 'agent.import')
      writeJsonAtomic(join(folder(agent.id), 'import-update.json'), { model: agent.model, permissions: agent.permissions })
      return
    }
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
    writeTextAtomic(join(home, '.env'), agentEnvFile({ apiKey: key, gatewayKey: wantsGateway(agent, agentGateway) || (agent.privacy === 'private' && agent.permissions.read_standard_chats && standardUrlFor(agent)) ? gateway : '' }))
    installSupervisorAssets(home)
    const config = hermesConfigYaml(agent, { tinfoilUrl: options.tinfoilUrl, contextLength: options.contextLength, gatewayUrl: agentGateway, standardChatsUrl: standardUrlFor(agent) })
    writeTextAtomic(join(home, 'config.yaml'), config)
    writeTextAtomic(join(dir, 'config.sha256'), `${createHash('sha256').update(config).digest('hex')}\n`)
  }

  // Upgrade only Service-managed containers. Host profiles/imports own their harness;
  // never traverse their home or rewrite user data. Keep a pending marker until apply
  // succeeds, so a crash/failed runtime RPC cannot turn a rewritten stamp into success.
  let harnessMigration
  function migrateManagedHarnesses() {
    if (harnessMigration) return harnessMigration
    harnessMigration = (async () => {
      if (!runtime?.apply) return
      for (const id of folderIds()) {
        const agent = readRaw(id)
        if (!agent || agent.runtime.kind !== 'container' || agent.imported || agent.runtime.admission === 'importing') continue
        const home = join(folder(id), restricted(agent) ? 'managed' : 'home')
        const pending = join(folder(id), '.harness-apply-pending')
        try {
          let missingToken = false
          if (wantsGateway(agent, gatewayUrlFor(agent))) {
            const token = gatewayKey(id)
            try { missingToken = !token || !readFileSync(join(home, '.env'), 'utf8').split(/\r?\n/u).includes(`WIZARD_MCP_TOKEN=${token}`) }
            catch { missingToken = true }
          }
          if (!harnessStale(agent) && !missingToken && !existsSync(pending)) continue
          writeTextAtomic(pending, 'managed harness upgrade\n')
          writeHarnessFiles(agent) // same ownership/stamp rules as an owner update
          if (serviceState(id).desired !== 'stopped') {
            invalidateCatalog(id)
            if (restricted(agent)) await options.beforeRestrictedStart?.(id)
            const result = await runtime.apply(id)
            if (result?.ok === false) throw new Error('runtime_failed')
            writeServiceState(id, { started_at: now(), last_error: result?.last_error === 'claude_login_missing' ? 'claude_login_missing' : '' })
          }
          rmSync(pending, { force: true })
        } catch (error) { writeServiceState(id, { last_error: runtimeError(error) }) }
      }
    })().finally(() => { harnessMigration = null })
    return harnessMigration
  }

  const idempotency = () => readJson(idempotencyPath) ?? {}

  async function create(body, { idempotencyKey = '', deferStart = false } = {}) {
    // Library-only owner import reservation; HTTP callers cannot set this option.
    if (deferStart && isolation !== 'restricted') fail(409, 'import_requires_restricted', 'agent.runtime')
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'agent.body')
    if (body.role !== undefined && body.role !== 'standard') fail(409, 'invalid_agent_role', 'agent.role')
    if (body.runtime !== undefined && body.runtime?.kind !== 'container') fail(400, 'invalid_runtime', 'agent.runtime', 'only container agents may be created through the API')
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
    if (preset.privacy === 'private') {
      const kinds = appKinds()
      for (const app of privateApps()) {
        const field = kinds.get(app)
        if (field && !agentAppIds({ permissions }).has(app)) permissions[field].push(app)
      }
    }
    const model = validateModel(body.model, await providers(), { privacy: preset.privacy })
    if (preset.privacy === 'private' && model.fallback) fail(409, 'fallback_not_allowed', 'agent.fallback')
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
    const id = slugFor(label)
    const agent = {
      schema: AGENT_SCHEMA, id, label, harness: 'hermes', privacy: preset.privacy,
      appearance: normalizeAppearance(body.appearance, preset.privacy),
      model, permissions,
      ...(body.notes_dir === undefined ? {} : { notes_dir: normalizeNotesDir(body.notes_dir) }),
      ...(normalizeMemory(body.memory) ? { memory: normalizeMemory(body.memory) } : {}),
      runtime: {
        kind: 'container', app_id: `agent-${id}`, api: `http://agent-${id}:8642`, port: nextPort(), image: options.image || '',
        // port is retained for schema/old records, but restricted agents never publish or use it.
        ...(isolation ? { isolation, network: nextNetwork(), ingress_socket: join(folder(id), 'gateway', 'ingress.sock') } : {}),
        ...(deferStart ? { admission: "importing" } : {}),
      },
      created_at: Math.floor(now() / 1000),
    }
    // Private agents read standard chats by default (James, 23 Oct 2026) where the read-only transport exists;
    // an explicit false from the client wins.
    if (agent.privacy === 'private' && overrides?.read_standard_chats === undefined && standardUrlFor(agent)) agent.permissions.read_standard_chats = true
    assertPrivateWalls(agent)
    assertStandardTransport(agent)
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
    writeServiceState(id, { desired: deferStart ? 'stopped' : 'running', started_at: deferStart ? 0 : now(), last_error: '' })
    if (deferStart) return { agent: read(id), replayed: false }
    try {
      if (restricted(agent)) await options.beforeRestrictedStart?.(id)
      const result = await runtime.apply(id)
      writeServiceState(id, { last_error: result?.last_error === 'claude_login_missing' ? 'claude_login_missing' : '' })
    } catch (error) { writeServiceState(id, { last_error: runtimeError(error) }) }
    await refreshCatalog(id).catch(() => undefined)
    return { agent: read(id), replayed: false }
  }

  async function update(id, body) {
    const agent = read(id)
    if (!agent) fail(404, 'agent_not_found', 'agent.id')
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'agent.body')
    if (agent.runtime.kind === 'profile') {
      // Sharing metadata is Service-owned even for a file-provisioned host profile.
      if (Object.keys(body).some(key => !['permissions', 'notes_dir'].includes(key))
        || Object.keys(body.permissions ?? {}).some(key => !['other_agents', 'shared_with_agents'].includes(key))) {
        fail(409, 'profile_agent_read_only', 'agent.runtime', 'host profiles are configured in Hermes; only sharing metadata is set here')
      }
      const next = { ...agent, permissions: normalizePermissions(agent.permissions, body.permissions) }
      if (body.notes_dir !== undefined) next.notes_dir = normalizeNotesDir(body.notes_dir)
      assertPrivateWalls(next)
      writeJsonAtomic(join(folder(id), 'agent.json'), next, 0o600)
      return read(id)
    }
    if (id === MAIN_AGENT_ID) {
      if (body.role !== undefined) {
        if (!['standard', 'recovery'].includes(body.role)) fail(400, 'invalid_agent_role', 'agent.role')
        if (Object.keys(body).some(key => key !== 'role')) fail(400, 'invalid_request', 'agent.body')
        if (body.role === 'recovery' && defaultAgentId() === MAIN_AGENT_ID) fail(409, 'recovery_cannot_be_default', 'agent.role')
        if (body.role === 'recovery' && options.isBindingTarget?.(MAIN_AGENT_ID)) fail(409, 'recovery_agent_bound', 'agent.recovery_sealed')
        if (body.role === 'recovery' && grants().some(grant => grant.reader === MAIN_AGENT_ID || grant.source === MAIN_AGENT_ID)) fail(409, 'recovery_agent_granted', 'agent.recovery_sealed')
        mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
        writeJsonAtomic(mainPath, { ...readJson(mainPath), schema: 1, ...mainApps(), role: body.role })
        appsChanged()
        return read(id)
      }
      if (agent.role === 'recovery') fail(409, 'recovery_agent_sealed', 'agent.recovery_sealed')
      // Apps and sharing are Service-owned; the other host settings stay in Hermes.
      const keys = Object.keys(body)
      const permKeys = Object.keys(body.permissions ?? {})
      if (keys.some((key) => !['permissions', 'hidden'].includes(key)) || (!permKeys.length && !Object.hasOwn(body, 'hidden')) || permKeys.some((key) => !['wizard_apps', 'agent_apps', 'other_agents', 'shared_with_agents'].includes(key))) {
        fail(409, 'main_agent_read_only', 'agent.main', 'the main agent is configured in Hermes itself; only its apps and sharing permissions are set here')
      }
      if (Object.hasOwn(body, 'hidden') && typeof body.hidden !== 'boolean') fail(400, 'invalid_hidden', 'agent.hidden')
      const apps = normalizePermissions(agent.permissions, body.permissions)
      mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
      writeJsonAtomic(mainPath, { ...readJson(mainPath), schema: 1, ...(Object.hasOwn(body, 'hidden') ? { hidden: body.hidden } : {}), wizard_apps: apps.wizard_apps, agent_apps: apps.agent_apps, other_agents: apps.other_agents, shared_with_agents: apps.shared_with_agents })
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
    if (body.hidden !== undefined) {
      if (typeof body.hidden !== 'boolean') fail(400, 'invalid_hidden', 'agent.hidden')
      next.hidden = body.hidden
    }
    if (body.label !== undefined) {
      next.label = cleanLabel(body.label)
      if (!next.label) fail(400, 'label_required', 'agent.label')
    }
    if (body.notes_dir !== undefined) {
      const notes = normalizeNotesDir(body.notes_dir)
      if (notes) next.notes_dir = notes
      else delete next.notes_dir
    }
    if (body.appearance !== undefined) next.appearance = normalizeAppearance(body.appearance, next.privacy)
    if (body.memory !== undefined) {
      const memory = normalizeMemory(body.memory)
      if (memory) next.memory = memory
      else delete next.memory
    }
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
    assertStandardTransport(next)
    assertIsolationSupports(next)
    // An unchanged update still re-applies a config an older release wrote (e.g. a new vision helper).
    const harnessPermissions = permissions => { const { other_agents, shared_with_agents, ...rest } = permissions; return rest }
    const harnessChanged = JSON.stringify([agent.model, harnessPermissions(agent.permissions)]) !== JSON.stringify([next.model, harnessPermissions(next.permissions)]) || harnessStale(next)
    if (JSON.stringify([...agentAppIds(agent)]) !== JSON.stringify([...agentAppIds(next)])) queueMicrotask(appsChanged)
    if (harnessChanged) writeHarnessFiles(next)
    writeJsonAtomic(join(folder(id), 'agent.json'), next, 0o600)
    if (harnessChanged && runtime && serviceState(id).desired !== 'stopped') {
      invalidateCatalog(id)
      writeServiceState(id, { started_at: now(), last_error: '' })
      try {
        if (restricted(next)) await options.beforeRestrictedStart?.(id)
        const result = await runtime.apply(id)
        writeServiceState(id, { last_error: result?.last_error === 'claude_login_missing' ? 'claude_login_missing' : '' })
      } catch (error) { writeServiceState(id, { last_error: runtimeError(error) }) }
      await refreshCatalog(id).catch(() => undefined)
    }
    return read(id)
  }

  async function prepareImport(id) {
    const agent = read(id)
    if (!agent || !restricted(agent) || agent.privacy !== 'standard'
      || agent.runtime.admission !== 'importing') fail(409, 'agent_not_importing', 'agent.import')
    if (!options.beforeRestrictedStart) fail(503, 'agent_socket_unavailable', 'agent.import')
    // Socket only: no runtime, harness rewrite, key rotation, home access or start.
    await options.beforeRestrictedStart(id)
    return agent
  }

  async function setRunning(id, running) {
    const agent = read(id)
    if (!agent) fail(404, 'agent_not_found', 'agent.id')
    if (id === MAIN_AGENT_ID) fail(409, 'main_agent_read_only', 'agent.main')
    if (agent.runtime.kind === 'profile') fail(409, 'profile_agent_read_only', 'agent.runtime', 'host profiles are always on with the main gateway')
    if (!runtime) fail(503, 'runtime_unavailable', 'agent.runtime')
    // An imported Hermes keeps its keys from admission; never start it with a missing key (fail closed, nothing regenerated).
    if (running && agent.imported?.schema === 1 && agent.imported?.format === 'hermes' && (!apiKey(id) || !gatewayKey(id))) fail(409, 'import_keys_unavailable', 'agent.import')
    // Invalidate negative evidence across lifecycle transitions. A failed refresh is not an empty history.
    invalidateCatalog(id)
    writeServiceState(id, running ? { desired: 'running', started_at: now(), last_error: '' } : { desired: 'stopped', last_error: '' })
    const epoch = catalogEpochs.get(id) ?? 0
    let stoppedCensus
    try {
      if (running && restricted(agent)) await options.beforeRestrictedStart?.(id)
      const result = await (running ? runtime.start(id) : runtime.stop(id))
      if (running) writeServiceState(id, { last_error: result?.last_error === 'claude_login_missing' ? 'claude_login_missing' : '' })
      if (!running && result?.ok !== false) stoppedCensus = result?.census
    } catch (error) { writeServiceState(id, { last_error: runtimeError(error) }) }
    if (running) await refreshCatalog(id).catch(() => undefined)
    // Only the census produced inside the helper's locked stop action can seal.
    // A separate census RPC after stop would leave a lifecycle gap.
    else if (stoppedCensus) await sealCatalog(id, stoppedCensus, epoch).catch(() => undefined)
    return agent
  }

  // Qualified pins. A legacy id->agent entry already contains an explicit agent: preserve it, not today's default.
  migrateJson(threadsPath, value => {
    if (![1, 2].includes(value?.schema) || !value.threads || typeof value.threads !== 'object' || Array.isArray(value.threads)) throw new Error('Invalid thread pins')
    if (value.schema === 2) {
      for (const [key, row] of Object.entries(value.threads)) {
        if (!row || !validAgentId(row.agent_id) || typeof row.session_id !== 'string' || !row.session_id || row.session_id.length > 200 || key !== threadKey(row.agent_id, row.session_id)) throw new Error('Invalid qualified thread pin')
      }
      // Pre-provenance schema-2 entries could have been seeded from side metadata. Reverify them;
      // only schema-1 legacy pins have an unambiguous trusted migration origin.
      return { ...value, threads: Object.fromEntries(Object.entries(value.threads).map(([key, row]) => [key, { ...row, provenance: row.provenance ?? 'legacy_unverified' }])) }
    }
    return { schema: 2, threads: Object.fromEntries(Object.entries(value.threads).map(([id, agent]) => {
      if (!id || id.length > 200 || !validAgentId(agent)) throw new Error('Invalid legacy thread pin')
      const pair = threadReference(id, agent)
      return [threadKey(pair.agent_id, id), { ...pair, provenance: 'migrated_pin' }]
    })) }
  })
  let pinsCache = null
  // session id -> pinned agent ids, rebuilt whenever the pin table object changes. A linear scan per
  // lookup made the private-thread filter quadratic (~15% of service CPU on seen-state reads).
  let pinIndex = null
  const pins = () => {
    if (!pinsCache) pinsCache = readJson(threadsPath)?.threads ?? {}
    return pinsCache
  }
  function pinnedAgents(sessionId) {
    const table = pins()
    if (pinIndex?.table !== table) {
      const bySession = new Map()
      for (const row of Object.values(table)) {
        if (!['runtime_verified', 'service_admission', 'migrated_pin'].includes(row?.provenance)) continue
        if (!bySession.has(row.session_id)) bySession.set(row.session_id, [])
        bySession.get(row.session_id).push(row.agent_id)
      }
      pinIndex = { table, bySession }
    }
    return [...(pinIndex.bySession.get(sessionId) ?? [])]
  }
  function pinnedAgent(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return ''
    const ids = pinnedAgents(sessionId)
    if (ids.length > 1) fail(409, 'ambiguous_thread', 'agent.ambiguous_thread')
    return ids[0] ?? ''
  }
  function pin(sessionId, agentId, provenance = 'service_admission') {
    if (!['runtime_verified', 'service_admission', 'migrated_pin'].includes(provenance)) return
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !readRaw(agentId)) return
    const current = pins()
    const key = threadKey(agentId, sessionId)
    if (['runtime_verified', 'service_admission', 'migrated_pin'].includes(current[key]?.provenance)) return
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
    const next = { ...current, [key]: { ...threadReference(sessionId, agentId), provenance } }
    writeJsonAtomic(threadsPath, { schema: 2, threads: next })
    pinsCache = next
  }
  // This authority store is never seeded from client-authored metadata. Only runtime-authenticated
  // history reads supply positive evidence only. Negative evidence needs an offline stopped-generation seal.
  const catalogPath = join(agentsDir, '.session-catalog.json')
  migrateJson(catalogPath, value => {
    if (value?.schema !== 1 || !value.agents || typeof value.agents !== 'object' || Array.isArray(value.agents)) throw new Error('Invalid session catalog')
    for (const [id, row] of Object.entries(value.agents)) {
      if (!validAgentId(id) || !row || !Number.isFinite(row.at) || typeof row.complete !== 'boolean' || !Array.isArray(row.ids) || row.ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Invalid session catalog row')
    }
    return value
  })
  let catalogs = readJson(catalogPath)?.agents ?? {}
  const catalogEpochs = new Map()
  async function catalogContains(agentId, sessionId) {
    const row = catalogs[agentId]
    if (row?.ids.includes(sessionId)) return true
    if (!row?.complete || typeof row.seal !== 'string' || !row.seal || !runtime?.inspect) return undefined
    const epoch = catalogEpochs.get(agentId) ?? 0
    const seal = row.seal
    try {
      const current = await runtime.inspect(agentId)
      // A lifecycle round may finish while inspect is in flight. Never consume
      // its old answer against a newly sealed catalog, even for the same token.
      if (epoch !== (catalogEpochs.get(agentId) ?? 0) || catalogs[agentId]?.seal !== seal
        || catalogs[agentId]?.complete !== true) return undefined
      // Disk-loaded seals are authority only when the driver still attests this stopped generation.
      if (current.status === 'stopped' && current.generation === seal) return false
    } catch { /* unknown lifecycle generation never proves absence */ }
    return undefined
  }
  async function sealCatalog(agentId, census, epoch) {
    if (!runtime?.inspect) return
    const current = await runtime.inspect(agentId)
    if (epoch !== (catalogEpochs.get(agentId) ?? 0) || census.status !== 'stopped' || current.status !== 'stopped'
      || typeof census.generation !== 'string' || !census.generation || census.generation !== current.generation
      || !Array.isArray(census.ids) || census.ids.some(id => typeof id !== 'string' || !id || id.length > 200)) return
    observeSessions(agentId, census.ids)
    saveCatalog(agentId, { ...catalogs[agentId], complete: true, seal: census.generation })
  }
  function saveCatalog(agentId, row) {
    const next = { ...catalogs, [agentId]: row }
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
    writeJsonAtomic(catalogPath, { schema: 1, agents: next }); catalogs = next
  }
  function invalidateCatalog(agentId) {
    catalogEpochs.set(agentId, (catalogEpochs.get(agentId) ?? 0) + 1)
    if (catalogs[agentId]) saveCatalog(agentId, { ...catalogs[agentId], complete: false, seal: null })
  }
  function observeSessions(agentId, ids, { index = true } = {}) {
    ids = ids.filter(id => typeof id === 'string' && id && id.length <= 200)
    if (!readRaw(agentId)) return
    const previous = catalogs[agentId]
    // Retain positive sightings even if a concurrent paginated census misses a newly created row.
    saveCatalog(agentId, { at: now(), complete: previous?.complete === true && Boolean(previous?.seal), seal: previous?.seal ?? null, ids: [...new Set([...(previous?.ids ?? []), ...ids])] })
    if (index) for (const id of ids) pin(id, agentId, 'runtime_verified')
  }
  async function refreshCatalog(agentId) {
    const agent = readRaw(agentId)
    if (!agent) throw new Error('Unknown catalog agent')
    const origin = agentId === MAIN_AGENT_ID ? options.mainOrigin : upstream(agent)
    const key = agentId === MAIN_AGENT_ID ? options.mainKey : apiKey(agentId)
    if ((!origin && !restricted(agent)) || !key) throw new Error('Catalog runtime credentials unavailable')
    const ids = [], seen = new Set(), epoch = catalogEpochs.get(agentId) ?? 0
    for (let offset = 0; offset <= 100000;) {
      const path = `/api/sessions?limit=100&offset=${offset}&include_children=true`
      const init = { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(4000) }
      const response = await (agentId === MAIN_AGENT_ID ? fetchImpl(`${origin}${path}`, init) : fetchAgent(agent, path, init))
      if (!response.ok) throw new Error('Catalog runtime unavailable')
      const value = await response.json(), rows = value.data ?? value.sessions ?? value.items
      const hasMore = value.has_more ?? value.pagination?.has_more
      if (!Array.isArray(rows) || rows.some(row => typeof row?.id !== 'string' || !row.id || row.id.length > 200 || seen.has(row.id))
        || (hasMore !== undefined && typeof hasMore !== 'boolean')
        || (value.pagination?.offset !== undefined && value.pagination.offset !== offset)) throw new Error('Invalid catalog listing')
      for (const row of rows) { if (seen.has(row.id)) throw new Error('Repeated catalog row'); seen.add(row.id); ids.push(row.id) }
      // A short page may just be a clamped limit. Without an explicit final-page flag,
      // keep paging until an empty page; repeated/ignored cursors never prove absence.
      if (hasMore === false || (!rows.length && hasMore !== true)) {
        if ((catalogEpochs.get(agentId) ?? 0) !== epoch) throw new Error('Catalog lifecycle changed during census')
        observeSessions(agentId, ids, { complete: true }); return
      }
      if (!rows.length) break
      offset += rows.length
    }
    throw new Error('Incomplete catalog listing')
  }
  const runsPath = join(agentsDir, '.run-threads.json')
  migrateJson(runsPath, value => {
    if (value?.schema !== 1 || !value.runs || typeof value.runs !== 'object' || Array.isArray(value.runs)) throw new Error('Invalid run pair index')
    for (const [id, rows] of Object.entries(value.runs)) {
      if (!Array.isArray(rows) || rows.some(row => !row || row.run_id !== id || !validAgentId(row.agent_id) || typeof row.session_id !== 'string' || !row.session_id)) throw new Error('Invalid run pair rows')
    }
    for (const field of ['latest_runs', 'latest_all_runs']) if (value[field] !== undefined) {
      if (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field])) throw new Error('Invalid latest run index')
      for (const [key, id] of Object.entries(value[field])) {
        let pair
        try { pair = JSON.parse(key) } catch { throw new Error('Invalid latest run pair') }
        if (!Array.isArray(pair) || pair.length !== 2 || !validAgentId(pair[0]) || typeof pair[1] !== 'string' || !pair[1]
          || typeof id !== 'string' || !value.runs[id]?.some(row => row.agent_id === pair[0] && row.session_id === pair[1] && (field === 'latest_all_runs' || !row.heavy_origin))) throw new Error('Invalid latest run authority')
      }
    }
    return value
  })
  const runs = new Map(Object.entries(readJson(runsPath)?.runs ?? {}))
  const latestRuns = new Map(Object.entries(readJson(runsPath)?.latest_runs ?? {}))
  const latestAllRuns = new Map(Object.entries(readJson(runsPath)?.latest_all_runs ?? {}))
  function noteRun(runId, agentId, sessionId = '', options = {}) {
    // Callers pass either the request idempotency key (direct turns) or
    // { heavyOrigin, idempotencyKey } (heavy relay continuations).
    const { heavyOrigin = '', idempotencyKey = '' } = typeof options === 'string' ? { idempotencyKey: options } : (options ?? {})
    if (typeof runId !== 'string' || !runId) return
    const rows = runs.get(runId) ?? []
    if (rows.some(row => row.agent_id === agentId && row.session_id === sessionId)) return
    if (!sessionId || !readRaw(agentId)) return
    const next = new Map(runs)
    next.set(runId, [...rows.filter(row => row.agent_id !== agentId), { run_id: runId, ...threadReference(sessionId, agentId), ...(idempotencyKey ? { idempotency_key: String(idempotencyKey) } : {}), ...(heavyOrigin ? { heavy_origin: heavyOrigin } : {}) }])
    const nextLatest = new Map(latestRuns)
    const nextAll = new Map(latestAllRuns)
    nextAll.set(JSON.stringify([agentId, sessionId]), runId)
    if (!heavyOrigin) nextLatest.set(JSON.stringify([agentId, sessionId]), runId)
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
    writeJsonAtomic(runsPath, { schema: 1, runs: Object.fromEntries(next), latest_runs: Object.fromEntries(nextLatest), latest_all_runs: Object.fromEntries(nextAll) })
    runs.set(runId, next.get(runId))
    if (!heavyOrigin) latestRuns.set(JSON.stringify([agentId, sessionId]), runId)
    latestAllRuns.set(JSON.stringify([agentId, sessionId]), runId)
  }
  const runAgents = runId => (runs.get(runId) ?? []).map(row => row.agent_id)

  return {
    runThread: (agentId, runId) => (runs.get(runId) ?? []).find(row => row.agent_id === agentId) ?? null,
    latestRunForSession: (agentId, sessionId, { includeHeavy = false } = {}) => {
      const pair = JSON.stringify([agentId, sessionId])
      const latest = (includeHeavy ? latestAllRuns : latestRuns).get(pair)
      const rows = latest ? (runs.get(latest) ?? []) : [...runs.values()].flat()
      if (latest || !includeHeavy) return rows.filter(row => row.agent_id === agentId && row.session_id === sessionId && (includeHeavy || !row.heavy_origin)).at(-1) ?? null
      // Pre-index stores have no cross-agent chronology. Follow only an
      // unambiguous heavy lineage from the authoritative non-heavy head;
      // never infer order from the run-id map when sibling branches collide.
      const candidates = rows.filter(row => row.agent_id === agentId && row.session_id === sessionId)
      let current = latestRuns.has(pair)
        ? candidates.find(row => row.run_id === latestRuns.get(pair))
        : candidates.filter(row => !row.heavy_origin).at(-1)
      const seen = new Set()
      while (current && !seen.has(current.run_id)) {
        seen.add(current.run_id)
        const children = candidates.filter(row => row.heavy_origin === current.run_id && !seen.has(row.run_id))
        if (children.length !== 1) break
        current = children[0]
      }
      return current ?? null
    },
    stateHome: id => {
      const agent = read(id)
      if (!agent) return ''
      if (id === MAIN_AGENT_ID) return options.mainHome || ''
      if (agent.runtime.kind === 'profile') return options.mainHome ? join(options.mainHome, 'profiles', agent.runtime.profile) : ''
      return join(folder(id), 'home')
    },
    agentsDir, list, read, status, upstream, fetchAgent, apiKey, agentOptions, providers, create, update, setRunning,
    credentialValues: () => folderIds().flatMap(id => [apiKey(id),gatewayKey(id)]).filter(Boolean),
    catalogContains, refreshCatalog, observeSessions,
    pinnedAgent, pinnedAgents, pin, runAgents, latestThreadRun: (agentId, sessionId) => [...runs.values()].flat().filter(row => row.agent_id === agentId && row.session_id === sessionId).at(-1), runAgent: runId => { const ids = runAgents(runId); if (ids.length > 1) fail(409, 'ambiguous_thread', 'agent.ambiguous_thread'); return ids[0] ?? '' }, noteRun, defaultAgentId, canStartAgent,
    agentForModel: (route) => agentForModel(list(), route),
    syncApps, migrateManagedHarnesses, allowedApps, appAgents, setAppAgents, agentForGatewayToken, agentRestricted,
    grants, addGrant, removeGrant, readableSources, prepareImport,
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
    inspect: (id) => call('POST', `/agents/${encodeURIComponent(id)}/inspect`),
    census: (id) => call('POST', `/agents/${encodeURIComponent(id)}/census`),
    deliver: (id, payload) => call('POST', `/agents/${encodeURIComponent(id)}/deliver`, payload),
    place: (id, payload) => call('POST', `/agents/${encodeURIComponent(id)}/place`, payload),
    fetch: (id, payload) => call('POST', `/agents/${encodeURIComponent(id)}/fetch`, payload),
  }
}
