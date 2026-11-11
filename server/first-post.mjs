// Chats Channels posts (issue 446, WIZARD_CHANNEL_FIRST_POSTS=1, off by default). A channel post is the owner's
// first message: its words (cleaned, at most FIRST_REQUEST_MAX UTF-16 code units) and the photos it carried, as
// file refs the authorized /wizard/files/<id>/content route serves. List rows carry them as firstRequest and
// firstAttachments, so the shell no longer reads each post's history.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { retainedMessagesWhere } from './delegation-receipts.mjs'
import { preparedRead } from './read-only-sqlite.mjs'
import { clean, FIRST_REQUEST_MAX } from './session-list-view.mjs'
import { visibleUserRequest } from './session-truth.mjs'

// Same id shape as the /wizard/files/<id>/content route.
const FILE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const MAX_ATTACHMENTS = 12
const WORKSPACE = /^\s*(?:\[Workspace::v1: [^\]\r\n]+\]|\[Workspace:[^\]\r\n]+\])\s*/u
// User turns that are never the owner's own first message, even with no display kind: Hermes' mid-turn steering
// wrapper, the Service's and coordinators' nudges (morning reconciliation, reporter, relays, follow-through, pick-ups)
// and cross-thread notes. The shell's history (chat-kit parseRows) never opens a turn on them either.
const INJECTED = /^(?:\[(?:OUT-OF-BAND\b|Morning reconciliation\b|reporter\]|Picked up from\b|Relayed by\b|Wizard follow-through\]|ASYNC\b|System\b|SYSTEM\b|Cross-thread note\b)|Cross-thread note from\b)/u
const FILE_MARKERS = /\[(WIZARD_FILES_V1|WIZARD_FILE_CHIPS_V1)\]\s*([\s\S]*?)\s*\[\/\1\]/gu

// Hermes stores a multi-part user message (text plus native image parts) as JSON; only its text parts are words.
function contentText(content) {
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part && ['text', 'input_text'].includes(part.type) && typeof part.text === 'string' ? part.text : '').join('\n')
  if (typeof content !== 'string') return ''
  const trimmed = content.trim()
  if (trimmed.startsWith('[{')) { try { const parts = JSON.parse(trimmed); if (Array.isArray(parts)) return contentText(parts) } catch { /* plain text that starts with a bracket */ } }
  return content
}

// Cut at a code-unit limit without leaving half of a surrogate pair at the end.
function cut(text, max) {
  if (text.length <= max) return text
  const head = text.slice(0, max), last = head.charCodeAt(max - 1)
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
}

/** One user message's post: { text, attachments: [{ id, name, mime }] } (images only). */
export function firstPostOf(content) {
  const raw = contentText(content)
  const files = []
  for (const match of raw.matchAll(FILE_MARKERS)) {
    try { const list = JSON.parse(match[2]); if (Array.isArray(list)) files.push(...list.filter(f => f && typeof f === 'object')) } catch { /* a broken marker carries no files */ }
  }
  const seen = new Set(), attachments = []
  for (const f of files) {
    const id = typeof f.id === 'string' ? f.id : '', mime = typeof f.mime === 'string' ? f.mime.toLowerCase() : ''
    if (!FILE_ID.test(id) || !mime.startsWith('image/') || mime.length > 160 || seen.has(id) || attachments.length >= MAX_ATTACHMENTS) continue
    seen.add(id)
    const name = typeof f.filename === 'string' && f.filename.trim() ? f.filename : typeof f.name === 'string' && f.name.trim() ? f.name : 'Photo'
    attachments.push({ id, name: name.slice(0, 240), mime })
  }
  let words = raw
    .replace(WORKSPACE, '')
    .replace(/\[(WIZARD_[A-Z0-9_]+)\][\s\S]*?\[\/\1\]/gu, ' ')
    .replace(/<\s*helm_attachments\s*>[\s\S]*?<\s*\/\s*helm_attachments\s*>/giu, ' ')
    .replace(/\s*\[Image attached at:[^\]]*\](?:\s*\[[^\]]*\])?/giu, ' ')
    // Hermes' text projection of an inline image.
    .replace(/\s*\[screenshot\]/giu, ' ')
  // The shell's screen note and any marker left open run to the end of the message: they are never the owner's words.
  const open = words.search(/\[Wizard ?OS context\]|\[WIZARD_[A-Z0-9_]+\]|<\s*helm_attachments\b/u)
  if (open >= 0) words = words.slice(0, open)
  words = clean(words)
  if (/^Please use the attached (?:photo|photos|file|files|image|images)\.?$/iu.test(words)) words = ''
  // A voice note with no typed words: its transcript is what the owner said.
  if (!words) words = clean(files.find(f => typeof f.transcript === 'string' && f.transcript.trim())?.transcript || '')
  return { text: cut(words, FIRST_REQUEST_MAX), attachments }
}

/** Whether a history row is the owner's own message, by the rules the shell's history view uses: a user row with no
 *  display kind (the Service has already cleared it on the owner's own turns Hermes stamped internal_notification),
 *  not an internal Hermes notice, not an injected nudge, steer or note. */
export function ownerMessage(row) {
  if (!row || row.role !== 'user' || row.display_kind) return false
  const content = typeof row.content === 'string' ? row.content : Array.isArray(row.content) ? contentText(row.content) : ''
  return visibleUserRequest(content, '') && !INJECTED.test(content.replace(WORKSPACE, ''))
}

/** The first owner message of a history page (oldest first, owner turns already restored). undefined: not decidable
 *  from this page. */
export function firstPostOfHistory(rows, hasMore) {
  if (!Array.isArray(rows) || !rows.length) return undefined
  for (const row of rows) {
    if (!row || row.role !== 'user') continue
    const content = typeof row.content === 'string' ? row.content : Array.isArray(row.content) ? JSON.stringify(row.content) : ''
    // An owner message with nothing in it yet (a voice note before its words): ask again later.
    if (!content.trim()) { if (!row.display_kind) return undefined; continue }
    if (ownerMessage(row)) return firstPostOf(row.content)
  }
  // No owner message on the first page: the agent started this thread.
  return hasMore === true && rows.length < 50 ? undefined : null
}

/** List-row fields from a reader's value: undefined (not read), null (agent-started) or the raw first content. */
export function firstPostFields(post) {
  return post && typeof post === 'object' ? { firstRequest: post.text, firstAttachments: post.attachments } : {}
}

const boundedIds = values => [...new Set((Array.isArray(values) ? values : []).filter(v => typeof v === 'string' && /^[A-Za-z0-9._:-]+$/.test(v)).slice(0, 200))]
// A multi-part message stored as JSON text: its parts, the shape the Hermes history API and the owner-turn restore use.
function storedContent(content) {
  if (typeof content !== 'string' || !content.trim().startsWith('[{')) return content
  try { const parts = JSON.parse(content); return Array.isArray(parts) ? parts : content } catch { return content }
}

/** Each listed thread's post from a Hermes state.db: Map id -> post, or null for an agent-started thread.
 *  Threads the file doesn't hold (or an unreadable file) are absent. Each thread's first user rows are read as a
 *  history page and, when `restore(raw, sessionId)` is given, passed through the same owner-turn restore the
 *  thread's view=wizard history uses, so the post is the first message that history shows as the owner's.
 *  Whole messages are parsed: the file marker comes after the owner's words, so a cut message would lose its photos. */
export function readHermesFirstPosts(path, sessionIds, { restore = null } = {}) {
  const out = new Map(), ids = boundedIds(sessionIds)
  if (!ids.length || !path || !existsSync(path)) return out
  let db
  try { db = new DatabaseSync(path, { readOnly: true }) } catch { return out }
  try {
    const columns = new Set(preparedRead(db, 'PRAGMA table_info(messages)').all().map(row => row.name))
    const kind = columns.has('display_kind') ? 'display_kind' : 'NULL AS display_kind'
    const known = preparedRead(db, 'SELECT 1 FROM sessions WHERE id=?')
    const read = preparedRead(db, `SELECT id, content, ${kind}, timestamp FROM messages WHERE session_id=? AND role='user'
      AND ${retainedMessagesWhere(columns)} AND trim(COALESCE(content,''))<>'' ORDER BY timestamp ASC, id ASC LIMIT 50`)
    for (const id of ids) {
      if (!known.get(id)) continue
      let rows = read.all(id).map(row => ({ id: Number(row.id), session_id: id, role: 'user', content: storedContent(row.content),
        timestamp: row.timestamp, ...(row.display_kind ? { display_kind: row.display_kind } : {}) }))
      if (rows.length && typeof restore === 'function') {
        try {
          const raw = Buffer.from(JSON.stringify({ object: 'list', session_id: id, data: rows, pagination: { order: 'oldest', offset: 0, limit: 50, returned: rows.length } }))
          const restored = JSON.parse(Buffer.from(restore(raw, id)).toString('utf8'))
          if (Array.isArray(restored?.data)) rows = restored.data
        } catch { /* unrestored rows: internal_notification owner turns stay hidden, as in that history */ }
      }
      out.set(id, firstPostOfHistory(rows, false) ?? null)
    }
    return out
  } finally { try { db.close() } catch { /* read-only cleanup */ } }
}
