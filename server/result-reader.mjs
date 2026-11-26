// Result reader (issue 630; owner switch `wizard/result-reader`, off by default; WIZARD_RESULT_READER '1' forces it on,
// '0' off). A fixed, stateless reader decides how a finished background run reaches the owner, instead of the agent's
// own WIZARD_STATUS_V1 line (after a long run the agent often forgets its reply rules: the line is missing, too long,
// or marks the wrong state). It is not an agent: no memory, no tools, one call to the box's PRIVATE fast router
// (privateRouter: Tinfoil by host, or a model on this box) at temperature 0, with a fixed prompt and bounded facts.
//
// Reads: run facts (agent, duration, ok / failed / killed, error text, owed background work), the status line as a
// hint, and the last block of the final reply (at most READER_REPLY_CHARS). Never the whole thread.
// Writes: strict JSON {kind: needs_you | result | fyi, urgent, ask (<= 140 chars), failed?, options?}. Anything else
// (invalid JSON, a timeout, an HTTP error) is null, and the Service files the run exactly as today (logged).
// No private router set: the reader is never called and nothing changes (logged once).

import { privateRouter } from './agent-alerts.mjs'
import { normalizeStatus, parseStatusObject, stripStatus } from './thread-status.mjs'

export const RESULT_READER_SWITCH = 'wizard/result-reader'
export const READER_KINDS = new Set(['needs_you', 'result', 'fyi'])
export const READER_REPLY_CHARS = 4000
export const READER_ASK_MAX = 140
export const READER_EXAMPLES = 8
export const READER_TIMEOUT_MS = 20_000
export const CLASSIFIED_BY = new Set(['reader', 'status_line', 'fallback'])
const TOKEN = /^[a-z][a-z0-9-]{0,19}$/u
const MAX_OPTIONS = 6

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export const READER_PROMPT = `You read the end of one finished background task and decide how it reaches its owner. You are not the agent and
you do nothing yourself. The agent's own status line is only a hint: when the reply itself says otherwise, the reply wins.
kind is one of:
- needs_you: the task cannot move on until the owner does one specific thing: choose, decide, approve, reply, sign in,
  pay, or fix something only he can. A reply that asks him a question or offers him choices is needs_you. A task that
  failed in a way only he can fix is needs_you.
- result: the task finished (or failed for good) and the owner should see the outcome; nothing is waiting on him.
- fyi: a progress note or a small update with nothing for him to do and nothing important finished.
urgent is true ONLY when it cannot wait for his next sweep: money at risk, health, safety, or a named person waiting on
him with a deadline under one day. When unsure, urgent is false.
failed is true when the run or the task itself did not succeed (an error, a crash, a refusal, nothing produced).
ask is what he reads cold, in one or two short plain sentences, at most 140 characters. For needs_you first say what is
waiting, then the exact thing to do ("Two venues found for Saturday. Reply A or B"). For result and fyi state the
outcome ("Flight search failed: the airline site was down"). No PR, issue or version numbers, no branch, flag, script,
job, file or app ids, no team jargon, never "Review this" or "Let me know".
options only when the reply itself offers the owner named choices: an object of up to 6 short lowercase reply words
to the message each one sends back, e.g. {"a": "Book the Harbour Room", "b": "Book the Loft"}. Otherwise leave it out.
Reply with ONLY one compact JSON object: {"kind": "...", "urgent": false, "failed": false, "ask": "...", "options": {...}}.`

/** The router the reader may call, or null. Only a private endpoint (privateRouter) ever counts. */
export function readerRouter(router) {
  return router && router.url && router.model && privateRouter(router) ? router : null
}

/** The status line of a reply as the reader's hint and the record's `status_line`, or null. */
export function statusHint(output) {
  const raw = parseStatusObject(typeof output === 'string' ? output : '')
  const status = raw ? normalizeStatus(raw) : null
  return status ? { state: status.state, ask: status.ask } : null
}

/** The kind today's status-line mapping gives a state (check is a needs_you there), for counting disagreements. */
export const statusKind = state => state === 'needs_you' || state === 'check' ? 'needs_you' : state === 'done' ? 'result' : state === 'fyi' ? 'fyi' : ''

/** The last block of the final reply, status line removed, at most `max` characters (cut at a line or word). */
export function replyTail(output, max = READER_REPLY_CHARS) {
  const text = stripStatus(typeof output === 'string' ? output : '').trim()
  if (text.length <= max) return text
  const tail = text.slice(-max)
  const cut = tail.search(/\n|\s/u)
  return `…${(cut >= 0 && cut < max * 0.2 ? tail.slice(cut) : tail).trimStart()}`
}

const outcomeOf = status => {
  const s = String(status ?? '')
  if (s === 'completed') return 'ok'
  if (s === 'cancelled' || s === 'canceled' || s === 'stopped' || s === 'interrupted') return 'killed'
  return 'failed'
}

/** The bounded facts the reader sees for one finished run. */
export function readerFacts({ agent = 'hermes', agentKind = '', run = {}, durationMs = null, owedWork = false, title = '' } = {}) {
  const output = typeof run.output === 'string' ? run.output : ''
  const hint = statusHint(output)
  const error = clip(typeof run.error === 'string' ? run.error : run.error?.message ?? '', 300)
  return {
    agent: clip(agent, 64), ...(agentKind ? { agent_kind: clip(agentKind, 32) } : {}), task: clip(title, 80),
    outcome: outcomeOf(run.status), run_status: clip(run.status, 32),
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { duration_minutes: Math.round(durationMs / 6000) / 10 } : {}),
    ...(error ? { error } : {}),
    ...(Array.isArray(run.files_changed) ? { files_changed: run.files_changed.slice(0, 20).map(f => clip(f, 120)) } : {}),
    owed_background_work: owedWork === true,
    status_line_hint: hint,
    final_reply_end: replyTail(output),
  }
}

/** The owner's latest corrections as prompt lines (newest first, at most READER_EXAMPLES). */
export function examplesBlock(examples = []) {
  const lines = (Array.isArray(examples) ? examples : []).slice(0, READER_EXAMPLES).map(e => `- ${clip(e.text, 160)}`).filter(line => line.length > 2)
  return lines.length ? `The owner corrected earlier filings like this (newest first):\n${lines.join('\n')}` : ''
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

/** The model's reply made strict, or null: kind from the set, urgent a boolean, a non-empty ask (clipped to 140). */
export function parseReaderReply(content) {
  const text = String(content ?? '').trim()
  const match = text.match(/\{[\s\S]*\}/u)
  if (!match) return null
  let value
  try { value = JSON.parse(match[0]) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const kind = String(value.kind ?? '').trim().toLowerCase()
  if (!READER_KINDS.has(kind) || typeof value.urgent !== 'boolean') return null
  const ask = clip(value.ask, READER_ASK_MAX)
  if (!ask) return null
  const options = kind === 'needs_you' ? cleanOptions(value.options) : {}
  return { kind, urgent: value.urgent, failed: value.failed === true, ask, ...(Object.keys(options).length ? { options } : {}) }
}

/** One read: -> the strict reply, or throws (HTTP error, timeout, unreadable JSON). */
export async function readResult(facts, { router, examples = [], fetchImpl = fetch, timeoutMs = READER_TIMEOUT_MS } = {}) {
  if (!readerRouter(router)) throw new Error('no private router')
  const extra = examplesBlock(examples)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let content = ''
  try {
    const upstream = await fetchImpl(router.url, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(router.key ? { Authorization: `Bearer ${router.key}` } : {}) },
      body: JSON.stringify({ model: router.model, temperature: 0, max_tokens: 300, messages: [
        { role: 'system', content: extra ? `${READER_PROMPT}\n\n${extra}` : READER_PROMPT },
        { role: 'user', content: JSON.stringify(facts) },
      ] }),
    })
    if (!upstream.ok) throw new Error(`model ${upstream.status}`)
    content = String((await upstream.json())?.choices?.[0]?.message?.content ?? '')
  } catch (error) {
    if (controller.signal.aborted) throw new Error('timeout')
    throw error
  } finally { clearTimeout(timer) }
  const reply = parseReaderReply(content)
  if (!reply) throw new Error('invalid reply')
  return reply
}

/** The Service's reader: `read(input)` -> `{ result, error }`; result null means "file it as today". In-flight reads
 *  are shared per key (the same finished run is seen by many polls). The no-private-router case is logged once. */
export function createResultReader({ router = () => null, examples = () => [], fetchImpl = fetch, timeoutMs = READER_TIMEOUT_MS, log = message => console.warn(message) } = {}) {
  const inFlight = new Map()
  let noRouterLogged = false
  const usable = () => {
    let r = null
    try { r = readerRouter(router()) } catch { r = null }
    if (!r && !noRouterLogged) { noRouterLogged = true; log('[result-reader] no private router endpoint (none set, or not private): finished runs are filed from their status line as before') }
    if (r) noRouterLogged = false
    return r
  }
  const read = (key, facts) => {
    const r = usable()
    if (!r) return null
    if (inFlight.has(key)) return inFlight.get(key)
    const job = (async () => {
      try { return { result: await readResult(facts, { router: r, examples: examples(), fetchImpl, timeoutMs }), model: clip(r.model, 120) } }
      catch (error) {
        log(`[result-reader] read failed (${clip(error?.message || error, 80)}); filed from the status line as before`)
        return { result: null, error: clip(error?.message || error, 80) || 'error' }
      } finally { inFlight.delete(key) }
    })()
    inFlight.set(key, job)
    return job
  }
  return { usable, read, busy: key => inFlight.has(key) }
}
