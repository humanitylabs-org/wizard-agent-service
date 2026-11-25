// Agent inbox (issue 549, step 1 of the agent inbox series; owner switch `wizard/agent-inbox`, off by default).
//
// One short record per background task. Capture creates it in state `running` before the worker starts, so a lost
// worker is visible. A worker never writes the inbox itself: the Service updates the record from the hidden
// WIZARD_STATUS_V1 line that ends each of the worker thread's turns (thread-status.mjs), and a finished turn with no
// parseable status line still turns the record into a result ("Finished without a summary"). Nothing is dropped.
// The sweep card, the Running view and alerts (later steps) read only this store.
//
// The store is a JSON file next to the Thread tracker ledger (state/wizard-mobile/agent-inbox.json in the Hermes
// home), so it lives in the agent's private data and inside the normal backup, and survives a Service restart.
// With the switch off the Service never calls a writing method and the routes answer 404.

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicStoreWrite, validAgentId } from './thread-reference.mjs'
import { normalizeStatus, parseStatusObject } from './thread-status.mjs'
import { planSweep, composeCard, cardView, yesToAllTargets, DEFAULT_LINKS } from './agent-sweep.mjs'

// Worker runs admitted by capture carry this idempotency-key prefix, so the nightly check can find finished worker
// runs that have no record without reading the record first.
export const INBOX_RUN_PREFIX = 'wizard-inbox-'
export const INBOX_KINDS = new Set(['result', 'needs_you', 'alert', 'fyi', 'note'])
export const INBOX_STATES = new Set(['running', 'new', 'surfaced', 'answered', 'parked', 'archived', 'stale'])
export const NO_SUMMARY = 'Finished without a summary. Open it to read.'
export const STALE_NOTE = 'No news for 6 h.'
// Stalls are failures (issue 607): a running task with no news for 6 h, or past its deadline, waits on the owner in
// Inbox, marked failed. A late status line from its worker still applies as usual.
export const STALLED_NOTE = 'Stalled: no news for 6 h. Open it to see what happened.'
export const LATE_NOTE = 'Stalled: past its deadline with no news. Open it to see what happened.'
export const START_FAILED = 'Could not start this task. Open it or say it again.'
export const SENT_NOTE = 'Sent here from Chats. Open it to read.'
export const ROUTE_EXAMPLES = 50
export const STALE_MS = 6 * 3600_000
const NIGHTLY_MS = 24 * 3600_000
// Finished worker runs older than this are not checked (their records may have been pruned on purpose).
export const CHECK_WINDOW_MS = 7 * 86400_000
const MAX_RECORDS = 3000
const ARCHIVE_KEEP_MS = 30 * 86400_000
const MAX_RUN_SIGS = 20
const MAX_SWEEPS = 10
const MAX_OPTIONS = 6
const MAX_ALERT_LOG = 200
// App doors (issue 569): a sweep any door asks for within this time of the newest card, from a door that has not drawn
// that card yet, draws the same card (one sweep event); the same door asking again, or later, is a new sweep.
export const SWEEP_SHARE_MS = 3600_000
export const DAILY_DOOR = 'daily'
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const MAX_DOOR_PINGS = 200
// An alert older than this is not pinged to a door any more (it waits in Alerts and the inbox as before).
const PING_WINDOW_MS = 2 * 86400_000
/** The door name of an app (its installed app id), kept apart from the Daily door. */
export const appDoor = app => (APP_ID.test(String(app ?? '')) ? `app:${app}` : '')
/** The app a record came from (`source` app:<id>/<item>), or '' for the orb, a thread, Chats or an alert rule. */
export const recordApp = record => /^app:([a-z0-9][a-z0-9._-]{0,63})\//u.exec(String(record?.source ?? ''))?.[1] || ''
const THREAD_ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/u
const RECORD_ID = /^inbox_[a-f0-9]{24}$/u
const TOKEN = /^[a-z][a-z0-9-]{0,19}$/u
const SEVERITIES = new Set(['low', 'normal', 'high', 'urgent'])
// Only a run in one of these states has finished; any other status (queued, started, running, a new alias) changes nothing.
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'expired', 'error', 'stopped', 'timed_out'])

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
const hash = value => createHash('sha256').update(value).digest('hex')
const isoOrNull = value => {
  if (value == null || value === '') return null
  const t = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null
}
const safeLink = value => {
  const link = String(value ?? '').trim()
  if (!link || link.length > 500) return null
  return /^\/(?!\/)/u.test(link) || /^https:\/\//iu.test(link) ? link : null
}
const cleanOptions = value => {
  const out = {}
  if (!value || typeof value !== 'object') return out
  const entries = Array.isArray(value) ? value.map(v => [v?.token ?? v?.id, v?.message ?? v?.text]) : Object.entries(value)
  for (const [rawToken, message] of entries) {
    const token = String(rawToken ?? '').trim().toLowerCase()
    const text = clip(message, 500)
    if (!TOKEN.test(token) || !text || Object.keys(out).length >= MAX_OPTIONS) continue
    out[token] = text
  }
  return out
}
// The optional keys a status line (or a capture) may carry beyond what the chat list reads.
const extrasOf = value => {
  const out = {}
  if (!value || typeof value !== 'object') return out
  if (value.recommendation != null) { const r = clip(value.recommendation, 200); if (r) out.recommendation = r }
  if (value.options != null) { const o = cleanOptions(value.options); if (Object.keys(o).length) out.options = o }
  if (typeof value.default_option === 'string') out.default_option = value.default_option.trim().toLowerCase()
  if (value.deadline != null) { const d = isoOrNull(value.deadline); if (d) out.deadline = d }
  if (typeof value.confirm === 'boolean') out.confirm = value.confirm
  return out
}
const withExtras = (record, extras) => {
  Object.assign(record, extras)
  if (record.default_option && !Object.hasOwn(record.options || {}, record.default_option)) record.default_option = null
}

/** The text of a record a model may read: none of a private record reaches a non-private model. */
export function textForModel(record, { privateModel = false } = {}) {
  if (!record || (record.privacy_class !== 'general' && !privateModel)) return null
  return { title: record.title, ask: record.ask, last_update: record.last_update, recommendation: record.recommendation || '' }
}

export class AgentInboxStore {
  constructor(path = '', { now = () => Date.now(), log = message => console.warn(message) } = {}) {
    this.path = path
    this.now = now
    this.log = log
    this.data = { schema: 1, records: {}, check: null }
    if (!path || !existsSync(path)) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed?.schema === 1 && parsed.records && typeof parsed.records === 'object' && !Array.isArray(parsed.records)) {
        this.data = { schema: 1, records: parsed.records, check: parsed.check ?? null, ...(Array.isArray(parsed.sweeps) ? { sweeps: parsed.sweeps } : {}) }
        // Alert rules (issue 552): the decision log and a pending "rules too loose" flag for the next sweep.
        if (Array.isArray(parsed.alert_log)) this.data.alert_log = parsed.alert_log
        if (parsed.rules_flag && typeof parsed.rules_flag === 'object') this.data.rules_flag = parsed.rules_flag
        // Open / Send to inbox taps (wizard-ux issue 1570): the orb router's few-shot examples, newest first.
        if (Array.isArray(parsed.route_examples)) this.data.route_examples = parsed.route_examples
        // App doors (issue 569): which app doors asked for alert pings, and the alerts each one was given.
        if (parsed.doors && typeof parsed.doors === 'object' && !Array.isArray(parsed.doors)) this.data.doors = parsed.doors
      }
    } catch { /* an unreadable store starts empty; the original bytes stay on disk until the next write */ }
  }

  #save() {
    const entries = Object.entries(this.data.records)
    const t = this.now()
    let records = entries.filter(([, r]) => !(r.state === 'archived' && t - (r.updated_at || 0) > ARCHIVE_KEEP_MS))
    if (records.length > MAX_RECORDS) {
      // Archived records go first, then the oldest; open work is the last thing dropped.
      records.sort((a, b) => Number(b[1].state !== 'archived') - Number(a[1].state !== 'archived') || (b[1].updated_at || 0) - (a[1].updated_at || 0))
      records = records.slice(0, MAX_RECORDS)
    }
    if (records.length !== entries.length) this.data.records = Object.fromEntries(records)
    if (!this.path) return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    atomicStoreWrite(this.path, JSON.stringify(this.data))
  }

  /** Capture: create the task's record in state `running` (before its worker starts). The same mail or ask
   *  (same dedupe hash) never makes a second record: the existing one is returned with created false. */
  capture(input = {}, { ready = false, fields = null } = {}) {
    const agent = input.agent || 'hermes'
    const thread = String(input.thread_id ?? '')
    if (!validAgentId(agent)) throw Object.assign(new Error('invalid agent'), { status: 400 })
    if (!THREAD_ID.test(thread)) throw Object.assign(new Error('invalid thread'), { status: 400 })
    const ask = clip(input.ask, 140)
    const title = clip(input.title || ask, 60)
    if (!title) throw Object.assign(new Error('title or ask required'), { status: 400 })
    const source = clip(typeof input.source === 'object' && input.source
      ? `app:${input.source.app ?? ''}/${input.source.item ?? input.source.item_id ?? ''}` : input.source || `thread:${thread}`, 200)
    const given = typeof input.dedupe_hash === 'string' && /^[a-f0-9]{16,64}$/u.test(input.dedupe_hash) ? input.dedupe_hash : ''
    const dedupe = given || hash(`${agent}\n${source.startsWith('thread:') ? '' : source}\n${(ask || title).toLowerCase()}`).slice(0, 32)
    const existing = Object.values(this.data.records).find(r => r.agent === agent && r.dedupe_hash === dedupe)
    if (existing) return { record: { ...existing }, created: false }
    const t = this.now()
    const record = {
      id: `inbox_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      agent, origin_item_id: input.origin_item_id ? clip(input.origin_item_id, 128) : null, thread_id: thread, source,
      kind: INBOX_KINDS.has(input.kind) ? input.kind : 'note', state: ready ? 'new' : 'running',
      title, ask, last_update: ask, recommendation: '', options: {}, default_option: null,
      link: safeLink(input.link), deadline: null,
      severity: SEVERITIES.has(input.severity) ? input.severity : 'normal',
      privacy_class: input.privacy_class === 'general' ? 'general' : 'private',
      confirm: false, dedupe_hash: dedupe, surfaced_count: 0,
      created_at: t, updated_at: t, surfaced_at: null, answered_at: null, run_sigs: [],
    }
    withExtras(record, extrasOf(input))
    // Service-set fields (issue 552: an event's alert decision); never from the request body.
    if (fields && typeof fields === 'object') Object.assign(record, structuredClone(fields))
    this.data.records[record.id] = record
    this.#save()
    return { record: { ...record }, created: true }
  }

  get(id) {
    this.markStale()
    const record = RECORD_ID.test(String(id)) ? this.data.records[id] : null
    return record ? { ...record } : null
  }

  /** The record a worker thread reports into: the newest one on that thread that is not archived. */
  linked(agent, thread) {
    let best = null
    for (const r of Object.values(this.data.records)) {
      if (r.agent !== (agent || 'hermes') || r.thread_id !== thread || r.state === 'archived') continue
      if (!best || r.created_at > best.created_at) best = r
    }
    return best
  }

  /** A captured task whose worker could not be started (issue 551): it is never lost, it waits on the owner. */
  startFailed(id, note = START_FAILED) {
    const record = RECORD_ID.test(String(id)) ? this.data.records[id] : null
    if (!record || record.state !== 'running') return null
    Object.assign(record, { state: 'new', kind: 'needs_you', last_update: clip(note, 140), updated_at: this.now() })
    this.#save()
    return { ...record }
  }

  /** The same task said again after its worker could not start: back to running, so the Service starts it again. */
  retryStart(id) {
    const record = RECORD_ID.test(String(id)) ? this.data.records[id] : null
    if (!record || record.state !== 'new' || record.kind !== 'needs_you' || record.last_update !== START_FAILED) return null
    Object.assign(record, { state: 'running', kind: 'note', last_update: record.ask, updated_at: this.now() })
    this.#save()
    return { ...record }
  }

  has(agent, thread) { return Object.values(this.data.records).some(r => r.agent === (agent || 'hermes') && r.thread_id === thread) }

  /** Hidden worker threads (issue 1569). Only a thread the Service started itself for a capture (`worker: true`, set
   *  before the thread exists) may be hidden, and never once the owner has typed in it: a thread the owner started or
   *  wrote in is his chat and always lists. An orb dump record written before `worker` existed is a worker too. */
  mayHide(agent, thread) {
    const records = Object.values(this.data.records).filter(r => r.agent === (agent || 'hermes') && r.thread_id === thread)
    return records.some(r => r.worker === true || r.source === 'orb:dump') && !records.some(r => r.owner_turn_at)
  }

  /** Send to inbox (wizard-ux issue 1570): the owner moves a visible thread into the background. The thread's record
   *  (or a new one) becomes a worker record the Service may hide (`worker: true`, every `owner_turn_at` cleared), so
   *  its next result reaches the sweep. `running`: a turn is still on its way, so the record waits for it; otherwise
   *  the thread is already done and waits in the inbox as a result. Returns the record. */
  sendToInbox(agent = 'hermes', thread = '', { title = '', ask = '', running = false } = {}) {
    if (!THREAD_ID.test(String(thread))) throw Object.assign(new Error('invalid thread'), { status: 400 })
    const dedupe = hash(`${agent}\nchats:send\n${thread}`).slice(0, 32)
    let record = this.linked(agent, thread) || Object.values(this.data.records).find(r => r.agent === agent && r.dedupe_hash === dedupe) || null
    if (!record) {
      record = this.data.records[this.capture({ agent, thread_id: thread, source: 'chats:send', kind: 'note', title: clip(title, 60) || clip(ask, 60) || 'Background task', ask, dedupe_hash: dedupe }, { fields: { worker: true } }).record.id]
    }
    const t = this.now()
    for (const r of Object.values(this.data.records)) if (r.agent === agent && r.thread_id === thread) delete r.owner_turn_at
    record.worker = true
    record.sent_at = t
    if (running) Object.assign(record, { state: 'running', kind: record.kind === 'needs_you' ? 'note' : record.kind })
    else Object.assign(record, { state: 'new', kind: 'result', last_update: SENT_NOTE })
    record.updated_at = t
    this.#save()
    return { ...record }
  }

  /** Open (wizard-ux issue 1570): the owner moves a hidden thread into the chat list. Like his own turn there, it is
   *  his chat from now on (`owner_turn_at`), so nothing hides it again until he sends it back. Returns its record. */
  openFromInbox(agent = 'hermes', thread = '') {
    const record = this.linked(agent, thread)
    this.ownerTurn(agent, thread)
    return record ? { ...this.data.records[record.id] } : null
  }

  /** One Open / Send to inbox tap as an example for the orb router (wizard-ux issue 1570): what was said (or the
   *  thread's first message), the route the orb chose and the route the owner wanted. Newest first, capped. */
  addRouteExample({ utterance = '', chosen = '', wanted = '', privacy_class = 'private' } = {}) {
    const text = clip(utterance, 200)
    const ok = route => route === 'agent' || route === 'dump'
    if (!text || !ok(chosen) || !ok(wanted) || chosen === wanted) return null
    // The id is the Sent row's correction_id (issue 607).
    const example = { id: `ex_${randomUUID().replaceAll('-', '').slice(0, 16)}`, at: this.now(), utterance: text, chosen, wanted, privacy_class: privacy_class === 'general' ? 'general' : 'private' }
    this.data.route_examples = [example, ...(Array.isArray(this.data.route_examples) ? this.data.route_examples : [])].slice(0, ROUTE_EXAMPLES)
    this.#save()
    return { ...example }
  }

  /** The newest correction of exactly these words (issue 607: an earlier correction routes them again), or null. */
  correctionFor(utterance = '') {
    const words = clip(utterance, 200).toLowerCase().replace(/[\s.!?…]+$/u, '')
    if (!words) return null
    const found = (Array.isArray(this.data.route_examples) ? this.data.route_examples : []).find(e => String(e.utterance || '').toLowerCase().replace(/[\s.!?…]+$/u, '') === words)
    return found ? { ...found } : null
  }

  /** The latest route examples, newest first. */
  routeExamples(limit = 8) {
    return (Array.isArray(this.data.route_examples) ? this.data.route_examples : []).slice(0, Math.max(0, Math.min(ROUTE_EXAMPLES, Number(limit) || 0))).map(e => ({ ...e }))
  }

  /** The owner typed in this thread: true when a record on it has not been told yet (the Service then shows the thread
   *  again and calls ownerTurn once that worked). */
  ownerTurnPending(agent, thread) {
    return Object.values(this.data.records).some(r => r.agent === (agent || 'hermes') && r.thread_id === thread && !r.owner_turn_at)
  }

  ownerTurn(agent, thread) {
    const t = this.now(), marked = []
    for (const r of Object.values(this.data.records)) {
      if (r.agent !== (agent || 'hermes') || r.thread_id !== thread || r.owner_turn_at) continue
      r.owner_turn_at = t
      marked.push({ ...r })
    }
    if (marked.length) this.#save()
    return marked
  }

  /** A worker run seen by the Service. Active runs change nothing; a finished run applies its status line (or the
   *  no-summary result). The same run output read again (list polls, history reads) is applied once.
   *  `continues`: more work is still on its way for this thread (another queued run, owed background work), so a
   *  fyi only updates `last_update`. `guard(status)`: the Service's heavy-work guard (done -> fyi while owed). */
  noteRun(agent, thread, run = {}, { continues = false, guard = s => s } = {}) {
    const record = typeof thread === 'string' && thread ? this.linked(agent, thread) : null
    if (!record) return null
    const status = String(run.status ?? '')
    if (!TERMINAL.has(status)) return null
    // Answered from the sweep card (issue 550): only the turn that carried the answer moves the record on. An earlier
    // turn that was still running when the owner answered finishes without touching it.
    if (record.state === 'answered' && record.answer_run && String(run.id ?? '') !== record.answer_run) return null
    const output = typeof run.output === 'string' ? run.output : ''
    const sig = hash(`${run.id ?? ''}\n${status}\n${output}`).slice(0, 24)
    if (record.run_sigs?.includes(sig)) return null
    record.run_sigs = [...(record.run_sigs || []), sig].slice(-MAX_RUN_SIGS)
    const raw = parseStatusObject(output)
    let parsed = raw ? normalizeStatus(raw) : null
    if (parsed) {
      const guarded = guard(parsed) || parsed
      this.#apply(record, guarded, raw, { final: true, continues: continues || guarded.state !== parsed.state })
    } else {
      // An answered record archives at the worker's next status line (issue 550); a run with none counts as one.
      record.state = record.state === 'answered' ? 'archived' : 'new'
      record.kind = 'result'
      delete record.failed
      record.last_update = NO_SUMMARY
      record.updated_at = this.now()
    }
    this.#save()
    return { ...record }
  }

  /** One status line on a linked thread that is not the end of a run (e.g. a progress line). */
  noteStatus(agent, thread, text, { continues = true } = {}) {
    const record = this.linked(agent, thread)
    const raw = parseStatusObject(text)
    const parsed = raw ? normalizeStatus(raw) : null
    if (!record || !parsed) return null
    this.#apply(record, parsed, raw, { final: false, continues })
    this.#save()
    return { ...record }
  }

  #apply(record, status, raw, { final, continues }) {
    const answered = record.state === 'answered'
    record.last_update = status.ask
    record.updated_at = this.now()
    // Each status line carries its own decision: an earlier line's recommendation and answer tokens never stick to a
    // later one. The deadline is the task's (often set at capture), so it stays unless a line names a new one.
    Object.assign(record, { recommendation: '', options: {}, default_option: null, confirm: false })
    withExtras(record, extrasOf(raw))
    // News from the worker: a stalled record is no longer failed (issue 607).
    const stalled = record.failed === true && Boolean(record.stale_at)
    delete record.failed
    // A line that asks the owner to confirm (send, book, buy, publish, delete) is never done: it waits on him.
    if (record.confirm === true && (status.state === 'done' || status.state === 'fyi')) status = { ...status, state: 'needs_you' }
    if (status.state === 'needs_you' || status.state === 'check') {
      record.state = 'new'; record.kind = 'needs_you'; record.ask = status.ask
      // A new question after an answer is a fresh ask: it starts its own sweep count.
      if (answered) { record.surfaced_count = 0; record.answer = null }
    } else if (answered) {
      // The worker's next status line after the owner's answer (issue 550): the record has done its job. A progress
      // line while the answer's turn is still running leaves it answered.
      if (final) record.state = 'archived'
    } else if (status.state === 'done') {
      record.state = 'new'; record.kind = 'result'
    } else if (final && !continues) {
      // A worker that ends on fyi with nothing still on its way has finished: an FYI for the sweep.
      record.state = 'new'; record.kind = 'fyi'
    } else if (record.state === 'stale') record.state = 'running' // news again
    else if (stalled) { record.state = 'running'; record.kind = 'note' } // a stalled task that sends progress runs again
  }

  /** Running records with no update for 6 hours, or past their deadline, have stalled: they fail and wait on the
   *  owner in Inbox (issue 607: `state` new, `kind` needs_you, `failed` true). Returns their ids. */
  markStale(now = this.now()) {
    const ids = []
    for (const r of Object.values(this.data.records)) {
      if (r.state !== 'running') continue
      const deadline = r.deadline ? Date.parse(r.deadline) : NaN
      const late = Number.isFinite(deadline) && now > deadline
      if (!late && now - (r.updated_at || 0) < STALE_MS) continue
      Object.assign(r, { state: 'new', kind: 'needs_you', failed: true, last_update: late ? LATE_NOTE : STALLED_NOTE, stale_at: now, updated_at: now })
      ids.push(r.id)
    }
    if (ids.length) this.#save()
    return ids
  }

  /** The nightly check: mark stale records, and count finished worker runs (`{agent, session_id, run_id,
   *  terminal_at}` in epoch seconds or ms) that have no record. The target is zero; a non-zero count is logged and
   *  kept in `check` for the next sweep. Runs at most once a day unless `force`. */
  nightly(now = this.now(), runs = [], { force = false } = {}) {
    const last = this.data.check?.at || 0
    if (!force && now - last < NIGHTLY_MS) return null
    const stale = this.markStale(now)
    const missing = []
    for (const run of Array.isArray(runs) ? runs : []) {
      const at = Number(run?.terminal_at) || 0
      const ms = at > 1e12 ? at : at * 1000
      if (!ms || now - ms > CHECK_WINDOW_MS) continue
      if (!this.has(run.agent || 'hermes', String(run.session_id ?? ''))) missing.push(String(run.run_id ?? run.session_id ?? ''))
    }
    this.data.check = { at: now, stale: stale.length, missing: missing.length, missing_runs: missing.slice(0, 20) }
    if (missing.length) this.log(`[agent-inbox] nightly check: ${missing.length} finished worker run(s) without an inbox record`)
    this.#save()
    return { ...this.data.check }
  }

  lastCheck() { return this.data.check ? { ...this.data.check } : null }

  list({ state = '', kind = '', agent = '', limit = 200 } = {}) {
    this.markStale()
    const states = String(state || '').split(',').filter(s => INBOX_STATES.has(s))
    return Object.values(this.data.records)
      .filter(r => (!states.length || states.includes(r.state)) && (!kind || r.kind === kind) && (!agent || r.agent === agent))
      // An urgent task (issue 607: the owner said "urgent" or "priority") sits at the top until it is archived.
      .sort((a, b) => Number(b.urgent === true && b.state !== 'archived') - Number(a.urgent === true && a.state !== 'archived') || b.updated_at - a.updated_at || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)))
      .map(r => ({ ...r }))
  }

  /** Owner actions: answer (with an option token when the record has options), snooze, archive, surface. */
  patch(id, input = {}) {
    const record = RECORD_ID.test(String(id)) ? this.data.records[id] : null
    if (!record) return null
    const t = this.now()
    const action = String(input.action ?? '')
    const option = typeof input.option === 'string' ? input.option.trim().toLowerCase() : ''
    // "Later" on the sweep card snoozes the item to the next sweep (issue 550), whatever tokens the record has.
    if (action === 'answer' && option === 'later') {
      record.state = 'new'; record.snoozed_at = t
    } else if (action === 'answer') {
      if (Object.keys(record.options || {}).length && !Object.hasOwn(record.options, option)) throw Object.assign(new Error('unknown option'), { status: 400 })
      record.state = 'answered'; record.answered_at = t; record.answer = option || null
      record.answer_run = typeof input.run_id === 'string' && input.run_id ? input.run_id.slice(0, 200) : null
    } else if (action === 'snooze') {
      record.state = 'new'; record.snoozed_at = t
    } else if (action === 'archive') {
      record.state = 'archived'
    } else if (action === 'surface') {
      record.state = record.state === 'new' ? 'surfaced' : record.state; record.surfaced_count = (record.surfaced_count || 0) + 1; record.surfaced_at = t
    } else throw Object.assign(new Error('unknown action'), { status: 400 })
    record.updated_at = t
    this.#save()
    return { ...record }
  }

  /** A signal sweep (issue 550): park items that sat on PARK_AFTER sweeps unanswered, pick what the card shows
   *  (caps in code), mark the shown Waiting items surfaced (one more sweep each), archive the shown Done items and
   *  the counted Later/FYI ones, and keep the card. Returns the stored card. */
  sweep({ id = '', thread_id = '', agent = 'hermes', day = '', links = DEFAULT_LINKS, door = DAILY_DOOR } = {}) {
    this.markStale()
    const t = this.now()
    const plan = planSweep(Object.values(this.data.records))
    const card = composeCard(plan, { id: id || `sweep_${randomUUID().replaceAll('-', '').slice(0, 24)}`, at: t, day, thread_id, agent, missing: this.data.check?.missing || 0, links, rulesFlag: this.data.rules_flag || null })
    // The doors that drew this card (issue 569); a card stored before doors existed was the Daily's.
    card.doors = [door]
    // The "rules too loose" flag rides on one sweep card, then it is done.
    delete this.data.rules_flag
    for (const r of plan.park) { r.state = 'parked'; r.parked_at = t; r.updated_at = t }
    for (const r of plan.waiting) { r.state = 'surfaced'; r.surfaced_count = (r.surfaced_count || 0) + 1; r.surfaced_at = t }
    for (const r of [...plan.done, ...plan.later]) { r.state = 'archived'; r.surfaced_at = t; r.updated_at = t }
    this.data.sweeps = [card, ...(Array.isArray(this.data.sweeps) ? this.data.sweeps : [])].slice(0, MAX_SWEEPS)
    this.#save()
    return structuredClone(card)
  }

  /** The newest card (optionally the newest one posted into `thread`), as stored. */
  latestSweep({ thread = '', agent = '' } = {}) {
    const card = (this.data.sweeps || []).find(c => (!thread || c.thread_id === thread) && (!agent || c.agent === agent)) || null
    // Only the newest card is live: an older card in another day's thread stays as it was.
    return card && card === this.data.sweeps[0] ? structuredClone(card) : null
  }

  /** A sweep asked for at one door (issue 569: Daily, an app such as Messenger, a typed or scheduled sweep). One
   *  sweep event serves every door: a door that has not drawn the newest card yet, asking within SWEEP_SHARE_MS of
   *  it, draws that same card, so surfacing, the age badge, parking and archiving happen once per event, never once
   *  per door. The same door asking again (or any door later) is a new sweep. The Daily door gives the card its
   *  thread when it draws a card an app door made. Returns `{ card, shared }`. */
  drawSweep({ door = DAILY_DOOR, thread_id = '', agent = 'hermes', day = '', links = DEFAULT_LINKS, shareMs = SWEEP_SHARE_MS } = {}) {
    const newest = Array.isArray(this.data.sweeps) ? this.data.sweeps[0] : null
    const doors = newest ? (Array.isArray(newest.doors) ? newest.doors : [DAILY_DOOR]) : []
    if (newest && !doors.includes(door) && this.now() - (newest.at || 0) < shareMs && (door !== DAILY_DOOR || !newest.thread_id || newest.thread_id === thread_id)) {
      newest.doors = [...doors, door]
      if (door === DAILY_DOOR && !newest.thread_id) Object.assign(newest, { thread_id, agent, day: day || newest.day })
      this.#save()
      return { card: structuredClone(newest), shared: true }
    }
    return { card: this.sweep({ thread_id, agent, day, links, door }), shared: false }
  }

  /** The stored cards one door drew, newest first. */
  doorCards(door) {
    return (this.data.sweeps || []).filter(c => (Array.isArray(c.doors) ? c.doors : [DAILY_DOOR]).includes(door)).map(c => structuredClone(c))
  }

  /** Whether an app door may answer this record (issue 569): it is still a Waiting item, it is on a card that door
   *  drew, and it did not come from another app. */
  doorMayAnswer(door, id) {
    const record = RECORD_ID.test(String(id)) ? this.data.records[id] : null
    if (!record) return false
    const app = recordApp(record)
    if (app && appDoor(app) !== door) return false
    // Only while it is still waiting: an answered, finished, archived or parked item is never answered (or reopened
    // by Later) again from an app door.
    if (record.kind !== 'needs_you' || (record.state !== 'new' && record.state !== 'surfaced')) return false
    return this.doorCards(door).some(c => (c.waiting?.items || []).some(item => item.id === id))
  }

  /** An app door's state: `{ pings, pings_since }` (null when it never registered). */
  door(door) { const d = this.data.doors?.[door]; return d ? { pings: d.pings === true, pings_since: d.pings_since || null } : null }

  /** An app door asks for (or stops) urgent alert pings. Alerts delivered before it asked are never pinged to it. */
  registerDoor(door, { pings = false } = {}) {
    if (!door.startsWith('app:')) throw Object.assign(new Error('invalid door'), { status: 400 })
    const doorsNow = this.data.doors && typeof this.data.doors === 'object' ? this.data.doors : {}
    const current = doorsNow[door] || {}
    const on = pings === true
    const next = { ...current, pings: on, pings_since: on ? (current.pings === true && current.pings_since ? current.pings_since : this.now()) : null, pinged: Array.isArray(current.pinged) ? current.pinged : [] }
    this.data.doors = { ...doorsNow, [door]: next }
    this.#save()
    return this.door(door)
  }

  /** The urgent alerts this door has not acknowledged yet, oldest first. Reading them changes nothing: a door marks
   *  each one delivered with `ackPings` only after it has stored it, so a crash or a lost answer between the read and
   *  the store never loses an urgent alert (issue 325). The urgency was decided once by the alert rules (issue 552):
   *  this only delivers what they already sent to Alerts. */
  pendingPings(door) {
    const d = this.data.doors?.[door]
    if (!d?.pings) return []
    const given = new Set(Array.isArray(d.pinged) ? d.pinged : [])
    return Object.values(this.data.records)
      .filter(r => r.kind === 'alert' && r.alert_delivered === true && (r.created_at || 0) >= (d.pings_since || 0) && this.now() - (r.created_at || 0) < PING_WINDOW_MS && !given.has(r.id))
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .map(r => ({ id: r.id, title: r.title, ask: r.ask, severity: r.severity, link: r.link, at: r.created_at }))
  }

  /** A door says it has stored these pings: each is handed out once per door, ever. Ids that are not pending for the
   *  door are ignored. Returns the ids it marked. */
  ackPings(door, ids) {
    const d = this.data.doors?.[door]
    if (!d?.pings || !Array.isArray(ids)) return []
    const pending = new Set(this.pendingPings(door).map(p => p.id))
    const marked = [...new Set(ids.filter(id => typeof id === 'string' && pending.has(id)))]
    if (!marked.length) return []
    d.pinged = [...(Array.isArray(d.pinged) ? d.pinged : []), ...marked].slice(-MAX_DOOR_PINGS)
    this.#save()
    return marked
  }

  /** Read and acknowledge in one step (the store-level shortcut for callers that keep the pings themselves). */
  takePings(door) {
    const fresh = this.pendingPings(door)
    this.ackPings(door, fresh.map(p => p.id))
    return fresh
  }

  sweepCard(id) { const card = (this.data.sweeps || []).find(c => c.id === id); return card ? structuredClone(card) : null }

  /** The card with each Waiting item's current state and answer. */
  sweepView(card) { return cardView(card, rid => this.data.records[rid] ? { ...this.data.records[rid] } : null) }

  /** What Yes to all would answer on this card: `[{ id, option }]` (never confirm items, never hidden ones). */
  yesToAll(cardId) {
    const card = this.sweepCard(cardId)
    return card ? yesToAllTargets(card, rid => this.data.records[rid] ? { ...this.data.records[rid] } : null) : null
  }

  /** Service-side field changes on one record (issue 552: alert decisions and feedback). Returns the record. */
  update(id, fields = {}) {
    const record = RECORD_ID.test(String(id)) ? this.data.records[id] : null
    if (!record) return null
    Object.assign(record, structuredClone(fields), { updated_at: this.now() })
    this.#save()
    return { ...record }
  }

  /** The record captured for one source dedupe hash, if any. */
  byDedupe(agent, dedupe) {
    const record = Object.values(this.data.records).find(r => r.agent === (agent || 'hermes') && r.dedupe_hash === dedupe)
    return record ? { ...record } : null
  }

  /** Alerts delivered on one alert day (issue 552), oldest first; `collapsed` picks the day's one collapsed alert. */
  alertsOfDay(day, { collapsed = false } = {}) {
    return Object.values(this.data.records)
      .filter(r => r.alert_day === day && r.alert_delivered === true && (r.alert_collapsed === true) === collapsed)
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)).map(r => ({ ...r }))
  }

  /** An alert record only while the day is under its cap (issue 552): the count and the write are one step, so two
   *  alerts decided at the same moment can never both pass the cap. Over the cap -> null (nothing written). */
  captureAlertUnderCap(day, cap, input, { fields = null } = {}) {
    if (this.alertsOfDay(day).length >= cap) return null
    return this.capture({ ...input, kind: 'alert' }, { ready: true, fields: { ...(fields || {}), alert_day: day, alert_delivered: true } })
  }

  /** One alert decision (issue 552): kept newest first, capped. No record text, only ids, stage and the reason. */
  logAlert(entry) {
    this.data.alert_log = [{ at: this.now(), ...entry }, ...(Array.isArray(this.data.alert_log) ? this.data.alert_log : [])].slice(0, MAX_ALERT_LOG)
    this.#save()
  }

  alertLog(limit = 50) { return (this.data.alert_log || []).slice(0, Math.max(1, Math.min(MAX_ALERT_LOG, Number(limit) || 50))).map(e => ({ ...e })) }

  /** The volume guard tripped (issue 552): the next sweep card says the rules let too much through. */
  flagRules(flag) {
    this.data.rules_flag = { ...flag, at: this.now() }
    this.#save()
  }

  rulesFlag() { return this.data.rules_flag ? { ...this.data.rules_flag } : null }

  /** For tests and repair: drop one record. */
  remove(id) {
    if (!Object.hasOwn(this.data.records, id)) return false
    delete this.data.records[id]
    this.#save()
    return true
  }
}
