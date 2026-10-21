import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { CronExpressionParser } from 'cron-parser'

export const SCHEDULE_INPUT = '[Wizard schedule]'
export const isSilentResult = value => {
  if (typeof value !== 'string') return false
  // Status trailers are machine metadata, not part of the answer's trailing boundary.
  const text = value.replace(/\[WIZARD_STATUS_V1\][\s\S]*?\[\/WIZARD_STATUS_V1\]/gi, '').trim()
  return text.startsWith('[SILENT]') || text.endsWith('[SILENT]')
}
export const isScheduleInput = value => typeof value === 'string' && value.trimStart().startsWith(SCHEDULE_INPUT)
// Scheduled reports are background turns. Hold their text until completion: a
// trailing [SILENT] cannot safely be classified from an early streaming delta.
// Bound memory and fail closed on malformed/unterminated streams; history remains
// authoritative for long reports. Ordinary interactive chat streaming is unchanged.
export function scheduledRunEvents() {
  const decoder = new StringDecoder('utf8')
  let pending = '', answer = '', overflow = false
  const scrub = value => {
    if (typeof value === 'string') return isSilentResult(value) ? '' : value
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]))
    return value
  }
  const block = (stream, raw) => {
    const lines = raw.split('\n')
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? ''
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) { stream.push(`${raw}\n\n`); return }
    let payload
    try { payload = JSON.parse(data) } catch { return }
    if (event.startsWith('message.')) {
      const delta = payload.delta ?? payload.text ?? ''
      if (typeof delta === 'string' && !overflow) {
        answer += delta
        if (answer.length > 1024 * 1024) { overflow = true; answer = '' }
      }
      return
    }
    if (/^run\.(completed|failed|cancelled|interrupted)$/.test(event)) {
      const output = typeof payload.output === 'string' ? payload.output : answer
      if (event === 'run.completed' && !overflow && output && !isSilentResult(output)) {
        stream.push(`event: message.delta\ndata: ${JSON.stringify({ delta: output })}\n\n`)
      }
      answer = ''
    }
    stream.push(`event: ${event}\ndata: ${JSON.stringify(scrub(payload))}\n\n`)
  }
  const consume = stream => {
    let i
    while ((i = pending.indexOf('\n\n')) >= 0) {
      const raw = pending.slice(0, i); pending = pending.slice(i + 2); block(stream, raw)
    }
    if (pending.length > 2 * 1024 * 1024) throw new Error('scheduled event exceeds bound')
  }
  return new Transform({ transform(chunk, _encoding, callback) {
    try { pending += decoder.write(chunk).replace(/\r/g, ''); consume(this); callback() } catch (error) { callback(error) }
  }, flush(callback) {
    try { pending += decoder.end(); consume(this); callback() } catch (error) { callback(error) }
  } })
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const iso = ms => new Date(ms).toISOString()
const text = (value, max, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`invalid ${field}`)
  return value.trim()
}
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)

export function normalizeWhen(when, timezone, now) {
  if (!when || typeof when !== 'object' || Array.isArray(when) || Object.keys(when).length !== 1) throw fail('when requires exactly one of cron, every, once')
  if (Object.hasOwn(when, 'cron')) {
    const cron = text(when.cron, 200, 'cron')
    if (cron.split(/\s+/).length !== 5) throw fail('cron requires five fields')
    try { CronExpressionParser.parse(cron, { tz: timezone, currentDate: now }).next() } catch { throw fail('invalid cron') }
    return { cron }
  }
  if (Object.hasOwn(when, 'every') && typeof when.every === 'number' && Number.isFinite(when.every) && when.every >= 1 && when.every <= 525600) return { every: when.every }
  if (Object.hasOwn(when, 'once') && typeof when.once === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(when.once) && Number.isFinite(Date.parse(when.once))) return { once: iso(Date.parse(when.once)) }
  throw fail('invalid when (every is minutes; once requires an ISO timestamp with offset)')
}

function nextInstant(job, after) {
  if (job.when.once) return null
  if (job.when.every) {
    const step = job.when.every * 60_000
    return job.anchor + (Math.floor((after - job.anchor) / step) + 1) * step
  }
  return CronExpressionParser.parse(job.when.cron, { tz: job.timezone, currentDate: after }).next().getTime()
}
function latestInstant(job, now) {
  if (job.when.once) return Date.parse(job.when.once)
  if (job.when.every) return nextInstant(job, now) - job.when.every * 60_000
  return CronExpressionParser.parse(job.when.cron, { tz: job.timezone, currentDate: now + 1 }).prev().getTime()
}

// One SQLite transaction claims an occurrence AND advances the high-water cursor.
// Delivery is an outbox: only a confirmed ordinary chat admission acknowledges it.
// There is deliberately no bounded seen-list and no log/file scanning for delivery.
export class Scheduler {
  constructor({ statePath, deliver, now = Date.now, timezone = 'Asia/Bangkok', hermesHome = '', intervalMs = 15_000 }) {
    if (!statePath) throw fail('scheduler state path required', 503)
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(statePath)
    chmodSync(statePath, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_occurrences (
        key TEXT PRIMARY KEY, job_id TEXT NOT NULL, instant INTEGER NOT NULL,
        data TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0, receipt TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS schedule_pending ON schedule_occurrences(admitted, job_id);
      CREATE TABLE IF NOT EXISTS schedule_imports (source TEXT PRIMARY KEY, job_id TEXT NOT NULL);`)
    this.deliver = deliver
    this.now = now
    this.timezone = timezone
    this.hermesHome = hermesHome
    this.intervalMs = intervalMs
    this.stopped = false
    this.inflight = null
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  list() { return this.db.prepare('SELECT data FROM schedules ORDER BY id').all().map(row => JSON.parse(row.data)) }
  get(jobId) {
    const row = this.db.prepare('SELECT data FROM schedules WHERE id=?').get(jobId)
    if (!row) throw fail('schedule not found', 404)
    return JSON.parse(row.data)
  }
  save(job) { this.db.prepare('INSERT OR REPLACE INTO schedules VALUES (?, ?)').run(job.id, JSON.stringify(job)); return job }
  normalize(input, prior = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid schedule')
    const allowed = ['name', 'when', 'timezone', 'agent', 'model', 'prompt', 'skill', 'thread', 'enabled']
    if (Object.keys(input).some(key => !allowed.includes(key))) throw fail('unknown schedule field')
    const now = this.now()
    const job = { ...(prior ?? {}), ...input }
    job.id = prior?.id ?? randomUUID()
    job.name = text(job.name, 160, 'name')
    job.timezone = text(job.timezone ?? this.timezone, 100, 'timezone')
    try { new Intl.DateTimeFormat('en', { timeZone: job.timezone }).format() } catch { throw fail('invalid timezone') }
    job.when = normalizeWhen(job.when, job.timezone, now)
    job.agent = job.agent ?? 'main'
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(job.agent)) throw fail('invalid agent')
    job.prompt = job.prompt ? text(job.prompt, 64_000, 'prompt') : ''
    job.skill = job.skill ? text(job.skill, 200, 'skill') : ''
    if (!job.prompt && !job.skill) throw fail('prompt or skill required')
    if (job.model !== undefined && job.model !== null) job.model = text(job.model, 200, 'model')
    else delete job.model
    if (job.thread !== undefined && job.thread !== null && !id(job.thread)) throw fail('invalid thread')
    job.thread = job.thread || null
    job.enabled = job.enabled ?? true
    if (typeof job.enabled !== 'boolean') throw fail('enabled must be boolean')
    job.createdAt = prior?.createdAt ?? iso(now)
    job.updatedAt = iso(now)
    const reset = !prior || Object.hasOwn(input, 'when') || Object.hasOwn(input, 'timezone') || (!prior.enabled && job.enabled)
    if (reset) {
      job.anchor = now
      // A one-shot's identity survives edits, pause/resume and backward clock jumps.
      job.nextAt = job.when.once ? Date.parse(job.when.once) : nextInstant(job, now)
    }
    return job
  }
  create(input) { return this.save(this.normalize(input)) }
  update(jobId, input) {
    return this.transaction(() => {
      const prior = this.get(jobId)
      // An admitted thread belongs to an agent: never silently reinterpret it on another runtime.
      if (prior.thread && input.agent && input.agent !== prior.agent && !Object.hasOwn(input, 'thread')) throw fail('changing agent requires an explicit thread')
      const next = this.normalize(input, prior)
      if (Object.hasOwn(input, 'thread')) delete next.createThread
      return this.save(next)
    })
  }
  delete(jobId) {
    this.transaction(() => {
      this.get(jobId)
      this.db.prepare('DELETE FROM schedules WHERE id=?').run(jobId)
      this.db.prepare('DELETE FROM schedule_occurrences WHERE job_id=? AND admitted=0').run(jobId)
    })
  }
  reserve(job, instant) {
    // This identity is persisted before any external session/run call. A crashed create
    // retries the same session id; a crashed admission retries the same frozen body/key.
    if (!job.thread) { job.thread = `wizard_schedule_${randomUUID()}`; job.createThread = true; this.save(job) }
    const key = `schedule:${job.id}:${iso(instant)}`
    const occurrence = { key, jobId: job.id, scheduledAt: iso(instant), agent: job.agent, thread: job.thread,
      createThread: Boolean(job.createThread), title: job.name.includes(' · ') ? job.name : `Schedules · ${job.name}`,
      body: { session_id: job.thread, input: `${SCHEDULE_INPUT}\n${job.skill ? `Load and follow the skill ${JSON.stringify(job.skill)}.\n` : ''}${job.prompt}\nIf there is nothing to report, respond exactly [SILENT].`, ...(job.model ? { model: job.model } : {}) } }
    this.db.prepare('INSERT OR IGNORE INTO schedule_occurrences(key,job_id,instant,data) VALUES(?,?,?,?)').run(key, job.id, instant, JSON.stringify(occurrence))
    return occurrence
  }
  runNow(jobId) {
    const occurrence = this.transaction(() => this.reserve(this.get(jobId), this.now()))
    // The durable receipt is returned immediately; admission retries on the loop or the
    // next explicit run request. A paused job stays paused, but its manual outbox drains.
    void this.tick(false).catch(() => { console.error('[scheduler] manual admission failed') })
    return occurrence
  }
  async tick(schedule = true) {
    if (this.stopped) return
    // Do not lose a scheduled tick or a newly added manual outbox entry when an
    // earlier admission is awaiting HTTP. Concurrent ticks share the drain promise.
    this.drainRequested = true
    this.scheduleRequested ||= schedule
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      while (this.drainRequested && !this.stopped) {
        const due = this.scheduleRequested
        this.drainRequested = false
        this.scheduleRequested = false
        await this.work(due)
      }
    })().finally(() => { this.inflight = null })
    return this.inflight
  }
  async work(schedule) {
    if (schedule) this.transaction(() => {
      const now = this.now()
      for (const job of this.list()) {
        if (!job.enabled || job.nextAt === null || job.nextAt > now) continue
        const pending = this.db.prepare('SELECT 1 FROM schedule_occurrences WHERE job_id=? AND admitted=0 LIMIT 1').get(job.id)
        if (!pending) this.reserve(job, latestInstant(job, now))
        // Skip every missed window, including when retrying a pending pre-downtime call.
        job.nextAt = nextInstant(job, now)
        if (job.when.once) job.enabled = false
        this.save(job)
      }
    })
    for (const row of this.db.prepare('SELECT key,data FROM schedule_occurrences WHERE admitted=0 ORDER BY instant').all()) {
      if (this.stopped) break
      try {
        const receipt = await this.deliver(JSON.parse(row.data))
        this.db.prepare('UPDATE schedule_occurrences SET admitted=1, receipt=?, error=NULL WHERE key=?').run(JSON.stringify(receipt ?? {}), row.key)
      } catch (error) {
        // No arbitrary exception/body strings in state/API responses (they may contain credentials).
        this.db.prepare('UPDATE schedule_occurrences SET error=? WHERE key=?').run(`admission failed (${Number(error?.status) || 503})`, row.key)
      }
    }
  }
  hasRun(agent, runId) {
    return Boolean(this.db.prepare("SELECT 1 FROM schedule_occurrences WHERE json_extract(data,'$.agent')=? AND json_extract(receipt,'$.run_id')=? LIMIT 1").get(agent, runId))
  }
  start() {
    if (this.timer || this.stopped) return
    const tick = () => { void this.tick().catch(() => { console.error('[scheduler] tick failed') }) }
    this.timer = setInterval(tick, this.intervalMs)
    this.timer.unref?.()
    tick()
  }
  quiesce() { this.stopped = true; clearInterval(this.timer); this.timer = null; return this.inflight }
  async close() { await this.quiesce(); this.db.close() }
}

export function importHermesSchedules(scheduler, { dryRun = true } = {}) {
  if (typeof dryRun !== 'boolean') throw fail('dryRun must be boolean')
  if (!scheduler.hermesHome) throw fail('HERMES_HOME required for import', 503)
  let source
  try { source = JSON.parse(readFileSync(join(scheduler.hermesHome, 'cron', 'jobs.json'), 'utf8')) } catch { throw fail('Hermes jobs unavailable or invalid', 400) }
  const jobs = Array.isArray(source) ? source : source?.jobs
  if (!Array.isArray(jobs)) throw fail('invalid Hermes jobs list')
  const results = scheduler.transaction(() => jobs.map(row => {
    if (!row || typeof row !== 'object') return { status: 'not imported: invalid job' }
    const base = { id: row.id, name: row.name }
    if (row.no_agent || row.script) return { ...base, status: 'not imported: script job' }
    if (!id(row.id)) return { ...base, status: 'not imported: invalid id' }
    const sourceKey = `${scheduler.hermesHome}:${row.id}`
    const previous = scheduler.db.prepare('SELECT job_id FROM schedule_imports WHERE source=?').get(sourceKey)
    if (previous) return { ...base, status: 'already imported', scheduleId: previous.job_id }
    const s = row.schedule
    const when = s?.kind === 'cron' ? { cron: s.expr } : s?.kind === 'interval' ? { every: s.minutes } : s?.kind === 'once' ? { once: s.run_at } : null
    try {
      const skills = [...new Set([...(Array.isArray(row.skills) ? row.skills : []), row.skill].filter(Boolean))]
      const input = { name: row.name || row.id, when, timezone: row.timezone || scheduler.timezone, agent: 'main',
        prompt: [row.prompt || '', ...skills.slice(1).map(skill => `Also load and follow the skill ${JSON.stringify(skill)}.`)].filter(Boolean).join('\n'),
        skill: skills[0] || '', ...(row.model ? { model: row.model } : {}), enabled: false }
      const job = scheduler.normalize(input)
      if (!dryRun) {
        scheduler.save(job)
        scheduler.db.prepare('INSERT INTO schedule_imports VALUES (?,?)').run(sourceKey, job.id)
      }
      return { ...base, status: dryRun ? 'would import (paused)' : 'imported (paused)', ...(dryRun ? {} : { scheduleId: job.id }), schedule: job }
    } catch { return { ...base, status: 'not imported: unsupported or invalid job' } }
  }))
  return { dryRun, results }
}

export async function handleSchedulesApi(request, response, url, { scheduler, readBody, sendJson }) {
  if (url.pathname !== '/wizard/v1/schedules' && !url.pathname.startsWith('/wizard/v1/schedules/')) return false
  if (!scheduler) throw fail('scheduler state unavailable', 503)
  const suffix = url.pathname.slice('/wizard/v1/schedules'.length)
  if (!suffix && request.method === 'GET') sendJson(response, 200, { schedules: scheduler.list() })
  else if (!suffix && request.method === 'POST') sendJson(response, 201, scheduler.create(await readBody(request)))
  else if (suffix === '/import-hermes' && request.method === 'POST') sendJson(response, 200, importHermesSchedules(scheduler, await readBody(request)))
  else {
    const match = /^\/([A-Za-z0-9._:-]+)(\/run)?$/.exec(suffix)
    if (!match) throw fail('schedule route not found', 404)
    if (match[2] && request.method === 'POST') sendJson(response, 202, scheduler.runNow(match[1]))
    else if (!match[2] && request.method === 'PATCH') sendJson(response, 200, scheduler.update(match[1], await readBody(request)))
    else if (!match[2] && request.method === 'DELETE') { scheduler.delete(match[1]); sendJson(response, 200, { deleted: true }) }
    else throw fail('method not allowed', 405)
  }
  return true
}
