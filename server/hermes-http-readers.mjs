// Hermes reads over its public HTTP API (stock Hermes, no state.db access).
//
// The Agent Service used to open Hermes's state.db read-only for six reads. These are the HTTP
// replacements for every read stock Hermes exposes; spec/AGENT_BRIDGE.md ("Agent adapter") lists
// the calls a second agent must serve and the reads that still need WIZARD_HERMES_STATE_PATH.
//
//   turn held          POST /v1/runs/<id>/steer {input:""}  400 = agent attached, 404/409 = none
//   abandoned outcome  GET  /api/sessions/<id>/messages?order=latest
//   follow-through     GET  /api/sessions  +  GET /api/sessions/<id>/messages?order=latest&limit=1
//   canonical listing  GET  /api/sessions (paged)
//
// `request(path, init)` is the caller's authenticated fetch: it returns parsed JSON or throws.

export const FOLLOW_THROUGH_DISPLAY_KIND = 'async_delegation_complete'
const HUMAN_SESSION_SOURCES = new Set(['webui', 'telegram', 'discord', 'slack', 'whatsapp', 'signal', 'wizard-mobile'])
const HUMAN_ID_PREFIXES = ['wizard_', 'wizard-assistant-', 'wizardop_user_']
const SESSION_PAGE = 200
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60

const enc = encodeURIComponent
const listOf = (payload) => (Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.sessions) ? payload.sessions : [])

/**
 * True while an agent is attached to the run (Hermes refuses an empty steer with 400), false when
 * Hermes reports no agent (409) or no longer knows the run (404). Any other answer is unknown and
 * throws, so the stale-run guard leaves the run alone.
 */
export async function hermesRunHasAgent(fetchImpl, origin, key, runId) {
  const response = await fetchImpl(`${origin}/v1/runs/${enc(runId)}/steer`, {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: '' }),
  })
  await response.arrayBuffer().catch(() => null)
  if (response.status === 409 || response.status === 404) return false
  if (response.status === 400) return true
  throw new Error(`run liveness unknown (${response.status})`)
}

const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'expired'])

/**
 * Stale-run guard: is Hermes still holding this run's turn? GET /v1/runs/<id> first: unknown (404)
 * or terminal is not held; queued, waiting_for_approval and stopping are held (Hermes still owns
 * the turn); `running` is held only while an agent is attached (empty-steer probe). Anything else
 * throws, and the guard treats unknown as held.
 */
export async function hermesRunTurnHeld(fetchImpl, origin, key, runId) {
  const response = await fetchImpl(`${origin}/v1/runs/${enc(runId)}`, {
    redirect: 'manual', headers: { Authorization: `Bearer ${key}` },
  })
  const raw = await response.text().catch(() => '')
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`run status unknown (${response.status})`)
  let status = ''
  try { status = String(JSON.parse(raw)?.status ?? '') } catch { throw new Error('run status unreadable') }
  if (RUN_TERMINAL.has(status)) return false
  if (status !== 'running') return true
  return hermesRunHasAgent(fetchImpl, origin, key, runId)
}

/** Newest active messages first, as Hermes returns them for the thread's live lineage. */
async function latestMessages(request, sessionId, limit) {
  const payload = await request(`/api/sessions/${enc(sessionId)}/messages?order=latest&limit=${limit}`)
  return listOf(payload).slice().reverse()
}

/**
 * After an abandoned run: `completed` when the thread's last assistant text since the run started
 * is followed only by tool rows (the answer reached the person), otherwise `interrupted`.
 */
export async function readAbandonedRunOutcomeHttp(request, sessionId, startedAt) {
  const since = Number(startedAt) || 0
  for (const row of await latestMessages(request, sessionId, 50)) {
    if (Number(row?.timestamp ?? 0) < since) break
    if (row?.display_kind === 'hidden' || row?.role === 'tool') continue
    if (row?.role === 'assistant' && !String(row?.content ?? '').trim()) continue
    return row?.role === 'assistant' ? 'completed' : 'interrupted'
  }
  return 'interrupted'
}

/**
 * Threads waiting on a follow-through: the newest message is a background-delegation completion
 * row and no run of ours is active on the thread. Only threads whose last_active moved are re-read.
 */
export function createFollowThroughFinder({ request, busy = () => false, prefix, sessionPrefixes = ['wizard_'], maxAgeSeconds = 2 * 3600 }) {
  const seen = new Map()
  return async (now = Date.now()) => {
    const cutoff = now / 1000 - maxAgeSeconds
    const sessions = listOf(await request(`/api/sessions?limit=100`))
    const pending = []
    for (const session of sessions) {
      const id = String(session?.id ?? '')
      const root = String(session?._lineage_root_id ?? id)
      const lastActive = Number(session?.last_active ?? session?.started_at ?? 0)
      if (!id || lastActive < cutoff || !sessionPrefixes.some((p) => root.startsWith(p) || id.startsWith(p))) continue
      if (seen.get(id) === lastActive) continue
      const [last] = await latestMessages(request, id, 1)
      seen.set(id, lastActive)
      if (!last || last.role !== 'user' || Number(last.timestamp ?? 0) < cutoff) continue
      const completion = last.display_kind === FOLLOW_THROUGH_DISPLAY_KIND || String(last.content ?? '').startsWith(prefix)
      if (!completion) continue
      // A pending thread is re-read every tick until a turn answers it (the watcher dedupes per row).
      seen.delete(id)
      if (busy(root) || busy(id)) continue
      pending.push({ sessionId: root, messageId: Number(last.id), at: Number(last.timestamp) })
    }
    return pending
  }
}

function isHumanSession(session) {
  const id = String(session?._lineage_root_id ?? session?.id ?? '')
  return HUMAN_SESSION_SOURCES.has(String(session?.source ?? '').toLowerCase()) || HUMAN_ID_PREFIXES.some((p) => id.startsWith(p))
}

/**
 * Wizard-visible sessions from GET /api/sessions: top-level, not hidden, not delegate children,
 * with messages, active in the last 30 days, human sources or Wizard ids. A compression chain is
 * listed under its root id with its live tip's fields (title, activity, count), the same identity
 * Wizard threads already use. Archived threads come from `archived()` (Hermes lists only live ones).
 */
/** @param {{ limit?: number, archived?: () => Array<Record<string, any>>, now?: number }} [options] */
export async function readCanonicalSessionsHttp(request, { limit = 2_000, archived = () => [], now = Date.now() } = {}) {
  const cutoff = now / 1000 - MAX_AGE_SECONDS
  const out = []
  const known = new Set()
  for (let offset = 0; out.length < limit; offset += SESSION_PAGE) {
    const page = listOf(await request(`/api/sessions?limit=${SESSION_PAGE}&offset=${offset}`))
    let older = false
    for (const session of page) {
      const lastActive = Number(session?.last_active ?? session?.started_at ?? 0)
      if (lastActive < cutoff) { older = true; continue }
      if (session?.hidden || session?.is_internal_child || session?.parent_session_id || !(Number(session?.message_count) > 0) || !isHumanSession(session)) continue
      const id = String(session._lineage_root_id ?? session.id)
      if (known.has(id)) continue
      known.add(id)
      const { _lineage_root_id: _root, _lineage_ids: _ids, ...rest } = session
      out.push({ ...rest, id, last_active: lastActive, pinned: Boolean(session.pinned), archived: Boolean(session.archived), hidden: false })
      if (out.length >= limit) break
    }
    if (page.length < SESSION_PAGE || older) break
  }
  for (const session of archived()) {
    if (out.length >= limit) break
    if (!known.has(session.id) && Number(session.last_active ?? session.started_at ?? 0) >= cutoff) { known.add(session.id); out.push(session) }
  }
  return out.sort((a, b) => Number(b.last_active ?? b.started_at ?? 0) - Number(a.last_active ?? a.started_at ?? 0))
}
