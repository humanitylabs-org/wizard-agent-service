// Typed messages can go quiet too (issue 669; owner switch `wizard/smart-inbox`, the Smart inbox switch of issue 667 and
// wizard-ux issue 1883, off by default). A typed first message always opened its visible thread, and its Sent row kept
// a shadow guess (`would_route`, issue 607): what the router would have done with it. This module judges each guess
// against what the owner then did, and says when the guess has proved right often enough to act on it:
//
// - A guess is `background` (a task with nothing to read back: dump or reminder) or `visible` (anything else). Reply
//   phrases ("reply", "tell me"), a question and "let me know when" always make it visible, whatever the router said.
// - What the owner wanted: his Sent correction first (Should have replied = visible, Didn't need a reply = background);
//   else a blocker or a failure reached Inbox either way (neutral, not counted); else a reply he typed in the thread
//   means visible; else a finished answer he left alone for TYPED_SETTLE_MS means background. Opening the thread is not
//   counted: today every typed thread is open at send, so it says nothing.
// - The gate counts only the background guesses, the ones that would change what he sees: at least TYPED_ROUTING_MIN of
//   the newest TYPED_WINDOW judged ones, and TYPED_ROUTING_RATE of them right. A typed message that already ran in the
//   background counts too, so a guess that gets worse closes the gate again.
//
// Pure functions: the Service gives them the Sent rows and how each one ended.
import { replyRules } from './voice-router.mjs'
import { asksToBeTold } from './thread-status.mjs'

export const TYPED_ROUTING_MIN = 50
export const TYPED_ROUTING_RATE = 0.9
export const TYPED_SETTLE_MS = 24 * 3600_000
export const TYPED_WINDOW = 200
const BACKGROUND_ROUTES = new Set(['dump', 'reminder'])

/** Words that always keep a typed message visible (ask 3): the rule that matched, or '' when none does. */
export function keepsVisible(text) {
  const said = String(text ?? '')
  if (!said.trim()) return 'empty'
  if (said.includes('?')) return 'question'
  if (asksToBeTold(said)) return 'notify_when_done'
  const rules = replyRules(said)
  if (rules.intent === 'agent') return rules.rules[0] || 'wants_reply'
  return ''
}

/** The guess on one typed Sent row: 'background', 'visible', or null (not a typed row, or not classified yet). A row
 *  that already ran in the background (route dump / reminder) is a background guess. */
export function typedGuessOf(row) {
  if (!row || row.source !== 'typed') return null
  if (BACKGROUND_ROUTES.has(row.route)) return 'background'
  if (keepsVisible(row.text)) return 'visible'
  if (BACKGROUND_ROUTES.has(row.would_route)) return 'background'
  // Classified with no guess (no router and no clear words) is unclear, so it stays visible.
  return row.would_route || row.would_decided_by ? 'visible' : null
}

/** How the run a typed row started ended, in the judge's words: 'done' | 'needs_you' | 'failed' | 'running' | ''. */
const endOf = state => state === 'done' || state === 'fyi' || state === 'check' || state === 'none' ? 'done'
  : state === 'needs_you' || state === 'failed' || state === 'running' ? state : ''

/** One typed row against what the owner did. `ended` = { state, at } (how its first run or background task ended),
 *  `replied` = he typed in that thread after sending it. -> { guess, wanted, verdict: match | miss | neutral | pending } */
export function judgeTyped(row, { ended = null, replied = false, now = Date.now(), settleMs = TYPED_SETTLE_MS } = {}) {
  const guess = typedGuessOf(row)
  if (!guess) return null
  let wanted = null
  if (typeof row.corrected?.should_reply === 'boolean') wanted = row.corrected.should_reply ? 'visible' : 'background'
  else {
    const end = endOf(ended?.state)
    if (end === 'needs_you' || end === 'failed') wanted = 'either'
    else if (replied) wanted = 'visible'
    else if (end === 'done' && Number(ended.at) > 0 && now - Number(ended.at) >= settleMs) wanted = 'background'
  }
  if (!wanted) return { guess, wanted: null, verdict: 'pending' }
  if (wanted === 'either') return { guess, wanted, verdict: 'neutral' }
  return { guess, wanted, verdict: wanted === guess ? 'match' : 'miss' }
}

const rate = (matched, judged) => judged ? Math.round((matched / judged) * 1000) / 1000 : null

/** The match rate over typed rows (newest first). `contextOf(row)` gives judgeTyped's { ended, replied }.
 *  -> { typed, pending, neutral, all, background, visible, gate, graduated, verdicts } where each of all /
 *  background / visible is { judged, matched, rate } over the newest `window` judged rows of that kind. */
export function typedMatch(rows, contextOf = () => ({}), { now = Date.now(), min = TYPED_ROUTING_MIN, rate: threshold = TYPED_ROUTING_RATE, window = TYPED_WINDOW, settleMs = TYPED_SETTLE_MS } = {}) {
  const tally = () => ({ judged: 0, matched: 0 })
  const all = tally(), background = tally(), visible = tally()
  let typed = 0, pending = 0, neutral = 0
  const verdicts = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.source !== 'typed') continue
    let context = {}
    try { context = contextOf(row) || {} } catch { context = {} }
    const judged = judgeTyped(row, { ...context, now, settleMs })
    if (!judged) continue
    typed += 1
    verdicts.set(row.id, judged)
    if (judged.verdict === 'pending') { pending += 1; continue }
    if (judged.verdict === 'neutral') { neutral += 1; continue }
    const right = judged.verdict === 'match' ? 1 : 0
    if (all.judged < window) { all.judged += 1; all.matched += right }
    const mine = judged.guess === 'background' ? background : visible
    if (mine.judged < window) { mine.judged += 1; mine.matched += right }
  }
  const out = t => ({ ...t, rate: rate(t.matched, t.judged) })
  const bg = out(background)
  return {
    typed, pending, neutral, all: out(all), background: bg, visible: out(visible),
    gate: { min, rate: threshold, window, counts: 'background', settle_hours: Math.round(settleMs / 3600_000) },
    graduated: bg.judged >= min && bg.rate != null && bg.rate >= threshold,
    verdicts,
  }
}
