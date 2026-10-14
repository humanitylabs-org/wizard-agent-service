// Wizard OS settings, the bootstrap payload and the app list for Wizard front ends.
//
// One small file, $WIZARD_OS_HOME/settings.json (default ~/.wizard-os/settings.json), holds the
// few facts every Wizard OS piece needs and no agent stores for us: who the user is, what they
// call their agent, their clock. The Agent Service owns the format; front ends read it through
// GET /wizard/v1/bootstrap and never hardcode any of it.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export const BOOTSTRAP_VERSION = 1
export const DEFAULT_AGENT_NAME = 'Wizard'

export function wizardOsHome(env = process.env) {
  return resolve(env.WIZARD_OS_HOME || resolve(env.HOME || homedir(), '.wizard-os'))
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max) : ''
}

export function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return ''
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value } catch { return '' }
}

/** One https origin, no path ('https://wizard.example.ts.net'); anything else is ''. Loopback http is allowed for a box with no tailnet yet. */
export function validOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 300) return ''
  let u
  try { u = new URL(value) } catch { return '' }
  const loopback = u.protocol === 'http:' && /^(?:localhost|127\.0\.0\.1|\[::1\])$/u.test(u.hostname)
  if ((u.protocol !== 'https:' && !loopback) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return ''
  return u.origin
}

function validHost(value) {
  return typeof value === 'string' && /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu.test(value) ? value.toLowerCase() : ''
}

/** The exact Tailscale HTTPS origin of this box ('https://wizard.tail1234.ts.net'), or ''. */
export function validTailnetOrigin(value) {
  const origin = validOrigin(value)
  if (!origin) return ''
  const u = new URL(origin)
  return u.protocol === 'https:' && /^[a-z0-9.-]+\.ts\.net$/u.test(u.hostname) ? origin : ''
}

/** A Tailscale login name as Serve reports it (lower-cased), or ''. */
export function validLogin(value) {
  if (typeof value !== 'string') return ''
  const login = value.trim().toLowerCase()
  return login && login.length <= 320 && !/[\s\x00-\x1f\x7f,]/u.test(login) ? login : ''
}

function validStamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) && Number.isFinite(Date.parse(value)) ? value : ''
}

function validDayStart(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value) ? value : '00:00'
}

/** Normalised settings. Unknown fields are ignored; nothing here is secret. */
export function normalizeSettings(raw, { canStartAgent = (id) => id === 'hermes' } = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const owner = value.owner && typeof value.owner === 'object' ? value.owner : {}
  const agent = value.agent && typeof value.agent === 'object' ? value.agent : {}
  const clock = value.clock && typeof value.clock === 'object' ? value.clock : {}
  const voice = value.voice && typeof value.voice === 'object' ? value.voice : {}
  const fastRouter = value.fast_router && typeof value.fast_router === 'object' ? value.fast_router : {}
  const network = value.network && typeof value.network === 'object' && !Array.isArray(value.network) ? value.network : {}
  const access = value.access && typeof value.access === 'object' && !Array.isArray(value.access) ? value.access : {}
  const tailscale = access.tailscale && typeof access.tailscale === 'object' && !Array.isArray(access.tailscale) ? access.tailscale : {}
  const setup = value.setup && typeof value.setup === 'object' && !Array.isArray(value.setup) ? value.setup : {}
  const tailnetOrigin = validTailnetOrigin(tailscale.origin)
  const ownerLogins = tailnetOrigin && Array.isArray(tailscale.owner_logins)
    ? [...new Set(tailscale.owner_logins.map(validLogin).filter(Boolean))].slice(0, 1) : []
  const vocabulary = Array.isArray(voice.vocabulary)
    ? voice.vocabulary.map((word) => cleanText(word, 40)).filter(Boolean).slice(0, 80)
    : []
  return {
    schema: 1,
    agents: { default_agent_id: typeof value.agents?.default_agent_id === 'string' && canStartAgent(value.agents.default_agent_id) ? value.agents.default_agent_id : 'hermes' },
    owner: {
      name: cleanText(owner.name, 80),
      place: cleanText(owner.place, 80),
    },
    agent: {
      name: cleanText(agent.name, 40) || DEFAULT_AGENT_NAME,
      // 'hermes-plugin': the wizard-os Hermes plugin puts the Wizard OS kernel in the agent's system prompt, so
      // runs carry only app changes. '' (any other harness): every run carries the full kernel.
      adapter: agent.adapter === 'hermes-plugin' ? 'hermes-plugin' : '',
    },
    clock: {
      // Empty means "use the device's own time zone"; that is right for a person carrying a phone.
      timezone: validTimeZone(clock.timezone),
      day_starts_at: validDayStart(clock.day_starts_at),
    },
    voice: {
      language: cleanText(voice.language, 12) || '',
      vocabulary,
    },
    // The fast model that sorts orb utterances into phone commands vs agent requests. It is not the
    // agent: these calls never go through Hermes. `account` names which connected account pays for
    // it (claude, chatgpt, tinfoil, ...); until Wizard OS has a shared accounts service, `endpoint`
    // + `key_env` say how to reach it. The key itself never lives in this file.
    fast_router: {
      account: cleanText(fastRouter.account, 40),
      model: cleanText(fastRouter.model, 120),
      endpoint: typeof fastRouter.endpoint === 'string' && /^https?:\/\/[^\s]+$/u.test(fastRouter.endpoint) ? fastRouter.endpoint.slice(0, 300) : '',
      key_env: typeof fastRouter.key_env === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(fastRouter.key_env) ? fastRouter.key_env : '',
    },
    // How this box is reached. Inside Wizard every link is a path ("/cinequeue/"), so it opens on whatever
    // address the device already uses (localhost on the Mac, the tailnet name on a phone) and none of this
    // is needed. base_url is only for links that leave Wizard (a message, an email, a QR code): '' until the
    // box has a reachable address (e.g. after "Connect your phone" turns on Tailscale), then its https origin.
    // aliases are this box's former hostnames; front ends fold links to them back into paths.
    network: {
      base_url: validOrigin(network.base_url),
      aliases: Array.isArray(network.aliases) ? [...new Set(network.aliases.map(validHost).filter(Boolean))].slice(0, 8) : [],
    },
    // Who may use this box through Tailscale Serve (tailnet-access.mjs), written by "Connect your phone"
    // (phone-setup.mjs) once the box is signed in and serving: the exact https origin and the one Tailscale
    // login that owns this node. Both or neither: an origin without an owner authorizes nobody. This is an
    // authorization input: settings.json must be writable only by the Service and owner-trusted box tools.
    access: {
      tailscale: tailnetOrigin && ownerLogins.length ? { origin: tailnetOrigin, owner_logins: ownerLogins } : { origin: '', owner_logins: [] },
    },
    // Setup app progress (ISO times, '' = not yet): the first-run checklist was seen, phone setup was
    // started, and the owner's phone was first seen.
    setup: {
      seen_at: validStamp(setup.seen_at),
      phone_started_at: validStamp(setup.phone_started_at),
      phone_seen_at: validStamp(setup.phone_seen_at),
    },
  }
}

/** An absolute link for use outside Wizard: base_url + path. '' when this box has no outside address yet. */
export function externalUrl(settings, path = '/') {
  const base = settings?.network?.base_url || ''
  if (!base) return ''
  const p = String(path || '/')
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return ''
  return base + p
}

/** The router to call for this request: settings first, then the service's env defaults. */
export function resolveFastRouter(settings, fallback = null, env = process.env) {
  const r = settings?.fast_router
  if (r?.endpoint && r?.model) return { url: r.endpoint, model: r.model, key: r.key_env ? String(env[r.key_env] || '') : '', account: r.account || '' }
  return fallback && fallback.url && fallback.model ? { ...fallback, account: fallback.account || '' } : null
}

/** Read settings.json on every call (it is tiny), so edits apply without a restart. */
export function readSettings(path, options = {}) {
  if (!path || !existsSync(path)) return { settings: normalizeSettings({}, options), source: 'default' }
  try {
    if (statSync(path).size > 64 * 1024) throw new Error('too large')
    return { settings: normalizeSettings(JSON.parse(readFileSync(path, 'utf8')), options), source: 'file' }
  } catch {
    return { settings: normalizeSettings({}, options), source: 'invalid' }
  }
}

/**
 * Change settings.json: `mutate(raw)` edits the parsed file in place. Fields this service does not
 * know survive (other Wizard OS pieces write their own keys); the result must still normalise. Writes
 * are atomic (temp file + rename). A file that exists but is not valid JSON is never overwritten.
 * Returns the normalised settings.
 */
export function updateSettings(path, mutate) {
  if (!path) throw Object.assign(new Error('settings path not configured'), { code: 'settings_unavailable' })
  let raw = { schema: 1 }
  if (existsSync(path)) {
    if (statSync(path).size > 64 * 1024) throw Object.assign(new Error('settings too large'), { code: 'settings_invalid' })
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { throw Object.assign(new Error('settings unreadable'), { code: 'settings_invalid' }) }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('settings unreadable'), { code: 'settings_invalid' })
  }
  mutate(raw)
  const text = `${JSON.stringify(raw, null, 1)}\n`
  if (Buffer.byteLength(text) > 64 * 1024) throw Object.assign(new Error('settings too large'), { code: 'settings_invalid' })
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o644 })
  renameSync(temporary, path)
  return normalizeSettings(raw)
}

function readJsonFile(path, limit = 2 * 1024 * 1024) {
  if (!path || !existsSync(path)) return null
  try {
    if (statSync(path).size > limit) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch { return null }
}

const SAFE_URL = /^(?:\/[^\s]*|https:\/\/[^\s]+)$/u

/**
 * The launcher list: installed Wizard apps from the App Manager's apps.json, plus the owner's own
 * links from launcher.json. Only what a front end needs to draw and open a tile leaves the box.
 */
export function readApps({ appsJsonPath, launcherPath }) {
  const out = []
  const seen = new Set()
  const installed = readJsonFile(appsJsonPath)
  for (const app of Array.isArray(installed?.apps) ? installed.apps : []) {
    const id = cleanText(app?.id, 64)
    if (!id || seen.has(id)) continue
    // The shell is the thing drawing the launcher; it never gets a tile of its own.
    if (Array.isArray(app.provides) && app.provides.includes('shell')) continue
    // Agents are not apps (spec/AGENTS.md): an agent's container never gets a launcher tile; it lives in Agents.
    if (id.startsWith('agent-') && (app.type === 'agent' || app.category === 'agent')) continue
    const view = typeof app.view === 'string' && SAFE_URL.test(app.view) ? app.view
      : app.view && typeof app.view.url === 'string' && SAFE_URL.test(app.view.url) ? app.view.url : ''
    seen.add(id)
    out.push({
      id, name: cleanText(app.name, 60) || id, desc: cleanText(app.summary, 120),
      url: view, status: cleanText(app.status, 24), system: app.system === true, source: 'apps.json',
      receives_voice_input: !!view && app.receives_voice_input === true,
    })
  }
  const launcher = readJsonFile(launcherPath, 256 * 1024)
  for (const link of Array.isArray(launcher?.links) ? launcher.links : []) {
    const id = cleanText(link?.id, 64)
    const url = typeof link?.url === 'string' && SAFE_URL.test(link.url) ? link.url : ''
    if (!id || !url || seen.has(id)) continue
    seen.add(id)
    out.push({
      id, name: cleanText(link.name, 60) || id, desc: cleanText(link.desc, 120), url,
      icon: cleanText(link.icon, 8), colors: Array.isArray(link.colors) ? link.colors.filter((c) => typeof c === 'string' && /^#[0-9a-f]{3,8}$/iu.test(c)).slice(0, 2) : [],
      ...(link.desktop_only === true ? { desktop_only: true } : {}), source: 'launcher.json',
      receives_voice_input: link.receives_voice_input === true,
    })
  }
  return { schema: 1, apps: out }
}

/**
 * The Wizard OS block every agent run gets (WORK_OUTSTANDING: "instruction injection"): the agent
 * is inside Wizard OS, and these apps are installed, with the MCP endpoint and skill file to use.
 * Built from apps.json on each run, so an install or uninstall takes effect on the next message.
 * Returns '' when no app is installed, so a box without the App Manager gets a plain run.
 */
// mcpAddress 'internal': the agent runs in a container on the box's private network, so it reaches apps
// by service name (apps.json mcp.internal). skillsInline: the agent cannot read this service's files, so
// each app's skill text travels in the instructions instead of a path.
export function wizardOsInstructions({ appsJsonPath, mcpAddress = 'url', skillsInline = false }) {
  const installed = readJsonFile(appsJsonPath)
  const apps = Array.isArray(installed?.apps) ? installed.apps : []
  const home = appsJsonPath ? dirname(appsJsonPath) : ''
  const lines = []
  for (const app of apps.slice(0, 40)) {
    const id = cleanText(app?.id, 64)
    if (!id || (app.status && cleanText(app.status, 24) !== 'running')) continue
    const parts = [`- ${cleanText(app.name, 60) || id} (\`${id}\`): ${cleanText(app.summary, 200)}`]
    const provides = Array.isArray(app.provides) ? app.provides.map((v) => cleanText(v, 40)).filter(Boolean) : []
    if (provides.length) parts.push(`Jobs: ${provides.join(', ')}.`)
    const mcp = cleanText(mcpAddress === 'internal' ? (app.mcp?.internal || app.mcp?.url) : app.mcp?.url, 300)
    if (mcp) parts.push(`MCP (${cleanText(app.mcp?.transport, 40) || 'streamable-http'}): ${mcp}.`)
    const skill = cleanText(app.skill, 200)
    if (skill && home && !skill.includes('..')) {
      if (!skillsInline) parts.push(`Read its skill first: ${resolve(home, skill)}.`)
      else {
        let text = ''
        try { text = readFileSync(resolve(home, skill), 'utf8').slice(0, 6000) } catch { /* skill missing */ }
        if (text) parts.push(`Its skill:\n<skill app="${id}">\n${text.replace(/<\/skill>/giu, '')}\n</skill>`)
      }
    }
    lines.push(parts.join(' '))
  }
  if (!lines.length) return ''
  return `\n\nYou are an agent inside Wizard OS. These apps are installed on this box. When a request matches an app's job, use that app through its MCP endpoint and follow its skill, even if the user does not name MCP. If you save a skill for such a job, make it a short pointer to the app and its skill file, never a copy of the app's workflow.\n${lines.join('\n')}`
}

export function bootstrapPayload({ settings, settingsSource, capabilities }) {
  return {
    bootstrap: BOOTSTRAP_VERSION,
    api: 'wizard-agent-service/1',
    settings,
    settings_source: settingsSource,
    capabilities,
    endpoints: {
      apps: '/wizard/v1/apps',
      sessions: '/wizard/hermes/api/sessions',
      runs: '/wizard/hermes/v1/runs',
      transcribe: capabilities.voice ? '/wizard/voice/transcribe' : '',
      route: capabilities.router ? '/wizard/v1/route' : '',
      upload: capabilities.files ? '/wizard/files/upload' : '',
      uploads: capabilities.resumable_uploads ? '/wizard/v1/uploads' : '',
      shares: capabilities.resumable_uploads ? '/wizard/v1/shares' : '',
      user_files: capabilities.upload_destinations ? '/wizard/v1/user-files' : '',
    },
  }
}
