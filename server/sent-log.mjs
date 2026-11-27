// Sent log (issue 607; owner switch `wizard/agent-inbox`, off by default). One row per capture the owner sends (an orb
// take, the side button, a new chat, a typed first message), written BEFORE the router runs, so a router that throws,
// hangs or is missing still leaves a row (with `decided_by: fallback`). Each row says where the take went and why:
// `route` dump | agent | command | reminder, `decided_by` owner_words | model | correction | fallback, the reply rules
// that matched, the model, its confidence, the tags. A typed first message always opens its visible thread; its row
// also keeps `would_route`, what the router would have done, so a trial shows whether typed messages could route too.
// The row's state (running, done, needs_you, failed) is read live from the inbox record or the thread, never stored
// here; the nightly check flags rows that still have no final state after SENT_FINAL_MS.
//
// The log is a JSON file next to the agent inbox store (state/wizard-mobile/sent-log.json in the Hermes home): the
// owner's own words, kept in the agent's private data and in the normal backup. With the switch off nothing writes it
// and its routes answer 404.

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicStoreWrite, validAgentId } from './thread-reference.mjs'
import { CHOSEN_BY } from './private-routing.mjs'

// `reply`: a message the owner sent inside an existing thread (wizard-ux issue 1808), route `thread`.
export const SENT_SOURCES = new Set(['orb', 'side', 'new_chat', 'typed', 'reply'])
export const SENT_ROUTES = new Set(['dump', 'agent', 'command', 'reminder', 'thread'])
// The agent's final status on a reply's run, as the row keeps it (`failed`: the run itself failed).
const OUTCOMES = new Set(['done', 'fyi', 'needs_you', 'check', 'failed', 'none'])
// A reply needs nothing from the owner: his words asked for no answer and the agent ended done or fyi.
const QUIET_OUTCOMES = new Set(['done', 'fyi'])
export const SENT_DECIDERS = new Set(['owner_words', 'model', 'correction', 'fallback'])
export const SENT_STATES = new Set(['routing', 'running', 'done', 'needs_you', 'failed', 'unknown'])
// A state the row can rest in: the take ran to an end, or it is waiting on the owner.
export const FINAL_STATES = new Set(['done', 'needs_you', 'failed'])
// The same words again without an idempotency key within this time are the same capture (the shell's quick command
// try and its outbox both ask the router for one take).
export const SENT_REPEAT_MS = 60_000
// A new thread's first owner turn within this time of an orb row with the same words is that row's visible thread.
export const SENT_LINK_MS = 10 * 60_000
// The nightly check flags a row still without a final state this long after it was sent.
export const SENT_FINAL_MS = 6 * 3600_000
const CHECK_WINDOW_MS = 7 * 86400_000
const NIGHTLY_MS = 24 * 3600_000
const MAX_ROWS = 2000
const MAX_TEXT = 2000
const ROW_ID = /^sent_[a-f0-9]{24}$/u
const KEY = /^[A-Za-z0-9._:-]{1,200}$/u
const THREAD_ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/u
const RECORD_ID = /^inbox_[a-f0-9]{24}$/u

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
/** The owner's words without the Service's marker blocks: a spoken turn carries its recording as a [WIZARD_FILES_V1]
 *  block (issue 707), which is never part of what he said (a clipped block has no closing tag). */
export const withoutMarkers = value => String(value ?? '').replace(/\[(WIZARD_[A-Z0-9_]+_V1)\][\s\S]*?(?:\[\/\1\]|$)/gu, ' ').replace(/\s+/gu, ' ').trim()
/** Words compared for "the same take": case, spacing and closing punctuation do not count. */
export const sameWords = value => String(value ?? '').toLowerCase().replace(/\s+/gu, ' ').replace(/[\s.!?…]+$/u, '').trim()
const cleanTags = value => [...new Set((Array.isArray(value) ? value : []).map(t => String(t ?? '').toLowerCase().trim()).filter(t => /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u.test(t)))].slice(0, 8)
const cleanRules = value => (Array.isArray(value) ? value : []).map(r => clip(r, 80)).filter(Boolean).slice(0, 12)

export class SentLog {
  constructor(path = '', { now = () => Date.now(), log = message => console.warn(message) } = {}) {
    this.path = path
    this.now = now
    this.log = log
    this.data = { schema: 1, rows: [], check: null }
    if (!path || !existsSync(path)) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed?.schema === 1 && Array.isArray(parsed.rows)) this.data = { schema: 1, rows: parsed.rows.filter(r => r && ROW_ID.test(String(r.id))), check: parsed.check ?? null }
      // Smart inbox (issue 667): the runs that ended needing nothing from the owner, beyond what the reply rows say.
      if (Array.isArray(parsed?.quiet_runs)) this.data.quiet_runs = parsed.quiet_runs.filter(q => q && THREAD_ID.test(String(q.thread)) && KEY.test(String(q.run)))
    } catch { /* an unreadable log starts empty; the original bytes stay on disk until the next write */ }
    if (this.#repairSpoken()) this.#save()
  }

  /** Issue 707: before the fix, a spoken orb take that opened a new chat wrote two rows: the orb's, with no thread, and
   *  the new chat's (source new_chat), whose words carried the recording's file block so they never matched. Each such
   *  pair becomes the orb's one row, linked to the chat; any row's words lose a file block. Returns whether it changed. */
  #repairSpoken() {
    let changed = false
    for (const row of this.data.rows) {
      if (typeof row.text !== 'string' || !/\[WIZARD_[A-Z0-9_]+_V1\]/u.test(row.text)) continue
      row.text = clip(withoutMarkers(row.text), MAX_TEXT) || 'Voice message'
      changed = true
    }
    const merged = new Set()
    for (const chat of this.data.rows) {
      if (chat.source !== 'new_chat' || !chat.thread_id) continue
      const words = sameWords(chat.text)
      const orb = this.data.rows.find(r => r !== chat && !merged.has(r) && r.agent === chat.agent && (r.source === 'orb' || r.source === 'side')
        && !r.thread_id && !r.record_id && (r.route === 'agent' || r.route === 'command' || r.route == null)
        && (chat.at || 0) >= (r.at || 0) && (chat.at || 0) - (r.at || 0) < SENT_LINK_MS && sameWords(r.text) === words)
      if (!orb || this.data.rows.some(r => r !== chat && r.agent === chat.agent && r.thread_id === chat.thread_id && r.source !== 'reply')) continue
      orb.thread_id = chat.thread_id
      if (!orb.run_key && chat.run_key) orb.run_key = chat.run_key
      if (!orb.run_id && chat.run_id) orb.run_id = chat.run_id
      if (chat.notify_when_done && !orb.notify_when_done) { orb.notify_when_done = true; if (chat.notified_run) orb.notified_run = chat.notified_run }
      if (Array.isArray(chat.tags) && chat.tags.length) orb.tags = cleanTags([...(orb.tags || []), ...chat.tags])
      if (chat.urgent === true) orb.urgent = true
      merged.add(chat)
      changed = true
    }
    if (merged.size) this.data.rows = this.data.rows.filter(r => !merged.has(r))
    return changed
  }

  #save() {
    if (this.data.rows.length > MAX_ROWS) this.data.rows = this.data.rows.slice(0, MAX_ROWS)
    if (!this.path) return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    atomicStoreWrite(this.path, JSON.stringify(this.data))
  }

  #row(id) { return ROW_ID.test(String(id)) ? this.data.rows.find(r => r.id === id) || null : null }

  /** A capture arrives: its row, written before anything routes it. The same idempotency key (or, with none, the same
   *  words from the same kind of capture within SENT_REPEAT_MS) is the same row: `{ row, created }`. */
  open({ text = '', source = 'orb', idempotency_key: key = '', thread_id: thread = '', agent = 'hermes' } = {}) {
    const words = clip(text, MAX_TEXT)
    if (!words) throw Object.assign(new Error('text required'), { status: 400 })
    if (!validAgentId(agent)) throw Object.assign(new Error('invalid agent'), { status: 400 })
    const t = this.now()
    const given = typeof key === 'string' && KEY.test(key) ? key : ''
    const kind = SENT_SOURCES.has(source) ? source : 'orb'
    const existing = given
      ? this.data.rows.find(r => r.idempotency_key === given && r.agent === agent)
      : this.data.rows.find(r => !r.idempotency_key && r.agent === agent && r.source === kind && t - (r.at || 0) < SENT_REPEAT_MS && sameWords(r.text) === sameWords(words))
    if (existing) {
      if (!existing.thread_id && typeof thread === 'string' && THREAD_ID.test(thread)) { existing.thread_id = thread; this.#save() }
      return { row: { ...existing }, created: false }
    }
    const row = {
      id: `sent_${randomUUID().replaceAll('-', '').slice(0, 24)}`, idempotency_key: given || null, at: t, source: kind, agent, text: words,
      route: null, decided_by: null, rules_matched: [], model: '', tags: [], urgent: false, correction_id: null,
      thread_id: typeof thread === 'string' && THREAD_ID.test(thread) ? thread : null, record_id: null, run_key: null, routed_at: null,
    }
    this.data.rows.unshift(row)
    this.#save()
    return { row: { ...row }, created: true }
  }

  /** How the take was routed (after the router answered, failed or was skipped). Returns the row. */
  finish(id, { route = 'agent', decided_by: by = 'fallback', rules = [], model = '', confidence = null, tags = [], urgent = false, correction_id: correction = null, record_id: record = null, thread_id: thread = null, error = '', agent_id: agentId = '', agent_model: agentModel = '', chosen_by: chosenBy = '' } = {}) {
    const row = this.#row(id)
    if (!row) return null
    Object.assign(row, {
      route: SENT_ROUTES.has(route) ? route : 'agent', decided_by: SENT_DECIDERS.has(by) ? by : 'fallback',
      rules_matched: cleanRules(rules), model: clip(model, 120), tags: cleanTags(tags), urgent: urgent === true,
      correction_id: correction ? clip(correction, 64) : row.correction_id, routed_at: this.now(),
    })
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) row.confidence = confidence
    else delete row.confidence
    if (record && RECORD_ID.test(String(record))) row.record_id = record
    if (thread && THREAD_ID.test(String(thread))) row.thread_id = thread
    if (error) row.error = clip(error, 80)
    else delete row.error
    // Issue 629 (switch wizard/private-routing): the agent the take was sent to and which rule chose it.
    if (validAgentId(agentId) && CHOSEN_BY.has(chosenBy)) Object.assign(row, { agent_id: agentId, chosen_by: chosenBy, agent_model: clip(agentModel, 120) })
    this.#save()
    return { ...row }
  }

  /** Service-side field changes on one row (the typed row's would_route, a correction). Returns the row. */
  update(id, fields = {}) {
    const row = this.#row(id)
    if (!row) return null
    Object.assign(row, structuredClone(fields))
    this.#save()
    return { ...row }
  }

  get(id) { const row = this.#row(id); return row ? { ...row } : null }

  /** Every row, newest first (copies), for the typed match rate (issue 669). */
  all() { return this.data.rows.map(r => ({ ...r })) }

  /** Newest first, `limit` rows after the row `before` (the previous page's `next`). */
  list({ limit = 50, before = '', agent = '' } = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50))
    let rows = this.data.rows.filter(r => !agent || r.agent === agent)
    if (before) {
      const at = rows.findIndex(r => r.id === before)
      rows = at >= 0 ? rows.slice(at + 1) : []
    }
    const page = rows.slice(0, n).map(r => ({ ...r }))
    return { rows: page, next: rows.length > n ? page.at(-1).id : null }
  }

  /** A new thread's first owner turn: the row it came from, linked to this thread. That is the row the shell named
   *  this thread for, else an orb / side / new chat row with exactly the same words, sent within SENT_LINK_MS, routed to a
   *  visible thread and not linked yet. Returns the row, or null (then it is a typed message). */
  linkTurn({ agent = 'hermes', thread = '', text = '', run_key: runKey = '' } = {}) {
    if (!THREAD_ID.test(String(thread))) return null
    const t = this.now()
    const words = sameWords(clip(withoutMarkers(text), MAX_TEXT))
    let row = this.data.rows.find(r => r.agent === agent && r.thread_id === thread)
    if (!row && words) {
      row = this.data.rows.find(r => r.agent === agent && r.source !== 'typed' && !r.thread_id && !r.record_id && t - (r.at || 0) < SENT_LINK_MS
        && (r.route === 'agent' || r.route === 'command' || r.route == null) && sameWords(r.text) === words)
      if (row) row.thread_id = thread
    }
    if (!row) return null
    if (!row.run_key && typeof runKey === 'string' && KEY.test(runKey)) row.run_key = runKey
    this.#save()
    return { ...row }
  }

  /** A typed first message in a new thread: its row (route agent, a visible thread, as always). The same run key twice
   *  is one row. */
  typed({ agent = 'hermes', thread = '', text = '', run_key: runKey = '', source = 'typed' } = {}) {
    if (!THREAD_ID.test(String(thread))) return null
    const given = typeof runKey === 'string' && KEY.test(runKey) ? runKey : ''
    const existing = this.data.rows.find(r => r.agent === agent && r.thread_id === thread)
    if (existing) return { ...existing }
    const { row } = this.open({ text, source: SENT_SOURCES.has(source) ? source : 'typed', agent, thread_id: thread })
    return this.update(row.id, { route: 'agent', decided_by: 'owner_words', rules_matched: [source === 'typed' ? 'typed' : 'new_chat'], run_key: given || null, routed_at: this.now() })
  }

  /** A message the owner sent inside an existing thread (wizard-ux issue 1808): its row (source reply, route thread),
   *  written before the turn is admitted. `wants_reply`: his words asked for an answer (the reply rules). The same run
   *  key twice is one row. */
  reply({ agent = 'hermes', thread = '', text = '', run_key: runKey = '', wants_reply: wants = true, rules = [], tags = [], urgent = false, steer = false, run_id: runId = '' } = {}) {
    if (!THREAD_ID.test(String(thread))) return null
    const given = typeof runKey === 'string' && KEY.test(runKey) ? runKey : ''
    const existing = given ? this.data.rows.find(r => r.agent === agent && r.source === 'reply' && r.thread_id === thread && r.run_key === given) : null
    if (existing) return { ...existing }
    const words = clip(text, MAX_TEXT)
    if (!words) return null
    if (!validAgentId(agent)) return null
    const t = this.now()
    const row = {
      id: `sent_${randomUUID().replaceAll('-', '').slice(0, 24)}`, idempotency_key: null, at: t, source: 'reply', agent, text: words,
      route: 'thread', decided_by: 'owner_words', rules_matched: cleanRules(rules), model: '', tags: cleanTags(tags), urgent: urgent === true, correction_id: null,
      thread_id: thread, record_id: null, run_key: given || null, run_id: typeof runId === 'string' && KEY.test(runId) ? runId : null, routed_at: t, wants_reply: wants !== false,
      ...(steer ? { steer: true } : {}),
    }
    this.data.rows.unshift(row)
    this.#save()
    return { ...row }
  }

  /** A reply's run ended: its outcome (the agent's final status, or failed) and one-line answer, kept once. Matched by
   *  the queue's public run id, else by the run key. Returns the rows it changed. */
  noteRun({ agent = 'hermes', thread = '', run_id: runId = '', run_key: runKey = '', state = 'none', answer = '' } = {}) {
    if (!THREAD_ID.test(String(thread))) return []
    const outcome = OUTCOMES.has(state) ? state : 'none'
    const changed = []
    for (const row of this.data.rows) {
      // A typed first message keeps its first run's outcome too (issue 669): it is how its shadow guess is judged.
      if (row.agent !== agent || (row.source !== 'reply' && row.source !== 'typed') || row.thread_id !== thread || row.outcome) continue
      if (!((runId && row.run_id === runId) || (runKey && row.run_key === runKey))) continue
      row.outcome = { state: outcome, answer: clip(answer, 200), at: this.now() }
      if (runId && !row.run_id) row.run_id = runId
      changed.push({ ...row })
    }
    if (changed.length) this.#save()
    return changed
  }

  /** Is the thread's newest run (its public run id) a reply that needs nothing from the owner? Every reply row on that
   *  run (a steer adds one) must have asked for no answer, and the run must have ended done or fyi. A run a reply did
   *  not start (a steer into the first turn's run) is never quiet. */
  quietFor(thread, runId, agent = 'hermes') {
    if (!runId || !THREAD_ID.test(String(thread))) return false
    const rows = this.data.rows.filter(r => r.agent === agent && r.source === 'reply' && r.thread_id === thread && r.run_id === runId)
    return rows.some(r => !r.steer) && rows.every(r => r.wants_reply === false && QUIET_OUTCOMES.has(r.outcome?.state))
  }

  /** Smart inbox (issue 667): the owner's own rows on one run (the first message's row by its run key, reply and steer
   *  rows by run id or key). None: nobody typed it, the run was started by the agent or the Service. */
  ownerRowsForRun(thread, runId = '', runKey = '', agent = 'hermes') {
    if (!THREAD_ID.test(String(thread)) || (!runId && !runKey)) return []
    return this.data.rows.filter(r => r.agent === agent && r.thread_id === thread
      && ((runId && r.run_id === runId) || (runKey && r.run_key === runKey))).map(r => ({ ...r }))
  }

  /** The oldest owner row in the thread that asked to be told when the work is done and has not been told yet. */
  pendingNotify(thread, agent = 'hermes') {
    if (!THREAD_ID.test(String(thread))) return null
    const row = this.data.rows.filter(r => r.agent === agent && r.thread_id === thread && r.notify_when_done === true && !r.notified_run).at(-1)
    return row ? { ...row } : null
  }

  /** Was this run the one that told the owner what he asked to hear about? */
  notifiedBy(thread, runId, agent = 'hermes') {
    return Boolean(runId) && this.data.rows.some(r => r.agent === agent && r.thread_id === thread && r.notified_run === runId)
  }

  /** Smart inbox: a run that ended with nothing for the owner (kept once per run id, newest 2000). */
  markQuiet(thread, runIds = [], agent = 'hermes') {
    if (!THREAD_ID.test(String(thread))) return false
    const list = this.data.quiet_runs ||= []
    const fresh = [...new Set(runIds)].filter(run => typeof run === 'string' && KEY.test(run) && !list.some(q => q.agent === agent && q.thread === thread && q.run === run))
    if (!fresh.length) return false
    for (const run of fresh) list.unshift({ agent, thread, run, at: this.now() })
    if (list.length > MAX_ROWS) list.length = MAX_ROWS
    this.#save()
    return true
  }

  quietRun(thread, runId, agent = 'hermes') {
    return Boolean(runId) && (this.data.quiet_runs || []).some(q => q.agent === agent && q.thread === thread && q.run === runId)
  }

  /** The nightly check: rows sent more than SENT_FINAL_MS ago (within the last week) whose live state (`stateOf(row)`)
   *  is still not final are flagged; the target is zero. Runs at most once a day unless `force`. */
  nightly(now = this.now(), stateOf = () => 'unknown', { force = false } = {}) {
    const last = this.data.check?.at || 0
    if (!force && now - last < NIGHTLY_MS) return null
    const flagged = []
    for (const row of this.data.rows) {
      const age = now - (row.at || 0)
      if (age < SENT_FINAL_MS || age > CHECK_WINDOW_MS) continue
      let state = 'unknown'
      try { state = stateOf(row) } catch { state = 'unknown' }
      if (FINAL_STATES.has(state)) { row.final_state = state; delete row.flag; continue }
      row.flag = 'no_final_state'
      flagged.push(row.id)
    }
    this.data.check = { at: now, unfinished: flagged.length, rows: flagged.slice(0, 20) }
    if (flagged.length) this.log(`[sent-log] nightly check: ${flagged.length} sent item(s) with no final state`)
    this.#save()
    return { ...this.data.check }
  }

  lastCheck() { return this.data.check ? { ...this.data.check } : null }
}
