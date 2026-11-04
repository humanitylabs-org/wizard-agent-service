// App → agent binding (wizard-os spec/AGENTS.md "App → agent binding").
//
// An app that produces work for an agent (recording recaps, reports, automations) declares `agent_binding` in its
// wizard.md; the App Manager copies it into apps.json. The owner picks which agent each such app routes through.
// The binding lives here, per installed app, in <wizard-os home>/app-bindings.json:
//     {"schema": 1, "apps": {"<app_id>": {"agent": "<agent id>", "set_at": <unix s>}}}
// No entry = the main agent. Apps deliver through POST /wizard/v1/apps/<app_id>/deliveries with their own
// app-scoped token (<wizard-os home>/app-tokens/<app_id>, created by the Service, handed to the app by the
// installer). An app never names an agent: the Service resolves the binding. A bound agent that is missing or down
// fails the delivery loudly; there is no fallback to another agent.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AgentError, MAIN_AGENT_ID } from './agents.mjs'

const APP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const KEY_RE = /^[A-Za-z0-9._:-]{1,160}$/u
const fail = (status, error, check, detail) => { throw new AgentError(status, error, check, detail) }

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeAtomic(path, text, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ').trim().slice(0, max) : ''
}

/** The `agent_binding` declaration from an apps.json entry, or null when the app declares none. */
export function bindingDeclaration(app) {
  const value = app?.agent_binding
  if (value === true) return { required: false, purpose: '' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return { required: value.required === true, purpose: cleanText(value.purpose, 120) }
}

/** Session id for an app delivery thread: stable per (app, thread), never chosen by the app. */
export function appThreadId(appId, thread) {
  return `wizard_app_${appId.replace(/[^A-Za-z0-9-]/gu, '-')}_${createHash('sha256').update(`${appId}\n${thread}`).digest('hex').slice(0, 20)}`
}

export function createAppBindings({ osHome, registry, appsJsonPath, launcherPath = '', now = () => Date.now() }) {
  const home = resolve(String(osHome))
  const bindingsPath = join(home, 'app-bindings.json')
  const tokensDir = join(home, 'app-tokens')

  /** Owner links from launcher.json (spec/AGENT_SERVICE_API.md "launcher list"): an app that runs outside the App
   * Manager can declare `agent_binding` on its link. App Manager entries win on an id collision. */
  const launcherLinks = () => {
    const links = launcherPath ? readJson(launcherPath)?.links : null
    return Array.isArray(links) ? links : []
  }

  /** Installed apps (apps.json, then launcher links) that declare an agent binding: [{id, label, required, purpose}]. */
  function bindingApps() {
    const apps = readJson(appsJsonPath)?.apps
    const out = []
    for (const app of [...(Array.isArray(apps) ? apps : []), ...launcherLinks()]) {
      const id = typeof app?.id === 'string' ? app.id : ''
      if (!APP_ID_RE.test(id) || out.some((item) => item.id === id)) continue
      const declared = bindingDeclaration(app)
      if (!declared) continue
      out.push({ id, label: cleanText(app.name, 40) || id, ...declared })
    }
    return out
  }

  const stored = () => {
    const value = readJson(bindingsPath)
    return value?.schema === 1 && value.apps && typeof value.apps === 'object' ? value.apps : {}
  }

  function agentFor(appId) {
    const entry = stored()[appId]
    return !entry || entry.is_default === true || entry.agent === 'default' ? (registry.defaultAgentId?.() ?? MAIN_AGENT_ID) : typeof entry.agent === 'string' && entry.agent ? entry.agent : (registry.defaultAgentId?.() ?? MAIN_AGENT_ID)
  }

  function declared(appId) {
    if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) fail(404, 'app_not_found', 'app.id')
    const app = bindingApps().find((item) => item.id === appId)
    if (!app) {
      const installed = [...(readJson(appsJsonPath)?.apps ?? []), ...launcherLinks()].some?.((item) => item?.id === appId)
      fail(installed ? 409 : 404, installed ? 'binding_not_declared' : 'app_not_found', installed ? 'app.agent_binding' : 'app.id')
    }
    return app
  }

  function view(app) {
    const agentId = agentFor(app.id)
    const agent = registry.read(agentId)
    return {
      app_id: app.id, label: app.label, required: app.required, purpose: app.purpose,
      agent: agentId, is_default: !stored()[app.id] || stored()[app.id].is_default === true || stored()[app.id].agent === 'default',
      agent_info: agent ? registry.threadAgent(agent) : null,
      ...(agent ? {} : { problem: 'agent_missing' }),
    }
  }

  function get(appId) {
    const app = declared(appId)
    ensureToken(app.id)
    return view(app)
  }

  function set(appId, body) {
    const app = declared(appId)
    const agentId = body?.agent === 'default' || body?.is_default === true ? (registry.defaultAgentId?.() ?? MAIN_AGENT_ID) : body?.agent
    if (typeof agentId !== 'string' || !agentId) fail(400, 'agent_required', 'app.binding.agent')
    if (!registry.read(agentId)) fail(404, 'agent_not_found', 'agent.id')
    if (registry.read(agentId)?.role === 'recovery') fail(409, 'recovery_agent_sealed', 'agent.recovery_sealed')
    const apps = { ...stored() }
    if ((body?.is_default !== false && agentId === (registry.defaultAgentId?.() ?? MAIN_AGENT_ID)) || body?.agent === 'default') delete apps[app.id]
    else apps[app.id] = { agent: agentId, set_at: Math.floor(now() / 1000) }
    mkdirSync(home, { recursive: true, mode: 0o700 })
    writeAtomic(bindingsPath, `${JSON.stringify({ schema: 1, apps }, null, 2)}\n`)
    ensureToken(app.id)
    return view(app)
  }

  /** Apps that send work to this agent (default-bound apps count for the main agent). */
  function appsFor(agentId) {
    return bindingApps().filter((app) => agentFor(app.id) === agentId).map((app) => ({ id: app.id, label: app.label, purpose: app.purpose }))
  }

  function list() {
    return bindingApps().map(view)
  }

  function tokenPath(appId) { return join(tokensDir, appId) }

  function ensureToken(appId) {
    try { const t = readFileSync(tokenPath(appId), 'utf8').trim(); if (t) return t } catch { /* create */ }
    mkdirSync(tokensDir, { recursive: true, mode: 0o700 })
    const token = randomBytes(32).toString('base64url')
    try { writeFileSync(tokenPath(appId), `${token}\n`, { mode: 0o600, flag: 'wx' }) } catch { return readFileSync(tokenPath(appId), 'utf8').trim() }
    return token
  }

  function tokenOk(appId, bearer) {
    if (!APP_ID_RE.test(appId) || !bearer) return false
    let token = ''
    try { token = readFileSync(tokenPath(appId), 'utf8').trim() } catch { return false }
    const a = Buffer.from(token)
    const b = Buffer.from(String(bearer))
    return token.length >= 24 && a.length === b.length && timingSafeEqual(a, b)
  }

  /** Validate an app's delivery body and turn it into the per-agent delivery payload. */
  function deliveryPayload(appId, body) {
    const key = body?.delivery_key
    if (typeof key !== 'string' || !KEY_RE.test(key)) fail(400, 'invalid_delivery_key', 'delivery.delivery_key')
    const text = typeof body.body === 'string' ? body.body : ''
    if (!text.trim() || text.length > 400_000) fail(400, 'invalid_body', 'delivery.body')
    const title = cleanText(body.title, 60)
    if (!title) fail(400, 'title_required', 'delivery.title')
    const thread = body.thread === undefined ? key : body.thread
    if (typeof thread !== 'string' || !KEY_RE.test(thread)) fail(400, 'invalid_thread', 'delivery.thread')
    const meta = {}
    if (body.metadata !== undefined) {
      if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata) || Object.keys(body.metadata).length > 20) fail(400, 'invalid_metadata', 'delivery.metadata')
      for (const [k, v] of Object.entries(body.metadata)) {
        if (!/^[a-z][a-z0-9_]{0,39}$/u.test(k) || !['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 300) fail(400, 'invalid_metadata', 'delivery.metadata')
        meta[k] = v
      }
    }
    return {
      session_id: appThreadId(appId, thread), title, body: text,
      delivery_key: `app:${appId}:${key}`,
      display_metadata: { ...meta, app_id: appId },
    }
  }

  return { bindingsPath, tokensDir, bindingApps, agentFor, get, set, list, appsFor, ensureToken, tokenOk, deliveryPayload }
}
