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

export const AGENT_INBOX_SWITCH = 'wizard/agent-inbox'
// Worker runs admitted by capture carry this idempotency-key prefix, so the nightly check can find finished worker
// runs that have no record without reading the record first.
export const INBOX_RUN_PREFIX = 'wizard-inbox-'
export const INBOX_KINDS = new Set(['result', 'needs_you', 'alert', 'fyi', 'note'])
export const INBOX_STATES = new Set(['running', 'new', 'surfaced', 'answered', 'parked', 'archived', 'stale'])
export const NO_SUMMARY = 'Finished without a summary. Open it to read.'
export const STALE_NOTE = 'No news for 6 h.'
export const STALE_MS = 6 * 3600_000
const NIGHTLY_MS = 24 * 3600_000
// Finished worker runs older than this are not checked (their records may have been pruned on purpose).
export const CHECK_WINDOW_MS = 7 * 86400_000
const MAX_RECORDS = 3000
const ARCHIVE_KEEP_MS = 30 * 86400_000
const MAX_RUN_SIGS = 20
const MAX_OPTIONS = 6
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
      if (parsed?.schema === 1 && parsed.records && typeof parsed.records === 'object' && !Array.isArray(parsed.records)) this.data = { schema: 1, records: parsed.records, check: parsed.check ?? null }
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
  capture(input = {}) {
    const agent = input.agent || 'hermes'
    const thread = String(input.thread_id ?? '')
    if (!validAgentId(agent)) throw Object.assign(new Error('invalid agent'), { status: 400 })
    if (!THREAD_ID.test(thread)) throw Object.assign(new Error('invalid thread'), { status: 400 })
    const ask = clip(input.ask, 140)
    const title = clip(input.title || ask, 60)
    if (!title) throw Object.assign(new Error('title or ask required'), { status: 400 })
    const source = clip(typeof input.source === 'object' && input.source
      ? `app:${input.source.app ?? ''}/${input.source.item ?? ''}` : input.source || `thread:${thread}`, 200)
    const given = typeof input.dedupe_hash === 'string' && /^[a-f0-9]{16,64}$/u.test(input.dedupe_hash) ? input.dedupe_hash : ''
    const dedupe = given || hash(`${agent}\n${source.startsWith('thread:') ? '' : source}\n${(ask || title).toLowerCase()}`).slice(0, 32)
    const existing = Object.values(this.data.records).find(r => r.agent === agent && r.dedupe_hash === dedupe)
    if (existing) return { record: { ...existing }, created: false }
    const t = this.now()
    const record = {
      id: `inbox_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      agent, origin_item_id: input.origin_item_id ? clip(input.origin_item_id, 128) : null, thread_id: thread, source,
      kind: INBOX_KINDS.has(input.kind) ? input.kind : 'note', state: 'running',
      title, ask, last_update: ask, recommendation: '', options: {}, default_option: null,
      link: safeLink(input.link), deadline: null,
      severity: SEVERITIES.has(input.severity) ? input.severity : 'normal',
      privacy_class: input.privacy_class === 'general' ? 'general' : 'private',
      confirm: false, dedupe_hash: dedupe, surfaced_count: 0,
      created_at: t, updated_at: t, surfaced_at: null, answered_at: null, run_sigs: [],
    }
    withExtras(record, extrasOf(input))
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

  has(agent, thread) { return Object.values(this.data.records).some(r => r.agent === (agent || 'hermes') && r.thread_id === thread) }

  /** A worker run seen by the Service. Active runs change nothing; a finished run applies its status line (or the
   *  no-summary result). The same run output read again (list polls, history reads) is applied once.
   *  `continues`: more work is still on its way for this thread (another queued run, owed background work), so a
   *  fyi only updates `last_update`. `guard(status)`: the Service's heavy-work guard (done -> fyi while owed). */
  noteRun(agent, thread, run = {}, { continues = false, guard = s => s } = {}) {
    const record = typeof thread === 'string' && thread ? this.linked(agent, thread) : null
    if (!record) return null
    const status = String(run.status ?? '')
    if (!TERMINAL.has(status)) return null
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
      record.state = 'new'
      record.kind = 'result'
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
    record.last_update = status.ask
    record.updated_at = this.now()
    // Each status line carries its own decision: an earlier line's recommendation and answer tokens never stick to a
    // later one. The deadline is the task's (often set at capture), so it stays unless a line names a new one.
    Object.assign(record, { recommendation: '', options: {}, default_option: null, confirm: false })
    withExtras(record, extrasOf(raw))
    if (status.state === 'needs_you' || status.state === 'check') {
      record.state = 'new'; record.kind = 'needs_you'; record.ask = status.ask
    } else if (status.state === 'done') {
      record.state = 'new'; record.kind = 'result'
    } else if (final && !continues) {
      // A worker that ends on fyi with nothing still on its way has finished: an FYI for the sweep.
      record.state = 'new'; record.kind = 'fyi'
    } else if (record.state === 'stale') record.state = 'running' // news again
  }

  /** Running records with no update for 6 hours become `stale` ("no news for 6 h"). Returns their ids. */
  markStale(now = this.now()) {
    const ids = []
    for (const r of Object.values(this.data.records)) {
      if (r.state !== 'running' || now - (r.updated_at || 0) < STALE_MS) continue
      r.state = 'stale'; r.last_update = STALE_NOTE; r.stale_at = now
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
      .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)))
      .map(r => ({ ...r }))
  }

  /** Owner actions: answer (with an option token when the record has options), snooze, archive, surface. */
  patch(id, input = {}) {
    const record = RECORD_ID.test(String(id)) ? this.data.records[id] : null
    if (!record) return null
    const t = this.now()
    const action = String(input.action ?? '')
    if (action === 'answer') {
      const option = typeof input.option === 'string' ? input.option.trim().toLowerCase() : ''
      if (Object.keys(record.options || {}).length && !Object.hasOwn(record.options, option)) throw Object.assign(new Error('unknown option'), { status: 400 })
      record.state = 'answered'; record.answered_at = t; record.answer = option || null
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

  /** For tests and repair: drop one record. */
  remove(id) {
    if (!Object.hasOwn(this.data.records, id)) return false
    delete this.data.records[id]
    this.#save()
    return true
  }
}
