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
  }
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
