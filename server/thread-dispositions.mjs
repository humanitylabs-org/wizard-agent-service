import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrateJson, atomicStoreWrite, qualifySideRecords, sideReference, sideKey, validAgentId } from './thread-reference.mjs'

const ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/
const DEVICE_MAX_CHARACTERS = 60
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const normalizedDevice = value => value.trim().replace(/\s+/gu, ' ')
const validDevice = value => typeof value === 'string' && value === normalizedDevice(value)
  && [...value].length > 0 && [...value].length <= DEVICE_MAX_CHARACTERS
const validRecord = (record) => record && typeof record.deferred === 'boolean'
  && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
  && (!owns(record, 'device') || validDevice(record.device))
const dispositionUpdate = value => {
  const update = typeof value === 'boolean' ? { deferred: value } : value
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null
  const hasDeferred = owns(update, 'deferred'), hasDevice = owns(update, 'device')
  if (!hasDeferred && !hasDevice) return null
  if (hasDeferred && typeof update.deferred !== 'boolean') return null
  if (hasDevice && typeof update.device !== 'string') return null
  const device = hasDevice ? normalizedDevice(update.device) : undefined
  if (hasDevice && device && !validDevice(device)) return null
  return { hasDeferred, hasDevice, deferred: update.deferred, device }
}

// User organization only: never archives a transcript or schedules agent work.
// Atomic replacement precedes memory publication so failed writes cannot look saved.
export class ThreadDispositionStore {
  constructor(statePath = '') {
    this.statePath = statePath
    this.scopes = new Map()
    if (!statePath || !existsSync(statePath)) return
    migrateJson(statePath, value => {
      if (value?.schema !== 1 || !value.scopes || typeof value.scopes !== 'object' || Array.isArray(value.scopes)) throw new Error('Invalid disposition authority')
      return { ...value, scopes: Object.fromEntries(Object.entries(value.scopes).map(([scope, records]) => [scope, qualifySideRecords(records)])) }
    })
    const data = JSON.parse(readFileSync(statePath, 'utf8'))
    if (data?.schema !== 1 || !data.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) throw new Error('Invalid thread disposition state')
    for (const [scope, records] of Object.entries(data.scopes)) {
      if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid thread disposition state')
      for (const [key, record] of Object.entries(records)) {
        const [runtime, ...parts] = sideReference(key, record).legacyKey.split(':')
        if (!['direct', 'operator'].includes(runtime) || !ID.test(parts.join(':')) || !validRecord(record)) throw new Error('Invalid thread disposition state')
      }
      this.scopes.set(scope, records)
    }
  }

  get(scope) { return structuredClone(this.scopes.get(scope) ?? {}) }

  clearSession(runtime, sessionId, agentId = 'hermes') {
    for (const [scope, records] of this.scopes) {
      if (records[sideKey(agentId, `${runtime}:${sessionId}`)]?.deferred) this.set(scope, runtime, sessionId, false, agentId)
    }
  }

  set(scope, runtime, sessionId, update, agentId = 'hermes') {
    const patch = dispositionUpdate(update)
    if (!scope || !validAgentId(agentId) || !['direct', 'operator'].includes(runtime) || typeof sessionId !== 'string' || !ID.test(sessionId) || !patch) {
      throw Object.assign(new Error('Invalid thread disposition'), { status: 400 })
    }
    const key = sideKey(agentId, `${runtime}:${sessionId}`)
    const previous = this.get(scope)[key]
    const device = patch.hasDevice ? patch.device : previous?.device
    const record = {
      deferred: patch.hasDeferred ? patch.deferred : previous?.deferred ?? false,
      updatedAt: new Date().toISOString(),
      agent_id: agentId,
      session_id: sessionId,
      ...(device ? { device } : {}),
    }
    const records = { ...this.get(scope), [key]: record }
    const next = new Map(this.scopes).set(scope, records)
    if (this.statePath) {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
      atomicStoreWrite(this.statePath, JSON.stringify({ schema: 1, scopes: Object.fromEntries(next) }))
    }
    this.scopes = next
    return record
  }
}
