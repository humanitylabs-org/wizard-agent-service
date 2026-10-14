// Thread titles: short "Project · Feature" names that stay put until the work really changes.
//
// The agent proposes a title in its hidden status line ([WIZARD_STATUS_V1] {..., "title": ...}) and is
// told to repeat the current title exactly unless the thread moved to a different project or feature.
// The Agent Service applies a changed proposal once per final reply through Hermes's own session PATCH,
// so Hermes stays the canonical title. Every rename is remembered here so the chat list can show
// "was: <old title>" for a few days and the thread can say "Renamed from …".
//
// A title the owner sets (a rename from a Wizard client, or any user-authority title Hermes holds
// that the agent did not write) locks the thread: the agent's proposals are ignored from then on.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const TITLE_MAX = 40
// A title that was on screen for less than this before being replaced was never a recognition anchor
// (typically the opener's sentence title, replaced by the first final reply), so the thread marks no rename.
export const ANCHOR_SECONDS = 30 * 60
const HISTORY_MAX = 8
const ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/
const LEADING_VERB = /^(?:review|reviewing|fix|fixing|build|building|send|sending|make|making|add|adding|create|creating|update|updating|check|checking|find|finding|help|helping|investigate|investigating|explore|exploring|discuss|discussing|plan|planning|set up|setting up|setup|write|writing)\s+/iu

export const TITLE_INSTRUCTIONS = 'title names the thread on the chat list: the project, then the feature or piece of work, written "Project · Feature" in two to four words and at most 32 characters (for example "Garden · Watering plan" or "Wizard OS · Thread titles"). It is a label, never a sentence: no leading verb such as Review, Fix, Build or Send, no trailing period, no emoji. Return the thread\'s current title exactly while the work stays on the same project and feature; progress, fixes and refinements never change it. Give a new title only when the thread has moved to a different project or feature, or when the current title is a sentence or does not follow this form.'

const squash = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, '').replace(/\s+/gu, ' ').trim()

// A proposed title, made safe and compact, or '' when it is unusable.
export function normalizeTitle(value) {
  let title = squash(value).replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, '').replace(/[.!?。]+$/u, '').trim()
  if (!title) return ''
  // "Project - Feature" / "Project: Feature" / "Project — Feature" → "Project · Feature"
  title = title.replace(/\s+(?:[-–—|:]|·|•)\s+/gu, ' · ').replace(/^([^·:]{2,24}):\s+/u, '$1 · ')
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX + 1)
    const space = cut.lastIndexOf(' ')
    title = (space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut.slice(0, TITLE_MAX)).replace(/[\s·,;:–—-]+$/u, '')
  }
  return title
}

export const titleKey = (value) => squash(value).toLocaleLowerCase().replace(/\s*(?:#\d+)$/u, '')

// Sentence-like titles (the opener's auto title) that should give way to a project label.
export function looksLikeSentence(title) {
  const text = squash(title)
  if (!text) return true
  if (LEADING_VERB.test(text)) return true
  return text.split(' ').length > 6 && !text.includes('·')
}

export function readSessionTitle(sessionDbPath, sessionId) {
  if (!sessionDbPath || !existsSync(sessionDbPath) || typeof sessionId !== 'string' || !ID.test(sessionId)) return null
  let database
  try {
    database = new DatabaseSync(sessionDbPath, { readOnly: true })
    const columns = new Set(database.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name))
    const row = database.prepare(`SELECT title, started_at${columns.has('title_source') ? ', title_source' : ''} FROM sessions WHERE id = ?`).get(sessionId)
    if (!row) return null
    return {
      title: typeof row.title === 'string' ? row.title : '',
      startedAt: Number(row.started_at) || 0,
      source: columns.has('title_source') ? (typeof row.title_source === 'string' ? row.title_source : null) : 'llm',
    }
  } catch {
    return null
  } finally {
    try { database?.close() } catch { /* already closed */ }
  }
}

// The per-run reminder: what the thread is called now, so the agent can keep it exactly. The owner's name
// comes from Wizard OS settings (owner.name); without one the line says "The owner".
export function titleContextLine(current, record, ownerName = '') {
  const title = squash(current)
  // No person's name here: this line reaches every owner's agent, and a fixed title may come from code (onboarding).
  if (record?.locked) return `This thread is titled “${title}”, and that title is fixed: put exactly that in the status line's title.`
  if (!title) return 'This thread has no title yet: give one in the status line.'
  return `This thread is currently titled “${title}”.`
}

const validEntry = (entry) => entry && typeof entry.from === 'string' && typeof entry.to === 'string'
  && Number.isFinite(entry.at) && ['agent', 'you'].includes(entry.by)

export class ThreadTitleStore {
  constructor(statePath = '', { now = () => Date.now() / 1000 } = {}) {
    this.statePath = statePath
    this.now = now
    this.threads = {}
    this.mtime = -1
    this.load()
  }

  load() {
    if (!this.statePath || !existsSync(this.statePath)) return this.threads
    try {
      const { mtimeMs } = statSync(this.statePath)
      if (mtimeMs === this.mtime) return this.threads
      const data = JSON.parse(readFileSync(this.statePath, 'utf8'))
      const threads = {}
      if (data?.schema === 1 && data.threads && typeof data.threads === 'object') {
        for (const [id, record] of Object.entries(data.threads)) {
          if (!ID.test(id) || !record || typeof record !== 'object') continue
          threads[id] = {
            title: typeof record.title === 'string' ? record.title : '',
            locked: record.locked === true,
            appliedFor: Number.isFinite(record.appliedFor) ? record.appliedFor : null,
            history: Array.isArray(record.history) ? record.history.filter(validEntry).slice(-HISTORY_MAX) : [],
          }
        }
      }
      this.threads = threads
      this.mtime = mtimeMs
    } catch { /* keep the last good copy */ }
    return this.threads
  }

  get(sessionId) {
    const record = this.load()[sessionId]
    return record ? structuredClone(record) : null
  }

  _save(threads) {
    if (this.statePath) {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
      const temporary = `${this.statePath}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ schema: 1, threads }), { mode: 0o600 })
      renameSync(temporary, this.statePath)
      try { this.mtime = statSync(this.statePath).mtimeMs } catch { this.mtime = -1 }
    }
    this.threads = threads
  }

  _put(sessionId, record) {
    if (!ID.test(sessionId)) throw Object.assign(new Error('Invalid session id'), { status: 400 })
    this._save({ ...this.load(), [sessionId]: record })
    return structuredClone(record)
  }

  // The agent's proposal for this reply was considered; nothing changed.
  markConsidered(sessionId, assistantAt) {
    const current = this.get(sessionId) ?? { title: '', locked: false, appliedFor: null, history: [] }
    if (current.appliedFor === assistantAt) return current
    return this._put(sessionId, { ...current, appliedFor: assistantAt })
  }

  // A rename that reached Hermes. `since` is when the old title first appeared (session start for the
  // first rename), so a title that was barely on screen leaves no mark in the thread.
  recordRename(sessionId, { from, to, by, assistantAt = null, since = null }) {
    const at = this.now()
    const current = this.get(sessionId) ?? { title: '', locked: false, appliedFor: null, history: [] }
    const shownSince = current.history.at(-1)?.at ?? since ?? 0
    const quiet = by === 'you' || !squash(from) || (shownSince > 0 && at - shownSince < ANCHOR_SECONDS)
    const entry = { from: squash(from), to: squash(to), at, by, ...(quiet ? { quiet: true } : {}) }
    return this._put(sessionId, {
      title: entry.to,
      locked: current.locked || by === 'you',
      appliedFor: assistantAt ?? current.appliedFor,
      history: [...current.history, entry].slice(-HISTORY_MAX),
    })
  }

  // Renames the thread view can mark in place ("Renamed from …"), oldest first.
  visibleHistory(sessionId) {
    return (this.load()[sessionId]?.history ?? []).filter((entry) => !entry.quiet).map(({ from, to, at, by }) => ({ from, to, at, by }))
  }
}

// Decide whether an agent proposal renames the thread. Returns the title to apply, or ''.
export function titleToApply({ currentTitle, proposed, record, assistantAt }) {
  if (!proposed || record?.locked) return ''
  if (assistantAt !== null && assistantAt !== undefined && record?.appliedFor === assistantAt) return ''
  const next = normalizeTitle(proposed)
  if (!next || next.length < 3) return ''
  if (titleKey(next) === titleKey(currentTitle)) return ''
  return next
}
