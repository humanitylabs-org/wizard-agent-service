// Thread status: what a finished thread asks of its owner, written by the agent at the end of its
// final reply and shown on the Wizard chat list (Ready: needs you / test this / done / FYI).
//
// The agent ends a final reply with one hidden line:
//   [WIZARD_STATUS_V1]{"state":"needs_you","ask":"Decide whether to ship desks","subject":"Wizard OS"}[/WIZARD_STATUS_V1]
// Clients never see the marker: it is stripped from history and previews and served as
// `wizard_attention` on the session list. Threads answered before the tag existed can carry a
// one-off backfill record that applies only while that exact reply is still the latest one.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isSilentResult, isScheduleInput } from './scheduler.mjs'
import { heavyResultOwed } from './heavy-wait.mjs'
export { SUPERVISOR_SPELL } from './supervisor.mjs'
import { migrateOptionalJson, qualifyRawThreadRecords, sideKey } from './thread-reference.mjs'
import { TITLE_INSTRUCTIONS, normalizeTitle } from './thread-titles.mjs'
import { SUBJECT_RULE } from './thread-subjects.mjs'
import { normalizeAppId, metadataAppId } from './thread-app-provenance.mjs'
import { normalizeSpaceId, SPACE_INSTRUCTIONS } from './thread-spaces.mjs'

export const STATUS_STATES = new Set(['needs_you', 'check', 'done', 'fyi'])
const MARKER = /\[WIZARD_STATUS_V1\]\s*([\s\S]*?)\s*\[\/WIZARD_STATUS_V1\]/giu
const OPEN_MARKER = /\[WIZARD_STATUS_V1\][\s\S]*$/u

// Keep the reply-length rule before status instructions in both runtime prompts: the status
// marker still governs the final line. Replies are concise prose, not a fixed report template.
export const CONCISE_REPLY_INSTRUCTIONS = 'Keep final replies as short as the content allows. Lead with the answer or result in plain prose; mention what was verified, what is still open, or what the user must do only when it matters. Never use a fixed template or labelled sections (such as What I did / Does it work / Still open); add lists, tables or headings only when the content genuinely needs them.'

export const SUMMARY_REPLY_INSTRUCTIONS = 'When a final reply finishes, fixes, ships or stages work (state done, check, or needs_you after work), format it as a finish report: first one plain verdict sentence in bold, with no label; then short paragraphs of one to three sentences, each starting with a bold label, in this order, leaving out any label with nothing to say: **What was wrong:** (fixes only), **What I did:**, **Does it work:** (the check that actually ran and what it returned, never "should work"), **What you need to do:** (one action; the same as the status ask when state is needs_you), **Still open:** (at most three bullets, each naming who owns it). No other headings, tables or recap; links sit inside the paragraph they belong to. Conversation, quick answers, ideation, interim progress and background-handoff messages stay free-form, and a reply that fits in three sentences never uses this format.' + ' Briefly restate what we are doing so someone opening the thread cold understands the original request and the result.'

// Existing installs and callers without a preference keep the Summary contract.
export const FINISH_REPORT_INSTRUCTIONS = SUMMARY_REPLY_INSTRUCTIONS
export const finishReportInstructions = style => style === 'concise' ? CONCISE_REPLY_INSTRUCTIONS : SUMMARY_REPLY_INSTRUCTIONS

// Hermes-only extension: callers for other agents retain the shared finish contract verbatim.
export const OWNED_OPEN_WORK_INSTRUCTIONS = 'Under **Still open:**, every bullet you own must name its live handle and when it lands (running now, scheduled for <time>, or queued job). Dispatch agent-owned follow-ups within existing authority in this same turn; never offer them as a question or say "say the word". Only owner decisions, money, external sends, or wider authority may be asked of the owner.'

export const STATUS_INSTRUCTIONS = 'End every final reply with one status line for the Wizard chat list, alone on the last line, exactly in this form: [WIZARD_STATUS_V1]{"state":"needs_you","ask":"Decide whether to ship the desks preview","subject":"Wizard OS","title":"Wizard OS · Desks"}[/WIZARD_STATUS_V1]. Wizard hides it from the user. state is one of: needs_you (only when the work cannot move until the user does one specific thing: decide, approve, reply, install, or act; an optional next step or an idea you could pursue is not needs_you, use done or fyi), done (the request is finished and you verified it yourself, including a bug the user reported that you fixed and tested; a suggestion to try it never makes it check), check (only when the user\'s own judgment is the missing piece: whether a new feature or design is what they meant, whether they like it (look, feel, wording, taste), or a real-device behaviour you could not verify yourself; and only once the change is already running where the user will try it: live on the server they use, or for a phone or desktop app update, confirmed installed on their device. While a build, publish or self-update is still on its way, use fyi, keep checking, and send check only after it has landed), fyi (an answer, report, or update with no action). ask is what the Ready list shows, read cold by someone who has not opened the thread: one or two short plain sentences, at most 140 characters. For needs_you, first say what is waiting in everyday words, then the exact thing to do (\"Phone update for everyone is ready. Reply ship to send it\", \"Two desk layouts to choose from. Pick A or B\"); if the action is a reply word, the sentence says what that word does. For check, say what changed and what to judge (\"New chat groups are live. Say if the 11 groups feel right\"), never \"Test that X works\". For done and fyi, state the outcome in plain words. Never put internal words in ask: no PR, issue or version numbers, branch, flag, script, job, file or app IDs, and no team jargon such as lane, gate, waive, receipt, cutover, soak, parity or unblock; never a vague \"Review this\" or \"Let me know\". The reply itself ends with the same ask in plain words. ' + SUBJECT_RULE + ' ' + TITLE_INSTRUCTIONS + ' ' + SPACE_INSTRUCTIONS + ' Leave the line out of interim progress messages and when ending a turn to wait for background helpers. A background handoff is still agent-owned work, never a done/FYI result. Before saying work is running, verify the actual worker and its continuation/delivery handle. If a terminal tool says completion notifications are unsupported, stay in the owning turn and wait for its result or arrange and verify a durable continuation; an untracked background process does not finish the request. Return to the owner with a self-contained verified outcome or one concrete owner-only gate, not a promise to resume.'

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
  return { state: mapped, ask, ...(subject ? { subject } : {}), ...(title ? { title } : {}), ...(appId ? { app_id: appId } : {}), ...(normalizeSpaceId(value.space) ? { space: value.space } : {}) }
}

// The last status marker in a reply, or null.
export function parseStatus(text) {
  if (typeof text !== 'string' || !text.includes('[WIZARD_STATUS_V1]')) return null
  let found = null
  for (const match of text.matchAll(MARKER)) {
    found = null
    try { found = normalizeStatus(JSON.parse(match[1])) } catch { /* malformed: ignore */ }
  }
  if (text.replace(MARKER, '').match(OPEN_MARKER)) return null
  return found
}

// Apply after parsing/backfill, including cached rows: heavy work can change
// independently of the assistant's final reply. An owner decision still wins.
export function guardHeavyStatus(status, { jobs = [], agentId = 'hermes', sessionId = '', isDelivered = () => false } = {}) {
  if (!['done', 'check'].includes(status?.state)) return status
  const pending = jobs?.some(job => (job.agent_id ?? 'hermes') === agentId
    && (job.sessionId ?? job.session_id) === sessionId && heavyResultOwed(job, isDelivered))
  return pending ? { ...status, state: 'fyi', ask: 'Background work is still running or waiting to report back.' } : status
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
  if (typeof value === 'string') return isSilentResult(value) || isScheduleInput(value) ? '' : stripStatus(value)
  if (Array.isArray(value)) return value.map((item) => stripStatusDeep(item, depth + 1))
  if (value && typeof value === 'object') {
    const role = value.role ?? value.author
    const content = value.content ?? value.text ?? value.output
    if ((role === 'assistant' && isSilentResult(content)) || (role === 'user' && isScheduleInput(content))) {
      return { ...(value.id ? { id: value.id } : {}), role: 'system', display_kind: 'hidden', content: '', display_content: '', shareable: false }
    }
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = stripStatusDeep(item, depth + 1)
    return out
  }
  return value
}

export function projectStatusMarkers(result) {
  if (!Buffer.isBuffer(result) || !['WIZARD_STATUS_V1', '[SILENT]', '[Wizard schedule]'].some(marker => result.includes(marker))) return result
  try { return Buffer.from(JSON.stringify(stripStatusDeep(JSON.parse(result.toString('utf8'))))) } catch { return result }
}

// One-off classifications for replies written before the tag existed:
// { "threads": { "<session id>": { "state", "ask", "subject", "assistant_at": <epoch seconds> } } }
export class StatusBackfill {
  constructor(path) {
    this.path = path || ''
    this.migrationReady = migrateOptionalJson(this.path, value => value.threads && typeof value.threads === 'object' && !Array.isArray(value.threads) ? { ...value, threads: qualifyRawThreadRecords(value.threads) } : value)
    this.mtime = -1
    this.threads = {}
  }

  load() {
    if (!this.migrationReady || !this.path || !existsSync(this.path)) { this.threads = {}; return this.threads }
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
