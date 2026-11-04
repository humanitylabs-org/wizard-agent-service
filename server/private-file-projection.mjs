import { join } from 'node:path'

const PRIVATE = '[private attachment]'
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A path ends at whitespace, quotes, markup or list punctuation.
const TAIL = `[^\\s"'<>\\x60\\]\\)},;]*`
// Sentence punctuation after a path stays outside the readable label.
const TRAILING = /[.:!?]+$/u
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 _.@+-]*$/u
const INBOX_FILE = /^\/\d{4}-\d{2}-\d{2}\/([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/u

// Stored recovery notes can legitimately mention a server-held attachment path.
// Redact configured attachment locations in the display response; never alter
// canonical history or turn input, or relax the separate credential guard.
// `readable` entries ({ root, label(rest) }) are more specific locations the
// owner may see (an agent's notes); label returns plain text, or null to redact.
export function projectPrivateFilePaths(result, trustedPaths, { readable = [] } = {}) {
  const valid = (value) => typeof value === 'string' && value.length > 1
  const labels = new Map()
  for (const entry of readable) if (valid(entry?.root) && typeof entry.label === 'function' && !labels.has(entry.root)) labels.set(entry.root, entry.label)
  const roots = [...new Set([...trustedPaths.filter(valid), ...labels.keys()])].sort((a, b) => b.length - a.length)
  if (!roots.length) return result
  // One alternation, longest root first, so the most specific location wins.
  const pattern = new RegExp(`(${roots.map(escape).join('|')})(${TAIL})`, 'g')
  const replace = (_match, root, rest) => {
    const label = labels.get(root)
    if (!label) return PRIVATE
    const trailing = rest.match(TRAILING)?.[0] ?? ''
    let text = null
    try { text = label(trailing ? rest.slice(0, -trailing.length) : rest) } catch { text = null }
    // A label never carries a protected location (the 502 guard would fire on it).
    if (typeof text !== 'string' || !text || roots.some(item => text.includes(item))) return PRIVATE
    return text + trailing
  }
  const visit = (value) => {
    if (typeof value === 'string') return value.replace(pattern, replace)
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') {
      const projected = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]))
      if (value.display_kind === 'run_context' && typeof value.run_context?.original === 'string'
        && projected.run_context?.original !== value.run_context.original) projected.run_context.redacted = true
      return projected
    }
    return value
  }
  try { return Buffer.from(JSON.stringify(visit(JSON.parse(result.toString('utf8'))))) }
  catch { return result } // Malformed/non-JSON responses retain the fail-closed guard.
}

const plainLabel = (value, fallback) => {
  const text = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 80) : ''
  return text || fallback
}

/**
 * Owner-readable locations inside a routed agent's home (host path and its
 * /opt/data mount): its declared notes folder reads "<Agent> notes › rel/path",
 * and a file the service placed in its inbox shows only its filename.
 */
export function agentReadablePaths(agent, home, containerRoot = '/opt/data') {
  const homes = [home, containerRoot].filter(value => typeof value === 'string' && value.length > 1)
  const inbox = (rest) => {
    const file = rest.match(INBOX_FILE)?.[1]
    return file ? `[private attachment: ${file}]` : null
  }
  const entries = homes.map(base => ({ root: join(base, 'inbox'), label: inbox }))
  const notesDir = typeof agent?.notes_dir === 'string' ? agent.notes_dir : ''
  // The inbox stays an attachment location even if notes were declared over it.
  if (!notesDir || notesDir.split('/')[0] === 'inbox' || !notesDir.split('/').every(part => SEGMENT.test(part))) return entries
  const name = `${plainLabel(agent?.label, 'Agent')} notes`
  const notes = (rest) => {
    if (!rest) return name
    if (!rest.startsWith('/')) return null // /opt/data/wikipedia is not the wiki folder
    const parts = rest.slice(1).split('/').filter(Boolean)
    if (!parts.length) return name
    // Hidden files and parent hops are not notes; they stay redacted.
    if (!parts.every(part => SEGMENT.test(part))) return null
    return `${name} › ${parts.join('/')}`
  }
  return [...entries, ...homes.map(base => ({ root: join(base, notesDir), label: notes }))]
}
