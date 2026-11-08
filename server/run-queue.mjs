import { createSlowTickLogger } from './speed-meter.mjs'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { withSqliteMigration, qualifyContinuation } from './thread-reference.mjs'
import { DatabaseSync } from 'node:sqlite'
import { normalizeProviderPreflightFailure } from './run-provider-failure.mjs'
import { annotateProviderSignOut } from './provider-reconnect.mjs'
import { admissionFailure, retryDelaySeconds } from './hermes-compat.mjs'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const TERMINAL_READ_TICK_MS = 5_000
const ACTIVE = new Set(['launching', 'running', 'waiting_for_approval', 'stopping'])
const ACTIVE_OR_QUEUED = new Set([...ACTIVE, 'queued'])
const HEAVY_COLUMNS = new Set(['body', 'dispatch_body', 'worker_dispatch_body'])
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
export const NOT_STARTED_REQUEUE_PREFIX = 'wizard-not-started-requeue-'
// A reply Hermes accepts but never starts is resent this many times, then fails visibly with Retry.
export const NOT_STARTED_MAX_RESENDS = 3
export const NOT_STARTED_SAFE_ERROR = 'Your agent took this message but never started on it, even after Wizard sent it again. Your message is saved. Tap Retry, or open Troubleshooter if it keeps happening.'
export const INTERRUPT_RECOVERY_PREFIX = 'wizard-interrupt-recovery-'
export const INTERRUPTED_SAFE_ERROR = 'Wizard restarted while this was running, so the reply was cut off.'
// Pending steer replay: Hermes accepts a steer (POST /v1/runs/<id>/steer -> 200) and injects it at the
// run's next tool result. A steer that arrives while the run is writing its final answer has no next
// tool result, so Hermes ends the run with the text in `pending_steer` "for replay" (24 Oct 2026: a voice
// note and a photo showed "Delivered · Wizard sees it next step" and were never read). The queue replays
// that text once, as the owner's next ordinary turn in the same thread, under this stable key prefix.
export const PENDING_STEER_REPLAY_PREFIX = 'wizard-pending-steer-'
const RECOVERY_EXCERPT_CHARS = 120
const MAX_QUEUED_BODY_BYTES = 12 * 1024 * 1024
const MAX_QUEUED_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_QUEUED_IMAGES = 9
const MAX_PROJECTION_INPUTS = 2048

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
  if (record.providerRecoveryAttempted && annotateProviderSignOut({ ...payload, status: 'failed' }, parseJson(record.body, null)).wizard_reconnect) {
    return { safeError: 'The automatic send could not finish because sign-in still needs attention. Your message is saved. Sign in again, then tap Retry.' }
  }
  const annotated = annotateProviderSignOut({ ...payload, status: 'failed' }, parseJson(record.body, null))
  return annotated.wizard_reconnect
    ? { safeError: '', reconnect: { ...annotated.wizard_reconnect, run_id: record.publicRunId } }
    : { safeError }
}

const queuedInputPreview = (body) => {
  const value = typeof body === 'string' ? parseJson(body, {}) : body
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

// The undelivered steer Hermes returns on a terminal run, or '' when there is none.
export const pendingSteerText = (payload) => (typeof payload?.pending_steer === 'string' ? payload.pending_steer.trim() : '')

// Comparable form of a message: its words before any Wizard file block, whitespace collapsed. Two
// messages are the same only when these are equal (never a substring: "yes" is not "yesterday").
export const steerProbe = (text) => {
  const words = String(text ?? '').split('[WIZARD_FILES_V1]')[0].replace(/\s+/g, ' ').trim()
  return words || String(text ?? '').replace(/\s+/g, ' ').trim()
}

// Files the steer attached that are not the owner's visible files stay redacted in the replay's output.
const hiddenFilePaths = (text) => {
  const block = String(text).match(/\[WIZARD_FILES_V1\]\s*([\s\S]*?)\s*\[\/WIZARD_FILES_V1\]/u)?.[1]
  const files = block ? parseJson(block, []) : []
  return Array.isArray(files) ? files.filter(file => file && !file.userVisible && typeof file.trusted_path === 'string').map(file => file.trusted_path) : []
}

/** The text of a saved /v1/runs request body (string or JSON). */
export const queuedInputTextOf = (body) => queuedInputText(typeof body === 'string' ? parseJson(body, {}) : body)

const requestError = (message, status) => Object.assign(new Error(message), { status })

export function queueRequestHash(runtime, body) {
  return createHash('sha256').update(`${runtime}\0${body}`).digest('hex')
}

export class DurableRunQueue {
  constructor({
    statePath,
    agentId = 'hermes',
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
    // Pending steer replay: steerDelivered(record, text) -> true when the thread already holds a user
    // turn with this text after the run started (resent by hand), false when not; a throw retries later.
    steerDelivered = null,
    onPendingSteerReplay = () => {},
    providerSignInReady = null,
    providerAccessRecovery = false,
    providerAccessWindowSeconds = 6 * 3600,
    providerFailureDismissed = () => false,
    // Hermes can take minutes to accept one new run (7 Nov 2026: POST /v1/runs took 658-1201 s while
    // every other Hermes read stayed fast). A tick waits at most launchWaitMs in total for launches;
    // a slower launch keeps going in the background, holds its thread and slot, and is never re-sent
    // while it is in flight. summary() waits at most summaryWaitMs for a tick so health always answers.
    launchWaitMs = 3_000,
    summaryWaitMs = 500,
    slowLaunchSeconds = 20,
    // 8 Nov 2026: new chats waited 13-20 min because every slot was held by runs Hermes had accepted but
    // whose turn nothing held (a stalled gateway, a dead agent). A run Hermes confirms has no turn held
    // for ghostGraceSeconds still fences its own thread but no longer occupies a global slot; people's
    // sends may use interactiveOverflow slots beyond maxActive (Hermes admits more than Wizard's 8).
    ghostGraceSeconds = 90,
    interactiveOverflow = 0,
    // 8 Nov 2026: Hermes accepted a reply (status `queued`, admission, no turn lease) and never started it, yet the
    // row stayed `running` for 20+ min, held a slot, and the owner's reply sat on "Queued". A run Hermes still calls
    // `queued` with no lease on its thread for notStartedSeconds is cancelled upstream (cancelUpstream -> true only
    // when Hermes confirms it is gone) and its exact message is sent again as a fresh run.
    notStartedSeconds = 60,
    leaseHeld = null,
    cancelUpstream = null,
    onRequeued = () => {},
    onNotStartedGaveUp = () => {},
  }) {
    if (!statePath) throw new Error('Wizard run queue state path is required')
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 64) throw new Error('Wizard run queue capacity is invalid')
    if (typeof launch !== 'function' || typeof lookup !== 'function') throw new Error('Wizard run queue transport is required')
    if (typeof agentId !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(agentId)) throw new Error('Wizard run queue agent is invalid')
    this.agentId = agentId
    this.logSlowTick = createSlowTickLogger(`run-queue:${agentId}`)
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
    this.steerDelivered = steerDelivered
    this.providerSignInReady = providerSignInReady
    this.providerAccessRecovery = providerAccessRecovery === true
    this.providerFailureDismissed = providerFailureDismissed
    this.providerAccessWindowSeconds = Math.max(1, Math.min(6 * 3600, Number(providerAccessWindowSeconds) || 6 * 3600))
    this.onPendingSteerReplay = onPendingSteerReplay
    this.leaselessSince = new Map()
    this.ghostGraceSeconds = Math.max(15, Number(ghostGraceSeconds) || 90)
    this.interactiveOverflow = Math.max(0, Math.min(8, Number.isSafeInteger(interactiveOverflow) ? interactiveOverflow : 0))
    this.ghostSessions = new Set()
    this.notStartedSeconds = Math.max(5, Number(notStartedSeconds) || 60)
    this.leaseHeld = leaseHeld
    this.cancelUpstream = cancelUpstream
    this.onRequeued = onRequeued
    this.onNotStartedGaveUp = onNotStartedGaveUp
    this.stalledSince = new Map()
    this.statements = new Map()
    this.failureProjections = new Map()
    this.gaveUpAt = []
    this.notStartedSince = new Map()
    this.refreshedAt = new Map()  // run id -> last lookup time; the 0.7 s throttle no longer relies on updated_at
    this.refreshing = new Map() // status polls share only this run's lookup, never the global tick
    this.launches = new Map() // run id -> { promise, startedAt }: one in-flight Hermes admission per run
    this.launchWaitMs = Math.max(0, Number.isFinite(Number(launchWaitMs)) ? Number(launchWaitMs) : 3_000)
    this.summaryWaitMs = Math.max(0, Number.isFinite(Number(summaryWaitMs)) ? Number(summaryWaitMs) : 500)
    this.slowLaunchSeconds = Math.max(1, Number(slowLaunchSeconds) || 20)
    // Retain only preview text and the provider hint, never attachment-bearing requests.
    this.projectionInputs = new Map()
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
      CREATE INDEX IF NOT EXISTS wizard_run_queue_session_latest
        ON wizard_run_queue(session_id, CASE WHEN status='unknown' THEN 0 ELSE 1 END,
          created_at DESC, public_run_id DESC, status);
      CREATE TABLE IF NOT EXISTS wizard_owner_stops (
        run_id TEXT PRIMARY KEY, at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wizard_interrupt_recovery (
        public_run_id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        recovery_run_id TEXT NOT NULL DEFAULT '', at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wizard_pending_steer_replay (
        public_run_id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        replay_run_id TEXT NOT NULL DEFAULT '', at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wizard_accepted_steers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, public_run_id TEXT NOT NULL,
        text TEXT NOT NULL, at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wizard_accepted_steers_session ON wizard_accepted_steers(session_id, at);
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
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'provider_wait_deadline')) {
      this.database.exec('ALTER TABLE wizard_run_queue ADD COLUMN provider_wait_deadline REAL NOT NULL DEFAULT 0; ALTER TABLE wizard_run_queue ADD COLUMN provider_recovery_attempted INTEGER NOT NULL DEFAULT 0;')
    }
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'retry_source_id')) {
      this.database.exec("ALTER TABLE wizard_run_queue ADD COLUMN retry_source_id TEXT NOT NULL DEFAULT ''; ALTER TABLE wizard_run_queue ADD COLUMN retry_order_at REAL NOT NULL DEFAULT 0;")
    }
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'worker_dispatch_body')) {
      this.database.exec("ALTER TABLE wizard_run_queue ADD COLUMN worker_dispatch_body TEXT")
    }
    })
    if (this.database.prepare('SELECT 1 FROM wizard_run_queue WHERE agent_id <> ? LIMIT 1').get(this.agentId)) throw new Error('Wizard run queue belongs to another agent')
    this.database.exec('CREATE TABLE IF NOT EXISTS wizard_provider_signin_seen (public_run_id TEXT PRIMARY KEY REFERENCES wizard_run_queue(public_run_id) ON DELETE CASCADE);')
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    } catch (error) {
      try { this.database.close() } catch { /* preserve original */ }
      throw error
    }
  }

  async initialize() {
    if (this.closed) throw new Error('Wizard run queue is closed')
    // Normalize older terminal receipts without replaying or changing saved requests.
    for (const record of this._rows("status IN ('completed','failed') AND runtime = 'direct' AND (payload_json LIKE '%Provider authentication failed:%' OR payload_json LIKE '%credentials%' OR payload_json LIKE '%Codex%')")) {
      const payload = normalizeProviderPreflightFailure(record.payload)
      if (payload !== record.payload) this._update(record.publicRunId, { status: 'failed', payload, updatedAt: record.updatedAt })
    }
    // Only failure-time admission creates provider_access intent. Enabling this
    // feature must not resurrect old failures; persisted waits resume in tick().
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
    // With no in-flight work preserve synchronous close for existing callers.
    if (!this.tickPromise && !this.refreshing.size && !this.launches.size) { this.database.close(); return this.closePromise = Promise.resolve() }
    return this.closePromise = Promise.allSettled([this.tickPromise, ...this.refreshing.values(), ...[...this.launches.values()].map(launch => launch.promise)])
      .then(() => this.database.close())
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
      retrySourceId: row.retry_source_id || '', retryOrderAt: Number(row.retry_order_at) || 0,
      providerWaitDeadline: Number(row.provider_wait_deadline) || 0,
      providerRecoveryAttempted: Boolean(row.provider_recovery_attempted),
      waitingReason: row.waiting_reason,
      retryAfter: Number(row.retry_after) || 0,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      terminalAt: row.terminal_at === null ? null : Number(row.terminal_at),
    }
  }

  get(publicRunId) {
    if (!PUBLIC_ID.test(String(publicRunId ?? ''))) return null
    return this._record(this._statement('SELECT * FROM wizard_run_queue WHERE public_run_id = ?').get(publicRunId))
  }

  // Saved request bodies carry attachments (up to MB each; 3.3k rows ~128 MB on 8 Nov 2026). Status scans run every
  // 1.5 s tick and used to read every matching body into memory several times per tick (~0.3 core). Rows read for
  // status work (_rows, latestForSession) leave the body columns behind; record.body (and the dispatch bodies) load
  // on first access, while the queue is open. get() still returns a complete record for callers outside the queue.
  _lightColumns() {
    return this.lightColumns ??= this.database.prepare('PRAGMA table_info(wizard_run_queue)').all()
      .map((column) => column.name).filter((name) => !HEAVY_COLUMNS.has(name)).join(', ')
  }

  _statement(sql) {
    let statement = this.statements.get(sql)
    if (!statement) {
      if (this.statements.size > 200) this.statements.clear()
      statement = this.database.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  _lazyRecord(row) {
    if (!row) return null
    const record = this._record({ ...row, body: '', dispatch_body: null, worker_dispatch_body: null })
    let loaded = null
    const load = () => loaded ??= this._statement('SELECT body, dispatch_body, worker_dispatch_body FROM wizard_run_queue WHERE public_run_id = ?').get(row.public_run_id)
      ?? { body: '', dispatch_body: null, worker_dispatch_body: null }
    for (const [field, column, fallback] of [['body', 'body', ''], ['dispatchBody', 'dispatch_body', null], ['workerDispatchBody', 'worker_dispatch_body', null]]) {
      Object.defineProperty(record, field, { enumerable: true, configurable: true,
        get: () => load()[column] ?? fallback,
        set: (value) => Object.defineProperty(record, field, { value, writable: true, enumerable: true, configurable: true }) })
    }
    return record
  }

  // failureProjection parses the saved body; failed rows rarely change, so reuse the answer until the row does.
  _failureProjection(record) {
    if (record.status !== 'failed') return failureProjection(record)
    const key = `${record.updatedAt}:${record.providerRecoveryAttempted ? 1 : 0}`
    const cached = this.failureProjections.get(record.publicRunId)
    if (cached?.key === key) return cached.value
    const value = failureProjection(record)
    if (this.failureProjections.size > 1000) this.failureProjections.clear()
    this.failureProjections.set(record.publicRunId, { key, value })
    return value
  }

  admittedForSession(runtime, sessionId) {
    if (!['direct', 'operator'].includes(runtime) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) return []
    return this.database.prepare(`SELECT * FROM wizard_run_queue
      WHERE runtime = ? AND session_id = ? AND upstream_run_id <> ''
      ORDER BY created_at, public_run_id`).all(runtime, sessionId).map((row) => this._record(row))
  }

  /** Every queued row for a thread, including ones that have not reached Hermes (no upstream run yet). */
  queuedForSession(runtime, sessionId) {
    if (!['direct', 'operator'].includes(runtime) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) return []
    return this.database.prepare(`SELECT * FROM wizard_run_queue
      WHERE runtime = ? AND session_id = ?
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

  _rows(where = '1=1', ...params) {
    return this._statement(`SELECT ${this._lightColumns()} FROM wizard_run_queue WHERE ${where} ORDER BY CASE WHEN retry_order_at>0 THEN retry_order_at ELSE created_at END, CASE WHEN retry_source_id<>'' THEN retry_source_id ELSE public_run_id END, public_run_id`).all(...params).map((row) => this._lazyRecord(row))
  }

  _update(publicRunId, changes) {
    const allowed = {
      status: 'status', upstreamRunId: 'upstream_run_id', workerRunId: 'worker_run_id',
      payload: 'payload_json', waitingReason: 'waiting_reason', retryAfter: 'retry_after',
      retrySourceId: 'retry_source_id', retryOrderAt: 'retry_order_at',
      providerWaitDeadline: 'provider_wait_deadline', providerRecoveryAttempted: 'provider_recovery_attempted',
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
    if (entries.some(([key]) => key === 'body')) this.projectionInputs.delete(publicRunId)
    return this.get(publicRunId)
  }

  _position(publicRunId) {
    const queued = this.database.prepare(`SELECT public_run_id FROM wizard_run_queue
      WHERE status = 'queued' AND waiting_reason <> 'provider_access'
      ORDER BY CASE WHEN retry_order_at>0 THEN retry_order_at ELSE created_at END,
        CASE WHEN retry_source_id<>'' THEN retry_source_id ELSE public_run_id END, public_run_id`).all()
    const index = queued.findIndex((record) => record.public_run_id === publicRunId)
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
    const failure = failureProjection(current)
    if (current.providerRecoveryAttempted && current.status === 'failed'
        && annotateProviderSignOut({ ...payload, status: 'failed' }, parseJson(current.body, null)).wizard_reconnect) {
      delete payload.wizard_reconnect; delete payload.wizard_provider_auth
      payload.safe_error = failure.safeError
      payload.error = { type: 'provider_recovery_failed', message: failure.safeError }
      payload.output = ''; if ('final_response' in payload) payload.final_response = ''
    }
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
      ...this._failureProjection(record),
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

  // Per-thread fingerprint of every queue row (rowid/id/status/update), for the Chats list cache: a thread
  // whose rows were added, changed or pruned by retention must be re-projected. Reads status
  // from the index and session_id from the row head, never the body (~10 ms for ~1,800 rows).
  sessionStamps() {
    const rows = this.database.prepare(`
      SELECT rowid, session_id, public_run_id, status, updated_at FROM wizard_run_queue INDEXED BY wizard_run_queue_fifo
    `).all()
    const parts = new Map()
    for (const row of rows) {
      const id = String(row.session_id)
      if (!parts.has(id)) parts.set(id, [])
      parts.get(id).push(`${row.rowid}:${row.public_run_id}=${row.status}:${row.updated_at}`)
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

  // Same winner as latestProjections, including unknown's session fence and launching -> queued.
  // Background discovery needs only this status, not previews, payloads or queue positions.
  latestStatus(sessionId) {
    const row = this.database.prepare(`SELECT status FROM wizard_run_queue WHERE session_id = ?
      ORDER BY CASE WHEN status='unknown' THEN 0 ELSE 1 END, created_at DESC, public_run_id DESC LIMIT 1`).get(sessionId)
    return row?.status === 'launching' ? 'queued' : row?.status ?? null
  }

  _projectionInput(row) {
    const cached = this.projectionInputs.get(row.public_run_id)
    if (cached && cached.requestHash === row.request_hash) return cached
    const body = this.database.prepare('SELECT body FROM wizard_run_queue WHERE public_run_id = ?').get(row.public_run_id)?.body
    const value = parseJson(body, null)
    const provider = value?.provider
    const input = { requestHash: row.request_hash, preview: queuedInputPreview(value),
      body: JSON.stringify(typeof provider === 'string' ? { provider } : {}) }
    if (this.projectionInputs.size >= MAX_PROJECTION_INPUTS) this.projectionInputs.delete(this.projectionInputs.keys().next().value)
    this.projectionInputs.set(row.public_run_id, input)
    return input
  }

  latestProjections(sessionIds) {
    const ids = Array.isArray(sessionIds) ? [...new Set(sessionIds)] : null
    if (ids && !ids.length) return []
    // Another connection may edit a saved request. Our own edits invalidate the one entry in _update.
    const version = this.database.prepare('PRAGMA data_version').get().data_version
    if (version !== this.projectionDataVersion) this.projectionInputs.clear()
    this.projectionDataVersion = version
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
        current.waiting_reason, current.request_hash, current.provider_recovery_attempted, current.idempotency_key,
        json_object('safe_error', json_extract(current.payload_json, '$.safe_error'),
          'wizard_reconnect', current.payload_json -> '$.wizard_reconnect',
          'error', current.payload_json -> '$.error',
          'output', substr(json_extract(current.payload_json, '$.output'), 1, 4000),
          'runtime', current.payload_json -> '$.runtime',
          'usage', json_object('runtime', current.payload_json -> '$.usage.runtime')) AS payload_json,
        current.created_at, current.updated_at
      FROM ranked JOIN wizard_run_queue current USING (public_run_id)
      WHERE ranked.position = 1
      ORDER BY current.created_at, current.public_run_id
    `).all(...(ids ?? [])).map((row) => {
      const input = this._projectionInput(row)
      return { ...this._record(row), body: input.body, preview: input.preview }
    }).map((record) => ({
      sessionId: record.sessionId,
      status: record.status === 'queued' || record.status === 'launching' ? 'queued' : record.status,
      queuePosition: record.status === 'queued' ? this._position(record.publicRunId) : 0,
      queueReason: record.waitingReason,
      preview: record.preview,
      ...failureProjection(record),
      publicRunId: record.publicRunId,
      idempotencyKey: record.idempotencyKey,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
  }

  // Durable insertion order rather than UUID order for same-millisecond admissions.
  latestForSession(sessionId) {
    const latest = this._statement('SELECT MAX(rowid) AS rowid FROM wizard_run_queue WHERE session_id=?').get(sessionId)
    const row = latest?.rowid == null ? null : this._statement(`SELECT ${this._lightColumns()} FROM wizard_run_queue WHERE rowid=?`).get(latest.rowid)
    return row ? this._lazyRecord(row) : null
  }

  /** Retry references are scoped to the original thread; the queue, not display history, owns bytes. */
  savedRetry(sessionId) {
    const record = this.latestForSession(sessionId)
    return record && (['failed', 'interrupted'].includes(record.status) || record.waitingReason === 'provider_access') && !this._ownerStopped(record) ? record : null
  }

  _retrySavedRow(publicRunId, sessionId, route = {}, automatic = false) {
    const source = this.get(publicRunId)
    if (!source || source.sessionId !== sessionId || source.runtime !== 'direct') throw requestError('saved retry not found', 404)
    const key = `wizard-saved-retry-${publicRunId}`
    const existing = this.byIdempotencyKey(source.runtime, key)
    if (existing) {
      // Recovery or another device may have admitted this source first. Never
      // acknowledge a manual retry on a different route as the owner's choice;
      // the existing execution cannot be switched and must not be duplicated.
      const selected = parseJson(existing.body, {})
      if (!automatic && ((route.model && selected.model !== route.model) || (route.provider && selected.provider !== route.provider))) {
        throw requestError('This saved request already restarted on another model. Check the latest reply before retrying.', 412)
      }
      // Crash recovery: insertion always precedes releasing the waiting source.
      if (source.waitingReason === 'provider_access') this._releaseProviderSource(source)
      return { record: existing, replayed: true }
    }
    if ((!automatic && this.savedRetry(sessionId)?.publicRunId !== publicRunId)
        || (automatic && source.waitingReason !== 'provider_access' && !(source.status === 'failed' && failureProjection(source).reconnect && !source.providerRecoveryAttempted && this.savedRetry(sessionId)?.publicRunId === publicRunId)) || this._ownerStopped(source)) throw requestError('saved request is no longer current', 409)
    const value = parseJson(source.body, {})
    if (!value.input || (typeof value.input === 'string' && !value.input.trim()) || (Array.isArray(value.input) && !value.input.length)) throw requestError('saved request is empty', 409)
    if (route.model) Object.assign(value, { model: route.model, ...(route.provider ? { provider: route.provider } : {}), require_model_lock: true })
    if (automatic) {
      const runtime = source.payload?.runtime || source.payload?.usage?.runtime || {}
      value.model ||= runtime.model || runtime.requested?.model
      value.provider ||= runtime.provider || runtime.requested?.provider
      value.require_model_lock = true // never permit provider fallback on a recovered owner request
    }
    const body = JSON.stringify(value)
    // One synchronous transaction: a process crash cannot insert a child without its inherited bounds.
    this.database.exec('BEGIN IMMEDIATE')
    let admitted
    try {
      admitted = this._admitRow({ runtime: source.runtime, sessionId, idempotencyKey: key,
        requestHash: queueRequestHash(source.runtime, body), body, trustedPaths: source.trustedPaths,
        continuation: source.continuation, recoveryAuthorized: source.recoveryAuthorized, agent_id: source.agent_id }, true)
      this._update(admitted.record.publicRunId, { retrySourceId: source.retrySourceId || source.publicRunId,
        retryOrderAt: source.retryOrderAt || source.createdAt, providerWaitDeadline: source.providerWaitDeadline,
        providerRecoveryAttempted: automatic || source.providerRecoveryAttempted ? 1 : 0 })
      if (source.waitingReason === 'provider_access') this._releaseProviderSource(source)
      this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
    return { ...admitted, record: this.get(admitted.record.publicRunId) }
  }

  async retrySaved(publicRunId, sessionId, route = {}) {
    const result = this._retrySavedRow(publicRunId, sessionId, route)
    if (!result.replayed) await this.tick()
    return { ...result, record: this.get(result.record.publicRunId) }
  }

  _releaseProviderSource(source) {
    this._update(source.publicRunId, { status: 'cancelled', waitingReason: '', retryAfter: 0,
      payload: { status: 'cancelled', superseded_by_retry: true }, terminalAt: nowSeconds() })
  }

  dismissProviderAccess(sessionId) {
    // Dismiss is session-scoped, including helper deliveries and queued rows
    // whose public run id is not the displayed external failure reference.
    for (const row of this.database.prepare("SELECT * FROM wizard_run_queue WHERE session_id=? AND status='queued' AND (waiting_reason='provider_access' OR (provider_recovery_attempted=1 AND retry_source_id<>''))").all(sessionId)) {
      this._releaseProviderSource(this._record(row))
    }
  }

  _waitForProvider(record) {
    if (!this.providerAccessRecovery || record.runtime !== 'direct' || record.status !== 'failed'
        || record.payload?.error?.type !== 'provider_preflight_failed' || record.providerRecoveryAttempted
        || this._ownerStopped(record) || this.providerFailureDismissed(record)) return record
    const value = parseJson(record.body, {})
    if (!value.input || (typeof value.input === 'string' && !value.input.trim()) || (Array.isArray(value.input) && !value.input.length)) return record
    if (!record.continuation && this.latestForSession(record.sessionId)?.publicRunId !== record.publicRunId) return record
    const deadline = record.providerWaitDeadline || record.createdAt + this.providerAccessWindowSeconds
    if (deadline <= nowSeconds()) return record
    // Negative failures extends the existing backoff row with an access fence, not a time-based blind resend.
    this.database.prepare('INSERT OR REPLACE INTO wizard_provider_backoff VALUES(?,?,?)').run(providerScope(record), deadline, -1)
    return this._update(record.publicRunId, { status: 'queued', waitingReason: 'provider_access',
      providerWaitDeadline: deadline, retryAfter: deadline, terminalAt: null })
  }

  _noteProviderSuccess(record) {
    if (!this.providerAccessRecovery || record.runtime !== 'direct' || record.status !== 'completed') return
    // Configured means this queue's own runtime, never another agent or provider.
    const provider = parseJson(record.body, {})?.provider || 'configured'
    for (const row of this.database.prepare('SELECT scope FROM wizard_provider_backoff WHERE failures=-1').all()) {
      const [runtime, savedProvider] = parseJson(row.scope, [])
      if (runtime === record.runtime && savedProvider === provider) this.database.prepare('DELETE FROM wizard_provider_backoff WHERE scope=?').run(row.scope)
    }
  }

  async _resumeDiagnosedSignIns() {
    if (!this.providerSignInReady) return
    // Exclude expired failures through the existing covering FIFO index before
    // SELECT * hydrates saved requests. Filtering them inside the loop rereads
    // every historical failure's attachment-bearing body on each queue tick.
    for (const source of this._rows(`public_run_id IN (
      SELECT public_run_id FROM wizard_run_queue INDEXED BY wizard_run_queue_fifo
      WHERE status='failed' AND created_at>?
    ) AND +runtime='direct' AND +provider_recovery_attempted=0`, nowSeconds() - this.providerAccessWindowSeconds)) {
      // The unary + keeps the planner on the id list above. Left bare, runtime='direct' picks the
      // (runtime, idempotency_key) index and walks every direct row (3.3k, ~110 MB of bodies) per tick.
      if (source.createdAt + this.providerAccessWindowSeconds <= nowSeconds()) continue
      const diagnosis = this._failureProjection(source).reconnect
      if (!diagnosis || this._ownerStopped(source) || this.savedRetry(source.sessionId)?.publicRunId !== source.publicRunId) continue
      let ready
      try { ready = await this.providerSignInReady(diagnosis.provider) === true } catch { continue }
      if (!ready) {
        this.database.prepare('INSERT OR IGNORE INTO wizard_provider_signin_seen(public_run_id) VALUES(?)').run(source.publicRunId)
        continue
      }
      // A healthy but divergent app credential is not evidence that this failed sign-in was restored.
      if (!this.database.prepare('SELECT 1 FROM wizard_provider_signin_seen WHERE public_run_id=?').get(source.publicRunId)) continue
      try { this._retrySavedRow(source.publicRunId, source.sessionId, {}, true) } catch (error) { if (![404, 409].includes(error.status)) throw error }
    }
  }

  _resumeProviderAccess() {
    if (!this.providerAccessRecovery) return
    for (const source of this._rows("status='queued' AND waiting_reason='provider_access'")) {
      if (this._ownerStopped(source) || this.providerFailureDismissed(source)
          || (!source.continuation && this.latestForSession(source.sessionId)?.publicRunId !== source.publicRunId)) { this._releaseProviderSource(source); continue }
      if (source.providerWaitDeadline <= nowSeconds()) {
        this._update(source.publicRunId, {status:'failed', waitingReason:'', retryAfter:0,
          payload:{...source.payload,status:'failed',safe_error:'The AI sign-in did not come back in time. Your message is saved. Tap Retry when you are signed in.'},terminalAt:nowSeconds()})
        continue
      }
      if (this.database.prepare('SELECT 1 FROM wizard_provider_backoff WHERE scope=? AND failures=-1').get(providerScope(source))) continue
      try { this._retrySavedRow(source.publicRunId, source.sessionId, {}, true) }
      catch (error) {
        // A malformed legacy row must not stop the queue or block unrelated requests.
        if (!Number.isInteger(error.status)) throw error
        this._update(source.publicRunId, { status: 'failed', waitingReason: '', retryAfter: 0, terminalAt: nowSeconds(),
          payload: { ...source.payload, status: 'failed', safe_error: 'This saved message could not be resent. Open the chat to try again.' } })
      }
    }
  }

  // Receipt insertion order is not lease ownership: a newer sibling completion
  // may be queued behind the running turn. Fail closed on ambiguous owners.
  mutationOwnerForSession(sessionId) {
    const rows = this.database.prepare("SELECT * FROM wizard_run_queue WHERE session_id=? AND status IN ('running','launching') LIMIT 2").all(sessionId)
    return rows.length === 1 ? this._record(rows[0]) : null
  }

  // Launches Hermes has not answered yet. launch_waiting_s is the oldest one's wait: a large value
  // means Hermes is slow to accept new messages (they are saved and will send), not that Wizard is down.
  launchState() {
    const now = nowSeconds()
    const rows = this._rows("status = 'launching' AND upstream_run_id = ''")
    let oldest = 0
    for (const record of rows) {
      const inFlight = this.launches.get(record.publicRunId)
      const started = inFlight ? inFlight.startedAt / 1000 : record.updatedAt
      oldest = Math.max(oldest, now - started)
    }
    const waiting = Math.max(0, Math.round(oldest))
    return { launching: rows.length, launch_waiting_s: waiting, hermes_slow_to_accept: rows.length > 0 && oldest >= this.slowLaunchSeconds }
  }

  async summary({ waitMs = this.summaryWaitMs } = {}) {
    // Never wait on a whole tick: it may be waiting on Hermes. Answer from the saved queue instead.
    let timer
    const fresh = await Promise.race([
      this.tick(false).then(() => true, () => false), // a failed refresh is not fresh
      new Promise((done) => { timer = setTimeout(done, waitMs, false); timer.unref?.() }),
    ])
    clearTimeout(timer)
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
      active: [...activeSessions].filter((id) => !this.ghostSessions.has(id)).length,
      ghost_slots_released: this.ghostSessions.size,
      queued: this._rows("status = 'queued' AND waiting_reason <> 'provider_access'").length,
      dispatch_paused: !dispatchHealthy,
      liveness_available: livenessAvailable,
      lane: 'interactive',
      interactive_reserved: this.reservedInteractive,
      provider_waiting: this._rows("status = 'queued' AND waiting_reason = 'provider_busy'").length,
      queue_stale: !fresh,
      ...this.launchState(),
      ...this.notStartedState(),
    }
  }

  // `continuation` is service authority (helper tokens; background recovery; quiet watcher launch semantics).
  // Never pass a caller-supplied value here.
  async admit(request) {
    const result = this._admitRow(request)
    if (!result.replayed) await this.tick(true)
    return result.replayed ? result : { record: this.get(result.record.publicRunId), replayed: false }
  }

  _admitRow({ runtime, sessionId, idempotencyKey, requestHash, body, trustedPaths = [], continuation = null, agent_id = this.agentId, recoveryAuthorized = false }, inTransaction = false) {
    // A queue has one immutable agent authority. Main still rejects routed agents;
    // an isolated routed queue can admit only its own configured identity.
    if (agent_id !== this.agentId) throw requestError('invalid queue agent', 400)
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
    if (!inTransaction) this.database.exec('BEGIN IMMEDIATE')
    try {
      const raced = this._existing(runtime, idempotencyKey)
      if (raced) {
        if (!inTransaction) this.database.exec('ROLLBACK')
        if (raced.sessionId !== sessionId || raced.requestHash !== requestHash) throw requestError('idempotency key conflict', 409)
        return { record: raced, replayed: true }
      }
      this.database.prepare(`
        INSERT INTO wizard_run_queue (
          public_run_id, runtime, session_id, idempotency_key, request_hash, body,
          trusted_paths_json, status, created_at, updated_at, continuation_json, agent_id, recovery_authorized
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
      `).run(publicRunId, runtime, sessionId, idempotencyKey, requestHash, body, JSON.stringify(trustedPaths), createdAt, createdAt, JSON.stringify(qualifyContinuation(continuation, sessionId)), agent_id, recoveryAuthorized ? 1 : 0)
      if (!inTransaction) this.database.exec('COMMIT')
    } catch (error) {
      if (!inTransaction) try { this.database.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
    return { record: this.get(publicRunId), replayed: false }
  }

  /** A reply sent into a running turn is held by Hermes until the agent reads it, so no other client can see it.
   *  Remember the exact text so every client's thread shows it right away (until Hermes shows it itself). */
  noteAcceptedSteer(runId, text) {
    const id = String(runId ?? '')
    const body = String(text ?? '').trim().slice(0, 20_000)
    if (!id || id.length > 256 || !body) return false
    const record = this.get(id) ?? this._record(this.database.prepare('SELECT * FROM wizard_run_queue WHERE upstream_run_id = ? OR worker_run_id = ?').get(id, id))
    if (!record || record.runtime !== 'direct') return false
    const now = nowSeconds()
    this.database.prepare('INSERT INTO wizard_accepted_steers(session_id, public_run_id, text, at) VALUES(?, ?, ?, ?)').run(record.sessionId, record.publicRunId, body, now)
    this.database.prepare('DELETE FROM wizard_accepted_steers WHERE at < ?').run(now - 24 * 3600)
    return true
  }

  /** Accepted replies on this thread whose run has not finished: [{ publicRunId, text, at, status }]. */
  acceptedSteersForSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) return []
    this.database.prepare('DELETE FROM wizard_accepted_steers WHERE at < ?').run(nowSeconds() - 24 * 3600)
    const rows = this.database.prepare('SELECT public_run_id, text, at FROM wizard_accepted_steers WHERE session_id = ? AND at > ? ORDER BY at, id').all(sessionId, nowSeconds() - 6 * 3600)
    const out = []
    for (const row of rows) {
      const record = this.get(row.public_run_id)
      if (record && !TERMINAL.has(record.status)) out.push({ publicRunId: row.public_run_id, text: row.text, at: row.at, status: record.status })
    }
    return out
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
    // An interrupted run was already dispatched, so its request is already the owner's last message in
    // this thread. Quoting it in full (voice note, file block and all) put the same message in the thread
    // twice: the owner saw his voice note repeated and the model read it as a second, new request.
    // Name it by a short excerpt only, and say plainly that it is not a new message.
    const text = queuedInputText(original).split('[WIZARD_FILES_V1]')[0].replace(/\s+/g, ' ').trim()
    const excerpt = text.length > RECOVERY_EXCERPT_CHARS ? `${text.slice(0, RECOVERY_EXCERPT_CHARS).trimEnd()}…` : text
    value.input = '[Wizard follow-through] Wizard restarted while your previous turn in this thread was running, so it was '
      + 'cut off before you replied. Resume that request from where it stopped and give your final answer in this thread. '
      + 'Check what already happened before repeating any step with side effects. '
      + 'The request is the owner\'s last message above, unchanged: this note is not a new or repeated message from the owner.'
      + (excerpt ? `\n\nIt began: "${excerpt}"` : '')
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

  _notePendingSteer(record, status, payload) {
    if (!TERMINAL.has(status) || !pendingSteerText(payload)) return
    this.database.prepare("INSERT OR IGNORE INTO wizard_pending_steer_replay(public_run_id, state, at) VALUES(?, 'pending', ?)")
      .run(record.publicRunId, nowSeconds())
  }

  pendingSteerReplay(publicRunId) {
    return this.database.prepare('SELECT * FROM wizard_pending_steer_replay WHERE public_run_id = ?').get(publicRunId) ?? null
  }

  _pendingSteerBody(record, text) {
    // Same thread, same model lock and client view context as the run the owner steered; only the
    // input changes. The text is the owner's message exactly as Hermes held it (files already resolved).
    const value = { ...parseJson(record.body, {}) }
    delete value._wizard_background_recovery
    delete value.wizard_file_ids
    value.input = text
    return JSON.stringify(value)
  }

  async _replayPendingSteers() {
    const pending = this.database.prepare("SELECT public_run_id FROM wizard_pending_steer_replay WHERE state = 'pending' ORDER BY at").all()
    for (const { public_run_id: id } of pending) {
      const record = this.get(id)
      const finish = (state, reason, replayRunId = '') => {
        this.database.prepare('UPDATE wizard_pending_steer_replay SET state = ?, reason = ?, replay_run_id = ?, at = ? WHERE public_run_id = ?')
          .run(state, reason, replayRunId, nowSeconds(), id)
        try { this.onPendingSteerReplay(record, { state, reason, replayRunId }) } catch { /* logging only */ }
      }
      const text = record ? pendingSteerText(record.payload) : ''
      if (!record || !TERMINAL.has(record.status)) { finish('skipped', 'not_terminal'); continue }
      if (!text) { finish('skipped', 'no_pending_steer'); continue }
      if (record.runtime !== 'direct') { finish('skipped', 'not_direct'); continue }
      if (this._ownerStopped(record)) { finish('skipped', 'owner_stopped'); continue }
      if (nowSeconds() - (record.terminalAt ?? record.updatedAt) > this.interruptRecoveryMaxAgeSeconds) { finish('skipped', 'too_old'); continue }
      const key = PENDING_STEER_REPLAY_PREFIX + record.publicRunId
      // The owner (or his phone's outbox) already resent it as a normal message in this thread.
      const probe = steerProbe(text)
      const resent = this.database.prepare(`SELECT body FROM wizard_run_queue WHERE runtime = ? AND session_id = ?
        AND created_at > ? AND idempotency_key <> ?`).all(record.runtime, record.sessionId, record.createdAt, key)
        .some(row => steerProbe(queuedInputText(parseJson(row.body, {}))) === probe)
      if (resent) { finish('skipped', 'already_resent'); continue }
      if (this.steerDelivered) {
        let delivered
        try { delivered = await this.steerDelivered(record, text) } catch { continue } // history unreadable: retry next tick
        if (delivered === true) { finish('skipped', 'already_in_thread'); continue }
      }
      try {
        const body = this._pendingSteerBody(record, text)
        const { record: admitted } = this._admitRow({ runtime: record.runtime, sessionId: record.sessionId, idempotencyKey: key,
          requestHash: queueRequestHash(record.runtime, body), body, trustedPaths: [...new Set([...(record.trustedPaths ?? []), ...hiddenFilePaths(text)])] })
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
    const started = performance.now()
    this.tickPromise = this._tick(force).finally(() => { this.tickPromise = null; this.logSlowTick(started) })
    return this.tickPromise
  }

  // Active status reads stay narrow. Queued/terminal reads must retain the
  // admission/recovery tick: they can reconcile lost acknowledgements, release
  // capacity, cancel superseded helpers and dispatch the next waiting run.
  async refreshRun(publicRunId) {
    const record = this.get(publicRunId)
    if (!record || this.closed) return record
    if (!record.upstreamRunId || TERMINAL.has(record.status)) {
      // A run that is already terminal has nothing of its own left to reconcile; the 1.5 s poll tick
      // owns admission and capacity. Re-reading a finished run (a client polling many old runs) must not
      // force a whole-queue tick each time, so those reads share one forced tick per few seconds. A queue
      // with no poll timer (pollIntervalMs 0: parity fixtures) has only these forced ticks, so it keeps them.
      if (record.upstreamRunId && TERMINAL.has(record.status) && this.pollIntervalMs > 0) {
        const at = performance.now()
        if (this.terminalReadTickAt !== undefined && at - this.terminalReadTickAt < TERMINAL_READ_TICK_MS) return this.get(publicRunId)
        this.terminalReadTickAt = at
      }
      await this.tick(true)
      return this.get(publicRunId)
    }
    const refreshed = await this._refresh(record, true)
    // An in-flight tick already owns reconciliation. Never join it from this
    // independent running-status read (it may be blocked on another provider).
    if (TERMINAL.has(refreshed.status) && !this.tickPromise) await this.tick(true)
    return this.get(publicRunId)
  }

  async _refresh(record, force) {
    const id = record.publicRunId
    if (this.refreshing.has(id)) return this.refreshing.get(id)
    const work = this._refreshOne(record, force).finally(() => this.refreshing.delete(id))
    this.refreshing.set(id, work)
    return work
  }

  async _refreshOne(record, force) {
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
      this._notePendingSteer(record, capacityStatus, nextPayload)
      const workerRunId = result?.workerRunId ?? record.workerRunId
      // An UPDATE rewrites the whole row, saved request body included (up to ~6 MB with
      // attachments): ~30-70 ms and MBs of journal per running reply every 1.5 s. Write only
      // when something changed, plus a 30 s heartbeat so updated_at stays fresh.
      if (capacityStatus === record.status && !TERMINAL.has(capacityStatus) && workerRunId === record.workerRunId
          && !record.waitingReason && record.terminalAt === null && nowSeconds() - record.updatedAt < 30
          && JSON.stringify(nextPayload ?? null) === JSON.stringify(record.payload ?? null)) return record
      const refreshed = this._update(record.publicRunId, {
        status: capacityStatus,
        payload: nextPayload,
        workerRunId,
        waitingReason: '',
        terminalAt: TERMINAL.has(capacityStatus) ? nowSeconds() : null,
      })
      this._noteProviderSuccess(refreshed)
      return this._waitForProvider(refreshed)
    } catch {
      return record
    }
  }

  // One admission per run at a time. A second caller (a later tick, a status read) shares the
  // in-flight request instead of sending the same message to Hermes again.
  _launch(record) {
    const id = record.publicRunId
    const inFlight = this.launches.get(id)
    if (inFlight) return inFlight.promise
    const entry = { promise: null, startedAt: Date.now() }
    this.launches.set(id, entry)
    entry.promise = this._launchOnce(record).finally(() => { if (this.launches.get(id) === entry) this.launches.delete(id) })
    entry.promise.catch(() => undefined) // a launch left running in the background must not crash the service
    return entry.promise
  }

  // Wait for a launch only while this tick's launch budget lasts. A launch Hermes has not answered by
  // then keeps running in the background (its row stays `launching`, holding its thread and a slot)
  // and the tick moves on, so status refresh and every other queued message keep going.
  async _launchWithin(record, deadline) {
    if (this.launches.has(record.publicRunId)) return this.get(record.publicRunId) ?? record
    const work = this._launch(record)
    const remaining = deadline - performance.now()
    const pending = Symbol('pending')
    let timer
    const outcome = await Promise.race([work,
      new Promise((done) => { timer = setTimeout(done, Math.max(0, remaining), pending); timer.unref?.() })])
    clearTimeout(timer)
    return outcome === pending ? (this.get(record.publicRunId) ?? record) : outcome
  }

  async _launchOnce(record) {
    const fresh = this.get(record.publicRunId)
    if (!fresh || !['queued', 'launching'].includes(fresh.status)) return fresh ?? record
    if (fresh.upstreamRunId) return this._refresh(fresh, true)
    // Recovery admission and dispatch can be separated by capacity/health awaits.
    // Recheck the original request so a Dismiss in that gap still wins.
    if (fresh.providerRecoveryAttempted && fresh.retrySourceId
        && this.providerFailureDismissed(this.get(fresh.retrySourceId) ?? fresh)) {
      this._releaseProviderSource(fresh)
      return this.get(fresh.publicRunId)
    }
    let current = this._update(record.publicRunId, { status: 'launching', waitingReason: '' })
    try {
      const result = await this.launch(current)
      const payload = record.runtime === 'direct' ? normalizeProviderPreflightFailure(result?.payload) : result?.payload
      if (payload !== result?.payload) { result.payload = payload; result.capacityStatus = 'failed' }
      const status = safeStatus(result?.capacityStatus ?? result?.status ?? result?.payload?.status)
      // An idempotent re-admission can answer with the run already finished: never refreshed again.
      this._notePendingSteer(record, status, result?.payload)
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
      if (current.payload?.error?.type !== 'provider_preflight_failed') this.database.prepare('DELETE FROM wizard_provider_backoff WHERE scope=? AND failures>=0').run(providerScope(current))
      this._noteProviderSuccess(current)
      return this._waitForProvider(current)
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
        if (Number(previous?.failures) !== -1) this.database.prepare('INSERT OR REPLACE INTO wizard_provider_backoff VALUES(?,?,?)').run(scope, nowSeconds() + delay, failures)
      }
      return this._update(record.publicRunId, retry
        ? { status: 'queued', waitingReason: status === 429 || error?.retryAfter ? 'provider_busy' : 'admission_retry', retryAfter: nowSeconds() + delay }
        : { status: 'failed', payload: { status: 'failed', error: error?.upstreamError, safe_error: failure || 'Wizard could not start this queued work.' }, terminalAt: nowSeconds() })
    }
  }

  _hermesNotStarted(record) {
    return record.status === 'running' && Boolean(record.upstreamRunId) && !record.workerRunId && record.payload?.status === 'queued'
  }

  // Cancel-and-resend a reply Hermes accepted but never started (see the constructor note). Bounded: a resent
  // run that also never starts is resent at most twice more. 8 Nov 2026: after the third resend the row then
  // sat on "running" for good while nothing worked on it. The last resend that also never starts now fails
  // visibly, with the message saved and Retry, instead of pretending to work.
  async _requeueNotStarted() {
    if (!this.cancelUpstream || !this.leaseHeld) return
    const now = nowSeconds()
    const rows = this._rows("status = 'running' AND upstream_run_id <> '' AND worker_run_id = ''")
    const seen = new Set()
    for (const record of rows) {
      if (!this._hermesNotStarted(record)) continue
      seen.add(record.publicRunId)
      if (!this.notStartedSince.has(record.publicRunId)) this.notStartedSince.set(record.publicRunId, now)
      if (now - this.notStartedSince.get(record.publicRunId) < this.notStartedSeconds) continue
      const generation = (record.idempotencyKey.match(/^wizard-not-started-requeue-(\d)-/)?.[1] ?? '0') | 0
      let held
      try { held = await this.leaseHeld(record) } catch { held = null }
      if (held !== false) { this.notStartedSince.set(record.publicRunId, now); this.stalledSince.delete(record.publicRunId); continue } // a turn is working on this thread: it is only waiting its turn
      // Confirmed: Hermes took it, nothing works on this thread, and it has not started. The stall clock
      // runs across resends so health reports how long the owner has really been waiting.
      if (!this.stalledSince.has(record.publicRunId)) this.stalledSince.set(record.publicRunId, this.notStartedSince.get(record.publicRunId))
      const stalledFor = now - this.stalledSince.get(record.publicRunId)
      let cancelled = false
      try { cancelled = (await this.cancelUpstream(record)) === true } catch { cancelled = false }
      // A cancel Hermes will not confirm cannot be resent safely; it must still not wait forever.
      const giveUp = generation >= NOT_STARTED_MAX_RESENDS || (!cancelled && stalledFor >= (NOT_STARTED_MAX_RESENDS + 1) * this.notStartedSeconds)
      if (giveUp) {
        // Give up honestly. If Hermes does start it later, its answer lands in the thread and the failure stops
        // showing (the failure predates that answer).
        this._update(record.publicRunId, { status: 'failed', waitingReason: '', terminalAt: nowSeconds(),
          payload: { ...(record.payload ?? {}), status: 'failed', last_event: 'run.not_started', reconciled_reason: 'not_started_gave_up',
            upstream_cancelled: cancelled, safe_error: NOT_STARTED_SAFE_ERROR } })
        this.notStartedSince.delete(record.publicRunId)
        this.stalledSince.delete(record.publicRunId)
        this.gaveUpAt.push(now)
        try { this.onNotStartedGaveUp(record, cancelled, stalledFor) } catch { /* logging only */ }
        continue
      }
      if (!cancelled) continue
      const key = `${NOT_STARTED_REQUEUE_PREFIX}${generation + 1}-${record.publicRunId}`
      try {
        this.database.exec('BEGIN IMMEDIATE')
        let admitted
        try {
          admitted = this._admitRow({ runtime: record.runtime, sessionId: record.sessionId, idempotencyKey: key,
            requestHash: queueRequestHash(record.runtime, record.body), body: record.body, trustedPaths: record.trustedPaths ?? [],
            continuation: record.continuation, recoveryAuthorized: record.recoveryAuthorized, agent_id: record.agent_id }, true)
          this._update(admitted.record.publicRunId, { retrySourceId: record.retrySourceId || record.publicRunId, retryOrderAt: record.retryOrderAt || record.createdAt })
          this._update(record.publicRunId, { status: 'cancelled', payload: { ...(record.payload ?? {}), status: 'cancelled', last_event: 'run.requeued', reconciled_reason: 'not_started' }, waitingReason: '', terminalAt: nowSeconds() })
          this.database.exec('COMMIT')
        } catch (error) { this.database.exec('ROLLBACK'); throw error }
        this.notStartedSince.delete(record.publicRunId)
        // The owner is still waiting on the same message: the resend inherits the stall clock.
        this.stalledSince.set(admitted.record.publicRunId, this.stalledSince.get(record.publicRunId) ?? now)
        this.stalledSince.delete(record.publicRunId)
        try { this.onRequeued(record, admitted.record) } catch { /* logging only */ }
      } catch { /* the next tick tries again */ }
    }
    for (const id of this.notStartedSince.keys()) if (!seen.has(id)) this.notStartedSince.delete(id)
    for (const id of this.stalledSince.keys()) if (!seen.has(id) && !ACTIVE_OR_QUEUED.has(this._statusOf(id))) this.stalledSince.delete(id)
    const horizon = now - 15 * 60
    while (this.gaveUpAt.length && this.gaveUpAt[0] < horizon) this.gaveUpAt.shift()
  }

  _statusOf(publicRunId) {
    return this.database.prepare('SELECT status FROM wizard_run_queue WHERE public_run_id = ?').get(publicRunId)?.status ?? ''
  }

  // Replies Hermes accepted and confirmed nothing is working on, that have still not started (across resends),
  // plus replies given up on in the last 15 minutes. Read by /wizard/health and the Troubleshooter's
  // "replies are starting" check: health can be green while no reply starts (8 Nov 2026).
  notStartedState() {
    const now = nowSeconds()
    let oldest = 0
    for (const since of this.stalledSince.values()) oldest = Math.max(oldest, now - since)
    const horizon = now - 15 * 60
    return { replies_not_started: this.stalledSince.size, replies_not_started_s: Math.max(0, Math.round(oldest)),
      replies_given_up_15m: this.gaveUpAt.filter((at) => at >= horizon).length }
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
      // Hermes serialises a thread's turns: a message sent while a long reply is still running is accepted
      // but shows no agent until that reply ends, then it is delivered. Only a thread nothing else is
      // working on can have an abandoned run; an unreadable busy state is unknown, so the run stays.
      let busy
      try { const active = await this.activeSessionIds(); busy = !Array.isArray(active) || active.includes(record.sessionId) }
      catch { busy = true }
      if (busy) { this.leaselessSince.delete(record.publicRunId); continue }
      const since = this.leaselessSince.get(record.publicRunId) ?? now
      this.leaselessSince.set(record.publicRunId, since)
      if (now - since < this.staleAfterSeconds) continue
      let verdict
      try { verdict = await this.confirmAbandoned(record) }
      catch { verdict = null }
      if (!verdict || !TERMINAL.has(verdict.status)) continue
      const payload = { ...(record.payload ?? {}), status: verdict.status, last_event: 'run.reconciled', reconciled_reason: 'no_turn_held', ...(verdict.safeError ? { safe_error: verdict.safeError } : {}) }
      this._update(record.publicRunId, { status: verdict.status, payload, waitingReason: '', terminalAt: nowSeconds() })
      this.leaselessSince.delete(record.publicRunId)
      try { this.onReconciled(record, verdict, now - since) } catch { /* logging only */ }
    }
  }

  // Sessions whose only queue runs are accepted by Hermes but hold no turn (confirmed false, not unknown),
  // and that no other Hermes surface is working on. They keep their thread fenced but free their slot.
  async _findGhostSessions(external) {
    const ghosts = new Set()
    if (!this.turnHeld && !this.leaseHeld) return ghosts
    const now = nowSeconds()
    const bySession = new Map()
    for (const record of this._rows("status IN ('launching','running','waiting_for_approval','stopping')")) {
      const list = bySession.get(record.sessionId) ?? []
      list.push(record)
      bySession.set(record.sessionId, list)
    }
    const outside = new Set(external)
    for (const [sessionId, records] of bySession) {
      if (outside.has(sessionId)) continue
      const verdicts = await Promise.all(records.map(async (record) => {
        if (record.status !== 'running' || !record.upstreamRunId || record.workerRunId || now - record.createdAt < this.ghostGraceSeconds) return false
        if (this._hermesNotStarted(record) && this.leaseHeld) { try { if ((await this.leaseHeld(record)) === false) return true } catch { /* fall through */ } }
        if (!this.turnHeld) return false
        try { return (await this.turnHeld(record)) === false } catch { return false }
      }))
      if (verdicts.every(Boolean)) ghosts.add(sessionId)
    }
    return ghosts
  }

  async _tick(force) {
    // The status is stored after the request body, so a plain scan follows every saved body's
    // overflow pages each 1.5 s. Select the identities through the (status, …) index instead.
    const launchDeadline = performance.now() + this.launchWaitMs
    let activeRows = this._rows("public_run_id IN (SELECT public_run_id FROM wizard_run_queue INDEXED BY wizard_run_queue_fifo WHERE status NOT IN ('queued','completed','failed','cancelled','interrupted'))")
    for (const record of activeRows) {
      if (record.status === 'launching' && !record.upstreamRunId) await this._launchWithin(record, launchDeadline)
      else await this._refresh(record, force)
    }
    await this._resumeDiagnosedSignIns()
    this._resumeProviderAccess()
    await this._reconcileStale()
    await this._requeueNotStarted()
    await this._recoverInterrupted()
    await this._replayPendingSteers()

    let external
    try { external = await this.activeSessionIds() }
    catch {
      for (const record of this._rows("status = 'queued' AND waiting_reason <> 'provider_access'")) this._update(record.publicRunId, { waitingReason: 'liveness_unavailable' })
      return
    }
    if (!Array.isArray(external)) {
      for (const record of this._rows("status = 'queued' AND waiting_reason <> 'provider_access'")) this._update(record.publicRunId, { waitingReason: 'liveness_unavailable' })
      return
    }
    const activeSessions = new Set(external.filter((value) => typeof value === 'string' && value))
    activeRows = this._rows("status IN ('launching','running','waiting_for_approval','stopping')")
    for (const record of activeRows) activeSessions.add(record.sessionId)
    const fenced = new Set(this._rows("status = 'unknown'").map(record => record.sessionId))
    for (const id of fenced) activeSessions.delete(id)
    this.ghostSessions = await this._findGhostSessions(external.filter((value) => typeof value === 'string' && value))
    const slotsUsed = () => { let used = 0; for (const id of activeSessions) if (!this.ghostSessions.has(id)) used += 1; return used }

    let dispatchHealthy = false
    try { dispatchHealthy = Boolean(await this.canDispatch()) }
    catch { dispatchHealthy = false }
    if (!dispatchHealthy) {
      for (const record of this._rows("status = 'queued' AND waiting_reason <> 'provider_access'")) this._update(record.publicRunId, { waitingReason: 'system_busy' })
      return
    }

    const pending = this._rows("status = 'queued' AND waiting_reason <> 'provider_access'")
    if (this.reservedInteractive) pending.sort((a, b) => Number(Boolean(b.retrySourceId)) - Number(Boolean(a.retrySourceId))
      || (a.retrySourceId && b.retrySourceId ? 0 : Number(isBackgroundContinuation(a)) - Number(isBackgroundContinuation(b))))
    const blockedRecoveryProviders = new Set()
    for (const record of pending) {
      const recoveryProvider = record.retrySourceId ? parseJson(record.body, {})?.provider || 'configured' : ''
      if (record.retrySourceId && blockedRecoveryProviders.has(recoveryProvider)) continue
      const people = !isBackgroundContinuation(record)
      if (slotsUsed() >= this.maxActive + (people ? this.interactiveOverflow : 0)) { if (people || !this.interactiveOverflow) break; continue }
      // Background turns may consume only the nonreserved total occupancy.
      // Existing turns are never preempted; two slots stay reachable by people.
      if (this.reservedInteractive && isBackgroundContinuation(record)
          && slotsUsed() >= this.maxActive - this.reservedInteractive) {
        this._update(record.publicRunId, { waitingReason: 'interactive_reserve' })
        if (record.retrySourceId) blockedRecoveryProviders.add(recoveryProvider)
        continue
      }
      const cooldown = this.database.prepare('SELECT retry_after FROM wizard_provider_backoff WHERE scope=? AND failures>=0').get(providerScope(record))
      if (Number(cooldown?.retry_after || 0) > nowSeconds()) {
        this._update(record.publicRunId, { waitingReason: 'provider_busy' })
        if (record.retrySourceId) blockedRecoveryProviders.add(recoveryProvider)
        continue
      }
      if (record.retryAfter > nowSeconds()) {
        if (record.retrySourceId) blockedRecoveryProviders.add(recoveryProvider)
        continue
      }
      // Unknown holds only its session, not a global slot or the interactive reserve.
      if (activeSessions.has(record.sessionId) || fenced.has(record.sessionId)) {
        this._update(record.publicRunId, { waitingReason: 'capacity' })
        if (record.retrySourceId) blockedRecoveryProviders.add(recoveryProvider)
        continue
      }
      const launched = await this._launchWithin(record, launchDeadline)
      if (ACTIVE.has(launched.status)) activeSessions.add(launched.sessionId)
      if (launched.status === 'unknown') fenced.add(launched.sessionId)
    }
    for (const record of this._rows("status = 'queued' AND waiting_reason <> 'provider_access'")) {
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
