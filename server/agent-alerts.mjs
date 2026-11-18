// Alert rules (issue 552, step 6 of the agent inbox series; owner switch `wizard/agent-inbox`, off by default).
//
// Decides what is loud. A candidate event (an app watcher's event posted to the inbox, Mail first, or a worker's inbox
// record with a high or urgent severity) goes through, in order:
//   1. Fixed rules, owner-editable in alert-rules.json next to the inbox store: named senders, keywords, and app
//      events (payment failed, a meeting that starts within 2 hours). A hit is an alert.
//   2. The owner's own examples: an event like one he marked "Not urgent" waits for the sweep; one like an item he
//      said "Should have alerted" on is an alert.
//   3. Borderline events (high or urgent severity, a deadline under a day, money/health/safety words) go to the fast
//      PRIVATE model with a strict rubric. Its decision and reason are logged. No private model, or a model failure:
//      the event waits for the sweep (never an alert by guess, never dropped).
//   4. Everything else becomes a normal inbox record (kind fyi) for the next sweep. Nothing is dropped.
// Volume guard: more alerts than the daily cap (3) in one alert day collapse into one alert ("more alerts today"),
// the extra events wait in the sweep, and the next sweep card flags the rules as too loose.
// Alerts stay their own channel: alert records (kind alert) never ride on the sweep card, and each one is sent once
// through the owner's notifications slot when one is running.

import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicStoreWrite } from './thread-reference.mjs'
import { dayOf } from './daily-channel.mjs'

export const ALERT_RULES_SCHEMA = 'wizard.alert-rules/1'
export const DAILY_ALERT_CAP = 3
export const MEETING_WINDOW_MIN = 120
export const BORDERLINE_DEADLINE_MS = 24 * 3600_000
export const MAX_EXAMPLES = 100
const MAX_LIST = 200
export const COLLAPSED_TITLE = 'More alerts today'
export const EVENT_TYPES = new Set(['mail', 'payment_failed', 'meeting', 'message', 'event', 'record'])
const SEVERITIES = new Set(['low', 'normal', 'high', 'urgent'])
// Words that make an event worth the model's look (not an alert by themselves): money, health, safety, a deadline.
const BORDERLINE_WORDS = /\b(?:urgent|asap|emergency|overdue|final notice|invoice|payment|refund|bank|card declined|fraud|doctor|hospital|clinic|pharmacy|health|injur\w*|accident|safety|police|deadline|today|tonight|within the hour)\b/iu

export const RUBRIC = `You decide whether one incoming event is URGENT enough to interrupt the owner right now.
Urgent means ONLY one of: money at risk (a failed or fraudulent payment, a bill about to cause harm), health, safety,
or a named person waiting on the owner with a deadline under one day. Everything else is NOT urgent: newsletters,
receipts, marketing, routine updates, FYI, requests without a deadline under a day. When unsure, it is NOT urgent.
Reply with ONLY one compact JSON object: {"urgent": true|false, "reason": "at most 12 words"}.`

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
const lower = value => clip(value, 200).toLowerCase()

export function defaultRules() {
  return {
    schema: ALERT_RULES_SCHEMA,
    senders: [],
    keywords: [],
    events: { payment_failed: true, meeting_within_minutes: MEETING_WINDOW_MIN },
    daily_cap: DAILY_ALERT_CAP,
    examples: { not_urgent: [], should_alert: [] },
  }
}

const cleanList = (value, max) => [...new Set((Array.isArray(value) ? value : []).map(v => clip(v, max)).filter(Boolean))].slice(0, MAX_LIST)
const cleanExample = e => e && typeof e === 'object' && typeof e.sig === 'string' && e.sig
  ? { sig: clip(e.sig, 300), app: clip(e.app, 60), type: clip(e.type, 30), sender: clip(e.sender, 120), title: clip(e.title, 80), at: Number(e.at) || 0 }
  : null

/** Owner-edited rules made safe: unknown fields dropped, lists capped, the daily cap between 1 and 20. */
export function normalizeRules(raw) {
  const base = defaultRules()
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const events = value.events && typeof value.events === 'object' ? value.events : {}
  const minutes = Number(events.meeting_within_minutes)
  const cap = Number(value.daily_cap)
  const examples = value.examples && typeof value.examples === 'object' ? value.examples : {}
  return {
    ...base,
    senders: cleanList(value.senders, 120).map(s => s.toLowerCase()),
    keywords: cleanList(value.keywords, 60),
    events: {
      payment_failed: events.payment_failed !== false,
      meeting_within_minutes: Number.isFinite(minutes) ? Math.max(0, Math.min(24 * 60, Math.round(minutes))) : MEETING_WINDOW_MIN,
    },
    daily_cap: Number.isFinite(cap) ? Math.max(1, Math.min(20, Math.round(cap))) : DAILY_ALERT_CAP,
    examples: {
      not_urgent: (Array.isArray(examples.not_urgent) ? examples.not_urgent : []).map(cleanExample).filter(Boolean).slice(-MAX_EXAMPLES),
      should_alert: (Array.isArray(examples.should_alert) ? examples.should_alert : []).map(cleanExample).filter(Boolean).slice(-MAX_EXAMPLES),
    },
  }
}

/** The owner-editable rules file (JSON). Read again whenever it changed on disk, so a hand edit applies at once. */
export class AlertRulesFile {
  constructor(path = '') {
    this.path = path
    this.memory = defaultRules()
    this.cache = null
  }

  read() {
    if (!this.path) return structuredClone(this.memory)
    try {
      const st = statSync(this.path)
      const sig = `${st.mtimeMs}:${st.size}:${st.ino}`
      if (this.cache?.sig !== sig) this.cache = { sig, rules: normalizeRules(st.size > 512 * 1024 ? {} : JSON.parse(readFileSync(this.path, 'utf8'))) }
      return structuredClone(this.cache.rules)
    } catch (error) {
      if (error?.code !== 'ENOENT' && existsSync(this.path)) console.warn('[agent-alerts] alert-rules.json unreadable; using the defaults')
      return defaultRules()
    }
  }

  write(rules) {
    const clean = normalizeRules(rules)
    if (!this.path) { this.memory = clean; return structuredClone(clean) }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    atomicStoreWrite(this.path, `${JSON.stringify(clean, null, 2)}\n`)
    this.cache = null
    return this.read()
  }

  /** The owner edits senders, keywords, events and the cap; examples only change through the two feedback taps. */
  edit(input = {}) {
    const current = this.read()
    const next = { ...current }
    for (const key of ['senders', 'keywords', 'daily_cap']) if (Object.hasOwn(input, key)) next[key] = input[key]
    if (input.events && typeof input.events === 'object') next.events = { ...current.events, ...input.events }
    return this.write(next)
  }

  /** One feedback tap: one example in `kind` (the same event again replaces its older copy, and leaves the other list). */
  addExample(kind, example) {
    if (kind !== 'not_urgent' && kind !== 'should_alert') throw Object.assign(new Error('unknown example kind'), { status: 400 })
    const clean = cleanExample(example)
    if (!clean) throw Object.assign(new Error('nothing to learn from'), { status: 400 })
    const rules = this.read()
    const other = kind === 'not_urgent' ? 'should_alert' : 'not_urgent'
    rules.examples[other] = rules.examples[other].filter(e => e.sig !== clean.sig)
    rules.examples[kind] = [...rules.examples[kind].filter(e => e.sig !== clean.sig), clean].slice(-MAX_EXAMPLES)
    return this.write(rules)
  }
}

const senderOf = value => {
  if (!value) return { name: '', email: '' }
  if (typeof value === 'string') {
    const m = /<([^<>\s]+@[^<>\s]+)>/u.exec(value) || /([^\s<>]+@[^\s<>]+)/u.exec(value)
    return { name: clip(value.split('<')[0].replace(/[<>"]/gu, ''), 120), email: m ? m[1].toLowerCase() : '' }
  }
  return { name: clip(value.name, 120), email: clip(value.email, 200).toLowerCase() }
}

/** A candidate event as the gate reads it. Throws 400 for an event with nothing to show. */
export function normalizeEvent(input = {}) {
  const value = input && typeof input === 'object' ? input : {}
  const source = value.source && typeof value.source === 'object' ? value.source : {}
  const app = clip(source.app ?? value.app, 60)
  const item = clip(source.item ?? value.item, 200)
  const title = clip(value.title || value.subject, 60)
  const ask = clip(value.ask || value.summary || value.text, 140)
  if (!title && !ask) throw Object.assign(new Error('title or ask required'), { status: 400 })
  return {
    type: EVENT_TYPES.has(value.type) ? value.type : 'event',
    app, item, title: title || clip(ask, 60), ask,
    sender: senderOf(value.sender ?? value.from),
    starts_at: isoOrNull(value.starts_at),
    deadline: isoOrNull(value.deadline),
    severity: SEVERITIES.has(value.severity) ? value.severity : 'normal',
    link: typeof value.link === 'string' ? value.link : null,
    privacy_class: value.privacy_class === 'general' ? 'general' : 'private',
  }
}

/** An inbox record (a worker's task) as a candidate event. */
export const eventOfRecord = record => ({
  type: 'record', app: '', item: record.id, title: record.title, ask: record.ask || record.last_update || '',
  sender: { name: '', email: '' }, starts_at: null, deadline: record.deadline || null,
  severity: record.severity || 'normal', link: record.link || null, privacy_class: record.privacy_class === 'general' ? 'general' : 'private',
})

/** What makes two events "the same kind of event" for the owner's examples: app, type and sender (or title when there
 *  is no sender), never the item id, so a tap teaches the next mail from that sender too. */
export function exampleSig(event) {
  const who = event.sender?.email || lower(event.sender?.name)
  return `${event.app || ''}|${event.type || ''}|${who || `title:${lower(event.title)}`}`
}

const exampleOf = (event, at) => ({ sig: exampleSig(event), app: event.app, type: event.type, sender: event.sender?.email || event.sender?.name || '', title: event.title, at })

const senderHit = (event, senders) => {
  const email = event.sender?.email || ''
  const name = lower(event.sender?.name)
  return senders.find(s => s && ((email && (email === s || (s.startsWith('@') && email.endsWith(s)))) || (name && name === s))) || ''
}
const keywordHit = (event, keywords) => {
  const text = `${event.title} ${event.ask}`
  return keywords.find(k => new RegExp(`(?:^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text)) || ''
}

/** Stage 1 and 2, pure: `{ stage, decision: 'alert' | 'sweep' | 'model', rule }`. */
export function classifyEvent(event, rules, now = Date.now()) {
  const sender = senderHit(event, rules.senders)
  if (sender) return { stage: 'rule', decision: 'alert', rule: 'sender' }
  if (event.type === 'payment_failed' && rules.events.payment_failed) return { stage: 'rule', decision: 'alert', rule: 'payment_failed' }
  if (event.type === 'meeting' && event.starts_at && rules.events.meeting_within_minutes > 0) {
    const ahead = Date.parse(event.starts_at) - now
    if (ahead >= -5 * 60_000 && ahead <= rules.events.meeting_within_minutes * 60_000) return { stage: 'rule', decision: 'alert', rule: 'meeting_soon' }
  }
  if (keywordHit(event, rules.keywords)) return { stage: 'rule', decision: 'alert', rule: 'keyword' }
  const sig = exampleSig(event)
  if (rules.examples.should_alert.some(e => e.sig === sig)) return { stage: 'example', decision: 'alert', rule: 'should_alert_example' }
  if (rules.examples.not_urgent.some(e => e.sig === sig)) return { stage: 'example', decision: 'sweep', rule: 'not_urgent_example' }
  const deadline = Date.parse(event.deadline || '')
  const borderline = event.severity === 'high' || event.severity === 'urgent'
    || (Number.isFinite(deadline) && deadline - now <= BORDERLINE_DEADLINE_MS)
    || BORDERLINE_WORDS.test(`${event.title} ${event.ask}`)
  return borderline ? { stage: 'model', decision: 'model', rule: 'borderline' } : { stage: 'rule', decision: 'sweep', rule: 'no_rule' }
}

/** A router the owner's private data may go to: Tinfoil, or a model on this box. */
export function privateRouter(router) {
  if (!router?.url) return false
  if (String(router.account || '').toLowerCase() === 'tinfoil' || router.private === true) return true
  try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(router.url).hostname) } catch { return false }
}

/** Stage 3: the fast private model with the strict rubric. -> { urgent, reason } (throws on any failure). */
export async function decideWithModel(event, rules, { router, fetchImpl = fetch, now = Date.now(), timeoutMs = 15_000 } = {}) {
  const line = e => `- ${[e.app, e.type, e.sender, e.title].filter(Boolean).join(' / ')}`
  const examples = [
    rules.examples.should_alert.length ? `The owner said these SHOULD have alerted:\n${rules.examples.should_alert.slice(-10).map(line).join('\n')}` : '',
    rules.examples.not_urgent.length ? `The owner said these were NOT urgent:\n${rules.examples.not_urgent.slice(-10).map(line).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  const facts = { now: new Date(now).toISOString(), type: event.type, app: event.app, from: event.sender?.name || event.sender?.email || '', title: event.title, text: event.ask, deadline: event.deadline, starts_at: event.starts_at, severity: event.severity }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let content = ''
  try {
    const upstream = await fetchImpl(router.url, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(router.key ? { Authorization: `Bearer ${router.key}` } : {}) },
      body: JSON.stringify({ model: router.model, temperature: 0, max_tokens: 120, messages: [{ role: 'system', content: examples ? `${RUBRIC}\n\n${examples}` : RUBRIC }, { role: 'user', content: JSON.stringify(facts) }] }),
    })
    if (!upstream.ok) throw new Error(`model ${upstream.status}`)
    content = String((await upstream.json())?.choices?.[0]?.message?.content ?? '')
  } finally { clearTimeout(timer) }
  const match = content.match(/\{[\s\S]*\}/u)
  const reply = match ? JSON.parse(match[0]) : null
  if (!reply || typeof reply.urgent !== 'boolean') throw new Error('model reply unreadable')
  return { urgent: reply.urgent, reason: clip(reply.reason, 120) }
}

/** The alert gate: stages, the volume guard, delivery and the two feedback taps, over one inbox store and rules file. */
/** @param {any} options */
export function createAlertGate(options = {}) {
  const { inbox, rules, router = () => null, notify = null, fetchImpl = fetch, now = Date.now, timezone = () => 'UTC', log = message => console.log(message) } = options
  const alertDay = at => dayOf(at, timezone() || 'UTC')

  const decide = async (event, current, at) => {
    const first = classifyEvent(event, current, at)
    if (first.decision !== 'model') return first
    const r = router()
    if (!r || (event.privacy_class !== 'general' && !privateRouter(r))) return { stage: 'model', decision: 'sweep', rule: 'no_private_model' }
    try {
      const { urgent, reason } = await decideWithModel(event, current, { router: r, fetchImpl, now: at })
      log(`[agent-alerts] borderline event decided by the private model: ${urgent ? 'alert' : 'sweep'}`)
      return { stage: 'model', decision: urgent ? 'alert' : 'sweep', rule: 'model', reason, model: clip(r.model, 120) }
    } catch (error) {
      log(`[agent-alerts] private model unavailable (${clip(error?.message || error, 80)}); the event waits for the sweep`)
      return { stage: 'model', decision: 'sweep', rule: 'model_failed' }
    }
  }

  const send = async record => {
    if (!notify) return false
    try {
      if (notify.available && !notify.available(record.agent)) return false
      await notify.send({ agent: record.agent, key: `agent-alert:${record.id}`, title: record.title, message: record.ask || record.title })
      return true
    } catch { return false }
  }

  // Over the daily cap: the day's one collapsed alert (made once, notified once) counts the extra events.
  const collapse = async (day, current, agent) => {
    const delivered = inbox.alertsOfDay(day).length
    const existing = inbox.alertsOfDay(day, { collapsed: true })[0]
    const extra = (existing?.alert_extra || 0) + 1
    const ask = `${extra} more alert${extra === 1 ? '' : 's'} today. They wait in the next sweep; the alert rules may be too loose.`
    inbox.flagRules({ day, alerts: delivered + extra, cap: current.daily_cap })
    if (existing) return inbox.update(existing.id, { alert_extra: extra, ask, last_update: ask, state: existing.state === 'archived' ? existing.state : 'new' })
    const { record, created } = inbox.capture({ agent, thread_id: `alert_${hash(`collapsed\n${day}`).slice(0, 24)}`, source: 'alerts:collapsed', kind: 'alert', title: COLLAPSED_TITLE, ask, severity: 'high', link: '/wizard-os-home/?inbox=alerts', dedupe_hash: hash(`${agent}\ncollapsed\n${day}`).slice(0, 32) },
      { ready: true, fields: { alert_day: day, alert_delivered: true, alert_collapsed: true, alert_extra: extra } })
    // Two extras racing: the second finds the first's collapsed alert and only counts.
    if (!created) return inbox.update(record.id, { alert_extra: (record.alert_extra || 0) + 1, ask, last_update: ask })
    return inbox.update(record.id, { notified: await send(record) })
  }

  /** One candidate event -> `{ record, decision, created }`. The same event posted again returns its first record. */
  const consider = async (input, { agent = 'hermes', forRecord = null } = {}) => {
    const event = normalizeEvent(input)
    const at = now()
    const source = event.app ? `app:${event.app}/${event.item || hash(`${event.title}\n${event.ask}`).slice(0, 16)}` : `event:${hash(`${event.title}\n${event.ask}`).slice(0, 16)}`
    const dedupe = hash(`${agent}\nevent\n${source}\n${event.item ? '' : `${event.title}\n${event.ask}`}`).slice(0, 32)
    const seen = inbox.byDedupe(agent, dedupe)
    if (seen) return { record: seen, decision: seen.alert_decision || null, created: false }
    const current = rules.read()
    const decision = await decide(event, current, at)
    const day = alertDay(at)
    const fields = { event: { app: event.app, type: event.type, sender: event.sender, sig: exampleSig(event), starts_at: event.starts_at }, alert_decision: decision }
    const base = {
      agent, thread_id: `alert_${dedupe.slice(0, 24)}`, source, title: event.title, ask: event.ask, severity: event.severity,
      privacy_class: event.privacy_class, deadline: event.deadline, dedupe_hash: dedupe,
      link: event.link || (decision.decision === 'alert' ? '/wizard-os-home/?inbox=alerts' : '/wizard-os-home/?inbox=later'),
    }
    let record
    if (forRecord && decision.decision !== 'alert') {
      // A worker's own record already waits in the sweep: nothing new is written for it.
      inbox.logAlert({ record_id: forRecord.id, stage: decision.stage, decision: 'sweep', rule: decision.rule, ...(decision.reason ? { reason: decision.reason } : {}), ...(decision.model ? { model: decision.model } : {}) })
      return { record: inbox.get(forRecord.id), decision, created: false }
    }
    if (forRecord && inbox.alertsOfDay(day).length >= current.daily_cap) {
      await collapse(day, current, agent)
      inbox.logAlert({ record_id: forRecord.id, stage: decision.stage, decision: 'collapsed', rule: decision.rule })
      return { record: inbox.get(forRecord.id), decision, created: false }
    }
    // The same event posted again while this one was being decided: the first call's record wins, nothing is sent twice.
    const once = captured => (captured.created ? captured.record : null)
    const again = () => { const first = inbox.byDedupe(agent, dedupe); return { record: first, decision: first?.alert_decision || null, created: false } }
    if (decision.decision === 'alert' && inbox.alertsOfDay(day).length < current.daily_cap) {
      record = once(inbox.capture({ ...base, kind: 'alert' }, { ready: true, fields: { ...fields, alert_day: day, alert_delivered: true } }))
      if (!record) return again()
      record = inbox.update(record.id, { notified: await send(record) })
    } else if (decision.decision === 'alert') {
      // The 4th alert of the day (with the default cap): it waits in the sweep, the day's collapsed alert counts it.
      record = once(inbox.capture({ ...base, kind: 'fyi', link: event.link || '/wizard-os-home/?inbox=later' }, { ready: true, fields: { ...fields, alert_day: day, alert_held: true } }))
      if (!record) return again()
      await collapse(day, current, agent)
    } else {
      record = once(inbox.capture({ ...base, kind: 'fyi' }, { ready: true, fields }))
      if (!record) return again()
    }
    inbox.logAlert({ record_id: record.id, stage: decision.stage, decision: record.kind === 'alert' ? 'alert' : record.alert_held ? 'collapsed' : 'sweep', rule: decision.rule, ...(decision.reason ? { reason: decision.reason } : {}), ...(decision.model ? { model: decision.model } : {}) })
    return { record: inbox.get(record.id), decision, created: true }
  }

  /** A worker's record with a high or urgent severity, once: an alert record for it when the stages say so. */
  const considerRecord = async record => {
    if (!record || record.alert_checked || !['high', 'urgent'].includes(record.severity) || record.state !== 'new' || record.kind === 'alert') return null
    inbox.update(record.id, { alert_checked: true })
    const event = eventOfRecord(record)
    return consider({ ...event, source: { app: '', item: '' }, link: record.link || `/wizard-os-home/?session=${encodeURIComponent(record.thread_id)}` }, { agent: record.agent, forRecord: record })
  }

  /** "Not urgent" on an alert: one not_urgent example, and the alert moves to the sweep (never lost).
   *  "Should have alerted" on a sweep item: one should_alert example. */
  const feedback = (id, action) => {
    const record = inbox.get(id)
    if (!record) return null
    const event = record.event ? { ...record.event } : eventOfRecord(record)
    const example = exampleOf({ ...event, sender: event.sender || { name: '', email: '' }, title: record.title }, now())
    if (record.event?.sig) example.sig = record.event.sig
    if (action === 'not_urgent') {
      if (record.kind !== 'alert') throw Object.assign(new Error('not an alert'), { status: 400 })
      if (record.alert_collapsed) return { record: inbox.update(id, { state: 'archived', feedback: 'not_urgent' }), rules: rules.read() }
      const next = rules.addExample('not_urgent', example)
      inbox.logAlert({ record_id: id, stage: 'feedback', decision: 'sweep', rule: 'not_urgent' })
      return { record: inbox.update(id, { kind: 'fyi', state: 'new', feedback: 'not_urgent' }), rules: next }
    }
    if (action === 'should_alert') {
      if (record.kind === 'alert') throw Object.assign(new Error('already an alert'), { status: 400 })
      const next = rules.addExample('should_alert', example)
      inbox.logAlert({ record_id: id, stage: 'feedback', decision: 'alert', rule: 'should_alert' })
      return { record: inbox.update(id, { feedback: 'should_alert' }), rules: next }
    }
    throw Object.assign(new Error('unknown action'), { status: 400 })
  }

  return { consider, considerRecord, feedback, alertDay }
}
