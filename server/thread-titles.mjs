// Thread titles: broad project homes, stable across every sub-ask, feature and fix.
//
// The agent proposes a title in its hidden status line ([WIZARD_STATUS_V1] {..., "title": ...}) and is
// told to repeat the current title exactly unless the project itself changes (or a legacy title needs broadening).
// The Agent Service applies a changed proposal once per final reply through Hermes's own session PATCH,
// so Hermes stays the canonical title. Every rename is remembered for the in-thread "Renamed from …" note.
//
// A title the owner sets (a rename from a Wizard client, or any user-authority title Hermes holds
// that the agent did not write) locks the thread: the agent's proposals are ignored from then on.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateOptionalJson, atomicStoreWrite, qualifyRawThreadRecords } from './thread-reference.mjs'
import { misspellsProductName, spellProductName } from './product-name.mjs'

export const TITLE_MAX = 32
// A title that was on screen for less than this before being replaced was never a recognition anchor
// (typically the opener's sentence title, replaced by the first final reply), so the thread marks no rename.
export const ANCHOR_SECONDS = 30 * 60
const HISTORY_MAX = 8
const ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/
const LEADING_VERB = /^(?:review|reviewing|fix|fixing|build|building|send|sending|make|making|add|adding|create|creating|update|updating|check|checking|find|finding|help|helping|investigate|investigating|explore|exploring|discuss|discussing|plan|planning|set up|setting up|setup|write|writing|troubleshoot|troubleshooting|debug|debugging|diagnose|test|testing|ship|shipping|deploy|deploying|rename|renaming|retitle|look into|looking into|get|getting)\s+/iu

export const TITLE_INSTRUCTIONS = "title names the thread on the chat list: a broad project-level label for the home where the owner can keep all related work, in one to four words and at most 32 characters. Name one app (\"Messenger\", \"Video Editor\", \"DeFleur\"), one long-lived surface of a bigger product (\"WizardOS · Desktop\", \"WizardOS · Phone app\", \"WizardOS · Voice\"), or one sustained project or life area (\"TSR podcast\", \"Tokyo trip\"). Use \" · \" only for a long-lived surface or area of a bigger product, never for a feature, fix, bug, ask or task: not \"Messenger · Settings buttons\" or \"WizardOS · Pane fix\". It is a label, never a sentence: no leading verb such as Review, Fix, Build or Send, no trailing period, no emoji. Return the thread's current title exactly as long as the work still belongs to that project, however many sub-asks, features or fixes pass through. Give a new title only when the project itself changes. Exception: a title naming a single feature, fix or sub-task is outdated; replace it once with its project as a one-time broadening, not with another feature. Also replace a sentence title with its project label. When the reply reports work in an installed app (app_id), the title is that app's plain name (\"Messenger\", \"Music\", \"Notes\"): no \"WizardOS ·\" prefix, no number. Never use the owner's own opening words or any sentence fragment. The product name is one word, WizardOS, in every title. Owner-set titles stay fixed."

const squash = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, '').replace(/\s+/gu, ' ').trim()

// A proposed title, made safe and compact, or '' when it is unusable.
export function normalizeTitle(value) {
  let title = spellProductName(squash(value)).replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, '').replace(/[.!?。]+$/u, '').trim()
  if (!title) return ''
  // Normalize legacy separators; their meaning is governed by the project-level instructions.
  title = title.replace(/\s+(?:[-–—|:]|·|•)\s+/gu, ' · ').replace(/^([^·:]{2,24}):\s+/u, '$1 · ')
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX + 1)
    const space = cut.lastIndexOf(' ')
    title = (space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut.slice(0, TITLE_MAX)).replace(/[\s·,;:–—-]+$/u, '')
  }
  return title
}

// A quick placeholder title from the owner's first message, so a new thread is never "Untitled chat" while its
// first reply is still being written. Deterministic and instant; the agent's own status-line title replaces it.
const FIRST_FILLER = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|well|um+|uh+|right|yeah|yes|no|what\??|please|pls|can you|could you|would you|will you|i(?:'d| would)? (?:like|want|need) (?:you )?to|i want|i need|i(?:'m| am) (?:trying|going) to|let's|lets|just|also|and|then|the|a|an)\b[\s,.!?:;-]*)+/iu
const LAST_FILLER = /[\s,.;:!?-]+(?:and|or|but|the|a|an|to|of|for|in|on|at|with|so|that|is|it|i|my|me)$/iu
export function provisionalTitleFrom(text, catalog = null) {
  const opener = openerWordsFrom(text)
  if (!catalog) return opener
  // An app is the topic only when the opener is about it (issue 726): named in the opener's own first words, or
  // written as "<Name> app" anywhere. A plain-word app name (Photos, Files) used in passing later never wins.
  const whole = String(text ?? '').replace(/\[(WIZARD_[A-Z0-9_]+)\][\s\S]*?\[\/\1\]/gu, ' ').replace(/\[Wizard ?OS context\][\s\S]*$/u, ' ')
  return (opener && appTopicInText(opener, catalog)) || appTopicInText(whole, catalog, { appWord: true }) || opener
}
function openerWordsFrom(text) {
  let line = String(text ?? '')
    .replace(/\[(WIZARD_[A-Z0-9_]+)\][\s\S]*?\[\/\1\]/gu, ' ')
    .replace(/\[Wizard ?OS context\][\s\S]*$/u, ' ')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/[*_#>`~]+/gu, ' ')
  line = squash(line.split(/\n/u).map(part => part.trim()).find(part => /[\p{L}\p{N}]{2,}/u.test(part)) ?? '')
  if (!line) return ''
  line = line.split(/(?<=[.!?])\s/u).find(part => /[\p{L}\p{N}]{3,}/u.test(part.replace(FIRST_FILLER, ''))) ?? line
  line = line.replace(FIRST_FILLER, '').trim()
  const words = line.split(/\s+/u).filter(Boolean).slice(0, 5)
  if (words.length < 1) return ''
  let title = words.join(' ')
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX + 1)
    const space = cut.lastIndexOf(' ')
    title = space > 8 ? cut.slice(0, space) : cut.slice(0, TITLE_MAX)
  }
  title = title.replace(LAST_FILLER, '').replace(/[\s·,;:–—'"“”‘’!?.-]+$/u, '').trim()
  title = normalizeTitle(title)
  if (title.length < 3) return ''
  return title.charAt(0).toLocaleUpperCase() + title.slice(1)
}

// Stripped when comparing, so a numbered or dated clash suffix never reads as a different project.
const CLASH_SUFFIX = /\s*(?:#\d+|\(\d{1,2} [A-Za-z]{3}(?: \d{2}:\d{2}(?: [a-z0-9]{1,4})?)?\))$/u
export const titleKey = (value) => squash(value).toLocaleLowerCase().replace(CLASH_SUFFIX, '')

// Sentence-like titles (the opener's auto title) that should give way to a project label.
export function looksLikeSentence(title) {
  const text = squash(title)
  if (!text) return true
  if (LEADING_VERB.test(text)) return true
  return text.replace(CLASH_SUFFIX, '').split(/\s+/u).filter(word => word !== '·').length > 4
}

// A title that is not a label (issue 694): a leading verb (a task line), more than six words outside a " · " surface,
// sentence punctuation inside, a cut-off ending, or longer than the cap. Used to refuse proposals on every agent and to
// spot a current title that must give way to a label.
export function isSentenceTitle(title) {
  const text = squash(title).replace(CLASH_SUFFIX, '')
  if (!text) return false
  if (text.length > TITLE_MAX || LEADING_VERB.test(text) || /(?:…|\.\.\.)$/u.test(text)) return true
  const words = text.split(/\s+/u).filter(word => word !== '·')
  if (!text.includes(' · ') && words.length > 6) return true
  return /[.!?;](?:\s|$)|,\s/u.test(text.replace(/[.!?]+$/u, ''))
}

// A short label cut from a sentence title (issue 694): the first clause, leading verb and filler dropped, stopping at
// the first connector, at most four words and TITLE_MAX characters. '' when nothing label-like is left.
const LABEL_FILLER = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'some', 'any', 'all', 'everything', 'anything', 'something', 'every', 'me', 'us', 'you', 'i', 'we', 'it', 'right', 'now', 'today', 'please', 'pls', 'just', 'really', 'again', 'quickly', 'also', 'maybe', 'bro', 'hey', 'hi', 'yo', 'ok', 'okay', 'so', 'well', 'actually', 'can', 'could', 'would', 'will', 'let\'s', 'lets', 'take', 'look', 'quick'])
const LABEL_STOP = new Set(['after', 'before', 'when', 'while', 'because', 'to', 'for', 'in', 'on', 'at', 'with', 'from', 'into', 'about', 'of', 'by', 'via', 'and', 'or', 'but', 'if', 'then', 'than', 'which', 'who', 'where', 'why', 'how', 'is', 'are', 'was', 'were', 'be', 'am', 'do', 'does', 'did', 'not', 'what', 'tell', 'needs'])
export function labelFrom(value) {
  let line = spellProductName(squash(value)).replace(CLASH_SUFFIX, '').replace(/(?:…|\.\.\.)$/u, '')
  line = line.split(/(?<=[.!?;])\s|,\s/u).find(part => /[\p{L}\p{N}]{3,}/u.test(part)) ?? ''
  for (let before = ''; before !== line;) { before = line; line = line.replace(FIRST_FILLER, '').replace(LEADING_VERB, '').trim() }
  const out = []
  for (const raw of line.split(/\s+/u)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    const bare = word.toLocaleLowerCase().replace(/’/gu, '\'')
    if (!word || word === '·' || LABEL_FILLER.has(bare) || /^(?:i|we|you)'/u.test(bare)) continue
    if (LABEL_STOP.has(bare)) { if (out.length) break; continue }
    if ([...out, word].join(' ').length > TITLE_MAX) break
    out.push(word)
    if (out.length === 4) break
  }
  const title = normalizeTitle(out.join(' '))
  const label = title ? title.charAt(0).toLocaleUpperCase() + title.slice(1) : ''
  return label.length >= 3 && !isSentenceTitle(label) && !looksLikeOpener(label) ? label : ''
}

// Opener words, not a topic: a sentence, a first-person or conversational fragment, a comma clause.
const CHATTER = /(?:^|\s)(?:i|i'm|i'd|i've|my|me|we|you|your|our|isn't|aren't|don't|doesn't|won't|can't|couldn't|could|would|should|actually|just|bro|hey|please)(?=[\s,.]|$)|[,;?!]/iu
export function looksLikeOpener(title) {
  const text = squash(title)
  return !text || looksLikeSentence(text) || CHATTER.test(text)
}

// ---- Topic: the app or area a thread works on, from facts the Service already holds. ----
// James (8 Nov): a thread's title is a very brief general topic - the app or thing being worked on - never the
// opener's words. The agent proposes it; this is the fallback when the agent echoes the opener placeholder.
const GENERIC_APP_WORDS = new Set(['money', 'morning', 'reference', 'search', 'stories', 'outline', 'profiles', 'browser', 'tasks', 'contacts', 'notifications', 'food', 'mail', 'google', 'claude', 'calendar'])
const GENERIC_SUBJECTS = new Set(['wizard apps', 'general', 'other', 'misc', 'miscellaneous', 'none'])
const titleCase = (word) => word.charAt(0).toLocaleUpperCase() + word.slice(1)

// The plain name of an installed app (catalog [{id, name}]); a not-installed id reads as its words without the wizard- prefix.
export function appTopicName(appId, catalog = []) {
  if (typeof appId !== 'string' || !appId) return ''
  const entry = (Array.isArray(catalog) ? catalog : []).find(app => app?.id === appId)
  const named = squash(entry?.name).replace(/\s*\((?:test|agent|beta|preview)\)\s*$/iu, '').trim()
  if (named) return normalizeTitle(named)
  const words = appId.replace(/^(?:wizard|agent)-/u, '').split('-').filter(Boolean)
  return words.length ? normalizeTitle(words.map(titleCase).join(' ')) : ''
}

// An app (or WizardOS) the free text names, earliest mention first. Generic app words need the word "app" after them;
// with appWord every app name does (WizardOS never needs it).
export function appTopicInText(text, catalog = [], { appWord = false } = {}) {
  const haystack = ` ${squash(text)} `
  if (haystack.trim().length < 3) return ''
  let best = { at: Infinity, name: '' }
  const consider = (name, pattern) => {
    const at = haystack.search(pattern)
    if (at >= 0 && at < best.at) best = { at, name }
  }
  consider('WizardOS', /\bwizard ?os\b/iu)
  for (const app of Array.isArray(catalog) ? catalog : []) {
    const name = appTopicName(app?.id, catalog)
    if (name.length < 4 || name.includes(' · ')) continue
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    consider(name, new RegExp(`\\b${escaped}${appWord || GENERIC_APP_WORDS.has(name.toLocaleLowerCase()) ? '\\s+app\\b' : '\\b'}`, 'iu'))
  }
  return best.name
}

// The topic title for a status line: its app_id's app, else an app the opener names, else its subject.
export function topicFor({ appId = '', catalog = [], texts = [], subject = '' } = {}) {
  const byId = appTopicName(appId, catalog)
  if (byId) return byId
  for (const text of texts) {
    const named = appTopicInText(text, catalog)
    if (named) return named
  }
  const area = normalizeTitle(subject)
  return area && area.length >= 3 && !GENERIC_SUBJECTS.has(area.toLocaleLowerCase()) && !looksLikeOpener(area) ? area : ''
}

// The date clashCandidates adds (issue 518): '(8 Nov)', '(8 Nov 13:05)' or '(8 Nov 13:05 ab12)', never a '#N'.
const DATED_SUFFIX = /\s+\(\d{1,2} [A-Za-z]{3}(?: \d{2}:\d{2}(?: [a-z0-9]{1,4})?)?\)$/u
// Undated chat titles (issue 518, on for everyone): a dated clash title is shown without its date. Hermes keeps
// its unique stored title; only what the Service serves changes.
export const undatedTitle = (value) => {
  const title = squash(value)
  const plain = title.replace(DATED_SUFFIX, '')
  return plain.length >= 3 ? plain : title
}
// Records written before issue 518 don't say whether the Service dated a title. Its date is the day of the rename
// (clashCandidates is called with now), so only a suffix naming that day is taken as the Service's.
const datedOnDay = (value, at) => {
  const day = squash(value).match(DATED_SUFFIX)?.[0]?.match(/\((\d{1,2}) ([A-Za-z]{3})/u)
  if (!day || !Number.isFinite(at)) return false
  const when = new Date(at * 1000)
  return Number(day[1]) === when.getUTCDate() && day[2] === MONTHS[when.getUTCMonth()]
}
// The title a rename asked for, before any clash date: recorded since issue 518, else read from the date's day.
const askedTitle = (entry) => typeof entry?.asked === 'string' ? entry.asked
  : entry?.by === 'agent' && datedOnDay(entry.to, entry.at) ? undatedTitle(entry.to) : squash(entry?.to)

// A clash-free spelling of a title another thread already holds: dated, never numbered.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function clashCandidates(title, now = new Date(), salt = '') {
  const base = squash(title).replace(CLASH_SUFFIX, '')
  const day = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]}`
  const time = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
  const fit = (suffix) => `${base.slice(0, Math.max(3, TITLE_MAX - suffix.length - 1)).trimEnd()} ${suffix}`
  // The last candidate carries a per-thread tail, so two same-topic threads in one minute never share it.
  const tail = String(salt ?? '').replace(/[^a-z0-9]/giu, '').slice(-4).toLowerCase()
  return [...new Set([base, fit(`(${day})`), fit(`(${day} ${time})`), ...(tail ? [fit(`(${day} ${time} ${tail})`)] : [])])]
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

// Every stored title that spells the product as two words (WizardOS is one word), oldest first. Read-only.
export function readMisspelledTitles(sessionDbPath, limit = 5000) {
  if (!sessionDbPath || !existsSync(sessionDbPath)) return []
  let database
  try {
    database = new DatabaseSync(sessionDbPath, { readOnly: true })
    const columns = new Set(database.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name))
    const rows = database.prepare(`SELECT id, title${columns.has('title_source') ? ', title_source' : ''} FROM sessions WHERE title IS NOT NULL AND lower(title) LIKE '%wizard%os%' ORDER BY started_at LIMIT ?`).all(limit)
    return rows.filter((row) => typeof row.id === 'string' && ID.test(row.id) && misspellsProductName(row.title))
      .map((row) => ({ id: row.id, title: row.title, source: columns.has('title_source') ? (row.title_source ?? null) : 'llm' }))
  } catch {
    return []
  } finally {
    try { database?.close() } catch { /* already closed */ }
  }
}

// The per-run reminder: what the thread is called now, so the agent can keep it exactly.
export function titleContextLine(current, record) {
  const title = squash(current)
  // No person's name here: this line reaches every owner's agent, and a fixed title may come from code (onboarding).
  if (record?.locked) return `This thread is titled “${title}”, and that title is fixed: put exactly that in the status line's title.`
  if (record?.provisional && title) return `This thread's title “${title}” is only a placeholder cut from the first message, not a label: never repeat it. Put the plain name of the app or area this thread works on (for example Messenger, Music, Notes, WizardOS) in the status line's title.`
  if (!title) return 'This thread has no title yet: give its broad project label in the status line.'
  return `This thread is currently titled “${title}”. Keep it exactly for all work in this project; rename only for a different project, or broaden a legacy feature/sentence title once to its project.`
}

const validEntry = (entry) => entry && typeof entry.from === 'string' && typeof entry.to === 'string'
  && Number.isFinite(entry.at) && ['agent', 'you'].includes(entry.by)

export class ThreadTitleStore {
  constructor(statePath = '', { now = () => Date.now() / 1000 } = {}) {
    this.statePath = statePath
    this.now = now
    this.threads = {}
    this.mtime = -1
    this.migrationReady = migrateOptionalJson(statePath, value => {
      if (value?.schema !== 1 || !value.threads) throw new Error('Invalid title projection')
      return { ...value, threads: qualifyRawThreadRecords(value.threads) }
    })
    this.load()
  }

  load() {
    if (!this.migrationReady || !this.statePath || !existsSync(this.statePath)) return this.threads
    try {
      const { mtimeMs } = statSync(this.statePath)
      if (mtimeMs === this.mtime) return this.threads
      const data = JSON.parse(readFileSync(this.statePath, 'utf8'))
      const threads = {}
      if (data?.schema === 1 && data.threads && typeof data.threads === 'object') {
        for (const [id, record] of Object.entries(data.threads)) {
          if (!ID.test(id) || !record || typeof record !== 'object') continue
          threads[id] = {
            agent_id: record.agent_id ?? 'hermes', session_id: record.session_id ?? id,
            title: typeof record.title === 'string' ? record.title : '',
            locked: record.locked === true,
            ...(record.provisional === true ? { provisional: true } : {}),
            ...(typeof record.undated === 'string' ? { undated: record.undated } : {}),
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
    if (this.statePath && this.migrationReady) {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
      atomicStoreWrite(this.statePath, JSON.stringify({ schema: 1, threads }))
      try { this.mtime = statSync(this.statePath).mtimeMs } catch { this.mtime = -1 }
    }
    this.threads = threads
  }

  _put(sessionId, record) {
    if (!ID.test(sessionId)) throw Object.assign(new Error('Invalid session id'), { status: 400 })
    record = { ...record, agent_id: 'hermes', session_id: sessionId }
    this._save({ ...this.load(), [sessionId]: record })
    return structuredClone(record)
  }

  // A placeholder title from the first message. Never replaces a title that exists, an owner's lock or an agent title.
  setProvisional(sessionId, title) {
    const next = normalizeTitle(title)
    const current = this.get(sessionId)
    if (!next || current?.locked || current?.title || current?.history?.length) return null
    return this._put(sessionId, { title: next, locked: false, provisional: true, appliedFor: current?.appliedFor ?? null, history: [] })
  }

  // The placeholder reached Hermes's own session title; remember it as the agent's so the owner's lock rules stay clean.
  markProvisionalApplied(sessionId, title) {
    const current = this.get(sessionId)
    if (!current?.provisional) return null
    const at = this.now()
    return this._put(sessionId, { ...current, title, undated: squash(title), history: [{ from: '', to: title, asked: squash(title), at, by: 'agent', quiet: true }] })
  }

  // The agent's proposal for this reply was considered; nothing changed.
  markConsidered(sessionId, assistantAt) {
    const current = this.get(sessionId) ?? { title: '', locked: false, appliedFor: null, history: [] }
    if (current.appliedFor === assistantAt) return current
    return this._put(sessionId, { ...current, appliedFor: assistantAt })
  }

  // A rename that reached Hermes. `since` is when the old title first appeared (session start for the
  // first rename), so a title that was barely on screen leaves no mark in the thread.
  // `asked` is the title before the Service dated a clash (issue 518); without one the rename is exactly `to`.
  recordRename(sessionId, { from, to, by, assistantAt = null, since = null, asked = to }) {
    const at = this.now()
    const current = this.get(sessionId) ?? { title: '', locked: false, appliedFor: null, history: [] }
    const shownSince = current.history.at(-1)?.at ?? since ?? 0
    const quiet = by === 'you' || !squash(from) || (shownSince > 0 && at - shownSince < ANCHOR_SECONDS)
    const entry = { from: squash(from), to: squash(to), asked: squash(asked), at, by, ...(quiet ? { quiet: true } : {}) }
    return this._put(sessionId, {
      title: entry.to,
      undated: entry.asked,
      locked: current.locked || by === 'you',
      appliedFor: assistantAt ?? current.appliedFor,
      history: [...current.history, entry].slice(-HISTORY_MAX),
    })
  }

  // A spelling fix (WizardOS is one word) that reached Hermes: not a rename. An owner-locked title stays the owner's;
  // an agent or auto title stays the agent's (a quiet entry), so the agent may still rename it later.
  respell(sessionId, { from, to, locked = false, asked = to }) {
    const current = this.get(sessionId)
    const history = (current?.history ?? []).map((entry) => ({ ...entry, from: spellProductName(entry.from), to: spellProductName(entry.to) }))
    if (locked || current?.locked || current?.provisional) {
      if (!current) return null
      return this._put(sessionId, { ...current, title: squash(to), undated: squash(asked), history })
    }
    const entry = { from: squash(from), to: squash(to), asked: squash(asked), at: this.now(), by: 'agent', quiet: true }
    return this._put(sessionId, { title: entry.to, undated: entry.asked, locked: false, appliedFor: current?.appliedFor ?? null, history: [...history, entry].slice(-HISTORY_MAX) })
  }

  // Renames the thread view can mark in place ("Renamed from …"), oldest first. `plain` (issue 518) drops the date
  // the Service added to an agent title; a title the owner typed keeps every word.
  visibleHistory(sessionId, { plain = false } = {}) {
    const history = this.load()[sessionId]?.history ?? []
    const visible = []
    history.forEach((entry, index) => {
      let { from, to } = entry
      const { at, by, quiet } = entry
      if (quiet) return
      if (plain) {
        const before = history[index - 1]
        if (before && squash(before.to) === squash(from)) from = askedTitle(before)
        to = askedTitle(entry)
        if (squash(from) === squash(to)) return
      }
      visible.push({ from: spellProductName(from), to: spellProductName(to), at, by })
    })
    return visible
  }

  // The title to show without a date the Service added to avoid a clash (issue 518, on for everyone).
  // Only a date the Service added (the record keeps the title it asked for) is dropped: an owner's own rename, an agent
  // title that names a date itself, a title changed outside the Service, or a thread with no record is shown as is.
  plainTitle(sessionId, title) {
    if (typeof title !== 'string' || !DATED_SUFFIX.test(squash(title))) return title
    const record = this.load()[sessionId]
    if (!record || spellProductName(squash(record.title)) !== spellProductName(squash(title))) return title
    if (typeof record.undated === 'string') return spellProductName(record.undated) || title
    const last = record.history.at(-1)
    return last && squash(last.to) === squash(record.title) ? spellProductName(askedTitle(last)) || title : title
  }
}

// Decide whether an agent proposal renames the thread. Returns the title to apply, or ''.
// `topic` (main chats only; undefined leaves routed agents untouched) is the app or area the Service worked out: an
// agent that echoes the opener placeholder, or proposes opener words, gets that topic instead - or no rename.
export function titleToApply({ currentTitle, proposed, record, assistantAt, topic }) {
  if (!proposed || record?.locked) return ''
  if (assistantAt !== null && assistantAt !== undefined && record?.appliedFor === assistantAt) return ''
  let next = normalizeTitle(proposed)
  if (!next || next.length < 3) return ''
  // Issue 694: the thread must end with a label. A sentence title (the opener's, Hermes's own, or an old task line) or the
  // Service's first-message placeholder gives way even when the agent echoes it or proposes another sentence.
  const needsLabel = record?.provisional === true || isSentenceTitle(currentTitle)
  // A task line or sentence is never applied, on any agent (routed agents pass no topic).
  const sentence = isSentenceTitle(next) || isSentenceTitle(squash(proposed).replace(/[.!?。]+$/u, ''))
  if (topic !== undefined) {
    const echoedPlaceholder = record?.provisional === true && titleKey(next) === titleKey(record.title || currentTitle)
    if (echoedPlaceholder || sentence || looksLikeOpener(next)) {
      // The topic stands in only for a title that must give way; a label stays when the proposal is unusable.
      next = needsLabel ? normalizeTitle(topic) : ''
      if (!next || next.length < 3 || looksLikeOpener(next) || isSentenceTitle(next)) next = ''
    }
  } else if (sentence) next = ''
  if (!next) {
    if (!needsLabel) return ''
    next = labelFrom(proposed) || labelFrom(currentTitle) || labelFrom(record?.title)
    if (!next) return ''
  }
  const currentKey = titleKey(currentTitle)
  const nextKey = titleKey(next)
  if (nextKey === currentKey) return ''
  // A narrower proposal is not evidence of a project change. Keep the existing home
  // even if the model drifts into Project · Feature (including suffixed canonical titles).
  // Semantic project changes and legacy broadening remain the shared prompt's job.
  if (currentKey && !record?.provisional && !needsLabel && nextKey.startsWith(`${currentKey} · `)) return ''
  return next
}

// Every stored title the one-time label repair (issue 694) may look at: visible top-level threads, oldest first. Read-only.
export function readSentenceTitles(sessionDbPath, limit = 5000) {
  if (!sessionDbPath || !existsSync(sessionDbPath)) return []
  let database
  try {
    database = new DatabaseSync(sessionDbPath, { readOnly: true })
    const columns = new Set(database.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name))
    const where = ['title IS NOT NULL', ...(columns.has('hidden') ? ['COALESCE(hidden, 0) = 0'] : []), ...(columns.has('parent_session_id') ? ['parent_session_id IS NULL'] : [])]
    const rows = database.prepare(`SELECT id, title FROM sessions WHERE ${where.join(' AND ')} ORDER BY started_at LIMIT ?`).all(limit)
    return rows.filter((row) => typeof row.id === 'string' && ID.test(row.id) && isSentenceTitle(row.title)).map((row) => ({ id: row.id, title: row.title }))
  } catch {
    return []
  } finally {
    try { database?.close() } catch { /* already closed */ }
  }
}
