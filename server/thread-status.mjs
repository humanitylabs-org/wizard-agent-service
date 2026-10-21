// Thread status: what a finished thread asks of its owner, written by the agent at the end of its
// final reply and shown on the Wizard chat list (Ready: needs you / test this / done / FYI).
//
// The agent ends a final reply with one hidden line:
//   [WIZARD_STATUS_V1]{"state":"needs_you","ask":"Decide whether to ship desks","subject":"Wizard OS"}[/WIZARD_STATUS_V1]
// Clients never see the marker: it is stripped from history and previews and served as
// `wizard_attention` on the session list. Threads answered before the tag existed can carry a
// one-off backfill record that applies only while that exact reply is still the latest one.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { migrateOptionalJson, qualifyRawThreadRecords, sideKey } from './thread-reference.mjs'
import { TITLE_INSTRUCTIONS, normalizeTitle } from './thread-titles.mjs'
import { SUBJECT_RULE } from './thread-subjects.mjs'
import { normalizeAppId, metadataAppId } from './thread-app-provenance.mjs'

export const STATUS_STATES = new Set(['needs_you', 'check', 'done', 'fyi'])
const MARKER = /\[WIZARD_STATUS_V1\]\s*([\s\S]*?)\s*\[\/WIZARD_STATUS_V1\]/giu
const OPEN_MARKER = /\[WIZARD_STATUS_V1\][\s\S]*$/u

export const STATUS_INSTRUCTIONS = 'End every final reply with one status line for the Wizard chat list, alone on the last line, exactly in this form: [WIZARD_STATUS_V1]{"state":"needs_you","ask":"Decide whether to ship the desks preview","subject":"Wizard OS","title":"Wizard OS · Desks"}[/WIZARD_STATUS_V1]. Wizard hides it from the user. state is one of: needs_you (only when the work cannot move until the user does one specific thing: decide, approve, reply, install, or act; an optional next step or an idea you could pursue is not needs_you, use done or fyi), done (the request is finished and you verified it yourself, including a bug the user reported that you fixed and tested; a suggestion to try it never makes it check), check (only when the user\'s own judgment is the missing piece: whether a new feature or design is what they meant, whether they like it (look, feel, wording, taste), or a real-device behaviour you could not verify yourself), fyi (an answer, report, or update with no action). ask is one plain sentence under 90 characters: for needs_you, it is the exact action the user takes, starting with the verb and naming the thing (\"Reply merge to ship thread titles to every install\", \"Pick desks layout A or B\"), never a vague \"Review this\" or \"Let me know\", and the reply itself ends with that same ask in plain words; for check, name what to judge ("Say if the 11 groups feel right"), never "Test that X works"; for done and fyi, state the outcome. ' + SUBJECT_RULE + ' ' + TITLE_INSTRUCTIONS + ' Leave the line out of interim progress messages and when ending a turn to wait for background helpers. A background handoff is still agent-owned work, never a done/FYI result. Before saying work is running, verify the actual worker and its continuation/delivery handle. If a terminal tool says completion notifications are unsupported, stay in the owning turn and wait for its result or arrange and verify a durable continuation; an untracked background process does not finish the request. Return to the owner with a self-contained verified outcome or one concrete owner-only gate, not a promise to resume.'

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export function normalizeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = String(value.state ?? '').trim().toLowerCase().replace(/[\s-]+/gu, '_')
  const mapped = state === 'needs' || state === 'needsyou' ? 'needs_you' : state === 'test' || state === 'qa' ? 'check' : state
  if (!STATUS_STATES.has(mapped)) return null
  const ask = clip(value.ask ?? value.line ?? value.summary, 140)
  if (!ask) return null
  const subject = clip(value.subject ?? value.project, 40)
  const title = normalizeTitle(value.title)
  const appId = normalizeAppId(value.app_id)
  return { state: mapped, ask, ...(subject ? { subject } : {}), ...(title ? { title } : {}), ...(appId ? { app_id: appId } : {}) }
}

// The last status marker in a reply, or null.
export function parseStatus(text) {
  if (typeof text !== 'string' || !text.includes('[WIZARD_STATUS_V1]')) return null
  let found = null
  for (const match of text.matchAll(MARKER)) {
    try { found = normalizeStatus(JSON.parse(match[1])) ?? found } catch { /* malformed: ignore */ }
  }
  return found
}

// Provenance is independent of attention: publishers may send an app-only marker.
// Only the last marker counts; a malformed/omitted final app_id must not revive an older one.
export function parseStatusAppId(text) {
  if (typeof text !== 'string' || !text.includes('[WIZARD_STATUS_V1]')) return null
  let id = null
  for (const match of text.matchAll(MARKER)) {
    id = null
    try { id = normalizeAppId(JSON.parse(match[1])?.app_id) } catch { /* malformed: ignore */ }
  }
  if (text.replace(MARKER, '').match(OPEN_MARKER)) return null
  return id
}

export function replyAppId(text, metadata) {
  const publisher = metadataAppId(metadata)
  return publisher.present ? publisher.id : parseStatusAppId(text)
}

// Remove status markers (and a trailing unterminated one) from user-visible text.
export function stripStatus(text) {
  if (typeof text !== 'string' || !text.includes('[WIZARD_STATUS_V1]')) return text
  return text.replace(MARKER, '').replace(OPEN_MARKER, '').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trimEnd()
}

// Strip markers from any string inside a JSON-like value (message history rows).
export function stripStatusDeep(value, depth = 0) {
  if (depth > 6) return value
  if (typeof value === 'string') return stripStatus(value)
  if (Array.isArray(value)) return value.map((item) => stripStatusDeep(item, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = stripStatusDeep(item, depth + 1)
    return out
  }
  return value
}

export function projectStatusMarkers(result) {
  if (!Buffer.isBuffer(result) || !result.includes('WIZARD_STATUS_V1')) return result
  try { return Buffer.from(JSON.stringify(stripStatusDeep(JSON.parse(result.toString('utf8'))))) } catch { return result }
}

// One-off classifications for replies written before the tag existed:
// { "threads": { "<session id>": { "state", "ask", "subject", "assistant_at": <epoch seconds> } } }
export class StatusBackfill {
  constructor(path) {
    this.path = path || ''
    migrateOptionalJson(this.path, value => value.threads && typeof value.threads === 'object' && !Array.isArray(value.threads) ? { ...value, threads: qualifyRawThreadRecords(value.threads) } : value)
    this.mtime = -1
    this.threads = {}
  }

  load() {
    if (!this.path || !existsSync(this.path)) { this.threads = {}; return this.threads }
    try {
      const { mtimeMs } = statSync(this.path)
      if (mtimeMs === this.mtime) return this.threads
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      this.threads = parsed && typeof parsed.threads === 'object' && parsed.threads ? parsed.threads : {}
      this.mtime = mtimeMs
    } catch { this.threads = {} }
    return this.threads
  }

  // Applies only while the reply it classified is still the thread's latest assistant reply.
  lookup(sessionId, latestAssistantAt, agentId = 'hermes') {
    const record = this.load()[sideKey(agentId, sessionId)]
    if (!record) return null
    const at = Number(record.assistant_at)
    if (!Number.isFinite(at) || !Number.isFinite(Number(latestAssistantAt)) || Math.abs(at - Number(latestAssistantAt)) > 2) return null
    return normalizeStatus(record)
  }
}
