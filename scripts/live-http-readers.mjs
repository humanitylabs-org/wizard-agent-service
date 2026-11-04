// Live check of the Agent adapter HTTP reads against a real stock Hermes API server.
// Usage: HERMES=http://127.0.0.1:8642 KEY=... node live-http-readers.mjs
import { createFollowThroughFinder, hermesRunTurnHeld, readAbandonedRunOutcomeHttp, readCanonicalSessionsHttp } from '../server/hermes-http-readers.mjs'
import { FOLLOW_THROUGH_PREFIX } from '../server/delegation-follow-through.mjs'

const origin = process.env.HERMES; const key = process.env.KEY
const request = async (path, init = {}) => {
  const r = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const text = await r.text()
  if (!r.ok) throw new Error(`${path} ${r.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}
const out = (k, v) => console.log(`${k.padEnd(34)} ${typeof v === 'string' ? v : JSON.stringify(v)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (runId, want, ms = 180_000) => {
  const end = Date.now() + ms
  for (;;) {
    const s = await request(`/v1/runs/${runId}`)
    if (want(s.status) || Date.now() > end) return s.status
    await sleep(700)
  }
}

const session = `wizard_httpcheck_${Date.now()}`
await request('/api/sessions', { method: 'POST', body: JSON.stringify({ id: session, title: 'Agent adapter HTTP check' }) }).catch((e) => out('create session (optional)', e.message))
const startedAt = Date.now() / 1000

// 1. A long run: held while running, released once stopped.
const long = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ session_id: session, input: 'Run the terminal command `sleep 25 && echo done`, then reply with the single word done.' }) })
out('long run', long.run_id)
await waitFor(long.run_id, (s) => s === 'running', 30_000)
await sleep(4000)
out('turn held while running', await hermesRunTurnHeld(fetch, origin, key, long.run_id))
await request(`/v1/runs/${long.run_id}/stop`, { method: 'POST', body: '{}' })
out('status after stop', await waitFor(long.run_id, (s) => !['running', 'stopping', 'queued'].includes(s)))
out('turn held after stop', await hermesRunTurnHeld(fetch, origin, key, long.run_id))
out('turn held, unknown run', await hermesRunTurnHeld(fetch, origin, key, 'run_does_not_exist'))

// 2. A short run that answers: abandoned-outcome reads `completed`.
const short = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ session_id: session, input: 'Reply with the single word ok.' }) })
out('short run final status', await waitFor(short.run_id, (s) => !['running', 'stopping', 'queued'].includes(s)))
out('turn held after completion', await hermesRunTurnHeld(fetch, origin, key, short.run_id))
out('abandoned outcome (answered)', await readAbandonedRunOutcomeHttp(request, session, startedAt))
out('abandoned outcome (future start)', await readAbandonedRunOutcomeHttp(request, session, Date.now() / 1000 + 60))

// 3. Canonical listing: the Wizard thread is listed under its own id, with live fields.
const listed = await readCanonicalSessionsHttp(request)
const mine = listed.find((s) => s.id === session)
out('canonical listing size', listed.length)
out('canonical has this thread', mine ? { id: mine.id, title: mine.title, message_count: mine.message_count, archived: mine.archived } : null)

// 4. Follow-through: nothing pending on an answered thread; message rows carry display_kind.
const find = createFollowThroughFinder({ request, prefix: FOLLOW_THROUGH_PREFIX })
out('follow-through pending (answered)', (await find()).filter((p) => p.sessionId === session))
const latest = await request(`/api/sessions/${session}/messages?order=latest&limit=3`)
out('latest rows (role, display_kind)', latest.data.map((m) => [m.role, m.display_kind ?? null]))
