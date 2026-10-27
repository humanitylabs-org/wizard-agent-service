// Box-wide shell preferences, separate from operator-owned settings.json.
// The calendar date must exist: Date.parse would quietly turn 2026-02-31 into 3 March.
const realDate = v => { const [y, m, d] = v.slice(0, 10).split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return Number.isFinite(Date.parse(v)) && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && +v.slice(11, 13) < 24 && +v.slice(14, 16) < 60 && +v.slice(17, 19) < 60 }
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
export const DEFAULT_UI_PREFERENCES = Object.freeze({ archiveAfterDays: 7, compact: false, chatLayout: 'day', readyOrder: 'newest', subjectOrder: [], pinnedChats: [], spaces: [] })
// 50 spaces × 500 thread ids (up to 180 chars), plus existing preferences.
export const UI_PREFERENCES_MAX_BYTES = 5 * 1024 * 1024
const THREAD_ID = /^[A-Za-z0-9._:-]{1,180}$/
const SPACE_ID = /^[a-z0-9-]{1,48}$/
const validSpace = s => !!s && typeof s === 'object' && !Array.isArray(s)
  && Object.keys(s).every(k => ['id', 'name', 'threads', 'createdAt', 'agent'].includes(k)) && ['id', 'name', 'threads', 'createdAt'].every(k => Object.hasOwn(s, k))
  && (!Object.hasOwn(s, 'agent') || (typeof s.agent === 'string' && /^[a-z0-9][a-z0-9-]{0,47}(?![\s\S])/u.test(s.agent)))
  && typeof s.id === 'string' && SPACE_ID.test(s.id)
  && typeof s.name === 'string' && s.name.trim().length > 0 && s.name.length <= 60 && !/[\u0000-\u001f\u007f]/u.test(s.name)
  && Array.isArray(s.threads) && s.threads.length <= 500 && s.threads.every(id => typeof id === 'string' && THREAD_ID.test(id)) && new Set(s.threads).size === s.threads.length
  && typeof s.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s.createdAt) && realDate(s.createdAt)
const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}(?![\s\S])/u
const MARKER = /^[a-z0-9][a-z0-9._-]{0,79}(?![\s\S])/u
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v)
const ids = v => Array.isArray(v) && v.length <= 100 && v.every(id => typeof id === 'string' && APP_ID.test(id)) && new Set(v).size === v.length
const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z(?![\s\S])/u.test(v) && realDate(v)
const nativeLink = a => isPlainObject(a) && Object.keys(a).every(k => ['id', 'name', 'icon', 'colors', 'href', 'phoneOnly', 'desc'].includes(k))
  && typeof a.id === 'string' && APP_ID.test(a.id) && text(a.name, 80) && text(a.icon, 160) && text(a.href, 2048)
  && /^(?:https?:\/\/[^\s]+|tel:[+0-9*#;,]*|sms:[+0-9;,]*|intent:(?:\/\/)?#Intent;[^\s]*;end)$/.test(a.href)
  && (!Object.hasOwn(a, 'desc') || text(a.desc, 240))
  && (!Object.hasOwn(a, 'phoneOnly') || typeof a.phoneOnly === 'boolean')
  && (!Object.hasOwn(a, 'colors') || (Array.isArray(a.colors) && a.colors.length >= 1 && a.colors.length <= 2 && a.colors.every(c => /^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?![\s\S])/iu.test(c))))
const launcherValidators = {
  nativeLinks: v => Array.isArray(v) && v.length <= 50 && v.every(nativeLink) && new Set(v.map(a => a.id)).size === v.length,
  recents: ids, desktopQuick: ids, autoOpen: ids, hostedThreadApps: ids,
  displayNames: v => isPlainObject(v) && Object.keys(v).length <= 100 && Object.entries(v).every(([k, name]) => APP_ID.test(k) && text(name, 80)),
}
const validLauncher = v => isPlainObject(v) && Object.entries(v).every(([k, value]) => Object.hasOwn(launcherValidators, k) && launcherValidators[k](value))
const validMigrations = v => isPlainObject(v) && Object.keys(v).length <= 100 && Object.entries(v).every(([k, value]) => MARKER.test(k) && iso(value))
const validators = {
  launcher: validLauncher,
  migrations: validMigrations,
  spaces: v => Array.isArray(v) && v.length <= 50 && v.every(validSpace) && new Set(v.map(s => s.id)).size === v.length,
  archiveAfterDays: v => Number.isInteger(v) && [0, 1, 3, 7, 14, 30].includes(v),
  compact: v => typeof v === 'boolean',
  // Chats list layout: 'day' (Ready, Yesterday, Past week) or 'status' (Working, Ready, Archive).
  chatLayout: v => v === 'day' || v === 'status',
  readyOrder: v => ['newest', 'oldest', 'priority', 'subject'].includes(v),
  subjectOrder: v => Array.isArray(v) && v.length <= 60 && v.every(s => typeof s === 'string' && s.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(s)) && new Set(v).size === v.length,
  // Pinned Chats threads, in pin order, shared by every device of the owner.
  pinnedChats: v => Array.isArray(v) && v.length <= 300 && v.every(s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,180}$/.test(s)) && new Set(v).size === v.length,
}
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

// Strict: PUT bodies only. Unknown keys or invalid values are a 400.
export function validateUiPreferences(value) {
  if (!isPlainObject(value) || Object.keys(value).some(k => !Object.hasOwn(validators, k) || !validators[k](value[k]))) throw Object.assign(new Error('invalid_preferences'), { status: 400 })
  return value
}

// Lenient: the stored file may have been written by a newer or older service or shell.
// Keep each known key whose value is valid here and default everything else, per key.
export function sanitizeUiPreferences(stored) {
  const out = { ...DEFAULT_UI_PREFERENCES, subjectOrder: [], pinnedChats: [], spaces: [] }
  if (!isPlainObject(stored)) return out
  for (const key of Object.keys(validators)) if (Object.hasOwn(stored, key) && validators[key](stored[key])) out[key] = stored[key]
  return out
}

// Raw stored object, or null when absent, oversized, unreadable, unparseable or not an object.
function readStored(path) {
  try {
    if (!existsSync(path) || statSync(path).size > UI_PREFERENCES_MAX_BYTES) return null
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return isPlainObject(value) ? value : null
  } catch { return null }
}

// Reads never fail on stored content. An unusable file yields defaults and stays untouched
// on disk until the next valid PUT replaces it.
export function readUiPreferences(path) {
  return sanitizeUiPreferences(readStored(path))
}

// Synchronous read/merge/atomic rename prevents concurrent partial updates from losing other fields.
// Stored keys this version does not understand are carried forward, so a rollback does not erase
// what a newer service wrote. Responses only ever contain the sanitized known keys.
export function updateUiPreferences(path, patch) {
  validateUiPreferences(patch)
  const stored = readStored(path) || {}
  return writePreferences(path, stored, { ...stored, ...patch }, patch)
}

// No await between read/check/write: shares PUT's process-local synchronous critical section.
// A marker and every missing launcher key are committed by the very same atomic rename.
export function seedUiPreferences(path, body) {
  if (!isPlainObject(body) || Object.keys(body).some(k => !['marker', 'launcher'].includes(k))
    || typeof body.marker !== 'string' || !MARKER.test(body.marker) || !validLauncher(body.launcher))
    throw Object.assign(new Error('invalid_preferences'), { status: 400 })
  const stored = readStored(path)
  // Never turn a corrupt owner's file into migration defaults.
  if (!stored && existsSync(path)) throw new Error('preferences_unavailable')
  const raw = stored || {}
  if (isPlainObject(raw.migrations) && Object.hasOwn(raw.migrations, body.marker))
    return { seeded: false, preferences: sanitizeUiPreferences(raw) }
  if ((Object.hasOwn(raw, 'launcher') && !validLauncher(raw.launcher))
    || (Object.hasOwn(raw, 'migrations') && !validMigrations(raw.migrations))) throw new Error('preferences_unavailable')
  const next = { ...raw, launcher: { ...body.launcher, ...raw.launcher },
    migrations: { ...raw.migrations, [body.marker]: new Date().toISOString() } }
  validateUiPreferences({ launcher: next.launcher, migrations: next.migrations })
  return { seeded: true, preferences: writePreferences(path, raw, next) }
}

function writePreferences(path, stored, next, patch = null) {
  let text = JSON.stringify(next) + '\n'
  if (patch && Buffer.byteLength(text) > UI_PREFERENCES_MAX_BYTES) { next = { ...sanitizeUiPreferences(stored), ...patch }; text = JSON.stringify(next) + '\n' }
  if (Buffer.byteLength(text) > UI_PREFERENCES_MAX_BYTES) throw Object.assign(new Error('invalid_preferences'), { status: 400 })
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally { if (existsSync(temp)) unlinkSync(temp) }
  return sanitizeUiPreferences(next)
}
