import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { normalizeProviderPreflightFailure } from './run-provider-failure.mjs'
import { admissionFailure, retryDelaySeconds } from './hermes-compat.mjs'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const ACTIVE = new Set(['launching', 'running', 'waiting_for_approval', 'stopping'])
const RETRIABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const PUBLIC_ID = /^wizardq_[0-9a-f]{32}$/
const SAFE_KEY = /^[^\p{Cc}]{1,256}$/u
const MAX_QUEUED_BODY_BYTES = 12 * 1024 * 1024
const MAX_QUEUED_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_QUEUED_IMAGES = 9

const nowSeconds = () => Date.now() / 1000
const safeStatus = (value) => {
  const status = String(value ?? '').toLowerCase()
  if (['accepted', 'pending', 'queued', 'submitting', 'started'].includes(status)) return 'running'
  if (['running', 'waiting_for_approval', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status)) return status
  return 'unknown'
}

const parseJson = (value, fallback) => {
  try { return JSON.parse(value) }
  catch { return fallback }
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

const requestError = (message, status) => Object.assign(new Error(message), { status })

export function queueRequestHash(runtime, body) {
  return createHash('sha256').update(`${runtime}\0${body}`).digest('hex')
}

export class DurableRunQueue {
  constructor({
    statePath,
    maxActive = 8,
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
  }) {
    if (!statePath) throw new Error('Wizard run queue state path is required')
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 64) throw new Error('Wizard run queue capacity is invalid')
    if (typeof launch !== 'function' || typeof lookup !== 'function') throw new Error('Wizard run queue transport is required')
    this.statePath = resolve(statePath)
    this.maxActive = maxActive
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
    this.leaselessSince = new Map()
    this.timer = null
    this.tickPromise = null
    this.closed = false
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(this.statePath)
    chmodSync(this.statePath, 0o600)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
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
    `)
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'continuation_json')) {
      this.database.exec("ALTER TABLE wizard_run_queue ADD COLUMN continuation_json TEXT NOT NULL DEFAULT 'null'")
    }
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'dispatch_attempted')) {
      // Existing rows have unknown dispatch history. Never mutate their saved request.
      this.database.exec("BEGIN IMMEDIATE; ALTER TABLE wizard_run_queue ADD COLUMN dispatch_attempted INTEGER NOT NULL DEFAULT 0; UPDATE wizard_run_queue SET dispatch_attempted=1; COMMIT;")
    }
    if (!this.database.prepare('PRAGMA table_info(wizard_run_queue)').all().some(row => row.name === 'dispatch_body')) {
      this.database.exec("ALTER TABLE wizard_run_queue ADD COLUMN dispatch_body TEXT")
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
    if (this.pollIntervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.tick().catch(() => undefined), this.pollIntervalMs)
      this.timer.unref?.()
    }
    return this
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.database.close()
  }

  _record(row) {
    if (!row) return null
    return {
      publicRunId: row.public_run_id,
      runtime: row.runtime,
      sessionId: row.session_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      body: row.body,
      dispatchAttempted: Boolean(row.dispatch_attempted),
      dispatchBody: row.dispatch_body ?? null,
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
    this.database.prepare('UPDATE wizard_run_queue SET dispatch_body=COALESCE(dispatch_body, ?) WHERE public_run_id=?').run(String(body), publicRunId)
    return this.get(publicRunId).dispatchBody
  }

  publicPayload(record) {
    const current = typeof record === 'string' ? this.get(record) : record
    if (!current) return null
    if (current.status === 'queued' || current.status === 'launching') {
      return {
        object: 'run',
        run_id: current.publicRunId,
        session_id: current.sessionId,
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
      publicRunId: record.publicRunId,
      idempotencyKey: record.idempotencyKey,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
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
      publicRunId: record.publicRunId,
      idempotencyKey: record.idempotencyKey,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
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
    }
  }

  // `continuation` is service authority (helper tokens; {kind:'background-recovery'} lets a manual Continue skip the
  // automatic helper check). Never pass a caller-supplied value here.
  async admit({ runtime, sessionId, idempotencyKey, requestHash, body, trustedPaths = [], continuation = null }) {
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
          trusted_paths_json, status, created_at, updated_at, continuation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(publicRunId, runtime, sessionId, idempotencyKey, requestHash, body, JSON.stringify(trustedPaths), createdAt, createdAt, JSON.stringify(continuation))
      this.database.exec('COMMIT')
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
    await this.tick(true)
    return { record: this.get(publicRunId), replayed: false }
  }

  async cancel(publicRunId) {
    const record = this.get(publicRunId)
    if (!record) throw requestError('queued run not found', 404)
    if (TERMINAL.has(record.status)) return record
    if (record.status !== 'queued') throw requestError('queued run already started', 409)
    return this._update(publicRunId, { status: 'cancelled', waitingReason: '', terminalAt: nowSeconds() })
  }

  async appendGuidance(publicRunId, guidance, trustedPaths = []) {
    const record = this.get(publicRunId)
    if (!record) throw requestError('queued run not found', 404)
    if (record.dispatchAttempted) throw requestError('Delivery may already have started; this reply cannot be changed', 409)
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
    if (!force && nowSeconds() - record.updatedAt < 0.7) return record
    try {
      const result = await this.lookup(record)
      const payload = record.runtime === 'direct' ? normalizeProviderPreflightFailure(result?.payload) : result?.payload
      if (payload !== result?.payload) { result.payload = payload; result.capacityStatus = 'failed' }
      const capacityStatus = safeStatus(result?.capacityStatus ?? result?.payload?.status)
      return this._update(record.publicRunId, {
        status: capacityStatus,
        payload: result?.payload ?? record.payload,
        workerRunId: result?.workerRunId ?? record.workerRunId,
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
    // Persist before crossing any launch boundary (including ambiguous network failure).
    this.database.prepare('UPDATE wizard_run_queue SET dispatch_attempted=1 WHERE public_run_id=?').run(record.publicRunId)
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
      return current
    } catch (error) {
      const status = Number(error?.status)
      if (status === 410 && (current.continuation || /^(wizard-helper-receipt-|wizard-follow-through-)/u.test(current.idempotencyKey))) {
        return this._update(record.publicRunId, { status: 'cancelled', payload: { status: 'cancelled', safe_error: 'The helper request is no longer current.' }, waitingReason: '', terminalAt: nowSeconds() })
      }
      const failure = admissionFailure(error)
      const retry = !failure && (error instanceof TypeError || RETRIABLE.has(status))
      return this._update(record.publicRunId, retry
        ? { status: 'queued', waitingReason: status === 429 ? 'provider_busy' : 'capacity', retryAfter: nowSeconds() + retryDelaySeconds(error?.retryAfter, this.retryDelayMs / 1000) }
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
    let activeRows = this._rows("status NOT IN ('queued','completed','failed','cancelled','interrupted')")
    for (const record of activeRows) {
      if (record.status === 'launching' && !record.upstreamRunId) await this._launch(record)
      else await this._refresh(record, force)
    }
    await this._reconcileStale()

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

    for (const record of this._rows("status = 'queued'")) {
      if (activeSessions.size >= this.maxActive) break
      if (record.retryAfter > nowSeconds() || activeSessions.has(record.sessionId) || fenced.has(record.sessionId)) {
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

    this.database.prepare(`DELETE FROM wizard_run_queue WHERE public_run_id IN (
      SELECT public_run_id FROM wizard_run_queue
       WHERE terminal_at IS NOT NULL AND terminal_at < ?
       ORDER BY terminal_at DESC LIMIT -1 OFFSET 128
    )`).run(nowSeconds() - 7 * 24 * 60 * 60)
  }
}
