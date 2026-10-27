// Host-only deterministic work. No Hermes runtime, prompt, transcript or cron writer.
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { CronExpressionParser } from 'cron-parser'
import { acquireLease } from './store-migration.mjs'
import { notificationFromOutput, isSilentResult } from './scheduler.mjs'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const ID = /^[a-zA-Z0-9_-]{1,80}$/
const iso = ms => new Date(ms).toISOString()
const plain = v => v && typeof v === 'object' && !Array.isArray(v)
function schedule(when, timezone, now) {
  if (!plain(when) || Object.keys(when).length !== 1) throw fail('Choose one schedule')
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format() } catch { throw fail('Invalid timezone') }
  if ('every' in when && Number.isSafeInteger(when.every) && when.every >= 1 && when.every <= 525600) return now + when.every * 60000
  if ('cron' in when && typeof when.cron === 'string' && when.cron.trim().split(/\s+/).length === 5) {
    try { return CronExpressionParser.parse(when.cron, { tz: timezone, currentDate: now }).next().getTime() } catch { /* invalid */ }
  }
  if ('once' in when && typeof when.once === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(when.once) && Number.isFinite(Date.parse(when.once))) return Date.parse(when.once)
  throw fail('Invalid schedule')
}
function validate(input, now) {
  if (!plain(input) || Object.keys(input).some(k => !['name', 'command', 'cwd', 'when', 'timezone', 'timeoutSeconds', 'envKeys', 'notify'].includes(k))) throw fail('Invalid system job fields')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 || /[\r\n\x00-\x1f]/.test(input.name)) throw fail('Invalid name')
  if (!Array.isArray(input.command) || !input.command.length || input.command.length > 100 || input.command.some(s => typeof s !== 'string' || !s || s.length > 4096 || /[\x00\r\n]/.test(s))) throw fail('Use a command argument array')
  if (!isAbsolute(input.command[0]) && !/^[a-zA-Z0-9_.-]+$/.test(input.command[0])) throw fail('Invalid executable')
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || /[\x00\r\n]/.test(input.cwd)) throw fail('Choose an absolute working directory')
  const timezone = input.timezone ?? 'UTC'
  schedule(input.when, timezone, now)
  const timeoutSeconds = input.timeoutSeconds ?? 3600
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) throw fail('Invalid time limit')
  const envKeys = input.envKeys ?? []
  if (!Array.isArray(envKeys) || envKeys.length > 100 || envKeys.some(k => typeof k !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(k))) throw fail('Use environment key names only')
  const notify = input.notify ?? 'failure'
  if (!['failure', 'output'].includes(notify)) throw fail('Choose failure or output notifications')
  return { ...input, timezone, timeoutSeconds, envKeys, notify }
}
const atomic = (path, text) => {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 }); renameSync(temporary, path)
}
const unitName = id => `wizard-system-job-${id}`
// systemd ExecStart quoting: never shell parsing, expansions or owner-controlled unit directives.
const quote = s => '"' + String(s).replace(/%/g, '%%').replace(/\$/g, () => '$$').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
export class SystemdJobTimers {
  constructor({ unitDir, socketPath, node = process.execPath, trigger = fileURLToPath(new URL('../scripts/system-job-trigger.mjs', import.meta.url)), control = args => execFileSync('systemctl', ['--user', ...args], { stdio: 'pipe', timeout: 15000 }) }) {
    if (![unitDir, socketPath, node, trigger].every(p => typeof p === 'string' && isAbsolute(p) && !/[\x00\r\n]/.test(p))) throw fail('Explicit host timer paths required')
    Object.assign(this, { unitDir, socketPath, node, trigger, control })
  }
  apply(job) {
    if (!ID.test(job.id)) throw fail('Invalid identity')
    const unit = unitName(job.id)
    if (!job.enabled || !job.nextAt) {
      // Only stop our timer. A running script is never killed by disabling its future schedule.
      if (existsSync(join(this.unitDir, `${unit}.timer`))) this.control(['disable', '--now', `${unit}.timer`])
      return
    }
    mkdirSync(this.unitDir, { recursive: true, mode: 0o700 })
    atomic(join(this.unitDir, `${unit}.service`), `[Unit]\nDescription=Wizard scheduled host maintenance\n[Service]\nType=oneshot\nExecStart=${[this.node, this.trigger, this.socketPath, job.id].map(quote).join(' ')}\nTimeoutStartSec=30\n`)
    const calendar = iso(job.nextAt).replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
    atomic(join(this.unitDir, `${unit}.timer`), `[Unit]\nDescription=Wizard scheduled host maintenance\n[Timer]\nOnCalendar=${calendar}\nPersistent=true\nAccuracySec=1s\nUnit=${unit}.service\n[Install]\nWantedBy=timers.target\n`)
    this.control(['daemon-reload'])
    this.control(['enable', `${unit}.timer`])
    this.control(['restart', `${unit}.timer`])
  }
}

export class SystemJobs {
  constructor({ statePath, timers = null, notifier = null, now = Date.now, hermesHome = '', execute = executeSystemCommand }) {
    if (!isAbsolute(statePath)) throw fail('Explicit state path required')
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    const release = acquireLease(`${statePath}.writer.sqlite`)
    try {
      this.db = new DatabaseSync(statePath)
      chmodSync(statePath, 0o600)
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS system_jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL, source TEXT UNIQUE);
        CREATE TABLE IF NOT EXISTS system_job_runs(id TEXT PRIMARY KEY, job TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER, outcome TEXT NOT NULL, code INTEGER, alert INTEGER NOT NULL DEFAULT 0, note TEXT);
        CREATE INDEX IF NOT EXISTS system_job_runs_latest ON system_job_runs(job,started);`)
      Object.assign(this, { release, timers, notifier, now, hermesHome, execute, active: new Map(), closed: false })
      // An uncertain execution is NEVER replayed: backups/cleanup can be non-idempotent.
      this.db.prepare("UPDATE system_job_runs SET outcome='interrupted',finished=?,alert=1 WHERE finished IS NULL").run(now())
    } catch (error) { this.db?.close(); release(); throw error }
  }
  get(id) {
    const row = this.db.prepare('SELECT data FROM system_jobs WHERE id=?').get(id)
    if (!row) throw fail('System job not found', 404)
    return JSON.parse(row.data)
  }
  project(job) {
    const run = this.db.prepare('SELECT * FROM system_job_runs WHERE job=? ORDER BY started DESC,rowid DESC LIMIT 1').get(job.id)
    return { ...job, nextRun: job.enabled && job.nextAt ? iso(job.nextAt) : null,
      lastRun: run ? { id: run.id, startedAt: iso(run.started), finishedAt: run.finished ? iso(run.finished) : null, outcome: run.outcome, exitCode: run.code, notification: run.alert === 1 ? 'pending' : run.alert === 2 ? 'sent' : 'none' } : null }
  }
  list() { return this.db.prepare('SELECT data FROM system_jobs ORDER BY rowid').all().map(r => this.project(JSON.parse(r.data))) }
  save(job, source = null) {
    this.db.prepare('INSERT INTO system_jobs(id,data,source) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job), source)
    return job
  }
  create(input, source = null) {
    const job = { ...validate(input, this.now()), id: randomUUID(), enabled: false, nextAt: null, timerError: null }
    this.save(job, source)
    return this.project(job)
  }
  edit(id, patch) {
    if (!plain(patch)) throw fail('Invalid edit')
    const old = this.get(id)
    const { enabled = old.enabled, ...fields } = patch
    if (typeof enabled !== 'boolean') throw fail('Invalid enabled state')
    const { id: _, enabled: __, nextAt, timerError, source, ...definition } = old
    const job = { ...validate({ ...definition, ...fields }, this.now()), id, enabled, nextAt, timerError: null }
    if (enabled && this.active.has(id) && Object.keys(fields).length) throw fail('Wait for the active command before editing its definition', 409)
    if (enabled && !this.timers) throw fail('Host timers are not configured', 503)
    if (enabled && (old.enabled !== enabled || fields.when || fields.timezone)) job.nextAt = schedule(job.when, job.timezone, this.now())
    if (enabled && job.nextAt <= this.now()) throw fail('Choose a future time before enabling')
    if (!enabled) job.nextAt = null
    // Disable authority before touching systemd. Old/stale callbacks then fail closed.
    this.save({ ...job, enabled: false })
    try { this.timers?.apply(job); this.save(job) }
    catch { this.save({ ...job, enabled: false, timerError: 'The host timer could not be updated. Try enabling it again.' }); throw fail('Host timer update failed; schedule is disabled', 503) }
    return this.project(job)
  }
  reconcile() {
    for (const job of this.list()) {
      const { lastRun, nextRun, ...stored } = job
      try { this.timers?.apply(stored) }
      catch { this.save({ ...stored, timerError: 'The host timer could not be updated. Check the host timer service.' }) }
    }
  }
  run(id, { scheduled = false } = {}) {
    if (this.closed) throw fail('System jobs are stopping', 503)
    if (!this.timers) throw fail('Host timers are not configured', 503)
    const job = this.get(id), now = this.now()
    if (!job.enabled) throw fail('Enable this system job first', 409)
    if (this.active.has(id)) throw fail('This system job is already running', 409)
    if (scheduled && (!job.nextAt || job.nextAt > now + 1000)) throw fail('This system job is not due', 409)
    if (scheduled) {
      const nextAt = 'once' in job.when ? null : 'every' in job.when ? job.nextAt + (Math.floor(Math.max(0, now - job.nextAt) / (job.when.every * 60000)) + 1) * job.when.every * 60000 : schedule(job.when, job.timezone, now)
      this.save({ ...job, nextAt, enabled: Boolean(nextAt) })
      // Re-arm before executing, but never replay the just-claimed work after a failure.
      try { this.timers?.apply({ ...job, nextAt, enabled: Boolean(nextAt) }) }
      catch { this.save({ ...job, nextAt, enabled: false, timerError: 'The next maintenance time could not be saved. Enable it again after checking the host timer service.' }) }
    }
    const receipt = { id: randomUUID(), job: id, startedAt: iso(now), outcome: 'running' }
    this.db.prepare("INSERT INTO system_job_runs(id,job,started,outcome) VALUES(?,?,?,'running')").run(receipt.id, id, now)
    // Freeze arguments before asynchronous work; coalesce timers/manual runs per job.
    const abort = new AbortController()
    const task = Promise.resolve().then(() => this.execute(job, abort.signal)).catch(() => ({ code: null })).then(result => {
      const ok = result.code === 0
      const note = ok && job.notify === 'output' && !isSilentResult(result.output) ? notificationFromOutput(result.output) : null
      this.db.prepare('UPDATE system_job_runs SET finished=?,outcome=?,code=?,alert=?,note=? WHERE id=?').run(this.now(), ok ? 'succeeded' : 'failed', Number.isInteger(result.code) ? result.code : null, !ok || note ? 1 : 0, note ? JSON.stringify(note) : null, receipt.id)
    }).finally(() => this.active.delete(id))
    this.active.set(id, { task, abort })
    return receipt
  }
  async flushAlerts() {
    if (this.alerting || this.closed) return
    this.alerting = true
    try {
      for (const row of this.db.prepare('SELECT id,note FROM system_job_runs WHERE alert=1 ORDER BY started LIMIT 100').all()) {
        try {
          if (!this.notifier) break
          // Ordinary output is never forwarded; only explicitly opted-in, bounded successful output has a note.
          await this.notifier.send({ agent: 'main', key: `system-job:${row.id}`, ...(row.note ? JSON.parse(row.note) : { title: 'Scheduled maintenance needs attention', message: 'Scheduled maintenance did not finish. Check the System jobs list before running it again.' }) })
          this.db.prepare('UPDATE system_job_runs SET alert=2 WHERE id=?').run(row.id)
        } catch { break } // durable, no aging-out; a temporarily unavailable app is not a lost alert.
      }
    } finally { this.alerting = false }
  }
  importHermes({ dryRun = true, timezone, ids } = {}) {
    if (typeof dryRun !== 'boolean' || typeof timezone !== 'string' || (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')))) throw fail('Choose dryRun, the source timezone and optional source IDs')
    if (!this.hermesHome || !isAbsolute(this.hermesHome)) throw fail('Explicit Hermes import home required', 503)
    const sourcePath = join(this.hermesHome, 'cron', 'jobs.json')
    if (statSync(sourcePath).size > 4 * 1024 * 1024) throw fail('Import snapshot is too large')
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf8'))
    const rows = Array.isArray(parsed) ? parsed : parsed.jobs
    if (!Array.isArray(rows) || rows.length > 10000) throw fail('Invalid Hermes snapshot')
    const seen = new Set()
    const results = rows.filter(r => !ids || ids.includes(r?.id)).map(row => {
      const base = { sourceId: typeof row?.id === 'string' ? row.id : null }
      if (!base.sourceId || !ID.test(base.sourceId) || seen.has(base.sourceId)) return { ...base, status: 'rejected', reason: 'Invalid or duplicate source identity' }
      seen.add(base.sourceId)
      if (row.no_agent !== true || typeof row.script !== 'string' || !row.script) return { ...base, status: 'skipped', reason: 'Not a script-only job' }
      const source = `hermes:${resolve(this.hermesHome)}:${row.id}`
      const prior = this.db.prepare('SELECT id FROM system_jobs WHERE source=?').get(source)
      if (prior) return { ...base, status: 'already imported', id: prior.id }
      try {
        if (row.monitor_script || row.context_from?.length || (row.repeat?.times && row.repeat.times !== 0)) throw fail('Review chained or finite-repeat work separately')
        const s = row.schedule
        const when = s?.kind === 'cron' ? { cron: s.expr } : s?.kind === 'interval' ? { every: s.minutes } : s?.kind === 'once' ? { once: s.run_at } : null
        const script = isAbsolute(row.script) ? row.script : resolve(this.hermesHome, 'scripts', row.script)
        if (row.interpreter && (!isAbsolute(row.interpreter) || /[\x00\r\n]/.test(row.interpreter))) throw fail('Review the interpreter')
        const command = /\.(sh|bash)$/i.test(script) ? ['/bin/bash', script] : [row.interpreter || 'python3', script]
        const input = validate({ name: row.name || row.id, when, timezone, command, cwd: row.workdir || this.hermesHome }, this.now())
        return { ...base, status: dryRun ? 'would import disabled' : 'imported disabled', ...(dryRun ? { definition: input } : { id: this.create(input, source).id }) }
      } catch { return { ...base, status: 'rejected', reason: 'Unsupported definition; review the command, dependencies and schedule' } }
    })
    return { dryRun, results }
  }
  async close() {
    this.closed = true
    for (const { abort } of this.active.values()) abort.abort()
    await Promise.allSettled([...this.active.values()].map(v => v.task))
    while (this.alerting) await new Promise(r => setTimeout(r, 10))
    this.db.close(); this.release()
  }
}

export function executeSystemCommand(job, signal) {
  return new Promise(resolveResult => {
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ', ...job.envKeys].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))
    const child = spawn(job.command[0], job.command.slice(1), { cwd: job.cwd, env, stdio: ['ignore', job.notify === 'output' ? 'pipe' : 'ignore', 'ignore'], detached: true })
    let output = '', bytes = 0, overflow = false
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 16384) { overflow = true; output = '' }; if (!overflow) output += chunk })
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }
    const timer = setTimeout(kill, job.timeoutSeconds * 1000)
    signal.addEventListener('abort', kill, { once: true })
    if (signal.aborted) kill()
    let settled = false
    const done = code => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', kill); resolveResult({ code, output: overflow ? '' : output }) }
    child.once('error', () => done(null)); child.once('close', code => done(code))
  })
}

// Private host IPC: no network listener, no agent token, no script definitions accepted.
// The containing directory must NOT be mounted into an agent container.
export function systemJobsSocket(jobs, socketPath) {
  if (!isAbsolute(socketPath) || socketPath.length > 100) throw fail('Choose a short absolute host socket path')
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 }); chmodSync(dirname(socketPath), 0o700)
  rmSync(socketPath, { force: true }) // only after the caller has acquired the writer lease
  const server = createServer((req, res) => {
    const id = req.url?.match(/^\/run\/([a-zA-Z0-9_-]{1,80})$/)?.[1]
    try {
      if (req.method !== 'POST' || !id) throw fail('Not found', 404)
      if (req.headers['content-length'] && req.headers['content-length'] !== '0' || req.headers['transfer-encoding']) throw fail('No body accepted')
      jobs.run(id, { scheduled: true }); res.writeHead(202); res.end()
    } catch (error) { res.writeHead(error.status || 500); res.end() }
  })
  server.listen(socketPath, () => chmodSync(socketPath, 0o600))
  return server
}

export async function handleSystemJobsApi(request, response, url, { jobs, sendJson, readBody }) {
  if (!jobs) { sendJson(response, 503, { error: 'Host system jobs are not configured' }); return }
  try {
    const suffix = url.pathname.slice('/wizard/v1/system-jobs'.length)
    const match = suffix.match(/^\/([a-zA-Z0-9_-]{1,80})(\/run)?$/)
    let value
    if (request.method !== 'GET') value = await readBody(request)
    if (!suffix && request.method === 'GET') sendJson(response, 200, { systemJobs: jobs.list(), hostTimers: Boolean(jobs.timers) })
    else if (!suffix && request.method === 'POST') sendJson(response, 201, jobs.create(value))
    else if (suffix === '/import-hermes' && request.method === 'POST') sendJson(response, 200, jobs.importHermes(value))
    else if (match && !match[2] && request.method === 'PATCH') sendJson(response, 200, jobs.edit(match[1], value))
    else if (match?.[2] && request.method === 'POST' && plain(value) && !Object.keys(value).length) sendJson(response, 202, jobs.run(match[1]))
    else sendJson(response, 404, { error: 'not_found' })
  } catch (error) { sendJson(response, error.status || 500, { error: error.status ? error.message : 'System job request failed' }) }
}
