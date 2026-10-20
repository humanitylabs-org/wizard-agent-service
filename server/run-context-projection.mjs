// Display-only excerpts of incoming machine startup notes, never model summaries.
// Keep this allowlist narrow: helper transcripts and compaction are not startup notes.
const PREFIX = '[Wizard follow-through]'
const WORKSPACE = /^\s*\[Workspace::v1: [^\]\r\n]+\]\s*/u
const MAX_ORIGINAL = 12_000

export function runContextText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // Do not walk arbitrary metadata, image URLs, tool results or attachment payloads.
  return content.filter(part => part && ['text', 'input_text'].includes(part.type) && typeof part.text === 'string')
    .map(part => part.text).join('\n')
}

// Deliberately conservative: omit the rest at the first private-context envelope,
// even in a code fence or when its closing delimiter was lost in an excerpt.
const PRIVATE_TAIL = /<\s*(?:memory-context|system(?:_prompt)?|developer(?:_instructions)?|helm_attachments)\b|\[(?:WIZARD_(?:FILES_V1|FILE_CHIPS_V1|STATUS_V1|CLOSE_AND_FILE_V1|IMAGE_INTENT_V1)|ASYNC DELEGATION BATCH COMPLETE|CONTEXT COMPACTION|CONTEXT SUMMARY|PRIOR CONTEXT|System(?: note| instructions| prompt)?[:\]]|Your active task list|Your previous agent loop)|["']trusted_path["']\s*:|(?:^|\n)\s*#{1,6}\s*(?:System(?: instructions| prompt)?|Developer instructions|Instructions|Memories|Memory|Project Context)\b|<\|(?:im_start|start_header_id)\|>/iu

function redact(text) {
  return text
    .replace(/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/gu, '[redacted private key]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu, '[redacted secret]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/giu, '$1 [redacted]')
    // Credential assignments can be nested, malformed, or truncated. Discard
    // the remainder instead of trying to parse just a scalar with a regex.
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|passphrase|secret|authorization)(?:["']?)\s*[:=]\s*)[\s\S]*/giu, '$1[redacted sensitive remainder]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
}

const compact = (text, limit) => {
  const value = text.replace(/\s+/gu, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

export function historyRunContext(message) {
  if (!message || !['user', 'system'].includes(message.role ?? message.author)) return null
  const source = runContextText(message.content ?? message.text ?? message.output).replace(WORKSPACE, '').trimStart()
  if (!source.startsWith(PREFIX)) return null
  // Receipt bodies can embed whole helper transcripts. They remain hidden until
  // a separately reviewed structured receipt excerpt exists.
  if (source.slice(PREFIX.length).trimStart().startsWith('Recovered helper receipt ')) return null
  let original = source
  const boundary = original.search(PRIVATE_TAIL)
  if (boundary >= 0) original = original.slice(0, boundary).trimEnd()
  original = redact(original)
  const redacted = original !== source
  const originalTruncated = original.length > MAX_ORIGINAL
  if (originalTruncated) original = original.slice(0, MAX_ORIGINAL)
  const body = original.slice(PREFIX.length).trim()
  const crossThread = body.match(/^Cross-thread note from (?:the )?["“]([^"”\r\n]+)["”] thread\.?\s*/u)
  // Labels are taken from the incoming envelope; no title lookup or guessed intent.
  const from = crossThread ? compact(crossThread[1], 240) : 'Wizard follow-through'
  const excerpt = crossThread ? body.slice(crossThread[0].length) : body
  const action = excerpt.match(/(?:^|[.!?]\s+|\n)(Please\s+[^\n]+?)(?=(?:[.!?](?:\s|$))|$)/u)?.[1]
  return {
    kind: crossThread ? 'cross_thread' : 'continuation',
    from,
    summary: compact(excerpt || body || PREFIX, 600),
    ...(action ? { requested_action: compact(action, 600) } : {}),
    original,
    ...(originalTruncated ? { original_truncated: true } : {}),
    ...(redacted ? { redacted: true } : {}),
  }
}
