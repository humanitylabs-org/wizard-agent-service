// Wizard OS settings, the bootstrap payload and the app list for Wizard front ends.
//
// One small file, $WIZARD_OS_HOME/settings.json (default ~/.wizard-os/settings.json), holds the
// few facts every Wizard OS piece needs and no agent stores for us: who the user is, what they
// call their agent, their clock. The Agent Service owns the format; front ends read it through
// GET /wizard/v1/bootstrap and never hardcode any of it.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

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

function validDayStart(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value) ? value : '00:00'
}

/** Normalised settings. Unknown fields are ignored; nothing here is secret. */
export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const owner = value.owner && typeof value.owner === 'object' ? value.owner : {}
  const agent = value.agent && typeof value.agent === 'object' ? value.agent : {}
  const clock = value.clock && typeof value.clock === 'object' ? value.clock : {}
  const voice = value.voice && typeof value.voice === 'object' ? value.voice : {}
  const fastRouter = value.fast_router && typeof value.fast_router === 'object' ? value.fast_router : {}
  const network = value.network && typeof value.network === 'object' && !Array.isArray(value.network) ? value.network : {}
  const vocabulary = Array.isArray(voice.vocabulary)
    ? voice.vocabulary.map((word) => cleanText(word, 40)).filter(Boolean).slice(0, 80)
    : []
  return {
    schema: 1,
    owner: {
      name: cleanText(owner.name, 80),
      place: cleanText(owner.place, 80),
    },
    agent: {
      name: cleanText(agent.name, 40) || DEFAULT_AGENT_NAME,
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
export function readSettings(path) {
  if (!path || !existsSync(path)) return { settings: normalizeSettings({}), source: 'default' }
  try {
    if (statSync(path).size > 64 * 1024) throw new Error('too large')
    return { settings: normalizeSettings(JSON.parse(readFileSync(path, 'utf8'))), source: 'file' }
  } catch {
    return { settings: normalizeSettings({}), source: 'invalid' }
  }
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
    const view = typeof app.view === 'string' && SAFE_URL.test(app.view) ? app.view
      : app.view && typeof app.view.url === 'string' && SAFE_URL.test(app.view.url) ? app.view.url : ''
    seen.add(id)
    out.push({
      id, name: cleanText(app.name, 60) || id, desc: cleanText(app.summary, 120),
      url: view, status: cleanText(app.status, 24), system: app.system === true, source: 'apps.json',
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
    })
  }
  return { schema: 1, apps: out }
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
    },
  }
}
