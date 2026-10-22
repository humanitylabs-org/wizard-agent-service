import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { withSqliteMigration, qualifyContinuation } from './thread-reference.mjs'
import { DatabaseSync } from 'node:sqlite'
import { normalizeProviderPreflightFailure } from './run-provider-failure.mjs'
import { annotateProviderSignOut } from './provider-reconnect.mjs'
import { admissionFailure, retryDelaySeconds } from './hermes-compat.mjs'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const ACTIVE = new Set(['launching', 'running', 'waiting_for_approval', 'stopping'])
const RETRIABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const PUBLIC_ID = /^wizardq_[0-9a-f]{32}$/
const SAFE_KEY = /^[^\p{Cc}]{1,256}$/u
// Only service-owned continuation metadata selects the background lane. Manual
// Continue is an interactive request; model text never determines scheduling.
export const isBackgroundContinuation = record => Boolean(record.continuation)
  && record.continuation.kind !== 'background-recovery'
// A run the owner did not stop but that ended `cancelled` lost its transport: an Agent Service
// or gateway restart dropped the SSE stream and Hermes interrupted the turn (19 Oct 2026: four
// threads ended as a blank "Worked for Ns" receipt). Such runs become `interrupted` (Needs retry)
// and are resumed once, through normal admission, under this stable key prefix.
export const INTERRUPT_RECOVERY_PREFIX = 'wizard-interrupt-recovery-'
export const INTERRUPTED_SAFE_ERROR = 'Wizard restarted while this was running, so the reply was cut off.'
const RECOVERY_INPUT_CHARS = 4000
const MAX_QUEUED_BODY_BYTES = 12 * 1024 * 1024
const MAX_QUEUED_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_QUEUED_IMAGES = 9

const nowSeconds = () => Date.now() / 1000
const providerScope = record => {
  const body = parseJson(record.body, {})
  return JSON.stringify([record.runtime, body.provider || 'configured', body.model || 'configured'])
}
export function retryAfterSeconds(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(String(value))
  return Number.isFinite(date) ? Math.max(0, (date - now) / 1000) : 0
}
const safeStatus = (value) => {
  const status = String(value ?? '').toLowerCase()
  if (['accepted', 'pending', 'queued', 'submitting', 'started'].includes(status)) return 'running'
  if (['running', 'waiting_for_approval', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status)) return status
  return value === 'unknown' ? 'unknown' : 'running'
}

const parseJson = (value, fallback) => {
  try { return JSON.parse(value) }
  catch { return fallback }
}

// A failed run whose provider sign-in expired names the connection app that fixes it
// (provider-reconnect.mjs). Classified at read time so runs that failed before this
// existed (and stored payloads) get the same plain message and Open button.
const failureProjection = (record) => {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {}
  const safeError = typeof payload.safe_error === 'string' ? payload.safe_error : ''
  if (record.status !== 'failed') return { safeError }
  const annotated = annotateProviderSignOut({ ...payload, status: 'failed' }, parseJson(record.body, null))
  return annotated.wizard_reconnect
    ? { safeError: annotated.safe_error, reconnect: annotated.wizard_reconnect }
    : { safeError }
}

const queuedInputPreview = (body) => {
  const value = parseJson(body, {})
  const input = value?.input
  if (typeof input === 'string') return input.trim().slice(0, 300)
  if (!Array.isArray(input)) return ''
  return input.flatMap((item) => {
    if (typeof item?.content === 'string') return [item.content]
    if (!Array.isArray(item?.content)) return []
    return item.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
  }).join('\n').trim().slice(0, 300)
}

const queuedInputText = (value) => {
  const input = value?.input
  if (typeof input === 'string') return input.trim()
  if (!Array.isArray(input)) return ''
  return input.flatMap((item) => {
    if (typeof item?.content === 'string') return [item.content]
    if (!Array.isArray(item?.content)) return []
    return item.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
  }).join('\n').trim()
}

const requestError = (message, status) => Object.assign(new Error(message), { status })

export function queueRequestHash(runtime, body) {
  return createHash('sha256').update(`${runtime}\0${body}`).digest('hex')
}

export class DurableRunQueue {
  constructor({
    statePath,
    maxActive = 8,
    reservedInteractive = 0,
    pollIntervalMs = 1_500,
    retryDelayMs = 2_000,
    activeSessionIds = async () => [],
    canDispatch = () => true,
    launch,
    lookup,
    // Stale-run guard: a run Hermes still calls `running` while no turn holds the session
    // (turnHeld → false) for `staleAfterSeconds`, and whose owner confirms nothing is
    // attached (confirmAbandoned → { status }), is closed so later messages can start.
    turnHeld = null,
    confirmAbandoned = null,
    onReconciled = () => {},
    staleAfterSeconds = 300,
    // Interrupt recovery: interruptOutcome(record) -> 'completed' when the answer landed before the
    // cut (no resume needed), anything else resumes. onInterruptRecovery logs each decision.
    interruptOutcome = null,
    onInterruptRecovery = () => {},
    interruptRecoveryMaxAgeSeconds = 6 * 3600,
  }) {
    if (!statePath) throw new Error('Wizard run queue state path is required')
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 64) throw new Error('Wizard run queue capacity is invalid')
    if (typeof launch !== 'function' || typeof lookup !== 'function') throw new Error('Wizard run queue transport is required')
    this.statePath = resolve(statePath)
    this.maxActive = maxActive
    if (!Number.isSafeInteger(reservedInteractive) || reservedInteractive < 0 || reservedInteractive >= maxActive) throw new Error('Wizard interactive reservation is invalid')
    this.reservedInteractive = reservedInteractive
    this.pollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0)
    this.retryDelayMs = Math.max(50, Number(retryDelayMs) || 2_000)
    this.activeSessionIds = activeSessionIds
    this.canDispatch = canDispatch
    this.launch = launch
    this.lookup = lookup
    this.turnHeld = turnHeld
    this.confirmAbandoned = confirmAbandoned
    this.onReconciled = onReconciled
    this.staleAfterSeconds = Math.max(1, Number(staleAfterSeconds) || 300)
    this.interruptOutcome = interruptOutcome
    this.onInterruptRecovery = onInterruptRecovery
    this.interruptRecoveryMaxAgeSeconds = Math.max(60, Number(interruptRecoveryMaxAgeSeconds) || 6 * 3600)
    this.leaselessSince = new Map()
    this.refreshedAt = new Map()  // run id -> last lookup time; the 0.7 s throttle no longer relies on updated_at
    this.timer = null
    this.tickPromise = null
    this.closed = false
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const hadState = existsSync(this.statePath)
    this.database = new DatabaseSync(this.statePath)
    try {
    chmodSync(this.statePath, 0o600)
    withSqliteMigration(this.database, this.statePath, hadState, () => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS wizard_provider_backoff (
        scope TEXT PRIMARY KEY, retry_after REAL NOT NULL, failures INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wizard_run_queue (
        public_run_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        trusted_paths_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        upstream_run_id TEXT NOT NULL DEFAULT '',
        worker_run_id TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        waiting_reason TEXT NOT NULL DEFAULT '',
        retry_after REAL NOT NULL DEFAULT 0,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        terminal_at REAL,
        UNIQUE(runtime, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS wizard_run_queue_fifo
        ON wizard_run_queue(status, created_at, public_run_id);
      CREATE INDEX IF NOT EXISTS wizard_run_queue_terminal
        ON wizard_run_queue(terminal_at, public_run_id) WHERE terminal_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS wizard_owner_stops (
        run_id TEXT PRIMARY KEY, at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wizard_interrupt_recovery (
        public_run_id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        recovery_run_id TEXT NOT NULL DEFAULT '', at REAL NOT NULL
      );
    `)
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'agent_id')) {

        this.database.exec("ALTER TABLE wizard_run_queue ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'hermes'; ALTER TABLE wizard_run_queue ADD COLUMN recovery_authorized INTEGER NOT NULL DEFAULT 0;")
        if (this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'continuation_json')) {
          for (const row of this.database.prepare('SELECT public_run_id,session_id,continuation_json FROM wizard_run_queue').all()) {
            this.database.prepare('UPDATE wizard_run_queue SET continuation_json=? WHERE public_run_id=?').run(JSON.stringify(qualifyContinuation(JSON.parse(row.continuation_json), row.session_id)), row.public_run_id)
          }
        }

    }
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'continuation_json')) {
      this.database.exec("ALTER TABLE wizard_run_queue ADD COLUMN continuation_json TEXT NOT NULL DEFAULT 'null'")
    }
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'dispatch_attempted')) {
      // Existing rows have unknown dispatch history. Never mutate their saved request.
      this.database.exec("ALTER TABLE wizard_run_queue ADD COLUMN dispatch_attempted INTEGER NOT NULL DEFAULT 0; UPDATE wizard_run_queue SET dispatch_attempted=1;")
    }
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'dispatch_body')) {
      this.database.exec("ALTER TABLE wizard_run_queue ADD COLUMN dispatch_body TEXT")
    }
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'worker_dispatch_body')) {
      this.database.exec("ALTER TABLE wizard_run_queue ADD COLUMN worker_dispatch_body TEXT")
    }
    })
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    } catch (error) {
      try { this.database.close() } catch { /* preserve original */ }
      throw error
    }
  }

  async initialize() {
    if (this.closed) throw new Error('Wizard run queue is closed')
    // Normalize older terminal receipts without replaying or changing saved requests.
    for (const record of this._rows("status = 'completed' AND runtime = 'direct' AND payload_json LIKE '%Provider authentication failed:%'")) {
      const payload = normalizeProviderPreflightFailure(record.payload)
      if (payload !== record.payload) this._update(record.publicRunId, { status: 'failed', payload, updatedAt: record.updatedAt })
    }
    await this.tick(true)
    if (!this.closed && this.pollIntervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.tick().catch(() => undefined), this.pollIntervalMs)
      this.timer.unref?.()
    }
    return this
  }

  quiesce() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
  close() {
    if (this.closePromise) return this.closePromise
    this.quiesce()
    // With no in-flight tick preserve synchronous close for existing callers.
    if (!this.tickPromise) { this.database.close(); return this.closePromise = Promise.resolve() }
    return this.closePromise = this.tickPromise.catch(() => undefined).then(() => this.database.close())
  }

  _record(row) {
    if (!row) return null
    return {
      publicRunId: row.public_run_id,
      runtime: row.runtime,
      sessionId: row.session_id,
      agent_id: row.agent_id ?? 'hermes',
      recoveryAuthorized: Boolean(row.recovery_authorized),
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      body: row.body,
      dispatchAttempted: Boolean(row.dispatch_attempted),
      dispatchBody: row.dispatch_body ?? null,
      workerDispatchBody: row.worker_dispatch_body ?? null,
      continuation: parseJson(row.continuation_json, null),
      trustedPaths: parseJson(row.trusted_paths_json, []),
      status: row.status,
      upstreamRunId: row.upstream_run_id,
      workerRunId: row.worker_run_id,
      payload: parseJson(row.payload_json, {}),
      waitingReason: row.waiting_reason,
      retryAfter: Number(row.retry_after) || 0,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      terminalAt: row.terminal_at === null ? null : Number(row.terminal_at),
    }
  }

  get(publicRunId) {
    if (!PUBLIC_ID.test(String(publicRunId ?? ''))) return null
    return this._record(this.database.prepare('SELECT * FROM wizard_run_queue WHERE public_run_id = ?').get(publicRunId))
  }

  admittedForSession(runtime, sessionId) {
    if (!['direct', 'operator'].includes(runtime) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) return []
    return this.database.prepare(`SELECT * FROM wizard_run_queue
      WHERE runtime = ? AND session_id = ? AND upstream_run_id <> ''
      ORDER BY created_at, public_run_id`).all(runtime, sessionId).map((row) => this._record(row))
  }

  _existing(runtime, idempotencyKey) {
    return this._record(this.database.prepare('SELECT * FROM wizard_run_queue WHERE runtime = ? AND idempotency_key = ?').get(runtime, idempotencyKey))
  }

  replay(runtime, sessionId, idempotencyKey, requestHash) {
    if (typeof idempotencyKey !== 'string' || !SAFE_KEY.test(idempotencyKey)) throw requestError('idempotency key required', 400)
    const existing = this._existing(runtime, idempotencyKey)
    if (!existing) return null
    if (existing.sessionId !== sessionId || existing.requestHash !== requestHash) throw requestError('idempotency key conflict', 409)
    return existing
  }

  /** Durable exact admission lookup: replay does not depend on which run is currently latest. */
  byIdempotencyKey(runtime, key) { return this._existing(runtime, key) }

  byBackgroundRecovery(id, sessionId) {
    const row = this.database.prepare(`SELECT * FROM wizard_run_queue
      WHERE runtime='direct' AND session_id=? AND json_extract(body,'$._wizard_background_recovery.id')=?
      ORDER BY created_at LIMIT 1`).get(sessionId, id)
    return row ? this._record(row) : null
  }

  admittedVoiceRun(runtime, sessionId, audioPaths) {
    const paths = new Set((Array.isArray(audioPaths) ? audioPaths : []).filter((path) => typeof path === 'string' && path))
    if (!paths.size || typeof sessionId !== 'string' || !sessionId) return null
    const rows = this.database.prepare(`SELECT * FROM wizard_run_queue
      WHERE runtime = ? AND session_id = ? AND status NOT IN ('failed', 'cancelled', 'interrupted')
      ORDER BY created_at DESC, public_run_id DESC`).all(runtime, sessionId)
    for (const row of rows) {
      const record = this._record(row)
      if (Array.isArray(record.trustedPaths) && record.trustedPaths.some((path) => paths.has(path))) return record
    }
    return null
  }

  _rows(where = '1=1') {
    return this.database.prepare(`SELECT * FROM wizard_run_queue WHERE ${where} ORDER BY created_at, public_run_id`).all().map((row) => this._record(row))
  }

  _update(publicRunId, changes) {
    const allowed = {
      status: 'status', upstreamRunId: 'upstream_run_id', workerRunId: 'worker_run_id',
      payload: 'payload_json', waitingReason: 'waiting_reason', retryAfter: 'retry_after',
      body: 'body', trustedPaths: 'trusted_paths_json', terminalAt: 'terminal_at', updatedAt: 'updated_at',
    }
    const entries = Object.entries(changes).filter(([key]) => allowed[key])
    if (!entries.length) return this.get(publicRunId)
    if (!entries.some(([key]) => key === 'updatedAt')) entries.push(['updatedAt', nowSeconds()])
    const values = entries.map(([key, value]) => {
      if (key === 'payload' || key === 'trustedPaths') return JSON.stringify(value)
      return value
    })
    this.database.prepare(`UPDATE wizard_run_queue SET ${entries.map(([key]) => `${allowed[key]} = ?`).join(', ')} WHERE public_run_id = ?`).run(...values, publicRunId)
    return this.get(publicRunId)
  }

  _position(publicRunId) {
    const queued = this._rows("status = 'queued'")
    const index = queued.findIndex((record) => record.publicRunId === publicRunId)
    return index < 0 ? 0 : index + 1
  }

  freezeDispatchBody(publicRunId, body) {
    // The transport calls this after preflight, immediately before run admission.
    this.database.prepare('UPDATE wizard_run_queue SET dispatch_attempted=1, dispatch_body=COALESCE(dispatch_body, ?) WHERE public_run_id=?').run(String(body), publicRunId)
    return this.get(publicRunId).dispatchBody
  }

  freezeWorkerDispatchBody(publicRunId, body) {
    // Operator work can start before the parent acknowledgement is admitted.
    this.database.prepare('UPDATE wizard_run_queue SET dispatch_attempted=1, worker_dispatch_body=COALESCE(worker_dispatch_body, ?) WHERE public_run_id=?').run(String(body), publicRunId)
    return this.get(publicRunId).workerDispatchBody
  }

  publicPayload(record) {
    const current = typeof record === 'string' ? this.get(record) : record
    if (!current) return null
    if (current.status === 'queued' || current.status === 'launching') {
      return {
        object: 'run',
        run_id: current.publicRunId,
        session_id: current.sessionId,
        agent_id: current.agent_id,
        status: 'queued',
        queue_position: this._position(current.publicRunId),
        queue_reason: current.waitingReason || 'capacity',
        created_at: current.createdAt,
        updated_at: current.updatedAt,
      }
    }
    const payload = current.payload && typeof current.payload === 'object' && !Array.isArray(current.payload) ? { ...current.payload } : {}
    payload.run_id = current.publicRunId
    payload.session_id = current.sessionId
    payload.agent_id = current.agent_id
    if (!payload.status) payload.status = current.status
    payload.updated_at ??= current.updatedAt
    return payload
  }

  projections() {
    const records = this.database.prepare(`
      SELECT current.*
      FROM wizard_run_queue current
      WHERE current.status IN ('queued','launching','running','waiting_for_approval','stopping','unknown')
        AND (current.status = 'unknown' OR NOT EXISTS (
          SELECT 1 FROM wizard_run_queue newer
          WHERE newer.session_id = current.session_id
            AND (newer.created_at > current.created_at
              OR (newer.created_at = current.created_at AND newer.public_run_id > current.public_run_id))
        ))
      ORDER BY current.created_at, current.public_run_id
    `).all().map((row) => this._record(row))
    return records.map((record) => ({
      sessionId: record.sessionId,
      status: record.status === 'queued' || record.status === 'launching' ? 'queued' : record.status,
      queuePosition: record.status === 'queued' ? this._position(record.publicRunId) : 0,
      queueReason: record.waitingReason,
      preview: queuedInputPreview(record.body),
      ...failureProjection(record),
      publicRunId: record.publicRunId,
      idempotencyKey: record.idempotencyKey,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
  }

  /** Cheap revision of the queue's unfinished rows (covering index only): changes on every admission or status move. */
  listRevision() {
    const rows = this.database.prepare(`
      SELECT status, public_run_id FROM wizard_run_queue INDEXED BY wizard_run_queue_fifo
       WHERE status NOT IN ('completed','failed','cancelled','interrupted')
    `).all()
    const newest = this.database.prepare('SELECT MAX(rowid) AS id, COUNT(*) AS n FROM wizard_run_queue').get()
    return `${newest?.id ?? 0}:${newest?.n ?? 0}:${rows.map((row) => `${row.public_run_id}=${row.status}`).sort().join(',')}`
  }

  // Per-thread fingerprint of every queue row (id=status), for the Chats list cache: a thread
  // whose rows were added, changed or pruned by retention must be re-projected. Reads status
  // from the index and session_id from the row head, never the body (~10 ms for ~1,800 rows).
  sessionStamps() {
    const rows = this.database.prepare(`
      SELECT session_id, public_run_id, status FROM wizard_run_queue INDEXED BY wizard_run_queue_fifo
    `).all()
    const parts = new Map()
    for (const row of rows) {
      const id = String(row.session_id)
      if (!parts.has(id)) parts.set(id, [])
      parts.get(id).push(`${row.public_run_id}=${row.status}`)
    }
    return new Map([...parts].map(([id, list]) => [id, list.sort().join(',')]))
  }

  // Sessions whose newest queued send is recent and never produced a finished answer here.
  // Lets the thread list keep a brand-new thread visible when its first send failed or waits.
  recentUnfinishedSessionIds(sinceSeconds, limit = 50) {
    return this.database.prepare(`
      SELECT session_id FROM wizard_run_queue
       WHERE created_at >= ?
       GROUP BY session_id
      HAVING SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) = 0
       ORDER BY MAX(created_at) DESC
       LIMIT ?
    `).all(Number(sinceSeconds), Number(limit)).map((row) => String(row.session_id))
  }

  latestProjections(sessionIds) {
    const ids = Array.isArray(sessionIds) ? [...new Set(sessionIds)] : null
    if (ids && !ids.length) return []
    // Rank narrow identities once. A correlated anti-join used to scan the
    // body-heavy queue for every row, blocking foreground reads on this loop.
    return this.database.prepare(`
      WITH ranked AS (
        SELECT public_run_id, ROW_NUMBER() OVER (
          PARTITION BY session_id ORDER BY CASE WHEN status='unknown' THEN 0 ELSE 1 END, created_at DESC, public_run_id DESC
        ) AS position
        FROM wizard_run_queue
        ${ids ? `WHERE session_id IN (${ids.map(() => '?').join(',')})` : ''}
      )
      SELECT current.public_run_id, current.session_id, current.status,
        current.waiting_reason, current.body, current.idempotency_key,
        json_object('safe_error', json_extract(current.payload_json, '$.safe_error'),
          'error', current.payload_json -> '$.error',
          'output', substr(json_extract(current.payload_json, '$.output'), 1, 4000),
          'runtime', current.payload_json -> '$.runtime',
          'usage', json_object('runtime', current.payload_json -> '$.usage.runtime')) AS payload_json,
        current.created_at, current.updated_at
      FROM ranked JOIN wizard_run_queue current USING (public_run_id)
      WHERE ranked.position = 1
      ORDER BY current.created_at, current.public_run_id
    `).all(...(ids ?? [])).map((row) => this._record(row)).map((record) => ({
      sessionId: record.sessionId,
      status: record.status === 'queued' || record.status === 'launching' ? 'queued' : record.status,
      queuePosition: record.status === 'queued' ? this._position(record.publicRunId) : 0,
      queueReason: record.waitingReason,
      preview: queuedInputPreview(record.body),
      ...failureProjection(record),
      publicRunId: record.publicRunId,
      idempotencyKey: record.idempotencyKey,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
  }

  // Durable insertion order rather than UUID order for same-millisecond admissions.
  latestForSession(sessionId) {
    const row = this.database.prepare('SELECT * FROM wizard_run_queue WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(sessionId)
    return row ? this._record(row) : null
  }

  async summary() {
    await this.tick(false)
    let external = []
    let livenessAvailable = true
    try { external = await this.activeSessionIds() }
    catch { livenessAvailable = false }
    if (!Array.isArray(external)) livenessAvailable = false
    const activeSessions = new Set((Array.isArray(external) ? external : []).filter((value) => typeof value === 'string' && value))
    for (const record of this._rows("status IN ('launching','running','waiting_for_approval','stopping')")) activeSessions.add(record.sessionId)
    for (const record of this._rows("status = 'unknown'")) activeSessions.delete(record.sessionId)
    let dispatchHealthy = false
    try { dispatchHealthy = Boolean(await this.canDispatch()) }
    catch { dispatchHealthy = false }
    return {
      max_active: this.maxActive,
      active: activeSessions.size,
      queued: this._rows("status = 'queued'").length,
      dispatch_paused: !dispatchHealthy,
      liveness_available: livenessAvailable,
      lane: 'interactive',
      interactive_reserved: this.reservedInteractive,
      provider_waiting: this._rows("status = 'queued' AND waiting_reason = 'provider_busy'").length,
    }
  }

  // `continuation` is service authority (helper tokens; {kind:'background-recovery'} lets a manual Continue skip the
  // automatic helper check). Never pass a caller-supplied value here.
  async admit(request) {
    const result = this._admitRow(request)
    if (!result.replayed) await this.tick(true)
    return result.replayed ? result : { record: this.get(result.record.publicRunId), replayed: false }
  }

  _admitRow({ runtime, sessionId, idempotencyKey, requestHash, body, trustedPaths = [], continuation = null, agent_id = 'hermes', recoveryAuthorized = false }) {
    // Secondary runtime runs are admitted by that runtime, not this external-Hermes queue.
    if (agent_id !== 'hermes') throw requestError('invalid queue agent', 400)
    if (!['direct', 'operator'].includes(runtime) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw requestError('invalid queued run', 400)
    if (typeof idempotencyKey !== 'string' || !SAFE_KEY.test(idempotencyKey)) throw requestError('idempotency key required', 400)
    if (typeof requestHash !== 'string' || !/^[0-9a-f-]{16,128}$/.test(requestHash)) throw requestError('invalid request hash', 400)
    if (typeof body !== 'string' || !body || body.length > 16 * 1024 * 1024) throw requestError('invalid queued body', 400)
    const existing = this._existing(runtime, idempotencyKey)
    if (existing) {
      if (existing.sessionId !== sessionId || existing.requestHash !== requestHash) throw requestError('idempotency key conflict', 409)
      return { record: existing, replayed: true }
    }
    const publicRunId = `wizardq_${randomUUID().replaceAll('-', '')}`
    const createdAt = nowSeconds()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const raced = this._existing(runtime, idempotencyKey)
      if (raced) {
        this.database.exec('ROLLBACK')
        if (raced.sessionId !== sessionId || raced.requestHash !== requestHash) throw requestError('idempotency key conflict', 409)
        return { record: raced, replayed: true }
      }
      this.database.prepare(`
        INSERT INTO wizard_run_queue (
          public_run_id, runtime, session_id, idempotency_key, request_hash, body,
          trusted_paths_json, status, created_at, updated_at, continuation_json, agent_id, recovery_authorized
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
      `).run(publicRunId, runtime, sessionId, idempotencyKey, requestHash, body, JSON.stringify(trustedPaths), createdAt, createdAt, JSON.stringify(qualifyContinuation(continuation, sessionId)), agent_id, recoveryAuthorized ? 1 : 0)
      this.database.exec('COMMIT')
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
    return { record: this.get(publicRunId), replayed: false }
  }

  /** The owner pressed Stop: a later `cancelled` for this run is deliberate, never resumed. */
  markOwnerStop(runId) {
    const id = String(runId ?? '')
    if (!id || id.length > 256) return
    const record = this.get(id) ?? this._record(this.database.prepare('SELECT * FROM wizard_run_queue WHERE upstream_run_id = ? OR worker_run_id = ?').get(id, id))
    const insert = this.database.prepare('INSERT OR IGNORE INTO wizard_owner_stops(run_id, at) VALUES(?, ?)')
    for (const value of new Set([id, record?.publicRunId, record?.upstreamRunId].filter(Boolean))) insert.run(value, nowSeconds())
    this.database.prepare('DELETE FROM wizard_owner_stops WHERE at < ?').run(nowSeconds() - 7 * 24 * 3600)
  }

  _ownerStopped(record) {
    return Boolean(this.database.prepare('SELECT 1 FROM wizard_owner_stops WHERE run_id IN (?, ?) LIMIT 1')
      .get(record.publicRunId, record.upstreamRunId || record.publicRunId))
  }

  interruptRecovery(publicRunId) {
    return this.database.prepare('SELECT * FROM wizard_interrupt_recovery WHERE public_run_id = ?').get(publicRunId) ?? null
  }

  _recoveryBody(record) {
    const original = parseJson(record.body, {})
    const value = { ...original }
    delete value._wizard_background_recovery
    const text = queuedInputText(original)
    const quoted = text.length > RECOVERY_INPUT_CHARS ? `${text.slice(0, RECOVERY_INPUT_CHARS)}…` : text
    value.input = '[Wizard follow-through] Wizard restarted while your previous turn in this thread was running, so it was '
      + 'cut off before you replied. Resume that request from where it stopped and give your final answer in this thread. '
      + 'Check what already happened before repeating any step with side effects.'
      + (quoted ? `\n\nThe interrupted request was:\n${quoted}` : '')
    return JSON.stringify(value)
  }

  async _recoverInterrupted() {
    const pending = this.database.prepare("SELECT public_run_id FROM wizard_interrupt_recovery WHERE state = 'pending' ORDER BY at").all()
    for (const { public_run_id: id } of pending) {
      const record = this.get(id)
      const finish = (state, reason, recoveryRunId = '') => {
        this.database.prepare('UPDATE wizard_interrupt_recovery SET state = ?, reason = ?, recovery_run_id = ?, at = ? WHERE public_run_id = ?')
          .run(state, reason, recoveryRunId, nowSeconds(), id)
        try { this.onInterruptRecovery(record, { state, reason, recoveryRunId }) } catch { /* logging only */ }
      }
      if (!record || record.status !== 'interrupted') { finish('skipped', 'not_interrupted'); continue }
      if (record.idempotencyKey.startsWith(INTERRUPT_RECOVERY_PREFIX)) { finish('skipped', 'recovery_already_interrupted'); continue }
      if (nowSeconds() - record.createdAt > this.interruptRecoveryMaxAgeSeconds) { finish('skipped', 'too_old'); continue }
      const key = INTERRUPT_RECOVERY_PREFIX + record.publicRunId
      const newer = this.database.prepare(`SELECT 1 FROM wizard_run_queue WHERE runtime = ? AND session_id = ?
        AND created_at > ? AND idempotency_key <> ? LIMIT 1`).get(record.runtime, record.sessionId, record.createdAt, key)
      if (newer) { finish('skipped', 'newer_request'); continue }
      if (this.interruptOutcome) {
        let outcome = null
        try { outcome = await this.interruptOutcome(record) } catch { outcome = null }
        if (outcome === 'completed') {
          this._update(id, { status: 'completed', payload: { ...record.payload, status: 'completed', last_event: 'run.reconciled', reconciled_reason: 'answered_before_interrupt' } })
          finish('skipped', 'answered_before_interrupt')
          continue
        }
      }
      try {
        const body = this._recoveryBody(record)
        const { record: admitted } = this._admitRow({ runtime: record.runtime, sessionId: record.sessionId, idempotencyKey: key,
          requestHash: queueRequestHash(record.runtime, body), body, trustedPaths: record.trustedPaths ?? [] })
        finish('admitted', '', admitted.publicRunId)
      } catch (error) {
        finish('failed', String(error?.message ?? error).slice(0, 200))
      }
    }
  }

  async cancel(publicRunId) {
    const record = this.get(publicRunId)
    if (!record) throw requestError('queued run not found', 404)
    if (TERMINAL.has(record.status)) return record
    if (record.dispatchAttempted) throw requestError('Delivery outcome is not yet confirmed; refresh before stopping', 409)
    if (record.status !== 'queued') throw requestError('queued run already started', 409)
    return this._update(publicRunId, { status: 'cancelled', waitingReason: '', terminalAt: nowSeconds() })
  }

  async appendGuidance(publicRunId, guidance, trustedPaths = []) {
    const record = this.get(publicRunId)
    if (!record) throw requestError('queued run not found', 404)
    if (record.dispatchAttempted) throw Object.assign(requestError('Delivery may already have started; this reply cannot be changed', 409), { code: 'dispatch_already_attempted' })
    if (record.status !== 'queued') throw requestError('queued run already started', 409)
    let guidanceContent = guidance
    if (Array.isArray(guidance) && guidance.length === 1 && guidance[0]?.role === 'user') guidanceContent = guidance[0].content
    const guidanceParts = Array.isArray(guidanceContent) ? guidanceContent : []
    const text = typeof guidanceContent === 'string'
      ? guidanceContent.trim()
      : guidanceParts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim()
    const mediaParts = guidanceParts.filter((part) => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
    if (!text || text.length > 64_000) throw requestError('invalid queued guidance', 400)
    const value = parseJson(record.body, null)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw requestError('invalid queued body', 500)
    const marker = `\n\nGuidance added while queued:\n${text}`
    if (typeof value.input === 'string') {
      value.input = mediaParts.length
        ? [{ role: 'user', content: [{ type: 'text', text: value.input + marker }, ...mediaParts] }]
        : value.input + marker
    }
    else if (Array.isArray(value.input) && value.input.length === 1 && value.input[0] && typeof value.input[0] === 'object') {
      const message = { ...value.input[0] }
      if (typeof message.content === 'string') {
        message.content = mediaParts.length
          ? [{ type: 'text', text: message.content + marker }, ...mediaParts]
          : message.content + marker
      }
      else if (Array.isArray(message.content)) {
        const index = message.content.findIndex((part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
        if (index < 0) throw requestError('queued text is unavailable', 409)
        message.content = message.content.map((part, partIndex) => partIndex === index ? { ...part, text: part.text + marker } : part)
        if (mediaParts.length) message.content.push(...mediaParts)
      } else throw requestError('queued text is unavailable', 409)
      value.input = [message]
    } else throw requestError('queued text is unavailable', 409)
    const allMediaParts = Array.isArray(value.input)
      ? value.input.flatMap((message) => Array.isArray(message?.content)
        ? message.content.filter((part) => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
        : [])
      : []
    const inlineBytes = allMediaParts.reduce((sum, part) => {
      const url = part.image_url.url
      const comma = url.indexOf(',')
      return sum + (url.startsWith('data:image/') && comma >= 0
        ? Buffer.from(url.slice(comma + 1).replace(/\s+/g, ''), 'base64').length
        : 0)
    }, 0)
    const mergedBody = JSON.stringify(value)
    if (allMediaParts.length > MAX_QUEUED_IMAGES || inlineBytes > MAX_QUEUED_IMAGE_BYTES
        || Buffer.byteLength(mergedBody) > MAX_QUEUED_BODY_BYTES) {
      throw requestError('queued guidance exceeds the attachment limit', 413)
    }
    const nextPaths = [...new Set([...(record.trustedPaths ?? []), ...trustedPaths.filter((path) => typeof path === 'string')])]
    return this._update(publicRunId, { body: mergedBody, trustedPaths: nextPaths })
  }

  async tick(force = false) {
    if (this.closed) return
    if (this.tickPromise) return this.tickPromise
    this.tickPromise = this._tick(force).finally(() => { this.tickPromise = null })
    return this.tickPromise
  }

  async _refresh(record, force) {
    if (!record.upstreamRunId || TERMINAL.has(record.status)) return record
    if (!force && nowSeconds() - (this.refreshedAt.get(record.publicRunId) ?? record.updatedAt) < 0.7) return record
    this.refreshedAt.set(record.publicRunId, nowSeconds())
    if (this.refreshedAt.size > 256) this.refreshedAt.delete(this.refreshedAt.keys().next().value)
    try {
      const result = await this.lookup(record)
      const payload = record.runtime === 'direct' ? normalizeProviderPreflightFailure(result?.payload) : result?.payload
      if (payload !== result?.payload) { result.payload = payload; result.capacityStatus = 'failed' }
      let capacityStatus = safeStatus(result?.capacityStatus ?? result?.payload?.status)
      let nextPayload = result?.payload ?? record.payload
      if (record.runtime === 'direct' && ['cancelled', 'interrupted'].includes(capacityStatus)
          && record.status !== 'stopping' && !this._ownerStopped(record)) {
        capacityStatus = 'interrupted'
        nextPayload = { ...(nextPayload ?? {}), status: 'interrupted', interrupted_reason: 'transport_lost', safe_error: INTERRUPTED_SAFE_ERROR }
        this.database.prepare("INSERT OR IGNORE INTO wizard_interrupt_recovery(public_run_id, state, at) VALUES(?, 'pending', ?)")
          .run(record.publicRunId, nowSeconds())
      }
      const workerRunId = result?.workerRunId ?? record.workerRunId
      // An UPDATE rewrites the whole row, saved request body included (up to ~6 MB with
      // attachments): ~30-70 ms and MBs of journal per running reply every 1.5 s. Write only
      // when something changed, plus a 30 s heartbeat so updated_at stays fresh.
      if (capacityStatus === record.status && !TERMINAL.has(capacityStatus) && workerRunId === record.workerRunId
          && !record.waitingReason && record.terminalAt === null && nowSeconds() - record.updatedAt < 30
          && JSON.stringify(nextPayload ?? null) === JSON.stringify(record.payload ?? null)) return record
      return this._update(record.publicRunId, {
        status: capacityStatus,
        payload: nextPayload,
        workerRunId,
        waitingReason: '',
        terminalAt: TERMINAL.has(capacityStatus) ? nowSeconds() : null,
      })
    } catch {
      return record
    }
  }

  async _launch(record) {
    const fresh = this.get(record.publicRunId)
    if (!fresh || !['queued', 'launching'].includes(fresh.status)) return fresh ?? record
    if (fresh.upstreamRunId) return this._refresh(fresh, true)
    let current = this._update(record.publicRunId, { status: 'launching', waitingReason: '' })
    try {
      const result = await this.launch(current)
      const payload = record.runtime === 'direct' ? normalizeProviderPreflightFailure(result?.payload) : result?.payload
      if (payload !== result?.payload) { result.payload = payload; result.capacityStatus = 'failed' }
      const status = safeStatus(result?.capacityStatus ?? result?.status ?? result?.payload?.status)
      current = this._update(record.publicRunId, {
        status,
        upstreamRunId: String(result?.upstreamRunId ?? ''),
        workerRunId: String(result?.workerRunId ?? ''),
        payload: result?.payload ?? {},
        trustedPaths: result?.trustedPaths ?? current.trustedPaths,
        waitingReason: '',
        retryAfter: 0,
        terminalAt: TERMINAL.has(status) ? nowSeconds() : null,
      })
      this.database.prepare('DELETE FROM wizard_provider_backoff WHERE scope=?').run(providerScope(current))
      return current
    } catch (error) {
      const status = Number(error?.status)
      if (status === 410 && (current.continuation || /^(wizard-helper-receipt-|wizard-follow-through-)/u.test(current.idempotencyKey))) {
        return this._update(record.publicRunId, { status: 'cancelled', payload: { status: 'cancelled', safe_error: 'The helper request is no longer current.' }, waitingReason: '', terminalAt: nowSeconds() })
      }
      // Permanent admission failures never enter provider backoff or capacity retry.
      const failure = admissionFailure(error)
      const retry = !failure && (error instanceof TypeError || RETRIABLE.has(status))
      let delay = this.retryDelayMs / 1000
      if (retry && (status === 429 || error?.retryAfter)) {
        const scope = providerScope(current)
        const previous = this.database.prepare('SELECT failures, retry_after FROM wizard_provider_backoff WHERE scope=?').get(scope)
        const failures = Math.min(10, Number(previous?.failures || 0) + 1)
        // Bound only our exponential delay, never the provider's Retry-After.
        delay = Math.max(retryDelaySeconds(String(error?.retryAfter ?? ''), delay), Math.min(60, delay * 2 ** (failures - 1)), Number(previous?.retry_after || 0) - nowSeconds())
        this.database.prepare('INSERT OR REPLACE INTO wizard_provider_backoff VALUES(?,?,?)').run(scope, nowSeconds() + delay, failures)
      }
      return this._update(record.publicRunId, retry
        ? { status: 'queued', waitingReason: status === 429 || error?.retryAfter ? 'provider_busy' : 'admission_retry', retryAfter: nowSeconds() + delay }
        : { status: 'failed', payload: { status: 'failed', error: error?.upstreamError, safe_error: failure || 'Wizard could not start this queued work.' }, terminalAt: nowSeconds() })
    }
  }

  async _reconcileStale() {
    if (!this.turnHeld || !this.confirmAbandoned) return
    const now = nowSeconds()
    const rows = this._rows("status IN ('running','stopping') AND upstream_run_id <> '' AND worker_run_id = ''")
    const seen = new Set(rows.map((record) => record.publicRunId))
    for (const id of this.leaselessSince.keys()) if (!seen.has(id)) this.leaselessSince.delete(id)
    for (const record of rows) {
      if (now - record.createdAt < this.staleAfterSeconds) continue
      let held
      try { held = await this.turnHeld(record) }
      catch { held = null }
      if (held !== false) { this.leaselessSince.delete(record.publicRunId); continue }
      const since = this.leaselessSince.get(record.publicRunId) ?? now
      this.leaselessSince.set(record.publicRunId, since)
      if (now - since < this.staleAfterSeconds) continue
      let verdict
      try { verdict = await this.confirmAbandoned(record) }
      catch { verdict = null }
      if (!verdict || !TERMINAL.has(verdict.status)) continue
      const payload = { ...(record.payload ?? {}), status: verdict.status, last_event: 'run.reconciled', reconciled_reason: 'no_turn_held' }
      this._update(record.publicRunId, { status: verdict.status, payload, waitingReason: '', terminalAt: nowSeconds() })
      this.leaselessSince.delete(record.publicRunId)
      try { this.onReconciled(record, verdict, now - since) } catch { /* logging only */ }
    }
  }

  async _tick(force) {
    // The status is stored after the request body, so a plain scan follows every saved body's
    // overflow pages each 1.5 s. Select the identities through the (status, …) index instead.
    let activeRows = this._rows("public_run_id IN (SELECT public_run_id FROM wizard_run_queue INDEXED BY wizard_run_queue_fifo WHERE status NOT IN ('queued','completed','failed','cancelled','interrupted'))")
    for (const record of activeRows) {
      if (record.status === 'launching' && !record.upstreamRunId) await this._launch(record)
      else await this._refresh(record, force)
    }
    await this._reconcileStale()
    await this._recoverInterrupted()

    let external
    try { external = await this.activeSessionIds() }
    catch {
      for (const record of this._rows("status = 'queued'")) this._update(record.publicRunId, { waitingReason: 'liveness_unavailable' })
      return
    }
    if (!Array.isArray(external)) {
      for (const record of this._rows("status = 'queued'")) this._update(record.publicRunId, { waitingReason: 'liveness_unavailable' })
      return
    }
    const activeSessions = new Set(external.filter((value) => typeof value === 'string' && value))
    activeRows = this._rows("status IN ('launching','running','waiting_for_approval','stopping')")
    for (const record of activeRows) activeSessions.add(record.sessionId)
    const fenced = new Set(this._rows("status = 'unknown'").map(record => record.sessionId))
    for (const id of fenced) activeSessions.delete(id)

    let dispatchHealthy = false
    try { dispatchHealthy = Boolean(await this.canDispatch()) }
    catch { dispatchHealthy = false }
    if (!dispatchHealthy) {
      for (const record of this._rows("status = 'queued'")) this._update(record.publicRunId, { waitingReason: 'system_busy' })
      return
    }

    const pending = this._rows("status = 'queued'")
    if (this.reservedInteractive) pending.sort((a, b) => Number(isBackgroundContinuation(a)) - Number(isBackgroundContinuation(b)))
    for (const record of pending) {
      if (activeSessions.size >= this.maxActive) break
      // Background turns may consume only the nonreserved total occupancy.
      // Existing turns are never preempted; two slots stay reachable by people.
      if (this.reservedInteractive && isBackgroundContinuation(record)
          && activeSessions.size >= this.maxActive - this.reservedInteractive) {
        this._update(record.publicRunId, { waitingReason: 'interactive_reserve' })
        continue
      }
      const cooldown = this.database.prepare('SELECT retry_after FROM wizard_provider_backoff WHERE scope=?').get(providerScope(record))
      if (Number(cooldown?.retry_after || 0) > nowSeconds()) {
        this._update(record.publicRunId, { waitingReason: 'provider_busy' })
        continue
      }
      if (record.retryAfter > nowSeconds()) continue
      // Unknown holds only its session, not a global slot or the interactive reserve.
      if (activeSessions.has(record.sessionId) || fenced.has(record.sessionId)) {
        this._update(record.publicRunId, { waitingReason: 'capacity' })
        continue
      }
      const launched = await this._launch(record)
      if (ACTIVE.has(launched.status)) activeSessions.add(launched.sessionId)
      if (launched.status === 'unknown') fenced.add(launched.sessionId)
    }
    for (const record of this._rows("status = 'queued'")) {
      if (!record.waitingReason) this._update(record.publicRunId, { waitingReason: 'capacity' })
    }

    this._pruneTerminal()
  }

  // Retention: finished runs older than 7 days go, keeping the newest 128 of those. terminal_at
  // sits after the request body, so without wizard_run_queue_terminal this scanned every saved
  // body under a write lock each 1.5 s tick (~70 ms, ~20% of a core). Once a minute is plenty.
  _pruneTerminal(force = false) {
    const now = nowSeconds()
    if (!force && now - (this.lastPruneAt ?? 0) < 60) return
    this.lastPruneAt = now
    this.database.prepare(`DELETE FROM wizard_run_queue WHERE public_run_id IN (
      SELECT public_run_id FROM wizard_run_queue INDEXED BY wizard_run_queue_terminal
       WHERE terminal_at IS NOT NULL AND terminal_at < ?
          AND idempotency_key NOT LIKE 'schedule:%'
       ORDER BY terminal_at DESC LIMIT -1 OFFSET 128
    )`).run(now - 7 * 24 * 60 * 60)
  }
}
