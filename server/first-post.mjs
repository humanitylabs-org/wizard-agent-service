// Chats Channels posts (issue 446, WIZARD_CHANNEL_FIRST_POSTS=1, off by default). A channel post is the owner's
// first message: its words (cleaned, at most FIRST_REQUEST_MAX UTF-16 code units) and the photos it carried, as
// file refs the authorized /wizard/files/<id>/content route serves. List rows carry them as firstRequest and
// firstAttachments, so the shell no longer reads each post's history.
import { clean, FIRST_REQUEST_MAX } from './session-list-view.mjs'
import { readHermesFirstRequests, visibleUserRequest } from './session-truth.mjs'

// Same id shape as the /wizard/files/<id>/content route.
const FILE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const MAX_ATTACHMENTS = 12
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
    .replace(/^\s*(?:\[Workspace::v1: [^\]\r\n]+\]|\[Workspace:[^\]\r\n]+\])\s*/u, '')
    .replace(/\[(WIZARD_[A-Z0-9_]+)\][\s\S]*?\[\/\1\]/gu, ' ')
    .replace(/<\s*helm_attachments\s*>[\s\S]*?<\s*\/\s*helm_attachments\s*>/giu, ' ')
    .replace(/\s*\[Image attached at:[^\]]*\](?:\s*\[[^\]]*\])?/giu, ' ')
  // The shell's screen note and any marker left open run to the end of the message: they are never the owner's words.
  const open = words.search(/\[Wizard ?OS context\]|\[WIZARD_[A-Z0-9_]+\]|<\s*helm_attachments\b/u)
  if (open >= 0) words = words.slice(0, open)
  words = clean(words)
  if (/^Please use the attached (?:photo|photos|file|files|image|images)\.?$/iu.test(words)) words = ''
  // A voice note with no typed words: its transcript is what the owner said.
  if (!words) words = clean(files.find(f => typeof f.transcript === 'string' && f.transcript.trim())?.transcript || '')
  return { text: cut(words, FIRST_REQUEST_MAX), attachments }
}

/** The first visible owner message of a history page (oldest first). undefined: not decidable from this page. */
export function firstPostOfHistory(rows, hasMore) {
  if (!Array.isArray(rows) || !rows.length) return undefined
  for (const row of rows) {
    if (!row || row.role !== 'user') continue
    const content = typeof row.content === 'string' ? row.content : Array.isArray(row.content) ? JSON.stringify(row.content) : ''
    // An owner message with nothing in it yet (a voice note before its words): ask again later.
    if (!content.trim()) { if (!row.display_kind) return undefined; continue }
    if (visibleUserRequest(content, row.display_kind)) return firstPostOf(row.content)
  }
  // No owner message on the first page: the agent started this thread.
  return hasMore === true && rows.length < 50 ? undefined : null
}

/** List-row fields from a reader's value: undefined (not read), null (agent-started) or the raw first content. */
export function firstPostFields(post) {
  return post && typeof post === 'object' ? { firstRequest: post.text, firstAttachments: post.attachments } : {}
}

/** Each listed thread's post from a Hermes state.db: Map id -> post, or null for an agent-started thread.
 *  Threads the file doesn't hold (or an unreadable file) are absent. The whole message is parsed (SQLite returns
 *  it whole anyway): the file marker comes after the owner's words, so a cut message would lose its photos. */
export function readHermesFirstPosts(path, sessionIds, read = readHermesFirstRequests) {
  const out = new Map()
  for (const [id, content] of read(path, sessionIds, { max: Number.MAX_SAFE_INTEGER })) out.set(id, content ? firstPostOf(content) : null)
  return out
}
