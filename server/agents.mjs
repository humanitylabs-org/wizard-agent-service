// Agents (wizard-os spec/AGENTS.md): more than one agent on a box.
//
// The registry is the folder `<agentsDir>/<id>/agent.json` (schema 1). The main agent is the host Hermes the
// Service already talks to and is always listed as `hermes`. Every other agent runs in its own container with its
// own Hermes home (`<id>/home`, its HERMES_HOME), its own API key (`<id>/runtime.key`) and its own model route.
// The Service never touches Docker: a runtime driver (agent-runtime helper on the host, see ops/agent-runtime)
// installs, starts and stops the container.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

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
export const TINFOIL = {
  id: 'tinfoil', label: 'Tinfoil (confidential)', confidential: true,
  models: [{ id: 'glm-5-3', label: 'GLM 5.3' }],
}
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

export function publicAgent(agent, status = { status: 'stopped', status_detail: '' }) {
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
    is_default: agent.id === MAIN_AGENT_ID,
  }
}

export function threadAgent(agent) {
  return { id: agent.id, label: agent.label, privacy: agent.privacy, appearance: agent.appearance }
}

/** Validate a stored agent.json. Returns null for anything that is not a schema-1 agent (e.g. other experiments). */
export function parseAgentFile(value, id) {
  if (!value || typeof value !== 'object' || value.schema !== AGENT_SCHEMA || value.id !== id || !ID_RE.test(id) || id === MAIN_AGENT_ID) return null
  if (value.harness !== 'hermes' || !['private', 'standard'].includes(value.privacy)) return null
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

/** Harness config for a container Hermes. The file is Service-owned; the owner edits the agent through the API. */
export function hermesConfigYaml(agent, { tinfoilUrl = '', contextLength = 0 } = {}) {
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
  lines.push('agent:', `  disabled_toolsets: [${disabled.map(yamlString).join(', ')}]`)
  // agent.disabled_toolsets is applied last for every platform, the API server included (hermes_cli/tools_config).
  // No app gateway, no shared skills for an agent without apps: nothing outside its own home is reachable.
  if (!agent.permissions.wizard_apps.length && !agent.permissions.agent_apps.length) lines.push('mcp_servers: {}')
  lines.push('memory:', '  memory_enabled: true', '  user_profile_enabled: true')
  return `${lines.join('\n')}\n`
}

export function agentEnvFile({ apiKey }) {
  return [
    '# Managed by the Wizard OS Agent Service. Secrets for this agent only; the runtime adds provider keys below.',
    `API_SERVER_KEY=${apiKey}`,
    'API_SERVER_HOST=0.0.0.0',
    'API_SERVER_PORT=8642',
    '',
  ].join('\n')
}

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
  const statusCache = new Map()

  const mainAgent = () => ({
    schema: AGENT_SCHEMA, id: MAIN_AGENT_ID, label: mainLabel, harness: 'hermes', privacy: 'standard',
    appearance: normalizeAppearance(options.mainAppearance, 'standard'),
    model: { provider: 'host', model: '', allowed_models: [], fallback: true },
    permissions: { preset: 'standard', outside_tools: OUTSIDE_TOOLS.map((tool) => tool.id), files: 'shared-write', wizard_apps: [], agent_apps: [], other_agents: 'none' },
    runtime: { kind: 'external' },
  })

  const folder = (id) => join(agentsDir, id)
  const read = (id) => {
    if (id === MAIN_AGENT_ID) return mainAgent()
    if (typeof id !== 'string' || !ID_RE.test(id)) return null
    return parseAgentFile(readJson(join(folder(id), 'agent.json')), id)
  }
  const list = () => {
    let names = []
    try { names = readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() } catch { names = [] }
    return [mainAgent(), ...names.map(read).filter(Boolean)]
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
  const upstream = (agent) => {
    if (agent.id === MAIN_AGENT_ID) return null
    if (upstreamMode === 'network') {
      const url = new URL(String(agent.runtime.api || ''))
      if (url.protocol !== 'http:' || url.hostname !== agent.runtime.app_id || url.username || url.password || url.pathname !== '/') {
        throw new AgentError(502, 'agent_unreachable', 'agent.runtime.api')
      }
      return url.origin
    }
    return `http://${upstreamHost}:${agent.runtime.port}`
  }

  async function probe(agent) {
    const cached = statusCache.get(agent.id)
    if (cached && now() - cached.at < 3000) return cached.value
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

  async function status(agent) {
    if (agent.id === MAIN_AGENT_ID) return options.mainStatus ? await options.mainStatus() : { status: 'running', status_detail: '' }
    return probe(agent)
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

  function nextPort() {
    const used = new Set(list().map((agent) => agent.runtime?.port).filter(Number.isInteger))
    let port = basePort
    while (used.has(port)) port += 1
    return port
  }

  function writeHarnessFiles(agent, { rotateKey = false } = {}) {
    const dir = folder(agent.id)
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true, mode: 0o700 })
    let key = rotateKey ? '' : apiKey(agent.id)
    if (!key) {
      key = randomBytes(32).toString('base64url')
      writeTextAtomic(join(dir, 'runtime.key'), `${key}\n`)
    }
    // Provider keys (TINFOIL_API_KEY) are added by the runtime driver on the host; the Service never holds them.
    writeTextAtomic(join(home, '.env'), agentEnvFile({ apiKey: key }))
    writeTextAtomic(join(home, 'config.yaml'), hermesConfigYaml(agent, { tinfoilUrl: options.tinfoilUrl, contextLength: options.contextLength }))
  }

  const idempotency = () => readJson(idempotencyPath) ?? {}

  async function create(body, { idempotencyKey = '' } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'agent.body')
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
      runtime: { kind: 'container', app_id: `agent-${id}`, api: `http://agent-${id}:8642`, port: nextPort(), image: options.image || '' },
      created_at: Math.floor(now() / 1000),
    }
    assertPrivateWalls(agent)
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
    if (id === MAIN_AGENT_ID) fail(409, 'main_agent_read_only', 'agent.main', 'the main agent is configured in Hermes itself')
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'agent.body')
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
        // Only an explicit downgrade gets here; the agent stops being private.
        next.privacy = 'standard'
      }
    }
    assertPrivateWalls(next)
    const harnessChanged = JSON.stringify([agent.model, agent.permissions]) !== JSON.stringify([next.model, next.permissions])
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

  // Thread pins: session id -> agent id, set when the thread is created. Absent = the main agent.
  let pinsCache = null
  const pins = () => {
    if (!pinsCache) pinsCache = readJson(threadsPath)?.threads ?? {}
    return pinsCache
  }
  function pinnedAgent(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return ''
    return pins()[sessionId] ?? ''
  }
  function pin(sessionId, agentId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || agentId === MAIN_AGENT_ID) return
    const current = pins()
    if (current[sessionId] === agentId) return
    if (current[sessionId] && current[sessionId] !== agentId) fail(409, 'thread_agent_pinned', 'thread.agent_pinned')
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
    pinsCache = { ...current, [sessionId]: agentId }
    writeJsonAtomic(threadsPath, { schema: 1, threads: pinsCache })
  }
  const runs = new Map()
  function noteRun(runId, agentId) {
    if (!runId) return
    runs.set(runId, agentId)
    if (runs.size > 512) runs.delete(runs.keys().next().value)
  }

  return {
    agentsDir, list, read, status, upstream, apiKey, agentOptions, providers, create, update, setRunning,
    pinnedAgent, pin, runAgent: (runId) => runs.get(runId) ?? '', noteRun,
    publicAgent: async (agent) => publicAgent(agent, await status(agent)),
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
