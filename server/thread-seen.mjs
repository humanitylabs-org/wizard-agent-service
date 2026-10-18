import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_THREAD_RECORDS = 500
const MAX_ACCOUNT_SCOPES = 32
const THREAD_KEY = /^[A-Za-z0-9._:-]{1,320}$/
const RUN_STATUSES = new Set(['idle', 'submitting', 'queued', 'running', 'waiting_for_approval', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'])
const READY_OR_ATTENTION_STATUSES = new Set(['completed', 'failed', 'interrupted', 'waiting_for_approval', 'unknown'])

function validRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const messageCount = value.messageCount
  const status = value.status
  const updatedAt = value.updatedAt
  const previewFingerprint = value.previewFingerprint
  const assistantActivityAt = value.assistantActivityAt
  const seenAt = value.seenAt
  if (messageCount !== undefined && (!Number.isSafeInteger(messageCount) || messageCount < 0)) return null
  if (status !== undefined && !RUN_STATUSES.has(status)) return null
  if (typeof updatedAt !== 'string' || updatedAt.length > 100 || !Number.isFinite(Date.parse(updatedAt))) return null
  if (typeof previewFingerprint !== 'string' || !/^[a-z0-9]{1,32}$/.test(previewFingerprint)) return null
  if (assistantActivityAt !== undefined && (typeof assistantActivityAt !== 'string' || assistantActivityAt.length > 100 || !Number.isFinite(Date.parse(assistantActivityAt)))) return null
  if (!Number.isFinite(seenAt) || seenAt < 0) return null
  return {
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(status !== undefined ? { status } : {}),
    updatedAt,
    previewFingerprint,
    ...(assistantActivityAt !== undefined ? { assistantActivityAt } : {}),
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
  const leftUpdatedAt = Date.parse(left.updatedAt)
  const rightUpdatedAt = Date.parse(right.updatedAt)
  // updatedAt is the canonical session revision. message_count is only a
  // tie-breaker because compaction can reduce it across later revisions.
  let selected
  if (leftUpdatedAt !== rightUpdatedAt) selected = rightUpdatedAt > leftUpdatedAt ? right : left
  else {
    const leftCount = left.messageCount ?? -1
    const rightCount = right.messageCount ?? -1
    if (leftCount !== rightCount) selected = rightCount > leftCount ? right : left
    else {
      const leftReady = Boolean(left.status && READY_OR_ATTENTION_STATUSES.has(left.status))
      const rightReady = Boolean(right.status && READY_OR_ATTENTION_STATUSES.has(right.status))
      if (leftReady !== rightReady) selected = rightReady ? right : left
      else {
        const leftStatus = left.status ?? ''
        const rightStatus = right.status ?? ''
        if (leftStatus !== rightStatus) selected = rightStatus > leftStatus ? right : left
        else if (left.previewFingerprint !== right.previewFingerprint) selected = right.previewFingerprint > left.previewFingerprint ? right : left
        else if (left.updatedAt !== right.updatedAt) selected = right.updatedAt > left.updatedAt ? right : left
        else selected = right.seenAt > left.seenAt ? right : left
      }
    }
  }
  const seenAt = Math.max(left.seenAt, right.seenAt)
  const leftAssistantAt = Date.parse(left.assistantActivityAt ?? '')
  const rightAssistantAt = Date.parse(right.assistantActivityAt ?? '')
  const assistantActivityAt = !Number.isFinite(leftAssistantAt)
    ? right.assistantActivityAt
    : !Number.isFinite(rightAssistantAt)
      ? left.assistantActivityAt
      : rightAssistantAt !== leftAssistantAt
        ? rightAssistantAt > leftAssistantAt ? right.assistantActivityAt : left.assistantActivityAt
        : (right.assistantActivityAt ?? '') > (left.assistantActivityAt ?? '') ? right.assistantActivityAt : left.assistantActivityAt
  return selected.seenAt === seenAt && selected.assistantActivityAt === assistantActivityAt
    ? selected
    : { ...selected, ...(assistantActivityAt ? { assistantActivityAt } : {}), seenAt }
}

export function mergeThreadSeenStates(left, right, { protect = null, keepInitializedAt = false } = {}) {
  if (!left) return right
  if (!right) return left
  let changed = !keepInitializedAt && right.initializedAt < left.initializedAt
  const threads = { ...left.threads }
  for (const [key, record] of Object.entries(right.threads)) {
    if (protect?.(key)) continue
    const selected = laterRecord(threads[key], record)
    if (selected !== threads[key]) {
      threads[key] = selected
      changed = true
    }
  }
  if (!changed) return left
  const order = (a, b) => b[1].seenAt - a[1].seenAt || a[0].localeCompare(b[0])
  const all = Object.entries(threads)
  // Protected records are kept whatever the caller sends; the cap applies to the rest.
  const kept = protect ? all.filter(([key]) => protect(key)) : []
  const rest = (protect ? all.filter(([key]) => !protect(key)) : all).sort(order).slice(0, Math.max(0, MAX_THREAD_RECORDS - kept.length))
  const entries = [...kept, ...rest].sort(order)
  return { initializedAt: keepInitializedAt ? left.initializedAt : Math.min(left.initializedAt, right.initializedAt), threads: Object.fromEntries(entries) }
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

  merge(scope, incoming, options = {}) {
    const state = normalizeThreadSeenState(incoming)
    if (!state) throw Object.assign(new Error('Invalid Wizard thread seen state'), { status: 400 })
    const previous = this.get(scope)
    const merged = mergeThreadSeenStates(previous, state, options)
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

// Durable record of thread failures James explicitly dismissed from the app.
// A dismissal suppresses the "Needs retry" projection for one bound failure
// identity; a newer request or run supersedes it automatically.
const MAX_DISMISSED_FAILURES = 500
const SESSION_KEY = /^[A-Za-z0-9._:-]{1,200}$/

export class DismissedFailureStore {
  constructor(statePath = '') {
    this.statePath = statePath
    this.dismissals = new Map()
    if (!statePath || !existsSync(statePath)) return
    let payload
    try { payload = JSON.parse(readFileSync(statePath, 'utf8')) }
    catch { throw new Error('Wizard dismissed failure state is invalid') }
    if (payload?.schema !== 1 || !payload.dismissals || typeof payload.dismissals !== 'object' || Array.isArray(payload.dismissals)) {
      throw new Error('Wizard dismissed failure state is invalid')
    }
    for (const [sessionId, record] of Object.entries(payload.dismissals).slice(0, MAX_DISMISSED_FAILURES)) {
      if (!SESSION_KEY.test(sessionId)) continue
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue
      const failureKey = typeof record.failureKey === 'string' ? record.failureKey : ''
      const dismissedAt = Number(record.dismissedAt)
      if (!failureKey || !Number.isFinite(dismissedAt) || dismissedAt < 0) continue
      this.dismissals.set(sessionId, { failureKey, dismissedAt })
    }
  }

  isDismissed(sessionId, failureKey = '') {
    const record = this.dismissals.get(sessionId)
    if (!record) return false
    return failureKey === '' || record.failureKey === failureKey
  }

  dismiss(sessionId, failureKey) {
    if (!SESSION_KEY.test(sessionId) || typeof failureKey !== 'string' || !failureKey) {
      throw Object.assign(new Error('invalid dismissal'), { status: 400 })
    }
    this.dismissals.set(sessionId, { failureKey, dismissedAt: Date.now() })
    while (this.dismissals.size > MAX_DISMISSED_FAILURES) {
      const oldest = [...this.dismissals.entries()].sort((left, right) => left[1].dismissedAt - right[1].dismissedAt)[0]
      if (!oldest) break
      this.dismissals.delete(oldest[0])
    }
    this.persist()
  }

  persist() {
    if (!this.statePath) return
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ schema: 1, dismissals: Object.fromEntries(this.dismissals) }), { mode: 0o600 })
    renameSync(temporary, this.statePath)
  }
}
