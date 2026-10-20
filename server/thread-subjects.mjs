// Thread subjects: the few broad areas Ready's "By subject" order groups threads under.
//
// The agent names a subject in its hidden status line. Left alone it coins a new one for every app,
// feature, meeting and one-off question, and the grouping stops compressing anything. Each install
// keeps its own short list in $WIZARD_OS_HOME/subjects.json (default ~/.wizard-os/subjects.json):
//
//   {
//     "subjects": [{ "name": "Wizard OS", "about": "the shell itself: chats, Ready, orb, settings" }, ...],
//     "aliases":  { "Wizard App": "Wizard OS", "McKenna Track": "Music" },
//     "threads":  { "<session id>": { "from": "Wizard OS", "subject": "Wizard Apps" } }
//   }
//
// - subjects: the canonical areas, in the owner's order. Every run is told this list.
// - aliases:  older or stray subject names folded into a canonical one when the list is served.
// - threads:  a one-off correction for one thread's current reply. It applies only while the agent's
//             subject for that thread is still `from`, so the next reply that names a listed subject wins.
//
// The file is re-read when it changes, so edits apply without a restart. No file means no list:
// subjects pass through exactly as the agent wrote them.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { migrateJson, qualifyRawThreadRecords, sideKey } from './thread-reference.mjs'

const SUBJECT_MAX = 40
const ABOUT_MAX = 120
const LIST_MAX = 24
const MAP_MAX = 2000
const ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/u

const clean = (value, max) => {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return text.length > max ? text.slice(0, max).trimEnd() : text
}
export const subjectKey = (value) => clean(value, SUBJECT_MAX).toLocaleLowerCase()

/** The generic rule every install gets, list or no list. */
export const SUBJECT_RULE = 'subject is the broad area the thread belongs to, one to three words, used to group threads on the chat list: a product, a sustained project, or a life area. It is never a single feature, app screen, meeting, track or one-off question; those go under the closest broader area. Reuse the subject this thread already has.'

export function normalizeSubjects(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const subjects = []
  const seen = new Set()
  for (const entry of Array.isArray(value.subjects) ? value.subjects : []) {
    const name = clean(typeof entry === 'string' ? entry : entry?.name, SUBJECT_MAX)
    if (!name || seen.has(subjectKey(name))) continue
    seen.add(subjectKey(name))
    subjects.push({ name, about: clean(typeof entry === 'object' && entry ? entry.about : '', ABOUT_MAX) })
    if (subjects.length >= LIST_MAX) break
  }
  const canonical = new Map(subjects.map((subject) => [subjectKey(subject.name), subject.name]))
  const resolveName = (name) => canonical.get(subjectKey(name)) ?? clean(name, SUBJECT_MAX)
  const aliases = new Map()
  const rawAliases = value.aliases && typeof value.aliases === 'object' && !Array.isArray(value.aliases) ? value.aliases : {}
  for (const [from, to] of Object.entries(rawAliases).slice(0, MAP_MAX)) {
    const key = subjectKey(from), target = resolveName(to)
    if (key && target && key !== subjectKey(target)) aliases.set(key, target)
  }
  const threads = new Map()
  const rawThreads = value.threads && typeof value.threads === 'object' && !Array.isArray(value.threads) ? value.threads : {}
  for (const [id, entry] of Object.entries(rawThreads).slice(0, MAP_MAX)) {
    if (!entry || typeof entry !== 'object') continue
    let pair
    try { pair = Object.values(qualifyRawThreadRecords({ [id]: entry }))[0] } catch { continue }
    if (!ID.test(pair.session_id)) continue
    const subject = resolveName(entry.subject)
    if (subject) threads.set(sideKey(pair.agent_id, pair.session_id), { from: subjectKey(entry.from), subject, agent_id: pair.agent_id, session_id: pair.session_id })
  }
  return { subjects, canonical, aliases, threads }
}

export class SubjectCatalog {
  constructor(path = '') {
    this.path = path || ''
    migrateJson(this.path, value => value.threads && typeof value.threads === 'object' && !Array.isArray(value.threads) ? { ...value, threads: qualifyRawThreadRecords(value.threads) } : value)
    this.mtime = -1
    this.data = normalizeSubjects({})
  }

  load() {
    if (!this.path || !existsSync(this.path)) { this.mtime = -1; this.data = normalizeSubjects({}); return this.data }
    try {
      const { mtimeMs, size } = statSync(this.path)
      if (mtimeMs === this.mtime) return this.data
      if (size > 256 * 1024) throw new Error('too large')
      this.data = normalizeSubjects(JSON.parse(readFileSync(this.path, 'utf8')))
      this.mtime = mtimeMs
    } catch { this.data = normalizeSubjects({}); this.mtime = -1 }
    return this.data
  }

  /** The subject to show for this thread: a thread correction, then an alias, then the canonical spelling. */
  resolve(sessionId, subject, agentId = 'hermes') {
    const raw = clean(subject, SUBJECT_MAX)
    const { canonical, aliases, threads } = this.load()
    const fix = typeof sessionId === 'string' ? threads.get(sideKey(agentId, sessionId)) : null
    if (fix && (!fix.from || fix.from === subjectKey(raw))) return fix.subject
    if (!raw) return ''
    const key = subjectKey(raw)
    return aliases.get(key) ?? canonical.get(key) ?? raw
  }

  /** wizard_attention with its subject folded into the owner's list. */
  apply(sessionId, attention, agentId = 'hermes') {
    if (!attention || typeof attention !== 'object') return attention
    const subject = this.resolve(sessionId, attention.subject, agentId)
    if (subject === (attention.subject ?? '')) return attention
    const { subject: _old, ...rest } = attention
    return subject ? { ...rest, subject } : rest
  }

  /** The per-run reminder: the owner's subjects and, when known, this thread's current one. */
  runNote(currentSubject = '') {
    const { subjects } = this.load()
    if (!subjects.length) return ''
    const list = subjects.map((subject) => subject.about ? `${subject.name} (${subject.about})` : subject.name).join('; ')
    const current = clean(currentSubject, SUBJECT_MAX)
    return `Subjects for the status line: ${list}. Use one of these names exactly. Coin a new subject only for a sustained project or life area that will hold several threads and that none of these covers.${current ? ` This thread's subject is “${current}”: keep it unless the work has moved to a different area.` : ''}`
  }
}
