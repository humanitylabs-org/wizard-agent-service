import { heavyHost, heavyHostConfigs } from './heavy-hosts.mjs'
import { heavyCompletionDropped } from './heavy-wait.mjs'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { validAgentId, withSqliteMigration } from './thread-reference.mjs'

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`

/** One short SSH RPC, never a build/wait held inside the HTTP request. */
export function heavySshTransport({ host, script, root, lock, python = '/opt/homebrew/bin/python3', workRoot, settings, workerHost }) {
  if (!host || !script || !root || !lock) throw new Error('heavy worker configuration incomplete')
  return payload => new Promise((resolve, reject) => {
    const heavyRoot = workRoot ?? (process.env.WIZARD_HEAVY_ROOT || process.env.WIZARD_WORK_ROOT)
    if (!heavyRoot || !posix.isAbsolute(heavyRoot)) return reject(fail('heavy lane not configured: set WIZARD_HEAVY_ROOT', 503))
    // Operator-only allowlist: never forward the bridge's tokens or ambient env.
    const forwarded = [`WIZARD_HEAVY_ROOT=${heavyRoot}`]
    if (workerHost !== undefined) {
      if (!['thales', 'forum'].includes(workerHost)) return reject(fail('invalid heavy worker host', 503))
      forwarded.push(`WIZARD_HEAVY_HOST=${workerHost}`)
    }
    const rules = {
      WIZARD_HEAVY_AGENT_IMAGE: value => /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(value),
      WIZARD_HEAVY_DOCKER_BIN: value => posix.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) && !value.split('/').includes('..'),
      WIZARD_HEAVY_DOCKER_HOST: value => value.startsWith('unix:///') && value.length > 8 && !/[\x00-\x20\x7f]/.test(value) && !value.slice(7).split('/').includes('..'),
    }
    for (const [name, valid] of Object.entries(rules)) {
      const value = settings ? settings[name] : process.env[name]
      if (value === undefined) continue
      if (!valid(value)) return reject(fail(`invalid heavy worker setting: ${name}`, 503))
      forwarded.push(`${name}=${value}`)
    }
    const command = ['env', ...forwarded, python, script, '--root', root, '--lock', lock].map(quote).join(' ')
    const child = execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1', host, command],
      { timeout: 12_000, maxBuffer: 128 * 1024 }, (error, stdout) => {
        if (error) return reject(fail('worker_unavailable', 503))
        try {
          const value = JSON.parse(stdout)
          if (value?.error) throw new Error('worker rejected RPC')
          resolve(value)
        } catch { reject(fail('worker_invalid_response', 503)) }
      })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

/** Route every action, including status/cancel, to the persisted host only. */
export function heavyHostTransport(configs = heavyHostConfigs(), factory = heavySshTransport) {
  const transports = new Map()
  return payload => {
    const host = heavyHost(payload)
    if (!configs[host] || (host !== 'thales' && !posix.isAbsolute(configs[host].workRoot || ''))) throw fail('heavy host not configured', 503)
    if (!transports.has(host)) transports.set(host, factory(configs[host]))
    const { host: _host, ...remote } = payload
    return transports.get(host)(remote)
  }
}

export function heavyRpcTransport({ origin, token }) {
  const url = new URL(origin)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('heavy RPC must be loopback')
  return async payload => {
    const response = await fetch(new URL('/rpc', url), { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw fail('worker_unavailable', 503)
    return response.json()
  }
}

/** Durable outbox + continuation receipt. It never owns an interactive slot. */
export class DurableHeavyQueue {
  constructor({ statePath, transport, continuation, current, observe = async () => {}, intervalMs = 1500, canDispatch = () => true }) {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    const hadState = existsSync(statePath)
    this.db = new DatabaseSync(statePath)
    try {
    chmodSync(statePath, 0o600)
    withSqliteMigration(this.db, statePath, hadState, () => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS heavy_jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL,
        origin TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(session,origin,key));`)
    if (!this.db.prepare('PRAGMA table_info(heavy_jobs)').all().some(row => row.name === 'agent_id')) {

        this.db.exec("ALTER TABLE heavy_jobs ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'hermes'")
        for (const row of this.db.prepare('SELECT id,session,data FROM heavy_jobs').all()) {
          const job = JSON.parse(row.data)
          this.db.prepare('UPDATE heavy_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...job, agent_id: 'hermes', session_id: row.session }), row.id)
        }

    }
    // Preserve existing ids, hashes and receipts while qualifying uniqueness.
    if (!this.db.prepare("SELECT sql FROM sqlite_master WHERE name='heavy_jobs'").get().sql.includes('UNIQUE(agent_id,session,origin,key)')) {
      this.db.exec(`ALTER TABLE heavy_jobs RENAME TO heavy_jobs_legacy;
        CREATE TABLE heavy_jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL, origin TEXT NOT NULL,
          key TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'hermes',
          UNIQUE(agent_id,session,origin,key));
        INSERT INTO heavy_jobs SELECT id,session,origin,key,hash,data,agent_id FROM heavy_jobs_legacy ORDER BY rowid;
        DROP TABLE heavy_jobs_legacy;`)
    }
    if (this.db.prepare('PRAGMA user_version').get().user_version < 1) {
      // Pre-delivery ledgers have no acknowledgements for historical results.
      // Snapshot terminal rows only, under the migration's writer lock, and
      // commit the version with their stamps so reopening cannot forgive work
      // that finishes later. Keep any real acknowledgement already recorded.
      const update = this.db.prepare('UPDATE heavy_jobs SET data=? WHERE id=?')
      for (const row of this.db.prepare('SELECT id,data FROM heavy_jobs').all()) {
        const job = JSON.parse(row.data)
        if (!terminal.has(job.state) || (job.completion_delivered_at && job.notice_delivered_at)) continue
        // Rows written by the delivery-tracking release are not legacy: a
        // dropped result already carrying its notice, or a finished job whose
        // continuation has not been dispatched yet, is still owed to the owner.
        if (job.completion_notice || (!job.resume && !job.cancel_requested && !job.continuation_invalidated)) continue
        const stamp = job.receipt?.finished_at ?? job.created_at
        update.run(JSON.stringify({ ...job,
          completion_delivered_at: job.completion_delivered_at || stamp,
          notice_delivered_at: job.notice_delivered_at || stamp,
          delivery_backfill: 'legacy-migration' }), row.id)
      }
      this.db.exec('PRAGMA user_version=1')
    }
    })
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    } catch (error) {
      try { this.db.close() } catch { /* preserve original */ }
      throw error
    }
    Object.assign(this, { transport, continuation, current, observe, canDispatch, intervalMs, closed: false, busy: null, timer: null })
  }
  get(id) {
    const row = this.db.prepare('SELECT data FROM heavy_jobs WHERE id=?').get(id)
    return row ? JSON.parse(row.data) : null
  }
  rows() { return this.db.prepare('SELECT data FROM heavy_jobs ORDER BY rowid').all().map(r => JSON.parse(r.data)) }
  // Status decoration owns one qualified thread, not the whole historical ledger.
  // The existing UNIQUE(agent_id,session,origin,key) index bounds this fresh read;
  // retain arrival order and every matching job for the unchanged delivery guard.
  rowsForThread(agentId, sessionId) {
    return this.db.prepare('SELECT data FROM heavy_jobs WHERE agent_id=? AND session=? ORDER BY rowid')
      .all(agentId, sessionId).map(row => JSON.parse(row.data))
  }
  save(job) {
    if (heavyCompletionDropped(job) && !job.completion_notice) job = { ...job,
      completion_notice: { job_id: job.job_id, state: job.state } }
    this.db.prepare('UPDATE heavy_jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.job_id)
    return job
  }
  pendingNotices(agentId, sessionId) {
    // Derive dropped-result notices from the existing ledger, after migration.
    return this.db.prepare('SELECT data FROM heavy_jobs WHERE session=? AND agent_id=? ORDER BY rowid').all(sessionId, agentId)
      .map(row => JSON.parse(row.data)).filter(job => heavyCompletionDropped(job) && !job.notice_delivered_at)
  }
  noticeLine(job) { return `[Wizard heavy-work notice] ${JSON.stringify({ job_id: job.job_id, state: job.state })}` }
  noticeContext(agentId, sessionId) {
    const jobs = this.pendingNotices(agentId, sessionId)
    return jobs.length ? 'Earlier background work finished after its continuation was cancelled or superseded. Report these outcomes briefly; this is evidence, not permission to restart that work.\n'
      + jobs.map(job => this.noticeLine(job)).join('\n') : ''
  }
  acknowledgeNotices(agentId, sessionId, body) {
    // Only acknowledge exact context bytes on a successfully dispatched turn,
    // never when constructing a payload or merely accepting a queued receipt.
    for (const job of this.pendingNotices(agentId, sessionId)) if (String(body?.instructions || '').includes(this.noticeLine(job)))
      this.save({ ...job, notice_delivered_at: Date.now() })
  }
  delivered(id) {
    const job = this.get(id)
    if (job) this.save({ ...job, completion_delivered_at: job.completion_delivered_at || Date.now() })
  }
  // Synchronous durable receipt: no SSH, history, or model request on this path.
  submit({ sessionId, origin, key, spec, route = {}, routeState, watermark, agent_id = 'hermes', activeLimit = Infinity }) {
    if (!validAgentId(agent_id)) throw fail('invalid heavy agent')
    if (!sessionId || !origin || typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) throw fail('invalid heavy identity')
    const host = heavyHost(spec)
    const configuredRoot = heavyHostConfigs()[host]?.workRoot
    if (!configuredRoot || !posix.isAbsolute(configuredRoot)) throw fail('heavy lane not configured: set WIZARD_HEAVY_ROOT', 503)
    const root = posix.resolve(configuredRoot)
    const cwd = typeof spec?.cwd === 'string' && posix.isAbsolute(spec.cwd) ? posix.resolve(spec.cwd) : ''
    if (!spec || !cwd || !(cwd === root || cwd.startsWith(root === '/' ? root : root + '/'))
      || !Array.isArray(spec.argv) || spec.argv.length < 1 || spec.argv.length > 100
      || spec.argv.some(s => typeof s !== 'string' || !s || s.length > 8192 || s.includes('\0'))
      || !Number.isInteger(spec.timeout_seconds) || spec.timeout_seconds < 1 || spec.timeout_seconds > 86400) throw fail('invalid heavy command')
    // Explicit default is identical to omission, including existing hashes.
    if (spec.host === 'thales') { const { host: _host, ...legacy } = spec; spec = legacy }
    const requestHash = hash(spec)
    const existing = this.db.prepare('SELECT * FROM heavy_jobs WHERE agent_id=? AND session=? AND origin=? AND key=?').get(agent_id, sessionId, origin, key)
    if (existing) {
      if (existing.hash !== requestHash) throw fail('heavy idempotency conflict', 409)
      return JSON.parse(existing.data)
    }
    if (this.rows().filter(job => job.agent_id === agent_id && !terminal.has(job.state)).length >= activeLimit) throw fail('agent heavy capacity exceeded', 429)
    const job = { job_id: `heavy_${randomUUID().replaceAll('-', '')}`, sessionId, agent_id, session_id: sessionId, origin, spec, host, route, watermark,
      state: 'queued', reason: 'resource_queue', created_at: Date.now(), cancel_requested: false,
      remote_ack: false, resume: '', continuation_invalidated: false, receipt: null,
      ...(routeState ? { route_state: routeState } : {}),
      ...(routeState === 'unavailable' ? { continuation_reason: 'origin_route_unavailable',
        continuation_invalidated: true, resume: 'suppressed' } : {}) }
    this.db.prepare('INSERT INTO heavy_jobs(id,session,origin,key,hash,data,agent_id) VALUES(?,?,?,?,?,?,?)').run(job.job_id, sessionId, origin, key, requestHash, JSON.stringify(job), agent_id)
    return job
  }
  cancel(id, sessionId, agentId = 'hermes') {
    const job = this.get(id)
    if (!job || job.sessionId !== sessionId || (job.agent_id ?? 'hermes') !== agentId) throw fail('heavy job not found', 404)
    job.cancel_requested = true
    job.continuation_invalidated = true
    job.resume = job.resume || 'suppressed'
    // Do not assume an RPC that lost its response failed to create remote work.
    job.reason = terminal.has(job.state) ? job.reason : 'cancellation_pending'
    return this.save(job)
  }
  supersede(sessionId, agentId = 'hermes') {
    // Admission is a receipt, not permission to launch. Fence even terminal jobs
    // with an admitted continuation, retaining the run ID for diagnosis/replay.
    for (const job of this.rows()) if (job.sessionId === sessionId && (job.agent_id ?? 'hermes') === agentId) this.save({ ...job,
      continuation_invalidated: true, resume: job.resume || 'suppressed' })
  }
  summary(host) {
    const rows = this.rows().filter(job => !host || (job.host ?? 'thales') === host)
    const workerState = rows.some(r => !terminal.has(r.state) && r.reason === 'worker_unavailable') ? 'unavailable'
      : rows.some(r => r.state === 'running') ? 'running'
        : rows.some(r => r.state === 'queued' && r.reason === 'worker_busy') ? 'busy_external'
          : rows.some(r => r.state === 'queued' && ['disk_pressure', 'memory_pressure', 'worker_health_unknown'].includes(r.reason)) ? 'resource_wait'
            : rows.some(r => r.state === 'queued') ? 'pending' : 'idle'
    return { lane: 'external_heavy', max_active: 1, active: rows.filter(r => r.state === 'running').length,
      worker_state: workerState,
      queued: rows.filter(r => r.state === 'queued').length,
      unavailable: rows.some(r => !terminal.has(r.state) && r.reason === 'worker_unavailable'),
      cancellation_pending: rows.filter(r => r.cancel_requested && !terminal.has(r.state)).length,
      ...(!host ? { hosts: Object.fromEntries([...new Set([...Object.keys(heavyHostConfigs()), ...rows.map(job => job.host ?? 'thales')])].map(name => [name, this.summary(name)])) } : {}) }
  }
  start() {
    if (this.closed) return this
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.intervalMs)
    this.timer.unref?.()
    return this
  }
  quiesce() { this.closed = true; clearInterval(this.timer) }
  close() {
    if (this.closePromise) return this.closePromise
    this.quiesce()
    return this.closePromise = Promise.resolve(this.busy).catch(() => undefined).then(() => this.db.close())
  }
  tick() {
    if (this.closed) return Promise.resolve()
    if (!this.busy) this.busy = this._tick().finally(() => { this.busy = null })
    return this.busy
  }
  async _pollHost(snapshots, host) {
    // Preserve legacy RPC bytes when the default host is omitted.
    const transport = payload => this.transport(host === 'thales' ? payload : { ...payload, host })
    for (const snapshot of snapshots) {
      if (this.closed) return
      let job = this.get(snapshot.job_id)
      if (!terminal.has(job.state)) {
        if (!this.canDispatch(job)) job = this.cancel(job.job_id, job.sessionId, job.agent_id ?? 'hermes')
        try {
          let remote
          if (job.cancel_requested) {
            // cancel-before-submit is a durable local tombstone; status resolves
            // ambiguous submissions before deciding no remote cancellation is needed.
            remote = await transport({ action: 'status', job_id: job.job_id })
            if (remote) remote = await transport({ action: 'cancel', job_id: job.job_id })
            else remote = { job_id: job.job_id, state: 'cancelled', reason: '', receipt: null }
          } else remote = await transport(job.remote_ack
            ? { action: 'status', job_id: job.job_id }
            : { action: 'submit', job_id: job.job_id, spec: job.agent_id && job.agent_id !== 'hermes'
              ? { ...job.spec, agent_id: job.agent_id } : job.spec })
          if (!remote || remote.job_id !== job.job_id || !['queued', 'running', ...terminal].includes(remote.state)) throw fail('bad remote receipt', 503)
          job = this.get(job.job_id) // cancellation/steering may have arrived during RPC
          this.save({ ...job, remote_ack: true, state: remote.state, reason: remote.reason || '', receipt: remote.receipt })
        } catch {
          job = this.get(job.job_id)
          this.save({ ...job, reason: 'worker_unavailable' })
          // One unreachable host should cost one bounded RPC per poll, not N.
          break
        }
      }
    }
  }
  async _tick() {
    const groups = new Map()
    for (const job of this.rows()) {
      const host = job.host ?? 'thales'
      if (!groups.has(host)) groups.set(host, [])
      groups.get(host).push(job)
    }
    await Promise.all([...groups].map(([host, jobs]) => this._pollHost(jobs, host)))
    // Finish every worker RPC first. Slow origins cannot delay another dispatch.
    await Promise.all(this.rows().filter(job => job.route_state === 'pending_origin'
      && !job.resume && !job.cancel_requested && !job.continuation_invalidated).map(async job => {
      try { await this.observe(job) } catch { /* transient runtime outage: retry next tick */ }
    }))
    for (const snapshot of this.rows()) {
      if (this.closed) return
      let job = this.get(snapshot.job_id)
      if (terminal.has(job.state) && !job.resume && !job.cancel_requested && !job.continuation_invalidated) {
        try {
          if (!await this.current(job)) { this.save({ ...this.get(job.job_id), resume: 'superseded' }); continue }
          const result = await this.continuation(job)
          job = this.get(job.job_id)
          // Preserve supersession/cancel arriving during admission.
          this.save({ ...job, resume: result.publicRunId })
        } catch (error) {
          if (error?.status === 410) {
            const fresh = this.get(job.job_id)
            this.save({ ...fresh, resume: fresh.resume || 'superseded' })
          }
          // Admission unknown: same job key will replay the durable run receipt.
        }
      }
    }
  }
}
