// Box-wide shell preferences, separate from operator-owned settings.json.
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
export const DEFAULT_UI_PREFERENCES = Object.freeze({ archiveAfterDays: 7, compact: false, readyOrder: 'newest', subjectOrder: [] })
const validators = {
  archiveAfterDays: v => Number.isInteger(v) && [0, 1, 3, 7, 14, 30].includes(v),
  compact: v => typeof v === 'boolean',
  readyOrder: v => ['newest', 'oldest', 'priority', 'subject'].includes(v),
  subjectOrder: v => Array.isArray(v) && v.length <= 60 && v.every(s => typeof s === 'string' && s.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(s)) && new Set(v).size === v.length,
}
export function validateUiPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(validators, k) || !validators[k](value[k]))) throw Object.assign(new Error('invalid_preferences'), { status: 400 })
  return value
}
export function readUiPreferences(path) {
  if (!existsSync(path)) return { ...DEFAULT_UI_PREFERENCES }
  if (statSync(path).size > 32768) throw new Error('preferences_too_large')
  try { return { ...DEFAULT_UI_PREFERENCES, ...validateUiPreferences(JSON.parse(readFileSync(path, 'utf8'))) } }
  catch { throw new Error('invalid_stored_preferences') }
}
// Synchronous read/merge/atomic rename prevents concurrent partial updates from losing other fields.
export function updateUiPreferences(path, patch) {
  validateUiPreferences(patch)
  const value = { ...readUiPreferences(path), ...patch }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally { if (existsSync(temp)) unlinkSync(temp) }
  return value
}
