// Box-wide shell preferences, separate from operator-owned settings.json.
// The calendar date must exist: Date.parse would quietly turn 2026-02-31 into 3 March.
const realDate = v => { const [y, m, d] = v.slice(0, 10).split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return Number.isFinite(Date.parse(v)) && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && +v.slice(11, 13) < 24 && +v.slice(14, 16) < 60 && +v.slice(17, 19) < 60 }
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
export const DEFAULT_UI_PREFERENCES = Object.freeze({ archiveAfterDays: 7, compact: false, readyOrder: 'newest', subjectOrder: [], pinnedChats: [], spaces: [] })
// 50 spaces × 500 thread ids (up to 180 chars), plus existing preferences.
export const UI_PREFERENCES_MAX_BYTES = 5 * 1024 * 1024
const THREAD_ID = /^[A-Za-z0-9._:-]{1,180}$/
const SPACE_ID = /^[a-z0-9-]{1,48}$/
const validSpace = s => !!s && typeof s === 'object' && !Array.isArray(s)
  && Object.keys(s).length === 4 && ['id', 'name', 'threads', 'createdAt'].every(k => Object.hasOwn(s, k))
  && typeof s.id === 'string' && SPACE_ID.test(s.id)
  && typeof s.name === 'string' && s.name.trim().length > 0 && s.name.length <= 60 && !/[\u0000-\u001f\u007f]/u.test(s.name)
  && Array.isArray(s.threads) && s.threads.length <= 500 && s.threads.every(id => typeof id === 'string' && THREAD_ID.test(id)) && new Set(s.threads).size === s.threads.length
  && typeof s.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s.createdAt) && realDate(s.createdAt)
const validators = {
  spaces: v => Array.isArray(v) && v.length <= 50 && v.every(validSpace) && new Set(v.map(s => s.id)).size === v.length,
  archiveAfterDays: v => Number.isInteger(v) && [0, 1, 3, 7, 14, 30].includes(v),
  compact: v => typeof v === 'boolean',
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
  let next = { ...stored, ...patch }
  let text = JSON.stringify(next) + '\n'
  if (Buffer.byteLength(text) > UI_PREFERENCES_MAX_BYTES) { next = { ...sanitizeUiPreferences(stored), ...patch }; text = JSON.stringify(next) + '\n' }
  if (Buffer.byteLength(text) > UI_PREFERENCES_MAX_BYTES) throw Object.assign(new Error('invalid_preferences'), { status: 400 })
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally { if (existsSync(temp)) unlinkSync(temp) }
  return sanitizeUiPreferences(next)
}
