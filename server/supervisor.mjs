import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SUPERVISOR_SPELL = `When the owner says "report this to supervisor", "tell the supervisor" or "send this to supervisor":
Call supervisor_report: what happened (at most 400 words), the owner's feedback verbatim, evidence (paths, commands, excerpts, thread links), and a proposed_home (skill, standing rule or regression test).
Do not implement the protocol/process fix yourself; fix only your immediate output if the owner asked.
Say in one line that it went to the Supervisor, then continue your task.
Private or siloed agents cannot send reports in this release: respect the privacy seal and explain the refusal.`

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const text = (value, max, field, optional = false) => {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`invalid ${field}`)
  return value // Preserve the owner's words verbatim, including whitespace.
}
const terminal = run => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run?.status)
const uid = prefix => `${prefix}_${randomUUID()}`
// Wizard thread titles are "Project · Feature" within 32 characters. The service shortens, never a model;
// report/build titles (60 chars) stay intact in the ledger, only the thread label is fitted.
export const THREAD_TITLE_MAX = 32
const PREFIX = 'Supervisor · '
const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'with', 'too'])
const tidy = value => value.replace(/[\s.,;:!?·\-—–(]+$/u, '').trim()
function fitTopic(topic, room) {
  let t = String(topic ?? '').replace(/\s+/g, ' ').trim().replace(/^supervisor\s*[·:]\s*/iu, '').trim()
  const head = t.split(/:| - | — |,|\(/u)[0].trim()
  if (tidy(head)) t = head
  t = tidy(t)
  if (!t) return ''
  const words = []
  for (const word of t.split(' ')) { if ([...words, word].join(' ').length > room) break; words.push(word) }
  while (words.length && STOP.has(words.at(-1).toLowerCase().replace(/[^\p{L}]/gu, ''))) words.pop()
  return tidy(words.join(' ')) || t.split(' ')[0].slice(0, room)
}
export function supervisorThreadTitle(topic) {
  return PREFIX + (fitTopic(topic, THREAD_TITLE_MAX - PREFIX.length) || 'Review')
}
/** Builder briefs may carry their own "Project · Feature" title; fit it to the same 32-character rule. */
export function builderThreadTitle(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim()
  if (/^supervisor\s*[·:]/iu.test(t) || !t.includes(' · ')) return supervisorThreadTitle(t)
  const [project, ...rest] = t.split(' · ')
  const p = project.trim().slice(0, 16)
  const feature = fitTopic(rest.join(' · '), THREAD_TITLE_MAX - p.length - 3)
  return feature ? `${p} · ${feature}` : supervisorThreadTitle(t)
}
const PRIVATE = 'Supervisor refuses private or siloed agents (privacy-seal exemption); nothing was shared.'
export { PRIVATE as SUPERVISOR_PRIVATE_REFUSAL }

/** SQLite ledger + durable outbox. Transport always queues ordinary runs, never steers.
 * Identity is trusted service context, not report arguments. One service owns this DB. */
export class Supervisor {
  constructor({ statePath, deliver, lookup = async () => null, canReadSource = () => true, now = Date.now, intervalMs = 15_000 }) {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(statePath); chmodSync(statePath, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, agent TEXT, thread TEXT, client TEXT, data TEXT, UNIQUE(agent,thread,client));
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, report TEXT, thread TEXT UNIQUE, state TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, review TEXT, deadline INTEGER, state TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS builds(id TEXT PRIMARY KEY, review TEXT, thread TEXT UNIQUE, state TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS outcomes(review TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE IF NOT EXISTS supervisor_outbox(key TEXT PRIMARY KEY, data TEXT, receipt TEXT);`)
    Object.assign(this, { deliver, lookup, canReadSource, now, intervalMs, stopped: false })
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  rows(table) { return this.db.prepare(`SELECT * FROM ${table}`).all() }
  reportBy(id) { const row = this.db.prepare('SELECT data FROM reports WHERE id=?').get(id); return row ? JSON.parse(row.data) : null }
  reviewBy(id) { return this.db.prepare('SELECT * FROM reviews WHERE id=?').get(id) }
  context(caller) {
    if (!caller || caller.privacy !== 'shareable') fail(PRIVATE, 403)
    if (!caller.agent_id || !caller.thread_id || !caller.run_id) fail('An authenticated active Wizard run is required', 409)
    const review = this.db.prepare('SELECT * FROM reviews WHERE thread=?').get(caller.thread_id)
    if (review && caller.agent_id === 'hermes') return { review, role: 'review' }
    const build = this.db.prepare('SELECT * FROM builds WHERE thread=?').get(caller.thread_id)
    if (build && caller.agent_id === 'hermes') return { review: this.reviewBy(build.review), role: 'builder', build }
    return { review: null, role: 'worker' }
  }
  requireReview(caller) {
    const c = this.context(caller)
    if (c.role !== 'review' || c.review.state !== 'open') fail('This tool requires an open Supervisor review thread', 403)
    return c.review
  }
  enqueue(key, { agent = 'hermes', thread, input, title = '', createThread = false }) {
    this.db.prepare('INSERT OR IGNORE INTO supervisor_outbox VALUES(?,?,NULL)').run(key, JSON.stringify({ key, agent, thread, title, createThread,
      body: { session_id: thread, input } }))
  }
  wake(review, key, value) {
    if (review?.state !== 'open') return
    this.enqueue(key, { thread: review.thread, input: `[supervisor update]\n${JSON.stringify(value)}` })
  }
  promote() {
    let open = this.db.prepare("SELECT count(*) AS n FROM reviews WHERE state='open'").get().n
    for (const review of this.db.prepare("SELECT * FROM reviews WHERE state='queued' ORDER BY rowid").all()) {
      if (open >= 2) break
      this.db.prepare("UPDATE reviews SET state='open' WHERE id=?").run(review.id)
      this.enqueue(`supervisor-review:${review.id}`, { thread: review.thread, title: supervisorThreadTitle(this.reportBy(review.report).title), createThread: true,
        input: `[supervisor review]\nLoad and follow the skill "supervisor".\n${JSON.stringify(this.reportBy(review.report))}` })
      open++
    }
  }
  report(args, caller) {
    const context = this.context(caller)
    const kind = args.kind ?? 'feedback'
    if (!['feedback', 'completion', 'answer'].includes(kind)) fail('invalid kind')
    const client = text(args.client_report_id, 160, 'client_report_id')
    // The sole suppression key is scoped to the calling agent and thread. No fuzzy dedupe.
    const previous = this.db.prepare('SELECT data FROM reports WHERE agent=? AND thread=? AND client=?').get(caller.agent_id, caller.thread_id, client)
    if (previous) return { report: JSON.parse(previous.data), suppressed: true }
    const title = text(args.title, 60, 'title')
    const happened = text(args.what_happened, 16000, 'what_happened')
    if (happened.trim().split(/\s+/).length > 400) fail('what_happened must be at most 400 words')
    const feedback = text(args.feedback_verbatim, 16000, 'feedback_verbatim', kind !== 'feedback')
    if (kind === 'feedback' && (!Array.isArray(args.evidence) || !args.evidence.length)) fail('feedback requires evidence')
    const evidence = args.evidence ?? []
    if (!Array.isArray(evidence) || evidence.length > 30) fail('invalid evidence')
    for (const e of evidence) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) fail('invalid evidence')
      text(e.type, 80, 'evidence type'); text(e.ref, 2000, 'evidence ref'); text(e.excerpt, 8000, 'evidence excerpt', true)
    }
    const report = { id: uid('report'), kind, depth: context.review ? 1 : 0, parent_id: context.review?.id ?? null,
      agent_id: caller.agent_id, thread_id: caller.thread_id, run_id: caller.run_id, created_at: new Date(this.now()).toISOString(),
      title, what_happened: happened, feedback_verbatim: feedback, evidence, proposed_home: text(args.proposed_home, 2000, 'proposed_home', true),
      privacy: 'shareable', client_report_id: client }
    // An answer without a question binding is not allowed to spawn a review.
    if (kind === 'answer') fail('Use supervisor_answer with the question_id', 409)
    if (kind === 'completion' && context.role !== 'builder') fail('A completion must come from a Supervisor builder thread', 403)
    this.transaction(() => {
      this.db.prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(report.id, caller.agent_id, caller.thread_id, client, JSON.stringify(report))
      if (context.review) {
        if (context.build && kind === 'completion') this.db.prepare("UPDATE builds SET state='reported' WHERE id=?").run(context.build.id)
        this.wake(context.review, `supervisor-report:${report.id}`, { report })
      } else {
        const review = { id: uid('review'), report: report.id, thread: uid('wizard_supervisor'), state: 'queued' }
        this.db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?)').run(review.id, report.id, review.thread, review.state, '{}')
        this.promote()
      }
    })
    return { report, suppressed: false }
  }
  ask(args, caller) {
    const review = this.requireReview(caller)
    const question = text(args.question, 8000, 'question')
    return this.transaction(() => {
      if (this.db.prepare('SELECT count(*) AS n FROM questions WHERE review=?').get(review.id).n >= 2) fail('At most two questions per review', 409)
      const origin = this.reportBy(review.report)
      const q = { id: uid('question'), question, agent: origin.agent_id, thread: origin.thread_id }
      this.db.prepare('INSERT INTO questions VALUES(?,?,?,?,?)').run(q.id, review.id, this.now() + 30 * 60_000, 'waiting', JSON.stringify(q))
      this.enqueue(`supervisor-question:${q.id}`, { agent: q.agent, thread: q.thread,
        input: `[supervisor question]\n${question}\nAnswer using supervisor_answer with question_id=${q.id}. Continue your own task afterward.` })
      return { question_id: q.id }
    })
  }
  answer(args, caller) {
    this.context(caller)
    const q = this.db.prepare('SELECT * FROM questions WHERE id=?').get(String(args.question_id || ''))
    if (!q) fail('question not found', 404)
    const saved = JSON.parse(q.data)
    if (saved.agent !== caller.agent_id || saved.thread !== caller.thread_id) fail('Question belongs to another worker thread', 403)
    const answer = text(args.answer, 16000, 'answer')
    if (q.state !== 'waiting') return { answered: false, state: q.state }
    this.transaction(() => {
      this.db.prepare("UPDATE questions SET state='answered', data=? WHERE id=?").run(JSON.stringify({ ...saved, answer, run_id: caller.run_id }), q.id)
      const report = { id: uid('report'), kind: 'answer', depth: 1, parent_id: q.review, agent_id: caller.agent_id,
        thread_id: caller.thread_id, run_id: caller.run_id, created_at: new Date(this.now()).toISOString(), title: 'Answer to Supervisor',
        what_happened: answer, feedback_verbatim: '', evidence: [{ type: 'question', ref: q.id }], proposed_home: '', privacy: 'shareable', client_report_id: `answer:${q.id}` }
      this.db.prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(report.id, caller.agent_id, caller.thread_id, report.client_report_id, JSON.stringify(report))
      this.wake(this.reviewBy(q.review), `supervisor-answer:${q.id}`, { question_id: q.id, answer })
    })
    return { answered: true }
  }
  build(args, caller) {
    const review = this.requireReview(caller)
    const b = { id: uid('build'), title: text(args.title, 60, 'title'), brief: text(args.brief, 32000, 'brief'), thread: uid('wizard_builder') }
    this.transaction(() => {
      this.db.prepare('INSERT INTO builds VALUES(?,?,?,?,?)').run(b.id, review.id, b.thread, 'running', JSON.stringify(b))
      this.enqueue(`supervisor-build:${b.id}`, { thread: b.thread, title: builderThreadTitle(b.title), createThread: true,
        input: `[supervisor build]\n${b.brief}\nWhen finished, call supervisor_report with kind=completion summarising what shipped, where, and how you verified it.` })
    })
    return { build_id: b.id, thread: b.thread }
  }
  lessons(args, caller) {
    // Reports are shared with the main review, not with every standard worker.
    this.requireReview(caller)
    const query = text(args.query, 200, 'query', true).toLowerCase().trim().split(/\s+/).filter(Boolean)
    const matches = this.rows('reviews').flatMap(r => {
      const report = this.reportBy(r.report)
      // Consult current grants/seals, not the source's admission-time privacy.
      if (!this.canReadSource(report.agent_id)) return []
      const outcome = this.db.prepare('SELECT data FROM outcomes WHERE review=?').get(r.id)
      if (!outcome) return []
      const item = { review_id: r.id, thread: r.thread, report, outcome: JSON.parse(outcome.data) }
      return query.every(w => JSON.stringify(item).toLowerCase().includes(w)) ? [item] : []
    })
    const lessons = []
    for (const item of matches.reverse()) {
      // Search full evidence, but return an index, not megabytes of transcripts.
      const r = item.report
      const next = { ...item, report: { id: r.id, title: r.title, agent_id: r.agent_id, thread_id: r.thread_id,
        what_happened: r.what_happened.slice(0, 800), feedback_verbatim: r.feedback_verbatim.slice(0, 400) } }
      if (lessons.length >= 50 || Buffer.byteLength(JSON.stringify([...lessons, next]), 'utf8') > 64 * 1024) break
      lessons.push(next)
    }
    return { lessons, total: matches.length, truncated: lessons.length < matches.length,
      ...(lessons.length < matches.length ? { hint: 'Narrow the query to see remaining lessons.' } : {}) }
  }
  closeReview(args, caller) {
    const c = this.context(caller)
    if (c.role !== 'review') fail('This tool requires a Supervisor review thread', 403)
    const review = c.review
    if (review.state === 'closed') return { closed: true, repeated: true }
    const outcome = args.outcome
    if (!['shipped', 'covered', 'needs_you'].includes(outcome)) fail('invalid outcome')
    const home = text(args.home, 2000, 'home')
    const summary = text(args.summary, 800, 'summary')
    if (/[\r\n]/.test(summary) || /[\r\n]/.test(home)) fail('closing summary and home must each be one plain line')
    const covered = args.covered_by ? this.reviewBy(args.covered_by) : null
    if (outcome === 'covered' && (!covered || covered.state !== 'closed' || covered.id === review.id)) fail('covered_by must name an earlier closed review')
    const origin = this.reportBy(review.report)
    this.transaction(() => {
      this.db.prepare('INSERT INTO outcomes VALUES(?,?)').run(review.id, JSON.stringify({ outcome, home, summary, covered_by: covered?.id ?? null, created_at: new Date(this.now()).toISOString() }))
      this.db.prepare("UPDATE reviews SET state='closed' WHERE id=?").run(review.id)
      // Existing internal_notification is an ingress event, hidden rather than a visible assistant notice.
      // Use the specified fallback: an ordinary, idle-boundary, exactly-one-line run in the origin thread.
      this.enqueue(`supervisor-close:${review.id}`, { agent: origin.agent_id, thread: origin.thread_id,
        input: `[supervisor closed]\nReply with exactly this one line, nothing else:\n${summary} Home: ${home}` })
      this.promote()
    })
    return { closed: true }
  }
  async tick() {
    if (this.stopped) return
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      this.transaction(() => {
        for (const q of this.db.prepare("SELECT * FROM questions WHERE state='waiting' AND deadline<=?").all(this.now())) {
          this.db.prepare("UPDATE questions SET state='timeout' WHERE id=?").run(q.id)
          this.wake(this.reviewBy(q.review), `supervisor-answer:${q.id}`, { question_id: q.id, answer: 'no answer' })
        }
        this.promote()
      })
      for (const b of this.db.prepare("SELECT * FROM builds WHERE state='running'").all()) {
        const out = this.db.prepare('SELECT receipt FROM supervisor_outbox WHERE key=?').get(`supervisor-build:${b.id}`)
        if (!out?.receipt) continue
        try {
          const run = await this.lookup({ agent: 'hermes', thread: b.thread }, JSON.parse(out.receipt))
          // Completion report may arrive during the lookup; re-read before marking a missing report.
          if (terminal(run) && this.db.prepare('SELECT state FROM builds WHERE id=?').get(b.id)?.state === 'running') this.transaction(() => {
            this.db.prepare("UPDATE builds SET state='ended' WHERE id=?").run(b.id)
            this.wake(this.reviewBy(b.review), `supervisor-build-ended:${b.id}`, { build_id: b.id, status: run.status, output: run.output || '', message: 'Builder run ended without reporting.' })
          })
        } catch { /* preserve for retry */ }
      }
      for (const row of this.db.prepare('SELECT * FROM supervisor_outbox WHERE receipt IS NULL ORDER BY rowid').all()) {
        if (this.stopped) break
        try {
          const receipt = await this.deliver(JSON.parse(row.data))
          if (!receipt?.run_id) throw new Error('admission missing run')
          this.db.prepare('UPDATE supervisor_outbox SET receipt=? WHERE key=?').run(JSON.stringify(receipt), row.key)
        } catch { /* Durable frozen input + stable idempotency key survive ambiguous admission. */ }
      }
    })().finally(() => { this.inflight = null })
    return this.inflight
  }
  start() {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.tick().catch(() => console.error('[supervisor] tick failed')) }, this.intervalMs)
    this.timer.unref?.(); void this.tick().catch(() => console.error('[supervisor] initial tick failed'))
  }
  async quiesce() { this.stopped = true; clearInterval(this.timer); await this.inflight }
  async close() { await this.quiesce(); this.db.close() }
  call(action, args, caller) {
    const methods = { report: 'report', ask: 'ask', answer: 'answer', build: 'build', lessons: 'lessons', close: 'closeReview' }
    if (!methods[action]) fail('Supervisor tool not found', 404)
    // Refuse forged identity/depth/parent fields even outside a schema-aware client.
    for (const k of ['id', 'agent_id', 'thread_id', 'run_id', 'depth', 'parent_id', 'privacy']) if (Object.hasOwn(args, k)) fail(`service-owned field: ${k}`)
    return this[methods[action]](args, caller)
  }
}
