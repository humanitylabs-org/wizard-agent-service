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
// Where a scheduled result goes. `thread`: the job's chat thread (default). `notification`: the box's
// notifications slot (bell beside Chats), for one-way alerts with no conversation to own them. The run still
// happens in its thread for history, but its answer is silent there and the service sends it to the slot.
export const DELIVERIES = ['thread', 'notification']
const NOTIFY_INSTRUCTION = '\nDeliver to: the owner\'s Notifications, not this chat. Write only the notification: a short title on the first line,'
  + ' then one or two plain sentences (what happened and what, if anything, they need to do). Put [SILENT] alone on the last line.'
  + ' If nothing is worth telling them, respond exactly [SILENT].'
/** The notification inside a notification-delivery answer: title + message, or null when there is nothing to send. */
export function notificationFromOutput(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\[WIZARD_STATUS_V1\][\s\S]*?\[\/WIZARD_STATUS_V1\]/gi, '').replace(/\[SILENT\]/g, '').trim()
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const first = lines[0].trim().replace(/^#+\s*/, '').replace(/^\*\*(.+?)\*\*\.?$/, '$1').trim()
  const rest = lines.slice(1).join('\n').trim()
  const title = (rest ? first : '').slice(0, 120)
  return { title, message: (rest || first).slice(0, 3800) }
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
// run: agent work in a thread. remind: a short agent turn that reminds. return (Boomerang): no agent at all,
// the thread or one message in it comes back to the owner's Ready list with a notification.
export const KINDS = ['run', 'remind', 'return']
export const RETURN_RUN_PREFIX = 'wzb_'
function normalizeTarget(target) {
  if (target === undefined || target === null) return { message: null, excerpt: '' }
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(k => !['message', 'excerpt'].includes(k))) throw fail('invalid target')
  const message = target.message ?? null
  if (message !== null && !(typeof message === 'number' && Number.isFinite(message) && message > 0) && !(typeof message === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(message))) throw fail('invalid target message')
  if (target.excerpt !== undefined && typeof target.excerpt !== 'string') throw fail('invalid target excerpt')
  return { message, excerpt: String(target.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, 280) }
}

// Named windows are sugar for `once`: resolved to one instant at insert, labelled for the
// Morning summary. 'morning' is the owner's wake time; 'overnight' starts after they sleep and
// is jittered so a batch of overnight jobs does not all go due in the same second.
export const WINDOWS = { morning: { hour: 8, minute: 30, jitterMin: 0 }, overnight: { hour: 3, minute: 30, jitterMin: 20 } }
function zonedParts(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
  return parts
}
function zonedInstant(y, mo, d, h, mi, timeZone) {
  // Wall-clock time in timeZone -> UTC ms (two passes absorb DST edges).
  let guess = Date.UTC(y, mo - 1, d, h, mi)
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, timeZone)
    guess -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Date.UTC(y, mo - 1, d, h, mi)
  }
  return guess
}
export function resolveWindow(name, timezone, now, random = Math.random) {
  const spec = WINDOWS[name]
  if (!spec) throw fail(`unknown window (use ${Object.keys(WINDOWS).join(' or ')})`)
  const today = zonedParts(now, timezone)
  let at = zonedInstant(today.year, today.month, today.day, spec.hour, spec.minute, timezone)
  if (at <= now) {
    const next = zonedParts(now + 24 * 3600_000, timezone)
    at = zonedInstant(next.year, next.month, next.day, spec.hour, spec.minute, timezone)
  }
  return at + Math.floor(random() * spec.jitterMin) * 60_000
}

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
function scheduleInput(job, deliver = 'thread') {
  const base = scheduleBaseInput(job)
  return deliver === 'notification' ? base.replace(/ in this thread/g, '') + NOTIFY_INSTRUCTION : base
}
function scheduleBaseInput(job) {
  const skill = job.skill ? `Load and follow the skill ${JSON.stringify(job.skill)}.\n` : ''
  if ((job.kind ?? 'run') === 'remind') {
    return `${SCHEDULE_INPUT} reminder\nThe owner asked to be reminded, in this thread, about:\n${job.prompt}\n`
      + 'Deliver the reminder now, briefly. You may cheaply check whether it is still relevant and add the current state. Do not start the work itself unless the reminder says to.'
  }
  if (job.when?.once) {
    return `${SCHEDULE_INPUT} deferred work\nThe owner asked for this to run later, in this thread:\n${skill}${job.prompt}\nDo the work now and report the result here.`
  }
  return `${SCHEDULE_INPUT}\n${skill}${job.prompt}\nIf there is nothing to report, respond exactly [SILENT].`
}

export class Scheduler {
  constructor({ statePath, deliver, lookup = null, notifier = null, now = Date.now, timezone = 'Asia/Bangkok', hermesHome = '', intervalMs = 15_000, trickleMs = 60_000, maxInflight = 6, random = Math.random }) {
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
    // Additive migration of the durable occurrence ledger, including pre-feature jobs.
    const columns = new Set(this.db.prepare('PRAGMA table_info(schedule_occurrences)').all().map(row => row.name))
    for (const column of ['started_at', 'finished_at', 'outcome']) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE schedule_occurrences ADD COLUMN ${column} TEXT`)
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS schedule_latest ON schedule_occurrences(job_id, instant DESC)')
    this.lookup = lookup
    this.deliver = deliver
    // { available(): boolean, send({ title, message, key, priority }) }: the notifications slot. Absent or
    // unavailable at claim time means a notification job falls back to its thread for that occurrence.
    this.notifier = notifier
    this.now = now
    this.timezone = timezone
    this.hermesHome = hermesHome
    this.intervalMs = intervalMs
    // Agent work trickles: one admission per trickleMs, at most maxInflight scheduled runs
    // unfinished at once. Reminders are short and bypass both. The run queue's own
    // max-active cap still applies on top, shared with interactive threads.
    this.trickleMs = trickleMs
    this.maxInflight = maxInflight
    this.random = random
    this.lastAdmitAt = -Infinity
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
  latest(jobId) {
    return this.db.prepare('SELECT * FROM schedule_occurrences WHERE job_id=? ORDER BY instant DESC, key DESC LIMIT 1').get(jobId)
  }
  project(job) {
    const row = this.latest(job.id)
    const onceClaimed = job.when.once && this.db.prepare('SELECT 1 FROM schedule_occurrences WHERE key=?').get(`schedule:${job.id}:${job.when.once}`)
    return { ...job, nextRun: job.enabled && job.nextAt !== null && !onceClaimed ? iso(job.nextAt) : null,
      lastRun: row ? { scheduledFor: iso(row.instant), startedAt: row.started_at ?? null, finishedAt: row.finished_at ?? null,
        outcome: row.outcome || (row.error ? 'failed' : 'running'), error: row.error || null } : null }
  }
  async refreshRuns() {
    if (this.stopped || !this.lookup) return
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      // Only the last occurrence can be shown. Never use unrelated chat activity.
      // Every unfinished admitted occurrence (bounded to 6 h) so the trickle's in-flight count is true.
      // A notification occurrence keeps being observed for 7 days, so a long run or a slot outage still sends it.
      const rows = this.db.prepare(`SELECT * FROM schedule_occurrences WHERE admitted=1 AND finished_at IS NULL
        AND (instant > ? OR (json_extract(data,'$.deliver')='notification' AND instant > ?))`).all(this.now() - 6 * 3600_000, this.now() - 7 * 86400_000)
      await Promise.all(rows.map(async row => {
        const receipt = JSON.parse(row.receipt || '{}')
        if (!receipt.run_id) return
        try {
          const run = await this.lookup(JSON.parse(row.data), receipt)
          if (!run || !['queued', 'accepted', 'pending', 'running', 'waiting_for_approval', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return
          const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
          const output = typeof run.output === 'string' ? run.output : ''
          let outcome = run.status === 'completed' ? (isSilentResult(output) || !output.trim() ? 'silent' : 'posted') : terminal ? 'failed' : 'running'
          const occurrence = JSON.parse(row.data)
          if (occurrence.deliver === 'notification' && run.status === 'completed') {
            const note = notificationFromOutput(output)
            if (note) {
              try {
                if (!this.notifier) throw new Error('no notifier')
                await this.notifier.send({ ...note, key: row.key })
                outcome = 'notified'
              } catch {
                // Stay unfinished so the next refresh retries (notification rows are observed for 7 days).
                this.db.prepare("UPDATE schedule_occurrences SET outcome='failed', error=? WHERE key=?").run('Notification not delivered; will retry', row.key)
                return
              }
            } else outcome = 'silent'
          }
          // Upstream errors can contain credentials. Only service-owned short copy is stored.
          const error = terminal && outcome === 'failed' ? (run.status === 'cancelled' ? 'Run cancelled' : run.status === 'interrupted' ? 'Run interrupted' : 'Run failed') : null
          const timestamp = value => {
            const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
            return Number.isFinite(ms) ? iso(ms) : null
          }
          const started = row.started_at || timestamp(run.started_at) || (['running', 'waiting_for_approval', 'stopping'].includes(run.status) ? iso(this.now()) : null)
          const finished = terminal ? timestamp(run.finished_at || run.completed_at) || iso(this.now()) : null
          this.db.prepare('UPDATE schedule_occurrences SET started_at=?, finished_at=?, outcome=?, error=? WHERE key=?')
            .run(started, finished, outcome, error, row.key)
        } catch { /* A lookup outage is not a failed run. Keep the last durable observation. */ }
      }))
    })().finally(() => { this.refreshing = null })
    return this.refreshing
  }
  save(job) { this.db.prepare('INSERT OR REPLACE INTO schedules VALUES (?, ?)').run(job.id, JSON.stringify(job)); return job }
  normalize(input, prior = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid schedule')
    const allowed = ['name', 'when', 'timezone', 'agent', 'model', 'prompt', 'skill', 'thread', 'enabled', 'kind', 'target', 'deliver']
    if (Object.keys(input).some(key => !allowed.includes(key))) throw fail('unknown schedule field')
    const now = this.now()
    const job = { ...(prior ?? {}), ...input }
    job.id = prior?.id ?? randomUUID()
    job.name = text(job.name, 160, 'name')
    job.timezone = text(job.timezone ?? (typeof this.timezone === 'function' ? this.timezone() : this.timezone), 100, 'timezone')
    try { new Intl.DateTimeFormat('en', { timeZone: job.timezone }).format() } catch { throw fail('invalid timezone') }
    if (input.when && typeof input.when === 'object' && Object.hasOwn(input.when, 'at') && Object.keys(input.when).length === 1) {
      const name = String(input.when.at)
      job.when = { once: iso(resolveWindow(name, job.timezone, now, this.random)) }
      job.window = name
    } else {
      if (Object.hasOwn(input, 'when')) delete job.window
      job.when = normalizeWhen(job.when, job.timezone, now)
    }
    job.kind = job.kind ?? 'run'
    if (!KINDS.includes(job.kind)) throw fail(`kind must be ${KINDS.join(', ')}`)
    if (job.kind === 'remind' && !job.prompt) throw fail('a reminder needs its text in prompt')
    job.agent = job.agent ?? 'main'
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(job.agent)) throw fail('invalid agent')
    if (job.kind === 'return') {
      // Boomerang: hand an existing thread (or one message in it) back to the owner. Never a prompt or a run,
      // so it has no skill/model, an optional short note, and must name the thread it returns.
      if (!job.when.once) throw fail('a return happens once (use once or at)')
      if (!job.thread || !id(job.thread)) throw fail('a return needs its thread')
      if (job.skill || (job.model !== undefined && job.model !== null)) throw fail('a return runs nothing (no skill or model)')
      job.prompt = typeof job.prompt === 'string' ? job.prompt.trim().slice(0, 500) : ''
      job.skill = ''
      delete job.model
      job.target = normalizeTarget(job.target)
    } else {
      if (Object.hasOwn(input, 'target')) throw fail('target is only for kind return')
      delete job.target
    }
    job.prompt = job.prompt ? text(job.prompt, 64_000, 'prompt') : ''
    job.skill = job.skill ? text(job.skill, 200, 'skill') : ''
    if (!job.prompt && !job.skill && job.kind !== 'return') throw fail('prompt or skill required')
    if (job.model !== undefined && job.model !== null) job.model = text(job.model, 200, 'model')
    else delete job.model
    if (job.thread !== undefined && job.thread !== null && !id(job.thread)) throw fail('invalid thread')
    job.thread = job.thread || null
    job.deliver = job.deliver ?? 'thread'
    if (!DELIVERIES.includes(job.deliver)) throw fail(`deliver must be ${DELIVERIES.join(' or ')}`)
    if (job.kind === 'return' && job.deliver !== 'thread') throw fail('a return always comes back as its thread')
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
  reserve(job, instant, manual = false) {
    // This identity is persisted before any external session/run call. A crashed create
    // retries the same session id; a crashed admission retries the same frozen body/key.
    if (!job.thread) { job.thread = `wizard_schedule_${randomUUID()}`; job.createThread = true; this.save(job) }
    const key = `schedule:${job.id}:${iso(instant)}`
    // Frozen per occurrence: an empty or stopped notifications slot sends this run to the thread instead.
    let deliver = 'thread'
    if (job.deliver === 'notification' && job.kind !== 'return') {
      try { if (this.notifier?.available()) deliver = 'notification' } catch { /* fall back to the thread */ }
    }
    const occurrence = { key, jobId: job.id, scheduledAt: iso(instant), agent: job.agent, thread: job.thread,
      createThread: Boolean(job.createThread), title: job.name.includes(' · ') ? job.name : `Schedules · ${job.name}`,
      kind: job.kind ?? 'run', window: job.window ?? null, ...(manual ? { manual: true } : {}), ...(deliver === 'notification' ? { deliver } : {}),
      ...(job.kind === 'return' ? { target: job.target ?? { message: null, excerpt: '' }, note: job.prompt || '' }
        : { body: { session_id: job.thread, input: scheduleInput(job, deliver), ...(job.model ? { model: job.model } : {}) } }) }
    this.db.prepare('INSERT OR IGNORE INTO schedule_occurrences(key,job_id,instant,data) VALUES(?,?,?,?)').run(key, job.id, instant, JSON.stringify(occurrence))
    return occurrence
  }
  runNow(jobId) {
    const occurrence = this.transaction(() => this.reserve(this.get(jobId), this.now(), true))
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
      const occurrence = JSON.parse(row.data)
      // Reminders, Boomerang returns and the owner's explicit Run now skip the trickle.
      const trickled = !['remind', 'return'].includes(occurrence.kind) && !occurrence.manual
      // A held row stays pending and is retried on the next tick, in due order.
      if (trickled && (this.now() - this.lastAdmitAt < this.trickleMs || this.inflightCount() >= this.maxInflight)) continue
      try {
        const receipt = await this.deliver(occurrence)
        if (trickled) this.lastAdmitAt = this.now()
        if (occurrence.kind === 'return') {
          // A return has no run to watch: delivery is the whole outcome.
          const at = iso(this.now())
          this.db.prepare("UPDATE schedule_occurrences SET admitted=1, receipt=?, error=NULL, outcome='returned', started_at=?, finished_at=? WHERE key=?").run(JSON.stringify(receipt ?? {}), at, at, row.key)
        } else this.db.prepare("UPDATE schedule_occurrences SET admitted=1, receipt=?, error=NULL, outcome='running', finished_at=NULL WHERE key=?").run(JSON.stringify(receipt ?? {}), row.key)
      } catch (error) {
        // No arbitrary exception/body strings in state/API responses (they may contain credentials).
        this.db.prepare("UPDATE schedule_occurrences SET error=?, outcome='failed' WHERE key=?").run('Admission failed; will retry', row.key)
      }
    }
    await this.refreshRuns()
  }
  inflightCount() {
    // Unfinished scheduled agent work. A run never observed finishing stops counting after 6 h.
    return this.db.prepare(`SELECT count(*) AS n FROM schedule_occurrences WHERE admitted=1 AND finished_at IS NULL
      AND coalesce(json_extract(data,'$.kind'),'run') NOT IN ('remind','return') AND instant > ?`).get(this.now() - 6 * 3600_000).n
  }
  // The phone's reply watcher polls a run id. A Boomerang hands it `wzb_<job id>` at creation, so the same
  // native notification path tells the owner when the thread comes back. Never exposes a prompt: only the
  // owner's own note or message excerpt, which the owner wrote or chose.
  returnRun(runId) {
    if (typeof runId !== 'string' || !runId.startsWith(RETURN_RUN_PREFIX)) return null
    const jobId = runId.slice(RETURN_RUN_PREFIX.length)
    const row = this.db.prepare('SELECT data FROM schedules WHERE id=?').get(jobId)
    // Cancelled or already acknowledged: unknown to the watcher (404), which drops it without a notification.
    if (!row) return null
    const job = JSON.parse(row.data)
    if (job.kind !== 'return') return null
    const done = this.latest(job.id)
    // Only the occurrence for the current time counts: "Again" moves the time, and the earlier return must not re-notify.
    const returned = done?.admitted === 1 && done.outcome === 'returned' && Boolean(job.when?.once) && done.instant === Date.parse(job.when.once)
    const text = job.prompt || job.target?.excerpt || job.name
    return { id: runId, run_id: runId, session_id: job.thread, status: returned ? 'completed' : 'queued',
      output: returned ? `🪃 Back: ${text}` : '', ...(returned ? { completed_at: done.finished_at } : {}) }
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
  quiesce() { this.stopped = true; clearInterval(this.timer); this.timer = null; return Promise.all([this.inflight, this.refreshing]) }
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
      const input = { name: row.name || row.id, when, ...(row.timezone ? { timezone: row.timezone } : {}), agent: 'main',
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
  if (request.method === 'GET' || request.method === 'PATCH') await scheduler.refreshRuns()
  if (!suffix && request.method === 'GET') sendJson(response, 200, { schedules: scheduler.list().map(job => scheduler.project(job)) })
  else if (!suffix && request.method === 'POST') sendJson(response, 201, scheduler.project(scheduler.create(await readBody(request))))
  else if (suffix === '/import-hermes' && request.method === 'POST') sendJson(response, 200, importHermesSchedules(scheduler, await readBody(request)))
  else {
    const match = /^\/([A-Za-z0-9._:-]+)(\/run)?$/.exec(suffix)
    if (!match) throw fail('schedule route not found', 404)
    if (match[2] && request.method === 'POST') sendJson(response, 202, scheduler.runNow(match[1]))
    else if (!match[2] && request.method === 'PATCH') sendJson(response, 200, scheduler.project(scheduler.update(match[1], await readBody(request))))
    else if (!match[2] && request.method === 'DELETE') { scheduler.delete(match[1]); sendJson(response, 200, { deleted: true }) }
    else throw fail('method not allowed', 405)
  }
  return true
}
