import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/
const validRecord = (record) => record && typeof record.deferred === 'boolean'
  && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))

// User organization only: never archives a transcript or schedules agent work.
// Atomic replacement precedes memory publication so failed writes cannot look saved.
export class ThreadDispositionStore {
  constructor(statePath = '') {
    this.statePath = statePath
    this.scopes = new Map()
    if (!statePath || !existsSync(statePath)) return
    const data = JSON.parse(readFileSync(statePath, 'utf8'))
    if (data?.schema !== 1 || !data.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) throw new Error('Invalid thread disposition state')
    for (const [scope, records] of Object.entries(data.scopes)) {
      if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid thread disposition state')
      for (const [key, record] of Object.entries(records)) {
        const [runtime, ...parts] = key.split(':')
        if (!['direct', 'operator'].includes(runtime) || !ID.test(parts.join(':')) || !validRecord(record)) throw new Error('Invalid thread disposition state')
      }
      this.scopes.set(scope, records)
    }
  }

  get(scope) { return structuredClone(this.scopes.get(scope) ?? {}) }

  clearSession(runtime, sessionId) {
    for (const [scope, records] of this.scopes) {
      if (records[`${runtime}:${sessionId}`]?.deferred) this.set(scope, runtime, sessionId, false)
    }
  }

  set(scope, runtime, sessionId, deferred) {
    if (!scope || !['direct', 'operator'].includes(runtime) || !ID.test(sessionId) || typeof deferred !== 'boolean') {
      throw Object.assign(new Error('Invalid thread disposition'), { status: 400 })
    }
    const record = { deferred, updatedAt: new Date().toISOString() }
    const records = { ...this.get(scope), [`${runtime}:${sessionId}`]: record }
    const next = new Map(this.scopes).set(scope, records)
    if (this.statePath) {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
      const temporary = `${this.statePath}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ schema: 1, scopes: Object.fromEntries(next) }), { mode: 0o600 })
      renameSync(temporary, this.statePath)
    }
    this.scopes = next
    return record
  }
}
