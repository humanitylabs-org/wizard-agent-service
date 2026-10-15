import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`

/** One short SSH RPC, never a build/wait held inside the HTTP request. */
export function heavySshTransport({ host, script, root, lock, python = '/opt/homebrew/bin/python3' }) {
  if (!host || !script || !root || !lock) throw new Error('heavy worker configuration incomplete')
  return payload => new Promise((resolve, reject) => {
    const command = [python, script, '--root', root, '--lock', lock].map(quote).join(' ')
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

/** Durable outbox + continuation receipt. It never owns an interactive slot. */
export class DurableHeavyQueue {
  constructor({ statePath, transport, continuation, current, intervalMs = 1500 }) {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(statePath)
    chmodSync(statePath, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS heavy_jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL,
        origin TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(session,origin,key));`)
    Object.assign(this, { transport, continuation, current, intervalMs, closed: false, busy: null, timer: null })
  }
  get(id) {
    const row = this.db.prepare('SELECT data FROM heavy_jobs WHERE id=?').get(id)
    return row ? JSON.parse(row.data) : null
  }
  rows() { return this.db.prepare('SELECT data FROM heavy_jobs ORDER BY rowid').all().map(r => JSON.parse(r.data)) }
  save(job) { this.db.prepare('UPDATE heavy_jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.job_id); return job }
  // Synchronous durable receipt: no SSH, history, or model request on this path.
  submit({ sessionId, origin, key, spec, route = {}, watermark }) {
    if (!sessionId || !origin || typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) throw fail('invalid heavy identity')
    if (!spec || typeof spec.cwd !== 'string' || !spec.cwd.startsWith('/Volumes/ThalesMedia/')
      || !Array.isArray(spec.argv) || spec.argv.length < 1 || spec.argv.length > 100
      || spec.argv.some(s => typeof s !== 'string' || !s || s.length > 8192 || s.includes('\0'))
      || !Number.isInteger(spec.timeout_seconds) || spec.timeout_seconds < 1 || spec.timeout_seconds > 86400) throw fail('invalid heavy command')
    const requestHash = hash(spec)
    const existing = this.db.prepare('SELECT * FROM heavy_jobs WHERE session=? AND origin=? AND key=?').get(sessionId, origin, key)
    if (existing) {
      if (existing.hash !== requestHash) throw fail('heavy idempotency conflict', 409)
      return JSON.parse(existing.data)
    }
    const job = { job_id: `heavy_${randomUUID().replaceAll('-', '')}`, sessionId, origin, spec, route, watermark,
      state: 'queued', reason: 'resource_queue', created_at: Date.now(), cancel_requested: false,
      remote_ack: false, resume: '', receipt: null }
    this.db.prepare('INSERT INTO heavy_jobs VALUES(?,?,?,?,?,?)').run(job.job_id, sessionId, origin, key, requestHash, JSON.stringify(job))
    return job
  }
  cancel(id, sessionId) {
    const job = this.get(id)
    if (!job || job.sessionId !== sessionId) throw fail('heavy job not found', 404)
    job.cancel_requested = true
    job.resume = job.resume || 'suppressed'
    // Do not assume an RPC that lost its response failed to create remote work.
    job.reason = terminal.has(job.state) ? job.reason : 'cancellation_pending'
    return this.save(job)
  }
  supersede(sessionId) {
    for (const job of this.rows()) if (job.sessionId === sessionId && !job.resume) this.save({ ...job, resume: 'suppressed' })
  }
  summary() {
    const rows = this.rows()
    return { lane: 'external_heavy', max_active: 1, active: rows.filter(r => r.state === 'running').length,
      queued: rows.filter(r => r.state === 'queued').length,
      unavailable: rows.some(r => !terminal.has(r.state) && r.reason === 'worker_unavailable'),
      cancellation_pending: rows.filter(r => r.cancel_requested && !terminal.has(r.state)).length }
  }
  start() {
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.intervalMs)
    this.timer.unref?.()
    return this
  }
  async close() {
    this.closed = true
    clearInterval(this.timer)
    await this.busy
    this.db.close()
  }
  tick() {
    if (this.closed) return Promise.resolve()
    if (!this.busy) this.busy = this._tick().finally(() => { this.busy = null })
    return this.busy
  }
  async _tick() {
    for (const snapshot of this.rows()) {
      if (this.closed) return
      let job = this.get(snapshot.job_id)
      if (!terminal.has(job.state)) {
        try {
          let remote
          if (job.cancel_requested) {
            // cancel-before-submit is a durable local tombstone; status resolves
            // ambiguous submissions before deciding no remote cancellation is needed.
            remote = await this.transport({ action: 'status', job_id: job.job_id })
            if (remote) remote = await this.transport({ action: 'cancel', job_id: job.job_id })
            else remote = { job_id: job.job_id, state: 'cancelled', reason: '', receipt: null }
          } else remote = await this.transport({ action: 'submit', job_id: job.job_id, spec: job.spec })
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
      job = this.get(job.job_id)
      if (terminal.has(job.state) && !job.resume && !job.cancel_requested) {
        try {
          if (!await this.current(job)) { this.save({ ...this.get(job.job_id), resume: 'superseded' }); continue }
          const result = await this.continuation(job)
          job = this.get(job.job_id)
          // Preserve supersession/cancel arriving during admission.
          this.save({ ...job, resume: job.resume || result.publicRunId })
        } catch (error) {
          if (error?.status === 410) this.save({ ...this.get(job.job_id), resume: 'superseded' })
          // Admission unknown: same job key will replay the durable run receipt.
        }
      }
    }
  }
}
