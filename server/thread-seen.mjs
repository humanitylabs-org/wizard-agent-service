import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_THREAD_RECORDS = 500
const MAX_ACCOUNT_SCOPES = 32
const THREAD_KEY = /^[A-Za-z0-9._:-]{1,320}$/
const RUN_STATUSES = new Set(['idle', 'submitting', 'queued', 'running', 'waiting_for_approval', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted'])
const READY_OR_ATTENTION_STATUSES = new Set(['completed', 'failed', 'interrupted', 'waiting_for_approval'])

function validRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const messageCount = value.messageCount
  const status = value.status
  const updatedAt = value.updatedAt
  const previewFingerprint = value.previewFingerprint
  const seenAt = value.seenAt
  if (messageCount !== undefined && (!Number.isSafeInteger(messageCount) || messageCount < 0)) return null
  if (status !== undefined && !RUN_STATUSES.has(status)) return null
  if (typeof updatedAt !== 'string' || updatedAt.length > 100 || !Number.isFinite(Date.parse(updatedAt))) return null
  if (typeof previewFingerprint !== 'string' || !/^[a-z0-9]{1,32}$/.test(previewFingerprint)) return null
  if (!Number.isFinite(seenAt) || seenAt < 0) return null
  return {
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(status !== undefined ? { status } : {}),
    updatedAt,
    previewFingerprint,
    seenAt,
  }
}

export function normalizeThreadSeenState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(value.initializedAt) || value.initializedAt < 0) return null
  if (!value.threads || typeof value.threads !== 'object' || Array.isArray(value.threads)) return null
  const entries = Object.entries(value.threads)
  if (entries.length > MAX_THREAD_RECORDS) return null
  const threads = {}
  for (const [key, candidate] of entries) {
    if (!THREAD_KEY.test(key)) return null
    const record = validRecord(candidate)
    if (!record) return null
    threads[key] = record
  }
  return { initializedAt: value.initializedAt, threads }
}

function laterRecord(left, right) {
  if (!left) return right
  if (typeof left.messageCount === 'number' && typeof right.messageCount === 'number' && left.messageCount !== right.messageCount) {
    return right.messageCount > left.messageCount ? right : left
  }
  const leftUpdatedAt = Date.parse(left.updatedAt)
  const rightUpdatedAt = Date.parse(right.updatedAt)
  if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt > leftUpdatedAt ? right : left
  const leftReady = Boolean(left.status && READY_OR_ATTENTION_STATUSES.has(left.status))
  const rightReady = Boolean(right.status && READY_OR_ATTENTION_STATUSES.has(right.status))
  if (leftReady !== rightReady) return rightReady ? right : left
  return right.seenAt > left.seenAt ? right : left
}

export function mergeThreadSeenStates(left, right) {
  if (!left) return right
  if (!right) return left
  let changed = right.initializedAt < left.initializedAt
  const threads = { ...left.threads }
  for (const [key, record] of Object.entries(right.threads)) {
    const selected = laterRecord(threads[key], record)
    if (selected !== threads[key]) {
      threads[key] = selected
      changed = true
    }
  }
  if (!changed) return left
  const entries = Object.entries(threads).sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, MAX_THREAD_RECORDS)
  return { initializedAt: Math.min(left.initializedAt, right.initializedAt), threads: Object.fromEntries(entries) }
}

export class ThreadSeenStore {
  constructor(statePath = '') {
    this.statePath = statePath
    this.scopes = new Map()
    if (!statePath || !existsSync(statePath)) return
    let payload
    try { payload = JSON.parse(readFileSync(statePath, 'utf8')) }
    catch { throw new Error('Wizard thread seen state is invalid') }
    if (payload?.schema !== 1 || !payload.scopes || typeof payload.scopes !== 'object' || Array.isArray(payload.scopes)) {
      throw new Error('Wizard thread seen state is invalid')
    }
    for (const [scope, candidate] of Object.entries(payload.scopes).slice(0, MAX_ACCOUNT_SCOPES)) {
      const state = normalizeThreadSeenState(candidate)
      if (state) this.scopes.set(scope, state)
    }
  }

  get(scope) {
    return this.scopes.get(scope) ?? null
  }

  merge(scope, incoming) {
    const state = normalizeThreadSeenState(incoming)
    if (!state) throw Object.assign(new Error('Invalid Wizard thread seen state'), { status: 400 })
    const previous = this.get(scope)
    const merged = mergeThreadSeenStates(previous, state)
    this.scopes.set(scope, merged)
    while (this.scopes.size > MAX_ACCOUNT_SCOPES) this.scopes.delete(this.scopes.keys().next().value)
    if (merged !== previous) this.persist()
    return merged
  }

  persist() {
    if (!this.statePath) return
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ schema: 1, scopes: Object.fromEntries(this.scopes) }), { mode: 0o600 })
    renameSync(temporary, this.statePath)
  }
}
