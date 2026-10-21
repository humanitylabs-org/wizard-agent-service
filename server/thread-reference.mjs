// Service-owned history references. Never infer an old row's agent from today's default.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync, constants, chmodSync } from 'node:fs'

export const LEGACY_AGENT_ID = 'hermes'
export const validAgentId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,30}$/u.test(id)
export const threadReference = (session_id, agent_id = LEGACY_AGENT_ID) => ({ agent_id, session_id })
export function qualifyContinuation(value, sessionId = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const id = value.session_id ?? value.sessionId ?? sessionId
  return { ...value, ...(id ? threadReference(id, value.agent_id ?? LEGACY_AGENT_ID) : {}), ...(value.receipt ? { receipt: qualifyContinuation(value.receipt, id) } : {}) }
}
// JSON tuples avoid delimiter collisions (session ids themselves may contain colons).
export const threadKey = (agentId, sessionId) => JSON.stringify([agentId || LEGACY_AGENT_ID, sessionId])
export function sideReference(key, record = {}) {
  const match = /^agent\/([a-z][a-z0-9-]{0,30})\/(.+)$/u.exec(key)
  const legacyKey = match?.[2] ?? key
  const agent_id = record.agent_id ?? match?.[1] ?? LEGACY_AGENT_ID
  const session_id = legacyKey.replace(/^(direct|operator):/u, '')
  if (!validAgentId(agent_id) || (match && match[1] !== agent_id) || (record.session_id !== undefined && record.session_id !== session_id)) throw Object.assign(new Error('Invalid thread pair'), { status: 400 })
  return { agent_id, session_id, legacyKey }
}
export const sideKey = (agentId, key) => agentId === LEGACY_AGENT_ID ? key : `agent/${agentId}/${key}`
export function qualifySideRecords(records) {
  return Object.fromEntries(Object.entries(records).map(([key, record]) => {
    const pair = sideReference(key, record)
    return [sideKey(pair.agent_id, pair.legacyKey), { ...record, agent_id: pair.agent_id, session_id: pair.session_id }]
  }))
}
// Raw session-id journals must not strip a literal "direct:" or "operator:" from an imported id.
export function qualifyRawThreadRecords(records) {
  return Object.fromEntries(Object.entries(records).map(([key, record]) => {
    const match = /^agent\/([a-z][a-z0-9-]{0,30})\/(.+)$/u.exec(key)
    const session_id = match?.[2] ?? key
    const agent_id = record.agent_id ?? match?.[1] ?? LEGACY_AGENT_ID
    if (!validAgentId(agent_id) || (match && match[1] !== agent_id) || (record.session_id !== undefined && record.session_id !== session_id)) throw new Error('Invalid thread journal pair')
    return [sideKey(agent_id, session_id), { ...record, agent_id, session_id }]
  }))
}
// Optional projections must preserve corrupt bytes, including on later writes.
export function migrateOptionalJson(path, transform) {
  try { migrateJson(path, transform); return true }
  catch { console.warn('[agent-pairs] optional metadata unavailable; original bytes preserved'); return false }
}
export function backupJson(path) {
  const backup = `${path}.pre-agent-pairs-v1.bak`
  if (!existsSync(backup)) {
    copyFileSync(path, backup, constants.COPYFILE_EXCL)
    chmodSync(backup, 0o600)
  }
  return backup
}
export function migrateJson(path, transform) {
  if (!path || !existsSync(path)) return false
  const old = JSON.parse(readFileSync(path, 'utf8'))
  const next = transform(structuredClone(old))
  if (JSON.stringify(old) === JSON.stringify(next)) return false
  backupJson(path)
  const temporary = `${path}.${process.pid}.agent-pairs.tmp`
  writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
  renameSync(temporary, path)
  return true
}
export function migrateJsonLines(path, transform = qualifyContinuation) {
  if (!path || !existsSync(path)) return false
  const old = readFileSync(path, 'utf8')
  const next = old.split('\n').map(line => line.trim() ? JSON.stringify(transform(JSON.parse(line))) : line).join('\n')
  if (next === old) return false
  backupJson(path)
  const temporary = `${path}.${process.pid}.agent-pairs.tmp`
  writeFileSync(temporary, next, { mode: 0o600 })
  renameSync(temporary, path)
  return true
}
// VACUUM INTO captures committed WAL pages as well as the main SQLite file. A failed backup aborts migration.
export function backupSqlite(db, path) {
  const backup = `${path}.pre-agent-pairs-v1.bak`
  if (!existsSync(backup)) {
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
    chmodSync(backup, 0o600)
  }
  return backup
}
