// Attention is an unanswered owner action, not the lifecycle of a background worker.
import { parseStatus } from './thread-status.mjs'

// Match deferred availability, not an explanation of what an immediate action will do.
const FUTURE_ASK = /\b(?:I|we|it|helper)\s+will\s+(?:send|have|share|post|give|arrive)\b|\bonce\s+(?:the\s+helper|ready)\b|\b(?:when|after)\s+the\s+helper\b|\bsoon\b/iu
const ASK_STATES = new Set(['needs_you', 'check'])
export function replyEpoch(value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric > 1e11 ? numeric / 1000 : numeric
  return Date.parse(value) / 1000 || 0
}
export const threadBackground = truth => truth?.heavyPending ? 'heavy'
  : truth?.helpersRunning || truth?.helperResultUnanswered || truth?.supervisorPending
    || truth?.helperStatus && (truth.helperStatus.phase !== 'held' || truth.helperStatus.pending > 0 || truth.helperStatus.returned > 0) ? 'helper' : ''

// Replies are visible final assistant replies only, in arrival order (oldest first).
// A timestamp must use the same epoch-seconds clock as lastUserAt. Keep unmarked
// replies: they establish whether the owner has a newer unanswered message.
export function resolveThreadSection({ replies = [], lastUserAt = 0, background = '', heavyPending = background === 'heavy' } = {}) {
  let ask = null, attention = null, lastAssistantAt = 0
  for (const reply of replies) {
    const at = replyEpoch(reply.timestamp)
    lastAssistantAt = Math.max(lastAssistantAt, at)
    if (at < replyEpoch(lastUserAt) || at === replyEpoch(lastUserAt) && !reply.afterUser) continue
    let status = reply.status ?? parseStatus(reply.content)
    if (!status) continue
    if (background && ASK_STATES.has(status.state) && FUTURE_ASK.test(status.ask)) status = { ...status, state: 'fyi' }
    if (status.state === 'check' && heavyPending) status = { ...status, state: 'fyi', ask: 'Background work is still running or waiting to report back.' }
    attention = status
    if (ASK_STATES.has(status.state)) ask = status
    else if (!background && ['done', 'fyi'].includes(status.state)) ask = null
  }
  if (replyEpoch(lastUserAt) > lastAssistantAt) return { section: 'Working', attention: null, background: '' }
  if (ask) return { section: 'Ready', attention: ask, background: background || '' }
  return { section: background ? 'Working' : 'Ready', attention, background: '' }
}

// Shared by main and routed runtimes, including slim list windows. Do not turn
// errors, stop requests or native approval gates into an ordinary Ready row.
export function projectOpenAskSession(session, { replies, lastUserAt, background = '', heavyPending = background === 'heavy' } = {}) {
  const decision = resolveThreadSection({ replies, lastUserAt, background, heavyPending })
  const row = { ...session }
  delete row.wizard_background
  if (['failed', 'interrupted', 'waiting_for_approval', 'stopping'].includes(row.status)) return row
  if (decision.attention) row.wizard_attention = decision.attention
  else delete row.wizard_attention
  if (decision.section === 'Working' && background) {
    row.status = 'running'
    if (background) row.wizard_waiting_on = heavyPending && replies?.at(-1)?.status?.state === 'check' ? 'heavy' : 'helper'
  } else if (decision.background) {
    row.status = 'completed'
    delete row.wizard_waiting_on
    row.wizard_background = decision.background
  }
  return row
}
