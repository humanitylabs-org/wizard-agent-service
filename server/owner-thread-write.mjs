// One admission rule for main and routed run/chat/steer entry points.
export const AGENT_TO_AGENT_PREFIX = '[Agent-to-agent'
export const OWNER_THREAD_WRITE_MESSAGE = 'Agents must not run turns in an existing owner thread. Read its history (GET /api/sessions/{id}/messages or session_search) and decide yourself; if the owner judgment is still needed, ask James once in your own thread.'

// Only inspect text-bearing input parts, never instructions, image URLs or tool results.
export function inputText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(inputText).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  if (value.role && value.role !== 'user') return ''
  return inputText(value.text ?? value.content ?? '')
}
export function isAgentToAgentRequest(input) {
  const text = inputText(input).trim()
  return text.startsWith(AGENT_TO_AGENT_PREFIX) || text.includes('NOT a James message')
}
export class OwnerThreadWriteError extends Error {
  constructor() {
    super(OWNER_THREAD_WRITE_MESSAGE)
    this.status = 409
    this.code = 'agent_to_agent_thread_write'
    this.payload = { error: { code: this.code, message: this.message } }
  }
}

export function isTurnWritePath(path) {
  return path === '/v1/runs' || /^\/v1\/runs\/[^/]+\/steer$/u.test(path) || /^\/api\/sessions\/[^/]+\/chat(?:\/stream)?$/u.test(path)
}

export async function guardOwnerThreadWrite({ method, upstreamPath, body, sessionExists }) {
  if (method !== 'POST' || !body || !isTurnWritePath(upstreamPath)) return
  const chat = upstreamPath.match(/^\/api\/sessions\/([^/]+)\/chat(?:\/stream)?$/u)
  const steer = /^\/v1\/runs\/[^/]+\/steer$/u.test(upstreamPath)
  if (upstreamPath !== '/v1/runs' && !chat && !steer) return
  const value = Buffer.isBuffer(body) ? JSON.parse(body.toString('utf8')) : body
  if (!isAgentToAgentRequest(chat ? (value?.message ?? value?.input) : value?.input)) return
  // A steer can only continue an existing turn; it never creates a session.
  if (steer) throw new OwnerThreadWriteError()
  const sessionId = chat ? decodeURIComponent(chat[1]) : value?.session_id
  if (typeof sessionId === 'string' && sessionId && await sessionExists(sessionId)) throw new OwnerThreadWriteError()
}

// Preview-only defense. Keep source order; associate assistant replies with their
// nearest preceding user turn, including internal/hidden users. Timestamps support
// both ascending and descending history pages. No canonical rows are changed.
export function withoutAgentToAgentTurns(rows) {
  const ordered = rows.filter(row => row && typeof row === 'object').map((row, index) => ({ row, index })).sort((a, b) => {
    const at = Number(a.row.timestamp ?? a.row.created_at), bt = Number(b.row.timestamp ?? b.row.created_at)
    return Number.isFinite(at) && Number.isFinite(bt) ? at - bt || a.index - b.index : a.index - b.index
  })
  const suppressed = new Set()
  let internal = false
  for (const { row } of ordered) {
    const role = row.role ?? row.author
    if (role === 'user') internal = isAgentToAgentRequest(row.content ?? row.text ?? row.output)
    if (internal && (role === 'user' || role === 'assistant')) suppressed.add(row)
  }
  return rows.filter(row => !suppressed.has(row))
}
