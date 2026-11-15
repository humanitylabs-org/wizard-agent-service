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
// A worker that is actually executing right now: a helper still running (6 h-capped
// helpersRunning, or a live helper-status phase with pending helpers) or a pending heavy job.
// Narrower than threadBackground: an unanswered result or a stalled helper is not running.
export const liveWorker = truth => truth?.heavyPending ? 'heavy'
  : truth?.helpersRunning > 0 || truth?.helperStatus?.phase === 'running' && truth.helperStatus.pending > 0 ? 'helper' : ''
// Terminal run states whose thread still belongs in Working while a worker runs (James,
// 7 Nov 2026: Ready only when everything has stopped). The status and its error card stay.
export const ENDED_WITH_ERROR = new Set(['failed', 'interrupted', 'cancelled', 'expired'])

// Item ids a pending ask is about: its needs_you items, else every item it lists (none: no tracker).
const askItemIds = ask => {
  const items = Array.isArray(ask?.items) ? ask.items : []
  const waiting = items.filter(item => item.state === 'needs_you')
  return new Set((waiting.length ? waiting : items).map(item => item.id))
}
// What a later status says about a pending ask's items: 'open' when it lists one of them as
// needs_you again, 'resolved' when it lists one of them in any other state, '' when it is silent.
function itemVerdict(ask, status) {
  const ids = askItemIds(ask)
  if (!ids.size || !Array.isArray(status?.items)) return ''
  const mine = status.items.filter(item => ids.has(item.id))
  if (mine.some(item => item.state === 'needs_you')) return 'open'
  return mine.length ? 'resolved' : ''
}
// A done reply answers the pending ask unless its own items show it is about a different item.
const doneAnswers = (ask, status) => {
  const verdict = itemVerdict(ask, status)
  return verdict ? verdict === 'resolved' : !(askItemIds(ask).size && status.items?.length)
}
// An fyi/done reply whose item tracker still lists an item as needs_you keeps that owner action
// on the thread's Ready line, so the line and the tracker strip agree (issue 525).
function itemAsk(status) {
  const item = Array.isArray(status?.items) ? status.items.find(entry => entry.state === 'needs_you') : null
  if (!item) return null
  const text = String(item.ask || item.title || '').trim()
  const ask = text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text
  return ask ? { state: 'needs_you', ask, items: [item], ...(status.subject ? { subject: status.subject } : {}) } : null
}

// Replies are visible final assistant replies only, in arrival order (oldest first).
// A timestamp must use the same epoch-seconds clock as lastUserAt. Keep unmarked
// replies: they establish whether the owner has a newer unanswered message.
// A pending needs_you/check ask stays until it is resolved (issue 525): a newer ask replaces it, a
// done reply clears it unless its items show it is about another item, and the item tracker
// clears it by marking the ask's item done/running. An fyi never clears it (the status contract).
// An owner message answers earlier asks, except one whose item a later reply lists as needs_you again.
export function resolveThreadSection({ replies = [], lastUserAt = 0, background = '', heavyPending = background === 'heavy' } = {}) {
  let ask = null, attention = null, lastAssistantAt = 0, carried = null
  const userAt = replyEpoch(lastUserAt)
  for (const reply of replies) {
    const at = replyEpoch(reply.timestamp)
    lastAssistantAt = Math.max(lastAssistantAt, at)
    const before = at < userAt || at === userAt && !reply.afterUser
    let status = reply.status ?? parseStatus(reply.content)
    if (!status) continue
    if (before) {
      // Track the ask the owner's message may have answered; it only returns if a later reply re-lists its item.
      if (ASK_STATES.has(status.state)) carried = status
      else if (!carried && itemAsk(status)) carried = itemAsk(status)
      else if (carried && (itemVerdict(carried, status) === 'resolved' || status.state === 'done' && doneAnswers(carried, status))) carried = null
      continue
    }
    if (carried) {
      // The same background guards as a fresh ask: a check waits for heavy work, a promise is not an action.
      if (itemVerdict(carried, status) === 'open' && !(heavyPending && carried.state === 'check') && !(background && FUTURE_ASK.test(carried.ask))) ask = carried
      carried = null
    }
    const original = status
    if (background && ASK_STATES.has(status.state) && FUTURE_ASK.test(status.ask)) status = { ...status, state: 'fyi' }
    if (['check', 'done'].includes(status.state) && heavyPending) status = { ...status, state: 'fyi', ask: 'Background work is still running or waiting to report back.' }
    attention = status
    if (ASK_STATES.has(status.state)) { ask = status; continue }
    const verdict = ask ? itemVerdict(ask, status) : ''
    if (verdict === 'resolved' || ask && !background && status.state === 'done' && doneAnswers(ask, status)) ask = null
    // A status a background guard demoted never turns its own items back into an open ask.
    if (!ask && status === original) {
      const listed = itemAsk(status)
      if (listed && !(background && FUTURE_ASK.test(listed.ask))) ask = listed
    }
  }
  if (userAt > lastAssistantAt) return { section: 'Working', attention: null, background: '' }
  if (ask) return { section: 'Ready', attention: ask, background: background || '' }
  return { section: background ? 'Working' : 'Ready', attention, background: '' }
}

/** Returned helpers whose thread is waiting on a durable background job are waiting on that job, not stuck:
 * no "no agent running" and no Resume (Continue would start a second agent beside the running job). */
export function backgroundHelperStatus(h) {
  return h && typeof h === 'object' && ['stalled', 'waiting'].includes(h.phase) ? { ...h, phase: 'background', resumeEligible: false } : h
}

// Shared by main and routed runtimes, including slim list windows. Do not turn
// errors, stop requests or native approval gates into an ordinary Ready row.
export function projectOpenAskSession(session, { replies, lastUserAt, background = '', heavyPending = background === 'heavy', inFlight = false, live = '' } = {}) {
  const decision = resolveThreadSection({ replies, lastUserAt, background, heavyPending })
  const row = { ...session }
  delete row.wizard_background
  // An errored last run keeps its status (the thread's error card), but a worker that is
  // still running keeps the row in Working via wizard_background, not in Ready/Errors.
  if (ENDED_WITH_ERROR.has(row.status)) {
    if (live === 'helper' || live === 'heavy') row.wizard_background = live
    return row
  }
  if (['waiting_for_approval', 'stopping'].includes(row.status)) return row
  // A live lease also owns execution when no API run has been admitted.
  if (inFlight && !row.wizard_run_id && row.status !== 'queued') return row
  // Admitted owner input can still be outside history. Keep the live release's
  // own-reply attention policy, while every controller ingress/status wins over
  // notice/helper classification until its real terminal receipt.
  if (row.status === 'queued' || row.wizard_run_id && ['submitting', 'accepted', 'started', 'running', 'unknown'].includes(row.status)) {
    const since = row.status === 'queued' ? Infinity : replyEpoch(row.wizard_assigned_at)
    const own = resolveThreadSection({ replies: (replies ?? []).filter((reply) => replyEpoch(reply.timestamp) >= since), lastUserAt })
    if (own.attention) row.wizard_attention = own.attention
    else delete row.wizard_attention
    if (row.wizard_waiting_on === 'helper') delete row.wizard_waiting_on
    return row
  }
  if (decision.attention) row.wizard_attention = decision.attention
  else delete row.wizard_attention
  if (decision.section === 'Working' && background) {
    row.status = 'running'
    if (background) row.wizard_waiting_on = heavyPending && replies?.at(-1)?.status?.state === 'check' ? 'heavy' : 'helper'
    // A turn that handed off to a durable background job (queued heavy job or a detached deploy) is
    // waiting on it. Helpers that returned earlier are not "stuck, no agent running" while the job
    // runs, and Continue would start a second agent next to it: say what it waits on, offer no resume.
    if (live === 'heavy' || heavyPending) {
      if (row.wizard_helper_status) row.wizard_helper_status = backgroundHelperStatus(row.wizard_helper_status)
    }
  } else if (decision.background) {
    row.status = 'completed'
    delete row.wizard_waiting_on
    row.wizard_background = decision.background
  }
  return row
}
