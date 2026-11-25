// Replies from WizardOS into chats a messaging app owns (wizard-agent-service issue 427; on for everyone, env
// WIZARD_MESSAGING_REPLIES=0 turns it off).
//
// Hermes lets only the Telegram/Slack/... connection write into a chat that connection started: an API turn into it
// is a second writer (newer Hermes refuses it with permission_denied, gateway/session_api_turn.py). So a WizardOS reply
// to such a chat never goes to /v1/runs. It waits here, in a small durable outbox, until the wizard-os Hermes plugin
// inside the gateway takes it (POST /wizard/internal/messaging-replies/take), posts a one-line "From WizardOS" note in
// that chat and hands the text to stock Hermes `PluginContext.inject_message(text, session_key=...)`: the chat's own
// adapter runs the turn, so the answer lands in the messaging app and in the same Hermes session, and the connection
// stays the only writer. The plugin reports back (POST .../done); the run's answer is then read from state.db.
//
// One reply = one item id (`wizmr_<32 hex>`), which is also the run's upstream id. The plugin keeps its own ledger of
// injected ids, so a lost acknowledgement or a second take never injects the same text twice.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const MESSAGING_RUN_PREFIX = 'wizmr_'
const RUN_ID = /^wizmr_[0-9a-f]{32}$/u

// Hermes session sources that belong to a messaging connection (the shell's FOREIGN_APPS list, wizard-ux chat-models.js).
export const MESSAGING_SOURCES = new Set(['telegram', 'slack', 'discord', 'whatsapp', 'whatsapp_cloud', 'signal', 'matrix',
  'mattermost', 'email', 'sms', 'bluebubbles', 'feishu', 'dingtalk', 'wecom', 'weixin', 'qqbot'])

// How long the plugin has to take a reply before the owner hears it did not go (no gateway, an older plugin).
export const TAKE_TIMEOUT_MS = 90_000
// A taken reply the plugin never acknowledged is offered again after this (its own ledger keeps it to one inject).
export const CLAIM_TTL_MS = 30_000
// How long an injected turn may take to answer before the run reads failed.
export const ANSWER_TIMEOUT_MS = 20 * 60_000
const KEEP_DONE_MS = 24 * 60 * 60_000
const MAX_ITEMS = 500
const MAX_TEXT = 16_000

export const NOT_TAKEN_ERROR = 'WizardOS couldn’t reach this chat’s messaging connection. Your message is saved. Try again in a minute.'
export const MOVED_ON_ERROR = 'This chat moved on in its messaging app while your reply waited. Your message is saved. Send it again to continue here.'
export const NO_ANSWER_ERROR = 'The reply reached the messaging app, but no answer came back here. Check the chat there.'
export const FILES_ERROR = 'Photos and files can’t be sent into a chat that lives in a messaging app yet. Your message is saved. Send the words on their own.'

export const isMessagingRunId = (id) => typeof id === 'string' && RUN_ID.test(id)

const openRead = (path) => new DatabaseSync(path, { readOnly: true })

/**
 * The messaging chat a Hermes session belongs to, or null when it is not one (or state.db can't say).
 * `current`: true when the session is still its conversation key's live session, false when the key moved on (a /new
 * in the app), null when Hermes keeps no routing table to tell.
 */
export function readMessagingSession(path, sessionId) {
  if (!path || typeof sessionId !== 'string' || !sessionId) return null
  let db
  try {
    db = openRead(path)
    const row = db.prepare('SELECT source, session_key, chat_id, chat_type, thread_id, ended_at, end_reason FROM sessions WHERE id = ?').get(sessionId)
    const source = String(row?.source || '').toLowerCase()
    if (!row || !MESSAGING_SOURCES.has(source)) return null
    const key = typeof row.session_key === 'string' ? row.session_key : ''
    let current = null
    if (key) {
      try {
        const routing = db.prepare('SELECT data FROM gateway_routing WHERE session_key = ?').all(key)
        if (routing.length) {
          current = routing.some(entry => { try { return JSON.parse(entry.data)?.session_id === sessionId } catch { return false } })
        }
      } catch { current = null }
    }
    if (row.ended_at && current !== true) current = false
    return { source, sessionKey: key, chatId: row.chat_id == null ? '' : String(row.chat_id),
      chatType: row.chat_type || '', threadId: row.thread_id == null ? '' : String(row.thread_id), current }
  } catch { return null }
  finally { try { db?.close() } catch { /* closed */ } }
}

/**
 * The injected reply in state.db: `user` when its owner row is there, `answer` = the first final assistant row after it.
 * Anchored at the injection time (the gateway's clock, the same one Hermes stamps rows with), so an earlier identical
 * message ("yes" twice) and its answer are never taken for this one.
 */
export function readInjected(path, sessionId, text, sinceSeconds) {
  const none = { user: false, answer: null }
  if (!path) return none
  let db
  try {
    db = openRead(path)
    // SELECT *: older Hermes schemas lack some columns (tool_calls, display_kind); a missing one reads undefined.
    const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? AND timestamp >= ? ORDER BY id LIMIT 400')
      .all(sessionId, Number(sinceSeconds) || 0)
    const want = String(text || '').trim()
    const user = rows.find(row => row.role === 'user' && String(row.content || '').trim() === want)
    if (!user) return none
    for (const row of rows) {
      if (row.id <= user.id) continue
      if (row.role !== 'assistant' || row.tool_calls) continue
      if (['commentary', 'hidden'].includes(row.display_kind)) continue
      const content = typeof row.content === 'string' ? row.content.trim() : ''
      if (!content) continue
      return { user: true, answer: { messageId: row.id, userMessageId: user.id, text: content, at: Number(row.timestamp) || 0 } }
    }
    return { user: true, answer: null }
  } catch { return none }
  finally { try { db?.close() } catch { /* closed */ } }
}

export const readInjectedAnswer = (path, sessionId, text, sinceSeconds) => readInjected(path, sessionId, text, sinceSeconds).answer

export class MessagingReplies {
  constructor(path, { now = Date.now } = {}) {
    this.path = path || ''
    this.now = now
    this.items = []
    this.notes = new Set()
    this._load()
  }

  _load() {
    if (!this.path || !existsSync(this.path)) return
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'))
      this.items = Array.isArray(data?.items) ? data.items.filter(item => isMessagingRunId(item?.id)) : []
      this.notes = new Set(Array.isArray(data?.notes) ? data.notes.filter(id => typeof id === 'string') : [])
    } catch { this.items = []; this.notes = new Set() }
  }

  _save() {
    if (!this.path) return
    const now = this.now()
    this.items = this.items.filter(item => !item.finishedAt || now - item.finishedAt < KEEP_DONE_MS).slice(-MAX_ITEMS)
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items, notes: [...this.notes].slice(-2000) }), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  get(id) { return this.items.find(item => item.id === id) || null }
  byRun(runId) { return this.items.find(item => item.runId === runId) || null }
  pending() { return this.items.filter(item => ['queued', 'taken'].includes(item.state)).length }

  /** One reply for the plugin to inject (kind 'inject'), or a one-off "continued in WizardOS" note (kind 'note'). */
  add({ kind = 'inject', runId = '', sessionId, chat, text = '' }) {
    if (runId) { const existing = this.byRun(runId); if (existing) return existing }
    if (kind === 'note') {
      if (this.notes.has(sessionId) || this.items.some(item => item.kind === 'note' && item.sessionId === sessionId)) return null
    }
    const item = {
      id: `${MESSAGING_RUN_PREFIX}${randomBytes(16).toString('hex')}`, kind, runId, sessionId,
      platform: chat.source, sessionKey: chat.sessionKey, chatId: chat.chatId, chatType: chat.chatType, threadId: chat.threadId,
      text: String(text).slice(0, MAX_TEXT), state: 'queued', createdAt: this.now(), takenAt: 0, attempts: 0,
      injectedAt: 0, finishedAt: 0, error: '', answer: null,
    }
    this.items.push(item)
    this._save()
    return item
  }

  /** What the plugin may work on now: queued items, and taken ones it never acknowledged (same id again). */
  take(limit = 10) {
    const now = this.now()
    const out = []
    let changed = false
    for (const item of this.items) {
      if (out.length >= limit) break
      const offer = item.state === 'queued' || (item.state === 'taken' && now - item.takenAt >= CLAIM_TTL_MS)
      if (!offer) continue
      item.state = 'taken'; item.takenAt = now; item.attempts += 1; changed = true
      out.push({ id: item.id, kind: item.kind, session_id: item.sessionId, session_key: item.sessionKey,
        platform: item.platform, chat_id: item.chatId, chat_type: item.chatType, thread_id: item.threadId, text: item.text })
    }
    if (changed) this._save()
    return out
  }

  /** The plugin's report: injected (with the time it did), older (the key moved on), noted, or failed. */
  done(id, result = {}) {
    const item = this.get(id)
    if (!item) return null
    if (!['queued', 'taken'].includes(item.state)) return item // a repeated acknowledgement changes nothing
    const status = String(result.status || '')
    const now = this.now()
    if (item.kind === 'note') {
      item.state = status === 'noted' ? 'noted' : 'failed'; item.finishedAt = now
      if (item.state === 'noted') this.notes.add(item.sessionId)
    } else if (status === 'injected') {
      item.state = 'injected'
      const at = Number(result.at) * 1000
      item.injectedAt = Number.isFinite(at) && Math.abs(at - now) < 86_400_000 ? at : now
    } else if (status === 'older') {
      item.state = 'failed'; item.error = MOVED_ON_ERROR; item.finishedAt = now
    } else {
      item.state = 'failed'; item.error = NOT_TAKEN_ERROR; item.finishedAt = now
    }
    this._save()
    return item
  }

  /** The run status of an inject item, reading its answer from state.db once injected. */
  status(id, hermesStatePath) {
    const item = this.get(id)
    if (!item) return { status: 'failed', error: NOT_TAKEN_ERROR }
    const now = this.now()
    if (item.state === 'answered') return { status: 'completed', output: item.answer?.text || '' }
    if (item.state === 'failed') return { status: 'failed', error: item.error || NOT_TAKEN_ERROR }
    if (['queued', 'taken'].includes(item.state)) {
      if (now - item.createdAt < TAKE_TIMEOUT_MS) return { status: 'running' }
      // Nothing reported in time. A worker that stopped after injecting but before reporting left the owner's words in
      // the chat: then this is that turn (its answer or still waiting), never a failure that invites a second send.
      const seen = item.state === 'taken' ? readInjected(hermesStatePath, item.sessionId, item.text, item.createdAt / 1000 - 5) : { user: false }
      if (!seen.user) {
        item.state = 'failed'; item.error = NOT_TAKEN_ERROR; item.finishedAt = now; this._save()
        return { status: 'failed', error: item.error }
      }
      item.state = 'injected'; item.injectedAt = item.createdAt - 5000; this._save()
    }
    // injected: the turn runs in the messaging connection; its answer is the next final assistant row.
    const answer = readInjectedAnswer(hermesStatePath, item.sessionId, item.text, item.injectedAt / 1000 - 1)
    if (answer) {
      item.state = 'answered'; item.answer = answer; item.finishedAt = now; this._save()
      return { status: 'completed', output: answer.text }
    }
    if (now - item.injectedAt >= ANSWER_TIMEOUT_MS) {
      item.state = 'failed'; item.error = NO_ANSWER_ERROR; item.finishedAt = now; this._save()
      return { status: 'failed', error: item.error }
    }
    return { status: 'running' }
  }
}
