// Catch me up (issue 668; on for everyone, the wizard/catch-me-up switch was removed). James, 26 Nov 2026: things
// that do not need him wait in the agent inbox until he says "catch me up", and Miguel's catch-up prompt (tried by
// James on 25 Nov) is the baseline every owner gets.
//
// When the owner says or types "catch me up" (or "signal sweep", the older name) to his main agent, the Service:
//  - builds the catch-up before the turn is admitted: the chats waiting on him (last 7 days, not archived, his last
//    message and the last reply of each), the agent inbox records that finished or are waiting since the last
//    catch-up (hard caps 7 waiting / 10 finished, overflow as "N more"), and the deferred list he asked to skip;
//  - marks what it showed as seen in the same step (finished and FYI records are archived, waiting ones are stamped
//    `caught_up_at`), so the next catch-up starts from there and one right after says nothing new;
//  - gives the turn one run note: Miguel's prompt verbatim, then that data.
// The agent acts through one gateway tool, `wizard_catch_up`: `clear` archives chats the way the shell's Archive does
// (Hermes archive + snooze cleared + saved result dismissed) and archives agent inbox records; `defer` keeps the
// "not now" list. Both refuse until the owner has answered in that catch-up's thread, and only for what it showed,
// so nothing is archived without his yes. Pull-only: nothing here is scheduled or pushed.
//
// Catch me up clears Sent (issue 710, switch wizard/catch-up-sent, off by default; James, 27 Nov 2026: "Sent becomes a
// record of things you've sent to the agent that are either in progress or have been handled ... but will get cleared
// when you do a catch me up"). On: every finished thread in Sent, whatever its age, is one count line in Clear all,
// and "clear" (`sent: true`, `keep` for "clear except N") archives them the way Archive does. Running threads,
// threads waiting on him, snoozed and archived ones are never offered. Off: nothing here changes.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicStoreWrite } from './thread-reference.mjs'
import { parseStatus } from './thread-status.mjs'
import { isSweepPhrase, WAITING_CAP, DONE_CAP } from './agent-sweep.mjs'

export const CATCH_UP_TOOL = 'wizard_catch_up'
export const CATCH_UP_SENT_SWITCH = 'wizard/catch-up-sent'
export const CHAT_DAYS = 7
export const CHAT_CAP = 15
// At most this many chats are read per catch-up (newest first) to find the ones the note lists.
export const CHAT_READS = 30
const EXCERPT = 300
const MAX_DEFERRED = 100
const DEFERRED_KEEP_MS = 30 * 86400_000
const MAX_SHOWN_RECORDS = 1000
const MAX_HISTORY = 10
// A clear or defer must come within this time of the catch-up it answers.
export const ANSWER_WINDOW_MS = 24 * 3600_000
// Issue 710: at most this many finished Sent threads are offered per catch-up (newest first); the rest wait for the next.
export const SENT_READS = 200
// Titles named on the Sent count line (the rest are a count).
export const SENT_TITLES = 20
// No catch-up reads more Sent threads than this while looking for finished ones.
export const SENT_MAX_READS = 600
const MAX_CLEARED = 2000

// Miguel's prompt, verbatim (the issue's baseline; James, 26 Nov: "could be our baseline and you would just be adding
// the agent inbox to it").
export const BASELINE_PROMPT = [
  'Catch me up. First, look at my recent Wizard chats (last 7 days, not archived) and keep the ones whose last reply is waiting on me or finished but not archived; read each one\'s last reply and my last message before describing it. Then list my installed apps and, for each one that has tools for reading my data, check whether anything there is waiting on me: messages or drafts to send, mail that needs an answer, tasks or items that name me, bills, offers or deadlines coming up. Skip apps with nothing for me without mentioning them. Check the source before calling anything open or stuck, and never describe something you haven\'t read.',
  'Answer in two steps, phone-friendly, no tables or headings, only bold app names and numbered lines, as short as possible.',
  'Step one: one "Clear all" list of things that need nothing from me (finished chats to archive, chatter or promos to mark read, obvious approvals), numbered continuously across apps, bulk items as one count line. Videos and links people sent me go on a separate "to watch" line and stay unread.',
  'End with: Reply clear or clear except N.',
  'Step two, after I answer: the needs-you items in batches of 3 to 5, one app at a time. Each is one numbered line with a bold short name, two sentences of real context, and a yes/no question with your pick in italics.',
  'Act only on what I say yes to, then show the next batch. Never send, archive, pay or reply without my yes.',
].join('\n')

// "catch me up" said or typed on its own: an optional greeting or "please" around it, punctuation, any case.
const PHRASE = /^\s*(?:(?:hey|hi|ok(?:ay)?)[\s,]+)?(?:wizard[\s,]+)?(?:(?:please|can you|could you|would you)\s+)?catch\s+me\s+up(?:[\s,]+(?:please|wizard))*[\s.!?]*$/iu
export const isCatchUpPhrase = text => typeof text === 'string' && text.length <= 80 && PHRASE.test(text)
/** The phrases that start a catch-up: "catch me up", and "signal sweep" as its alias. */
export const startsCatchUp = text => isCatchUpPhrase(text) || isSweepPhrase(text)

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
// Wizard's hidden markers ([WIZARD_STATUS_V1]...[/WIZARD_STATUS_V1] and the like) never reach the note.
const visible = text => String(text ?? '').replace(/\[WIZARD_[A-Z0-9_]+\][\s\S]*?\[\/WIZARD_[A-Z0-9_]+\]/gu, ' ').replace(/\[WIZARD_[A-Z0-9_]+\][\s\S]*$/u, ' ')
const textOf = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
  return ''
}
const seconds = value => {
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n / 1000 : n
  const t = Date.parse(String(value ?? ''))
  return Number.isFinite(t) ? t / 1000 : 0
}
const ago = (ms, now) => {
  const minutes = Math.max(0, Math.round((now - ms) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / 1440)} days ago`
}

/** The last owner message and last reply of one chat page (`{data|messages|items}`), newest last or first. */
export function lastTurns(page) {
  const rows = (['data', 'messages', 'items'].map(k => page?.[k]).find(Array.isArray) || [])
    .filter(row => row && (row.role === 'user' || row.role === 'assistant') && textOf(row.content).trim())
    .map((row, index) => ({ row, index, at: seconds(row.timestamp ?? row.created_at) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
  const last = rows.at(-1)
  const lastOf = role => rows.filter(r => r.row.role === role).at(-1)
  const reply = lastOf('assistant'), mine = lastOf('user')
  return {
    // A chat whose newest message is the owner's is still with the agent: not waiting on him, not finished.
    answered: last?.row.role === 'assistant',
    reply: reply ? clip(visible(textOf(reply.row.content)), EXCERPT) : '',
    status: reply ? parseStatus(textOf(reply.row.content)) : null,
    mine: mine ? clip(visible(textOf(mine.row.content)), EXCERPT) : '',
    at: last?.at || 0,
  }
}

const isWaitingRecord = r => (r.kind === 'needs_you' || r.kind === 'confirm') && (r.state === 'new' || r.state === 'surfaced')
const isFinishedRecord = r => (r.kind === 'result' || r.kind === 'fyi' || r.kind === 'note') && (r.state === 'new' || r.state === 'surfaced')
const byNewest = (a, b) => (b.updated_at || 0) - (a.updated_at || 0) || String(a.id).localeCompare(String(b.id))

// Issue 710: a Sent thread is finished when the last word is the agent's and it waits on nothing from the owner.
const finishedTurns = turns => Boolean(turns?.answered) && turns.status?.state !== 'needs_you' && turns.status?.state !== 'check'

// Smart inbox on (wizard/smart-inbox): "not in Inbox" is the shell's own rule, mirrored here from the same facts (wizard-ux
// web/core/chats-list-model.js smartPlace, issues 1883, 1927 and 1977): his newest Sent row (the Sent log's view of it)
// and the last reply. A finished answer to his words is Inbox unless they wanted no answer, set a reminder that has not
// fired, or went to the background or a command; a thread with no Sent row is Sent unless it is a delivery he set up
// (a scheduled run or a pinned thread). The shell has no row for a thread past the chat listing, so that one is Sent.
const TAPS = /\[WIZARD_TAPS_V1\]/u
const SILENT = /^\s*\[SILENT\]/iu
const REMIND = /\bremind me\b/iu
const FIRED_AFTER_MS = 5 * 60_000
const ASK_WORDS = /\b(?:answer me|tell me|let me know|get back to me|ping me|update me|keep me posted|what do you think)\b/iu
const ACK_WORDS = ['thank you so much', 'thank you', 'thanks a lot', 'sounds good', 'no worries', 'all good', 'got it', 'very much', 'so much', 'a lot', 'ok', 'okay', 'k', 'kk', 'thanks', 'thank', 'thx', 'ty', 'cheers',
  'great', 'perfect', 'nice', 'cool', 'awesome', 'good', 'np', 'lovely', 'brilliant', 'excellent', 'noted', 'ta', 'alright', 'many']
const ACK_MARKS = /[\p{Extended_Pictographic}\u200d\ufe0f\u{1F3FB}-\u{1F3FF}!.,;:~-]/gu
function ackOnly(text) {
  let t = String(text || '').replace(ACK_MARKS, ' ').toLowerCase().split(/\s+/u).filter(Boolean).join(' ')
  while (t) {
    const w = ACK_WORDS.find(a => t === a || t.startsWith(`${a} `))
    if (!w) return false
    t = t.slice(w.length).trim()
  }
  return true
}
const firstRule = r => String((Array.isArray(r?.rules_matched) && r.rules_matched[0]) || '')
const shouldReply = r => (typeof r?.corrected?.should_reply === 'boolean' ? r.corrected.should_reply : undefined)
const noAnswer = r => {
  if (!r || shouldReply(r) === false || /^no_reply:/u.test(firstRule(r))) return true
  const t = String(r.text || '').trim()
  return !t || TAPS.test(t) || ackOnly(t)
}
const askedForAnswer = r => {
  if (!r || r.quiet === true) return false
  if (shouldReply(r) !== undefined) return shouldReply(r)
  const first = firstRule(r)
  if (/^no_reply:/u.test(first)) return false
  if (/^wants_reply:/u.test(first) || first === 'short_question' || first === 'question' || (r.route === 'thread' && first === 'voice')) return true
  const t = String(r.text || '')
  return t.includes('?') || ASK_WORDS.test(t)
}
const reminderSet = r => r?.route === 'reminder' || r?.would_route === 'reminder' || REMIND.test(String(r?.text || ''))
/** Smart inbox: 'inbox' or 'sent' for a finished, listed thread. `last` is his newest Sent row (sent log view) or null,
 *  `turns` the thread's lastTurns, `delivery` a scheduled run or a pinned thread. Pure. */
export function smartPlace({ last = null, turns = null, delivery = false } = {}) {
  if (last?.state === 'failed') return 'inbox'
  if (last && ['done', 'needs_you'].includes(last.state) && !noAnswer(last) && askedForAnswer(last)) return 'inbox'
  const readable = !SILENT.test(turns?.reply || '') && (!turns?.status || ['done', 'fyi'].includes(turns.status.state))
  if (!readable) return 'sent'
  if (!last) return delivery ? 'inbox' : 'sent'
  if (last.state !== 'done' && last.state !== 'needs_you') return 'sent'
  const after = (seconds(turns?.at) - seconds(last.at)) * 1000
  if ((reminderSet(last) || delivery) && after > FIRED_AFTER_MS) return 'inbox'
  if (noAnswer(last) || reminderSet(last) || ['dump', 'command'].includes(last.route)) return 'sent'
  return 'inbox'
}
// Issue 710: on the Sent line only when the Sent tab shows it (Smart inbox on: not in Inbox).
const inSentTab = (row, listed, turns) => !(row?.smart && listed && smartPlace({ last: row.last || null, turns, delivery: Boolean(row.delivery) }) === 'inbox')

function emptyState() { return { schema: 1, last: null, history: [], shown_records: {}, deferred: { chats: {}, items: [] }, cleared: {} } }

/**
 * The catch-up store and builder. `inbox` is the AgentInboxStore (or null when the agent inbox is off), `readChats`
 * lists the main agent's chats (rows with id, title, last_active, archived), `readTurns(id)` reads one chat's newest
 * page, `archiveChat(id)` archives one chat the way the shell's Archive does, `skipThreads()` names threads that are
 * never part of a catch-up (Daily, Alerts).
 * Issue 710 (`sentOn()` true): `readSent()` lists the threads Sent shows, any age, as rows `{ id, title, at (ms),
 * listed, archived, hidden, snoozed, working, smart, last, delivery }` (`listed`: inside the chat listing the shell
 * reads; `archived` is only known for those; `smart`: Smart inbox is on, `last` his newest Sent row, `delivery` a
 * scheduled or pinned thread), and `readSession(id)` reads one unlisted thread's Hermes row (null when it is gone).
 */
export function createCatchUp({ statePath = '', now = Date.now, inbox = null, readChats, readTurns, archiveChat, skipThreads = () => [], sentOn = () => false, readSent = async () => [], readSession = async () => null, log = line => console.warn(`[catch-up] ${line}`) } = {}) {
  let state = emptyState()
  if (statePath && existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
      if (parsed?.schema === 1) state = { ...emptyState(), ...parsed, deferred: { chats: { ...(parsed.deferred?.chats || {}) }, items: Array.isArray(parsed.deferred?.items) ? parsed.deferred.items : [] },
        cleared: parsed.cleared && typeof parsed.cleared === 'object' && !Array.isArray(parsed.cleared) ? parsed.cleared : {} }
    } catch { /* an unreadable file starts empty; its bytes stay on disk until the next write */ }
  }
  const save = () => {
    if (!statePath) return
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    atomicStoreWrite(statePath, JSON.stringify(state))
  }
  const pruneDeferred = t => {
    state.deferred.items = state.deferred.items.filter(item => t - (item.at || 0) < DEFERRED_KEEP_MS).slice(-MAX_DEFERRED)
    for (const [id, entry] of Object.entries(state.deferred.chats)) if (t - (entry.at || 0) >= DEFERRED_KEEP_MS) delete state.deferred.chats[id]
  }

  /** The chats a catch-up lists: answered (not still with the agent), last 7 days, not archived, not Daily/Alerts,
   *  not the catch-up thread itself, not deferred (unless a newer reply came since). Newest first. */
  async function chats(threadId, t) {
    let rows = []
    try { rows = await readChats() } catch (error) { log(`chats unreadable: ${error?.message || error}`); return { list: [], failed: true } }
    // Earlier catch-up threads are the catch-up itself, never something it reports.
    const skip = new Set([threadId, ...(state.history || []).map(h => h.thread_id), ...(skipThreads() || [])])
    const cutoff = t / 1000 - CHAT_DAYS * 86400
    const candidates = (Array.isArray(rows) ? rows : [])
      .filter(row => row?.id && !row.archived && !row.hidden && !skip.has(String(row.id)) && seconds(row.last_active ?? row.updated_at) >= cutoff)
      .sort((a, b) => seconds(b.last_active ?? b.updated_at) - seconds(a.last_active ?? a.updated_at))
      .slice(0, CHAT_READS)
    const out = []
    for (let i = 0; i < candidates.length; i += 5) {
      const batch = await Promise.all(candidates.slice(i, i + 5).map(async row => {
        try { return { row, turns: lastTurns(await readTurns(String(row.id))) } } catch { return null }
      }))
      for (const item of batch) {
        if (!item?.turns.answered) continue
        const id = String(item.row.id)
        const at = item.turns.at || seconds(item.row.last_active)
        const deferred = state.deferred.chats[id]
        if (deferred && at <= (deferred.last_at || 0)) continue
        const waiting = item.turns.status?.state === 'needs_you' || item.turns.status?.state === 'check'
        out.push({ id, title: clip(item.row.title || item.turns.mine || 'Untitled chat', 80), at, waiting,
          ask: clip(item.turns.status?.ask || '', 160), mine: item.turns.mine, reply: item.turns.reply })
      }
    }
    return { list: out, failed: false }
  }

  const isOn = () => { try { return sentOn() === true } catch { return false } }
  /** Issue 710: the finished threads in Sent, any age, newest first: not archived, hidden, snoozed or running, not
   *  waiting on the owner (his message is the newest, or the last reply needs him or asks for a check), not Daily/Alerts
   *  or a catch-up, not kept or deferred (unless it changed since).
   *  `{ list: [{ id, title, at, listed }], more, failed }`. */
  async function sentChats(threadId) {
    let rows = []
    try { rows = await readSent() } catch (error) { log(`sent unreadable: ${error?.message || error}`); return { list: [], more: 0, failed: true } }
    const skip = new Set([threadId, ...(state.history || []).map(h => h.thread_id), ...(skipThreads() || [])])
    const seen = new Set()
    const candidates = (Array.isArray(rows) ? rows : [])
      .filter(row => {
        const id = row?.id ? String(row.id) : ''
        if (!id || seen.has(id) || skip.has(id)) return false
        seen.add(id)
        // Back in the listing and not archived (revived, or unarchived by hand): the Sent log shows its sends again.
        if (row.listed && !row.archived && Object.hasOwn(state.cleared, id)) delete state.cleared[id]
        if (row.archived || row.hidden || row.snoozed || row.working) return false
        // A thread the catch-up archived that is still outside the listing has not come back: no read needed.
        if (!row.listed && Object.hasOwn(state.cleared, id) && seconds(row.at) <= seconds(state.cleared[id].at)) return false
        return true
      })
      .sort((a, b) => seconds(b.at) - seconds(a.at))
    // Kept or deferred and unchanged since: skipped without a read.
    const fresh = candidates.filter(row => { const d = state.deferred.chats[String(row.id)]; return !(d && seconds(row.at) <= (d.last_at || 0)) })
    const out = []
    let read = 0
    // Read newest first until SENT_READS finished threads are found; threads that turn out not to be finished never
    // use up the room, but no catch-up reads more than SENT_MAX_READS.
    while (read < fresh.length && out.length < SENT_READS && read < SENT_MAX_READS) {
      const slice = fresh.slice(read, read + 5)
      read += slice.length
      const batch = await Promise.all(slice.map(async row => {
        const id = String(row.id)
        try {
          let title = row.title, listed = row.listed === true, at = seconds(row.at)
          if (!listed) {
            const session = await readSession(id)
            // Archived outside the listing (by hand, or gone): remembered, so it is not read again until it changes.
            if (session?.archived) { state.cleared[id] = { at: now() }; return null }
            if (!session || session.hidden) return null
            title = session.title || title
            at = Math.max(at, seconds(session.last_active ?? session.updated_at))
          }
          return { row, id, title, listed, at, turns: lastTurns(await readTurns(id)) }
        } catch { return null }
      }))
      for (const item of batch) {
        if (!finishedTurns(item?.turns) || !inSentTab(item.row, item.listed, item.turns)) continue
        const at = Math.max(item.at, item.turns.at || 0)
        const deferred = state.deferred.chats[item.id]
        if (deferred && at <= (deferred.last_at || 0)) continue
        if (out.length < SENT_READS) out.push({ id: item.id, title: clip(item.title || item.turns.mine || 'Untitled chat', 80), at, listed: item.listed })
      }
    }
    return { list: out, more: fresh.length - read, failed: false }
  }

  /** Records new since the last catch-up: never shown, or changed after they were shown. */
  function records() {
    if (!inbox) return { waiting: [], finished: [], running: 0 }
    const all = inbox.list({ limit: 1000 })
    const fresh = r => !Object.hasOwn(state.shown_records, r.id) || (r.updated_at || 0) > state.shown_records[r.id]
    return {
      waiting: all.filter(r => isWaitingRecord(r) && fresh(r)).sort((a, b) => (a.created_at || 0) - (b.created_at || 0) || String(a.id).localeCompare(String(b.id))),
      finished: all.filter(r => isFinishedRecord(r) && fresh(r)).sort(byNewest),
      running: all.filter(r => r.state === 'running' || r.state === 'stale').length,
    }
  }

  /**
   * Build one catch-up for the owner's turn in `threadId`, mark what it shows as seen, and return
   * `{ id, note, nothing_new, chats, records }`. Never sends, archives a chat or replies.
   */
  async function compose({ threadId }) {
    const t = now()
    pruneDeferred(t)
    const prev = state.last
    const listed = await chats(threadId, t)
    // Issue 710 (switch on): every finished chat in Sent is on the one Sent count line, not listed on its own.
    const sent = isOn() ? await sentChats(threadId) : null
    if (sent) { const inSent = new Set(sent.list.map(c => c.id)); listed.list = listed.list.filter(c => !inSent.has(c.id)) }
    const shownBefore = prev?.chats || {}
    const newChats = listed.list.filter(c => !Object.hasOwn(shownBefore, c.id) || c.at > shownBefore[c.id])
    const oldChats = listed.list.filter(c => !newChats.includes(c))
    const shownChats = newChats.slice(0, CHAT_CAP)
    const sentNew = sent ? sent.list.filter(c => !((prev?.sent || {})[c.id] >= c.at) && !(shownBefore[c.id] >= c.at)) : []
    const recs = records()
    const waiting = recs.waiting.slice(0, WAITING_CAP), finished = recs.finished.slice(0, DONE_CAP)
    const waitingMore = recs.waiting.length - waiting.length, finishedMore = recs.finished.length - finished.length
    const nothingNew = Boolean(prev) && !shownChats.length && !waiting.length && !finished.length && !listed.failed && !sentNew.length && !sent?.failed
    // Marked seen in the same step: finished and FYI records leave the inbox (as the sweep does), waiting ones stay
    // open for step two but are stamped, so a later catch-up shows them again only when they change.
    const marked = {}
    for (const r of finished) {
      const after = inbox?.patch(r.id, { action: 'archive' })
      if (after) { inbox.update(r.id, { caught_up_at: t }); marked[r.id] = inbox.get(r.id)?.updated_at ?? t }
    }
    for (const r of waiting) {
      const after = inbox?.update(r.id, { caught_up_at: t, ...(r.state === 'new' ? { state: 'surfaced', surfaced_at: t } : {}) })
      if (after) marked[r.id] = after.updated_at
    }
    const id = `catchup_${randomUUID().replaceAll('-', '').slice(0, 20)}`
    const chatMap = Object.fromEntries([...oldChats, ...shownChats].map(c => [c.id, c.at]))
    state.shown_records = Object.fromEntries(Object.entries({ ...state.shown_records, ...marked }).slice(-MAX_SHOWN_RECORDS))
    state.last = { id, at: t, thread_id: threadId, chats: chatMap, records: Object.keys(marked), answered_at: null, nothing_new: nothingNew,
      ...(sent ? { sent: Object.fromEntries(sent.list.map(c => [c.id, c.at])), sent_unlisted: sent.list.filter(c => !c.listed).map(c => c.id) } : {}) }
    state.history = [{ id, at: t, thread_id: threadId, chats: shownChats.length, records: Object.keys(marked).length, nothing_new: nothingNew }, ...(state.history || [])].slice(0, MAX_HISTORY)
    save()
    const note = catchUpNote({ prev, t, nothingNew, shownChats, chatMore: newChats.length - shownChats.length, oldChats: oldChats.length, chatsFailed: listed.failed,
      waiting, waitingMore, finished, finishedMore, running: recs.running, inboxOn: Boolean(inbox), deferred: state.deferred.items, sent })
    return { id, note, nothing_new: nothingNew, chats: shownChats.map(c => c.id), records: Object.keys(marked), ...(sent ? { sent: sent.list.map(c => c.id) } : {}) }
  }

  /** An owner turn in a thread: once he answers in the latest catch-up's thread, clear and defer may act on it. */
  function ownerTurn(threadId, text = '') {
    const last = state.last
    if (!last || last.thread_id !== threadId || startsCatchUp(String(text))) return false
    if (now() - last.at > ANSWER_WINDOW_MS) return false
    last.answered_at = now()
    save()
    return true
  }

  const refuse = text => ({ isError: true, content: [{ type: 'text', text }] })
  const okText = text => ({ content: [{ type: 'text', text }] })
  const answered = () => {
    const last = state.last
    if (!last) return 'There is no catch-up yet. Only act after a catch-up and the owner\'s yes.'
    if (!last.answered_at || last.answered_at < last.at) return 'The owner has not answered this catch-up yet. Show it and wait for his reply (clear, clear except N, a yes, or not now); never clear or defer anything before he says so.'
    if (now() - last.at > ANSWER_WINDOW_MS) return 'That catch-up is more than a day old. Run a new catch-up first.'
    return ''
  }
  const ids = (value, max = 60) => (Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && v && v.length <= 180))].slice(0, max) : [])

  async function clear(args) {
    const why = answered()
    if (why) return refuse(why)
    const last = state.last
    const sentShown = isOn() && last.sent ? last.sent : null
    // Issue 710: `sent: true` is every finished chat in Sent this catch-up offered, except the ones in `keep`.
    const keep = sentShown ? new Set(ids(args.keep, 1000)) : new Set()
    const sentIds = sentShown && args.sent === true ? Object.keys(sentShown).filter(id => !keep.has(id)) : []
    // A Sent thread is checked again right before it is archived: one that runs, waits on him, was snoozed or got a new
    // reply since the catch-up showed it stays.
    let sentNow = null
    const changedSince = async chat => {
      if (!sentShown || !Object.hasOwn(sentShown, chat) || Object.hasOwn(last.chats || {}, chat)) return false
      try {
        sentNow ??= new Map((await readSent() || []).map(row => [String(row?.id), row]))
        const row = sentNow.get(chat)
        if (!row || row.archived || row.hidden || row.snoozed || row.working) return true
        const turns = lastTurns(await readTurns(chat))
        return !finishedTurns(turns) || !inSentTab(row, row.listed === true, turns) || (turns.at || 0) > seconds(sentShown[chat])
      } catch { return true }
    }
    const chatIds = [...new Set([...ids(args.chats), ...sentIds])], recordIds = ids(args.records)
    if (!chatIds.length && !recordIds.length && !keep.size) return refuse(sentShown ? 'Name the chats (ids) and/or agent inbox records (ids) the owner said yes to clearing, or sent: true for the finished chats in Sent.' : 'Name the chats (ids) and/or agent inbox records (ids) the owner said yes to clearing.')
    const shownRecords = new Set(Object.keys(state.shown_records))
    const done = [], skipped = []
    const t = now()
    for (const chat of chatIds) {
      if (!Object.hasOwn(last.chats || {}, chat) && !(sentShown && Object.hasOwn(sentShown, chat))) { skipped.push(`${chat} (not in this catch-up)`); continue }
      if (await changedSince(chat)) { skipped.push(`${chat} (changed since the catch-up: running, waiting on him or a new reply)`); continue }
      try {
        await archiveChat(chat); done.push(`chat ${chat}`)
        // A Sent thread outside the listing: the shell can't see it archived, so the Sent log leaves its sends out.
        if (sentShown && (last.sent_unlisted || []).includes(chat)) state.cleared[chat] = { at: t }
      } catch (error) { skipped.push(`${chat} (archive failed: ${clip(error?.message || 'error', 60)})`) }
    }
    // "clear except N": a kept Sent chat is not offered again until it changes.
    const kept = []
    for (const chat of keep) if (sentShown && Object.hasOwn(sentShown, chat)) { state.deferred.chats[chat] = { at: t, last_at: sentShown[chat] }; kept.push(chat) }
    const clearedIds = Object.keys(state.cleared)
    if (clearedIds.length > MAX_CLEARED) for (const id of clearedIds.slice(0, clearedIds.length - MAX_CLEARED)) delete state.cleared[id]
    for (const record of recordIds) {
      if (!shownRecords.has(record) || !inbox) { skipped.push(`${record} (not in a catch-up)`); continue }
      const after = inbox.patch(record, { action: 'archive' })
      if (after) { done.push(`record ${record}`); state.shown_records[record] = after.updated_at } else skipped.push(`${record} (not found)`)
    }
    save()
    return okText(`Cleared ${done.length}${done.length ? `: ${done.join(', ')}` : ''}.${kept.length ? ` Kept in Sent: ${kept.join(', ')}.` : ''}${skipped.length ? ` Not cleared: ${skipped.join('; ')}.` : ''}`)
  }

  function defer(args) {
    const why = answered()
    if (why) return refuse(why)
    const last = state.last
    const t = now()
    const chatIds = ids(args.chats)
    const items = (Array.isArray(args.items) ? args.items : []).map(item => clip(item, 120)).filter(Boolean).slice(0, 20)
    if (!chatIds.length && !items.length) return refuse('Name the chats (ids) and/or the other items (short labels, e.g. "Mail: Sam\'s invoice") the owner said not now to.')
    const done = [], skipped = []
    for (const chat of chatIds) {
      const sentAt = isOn() && last.sent && Object.hasOwn(last.sent, chat) ? last.sent[chat] : null
      if (!Object.hasOwn(last.chats || {}, chat) && sentAt == null) { skipped.push(`${chat} (not in this catch-up)`); continue }
      state.deferred.chats[chat] = { at: t, last_at: Object.hasOwn(last.chats || {}, chat) ? last.chats[chat] : sentAt }
      done.push(`chat ${chat}`)
    }
    for (const label of items) {
      if (!state.deferred.items.some(item => item.label.toLowerCase() === label.toLowerCase())) state.deferred.items.push({ label, at: t })
      done.push(`"${label}"`)
    }
    pruneDeferred(t)
    save()
    return okText(`Deferred ${done.length}: later catch-ups skip ${done.join(', ') || 'nothing'} (a deferred chat comes back when it gets a new reply).${skipped.length ? ` Not deferred: ${skipped.join('; ')}.` : ''}`)
  }

  // Issue 710 (switch on): clear also takes `sent` and `keep` for the finished chats in Sent.
  const SENT_TOOL_TEXT = ' sent: true clears every finished chat in Sent the catch-up offered; keep: those chat ids stay ("clear except N").'
  const SENT_PROPS = {
    sent: { type: 'boolean', description: 'Clear only: true archives every finished chat in Sent this catch-up offered.' },
    keep: { type: 'array', items: { type: 'string' }, description: 'Clear only: chat ids from the Sent line the owner kept ("clear except N").' },
  }
  const TOOL = {
    name: CATCH_UP_TOOL,
    description: '[WizardOS] Act on the owner\'s answer to a catch-up ("catch me up"), only after he answered it and only on what he said yes to. action clear: archive the chats (ids from the catch-up) and agent inbox records (ids) he cleared, the same way Archive in Chats does (snoozes clear too). action defer: chats (ids) and other items (short labels) he said "drop" or "not now" to; later catch-ups skip them. Never use it to send, pay or reply.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['clear', 'defer'] },
        chats: { type: 'array', items: { type: 'string' }, description: 'Chat ids from the catch-up.' },
        records: { type: 'array', items: { type: 'string' }, description: 'Agent inbox record ids from the catch-up (clear only).' },
        items: { type: 'array', items: { type: 'string' }, description: 'Other things to skip next time, as short labels (defer only).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  }

  const tool = () => (isOn() ? { ...TOOL, description: TOOL.description + SENT_TOOL_TEXT, inputSchema: { ...TOOL.inputSchema, properties: { ...TOOL.inputSchema.properties, ...SENT_PROPS } } } : TOOL)
  return {
    compose,
    ownerTurn,
    /** Issue 710: Sent threads outside the listing the catch-up archived: `{ id: { at } }`. */
    cleared: () => structuredClone(state.cleared || {}),
    latest: () => (state.last ? structuredClone(state.last) : null),
    deferred: () => structuredClone(state.deferred),
    history: () => structuredClone(state.history || []),
    tools: {
      list: () => [tool()],
      async call(name, args = {}) {
        if (name !== TOOL.name) return undefined
        if (!args || typeof args !== 'object' || Array.isArray(args)) return refuse('Arguments must be an object.')
        if (!isOn() && (Object.hasOwn(args, 'sent') || Object.hasOwn(args, 'keep'))) args = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'sent' && k !== 'keep'))
        if (args.action === 'clear') return clear(args)
        if (args.action === 'defer') return defer(args)
        return refuse('action must be clear or defer.')
      },
    },
  }
}

const recordLine = r => `- id ${r.id}${r.agent && r.agent !== 'hermes' ? ` (agent ${r.agent})` : ''}: ${clip(r.title, 80)}${r.ask && r.ask !== r.title ? ` | ${clip(r.ask, 140)}` : ''}${r.recommendation ? ` | recommendation: ${clip(r.recommendation, 140)}` : ''}${r.kind === 'confirm' || r.confirm ? ' | needs a sure yes' : ''}`

/** Issue 710: the note's lines for the finished chats in Sent (switch on). */
function sentLines(sent) {
  if (sent.failed) return ['Finished chats in Sent: the Sent list could not be read right now. Say so in one line; do not guess.']
  const n = sent.list.length
  const out = [`Finished chats in Sent (any age: the owner sent them, they finished and need nothing from him; none is running, waiting on him or snoozed). They go in "Clear all" as ONE count line, "${n} finished chat${n === 1 ? '' : 's'} in Sent"; name the titles only if he asks:`]
  if (!n) return [...out, '- None.']
  for (const c of sent.list.slice(0, SENT_TITLES)) out.push(`- id ${c.id} | "${c.title}"`)
  if (n > SENT_TITLES) out.push(`- and ${n - SENT_TITLES} more (cleared with the rest by "sent": true).`)
  if (sent.more > 0) out.push(`- ${sent.more} older Sent chats were not checked this time; the next catch-up offers them.`)
  return out
}

/** The run note for one catch-up turn: Miguel's prompt, then the data the Service read for it. */
export function catchUpNote({ prev, t, nothingNew, shownChats, chatMore, oldChats, chatsFailed, waiting, waitingMore, finished, finishedMore, running, inboxOn, deferred, sent = null }) {
  const out = ['Catch me up (built into WizardOS): the owner asked for a catch-up. Follow this prompt exactly; the Wizard Agent Service has already read his chats and agent inbox for you below.', '', BASELINE_PROMPT, '']
  out.push(prev ? `Last catch-up: ${ago(prev.at, t)}. Only what is new since then is listed below.` : 'This is the first catch-up.')
  if (nothingNew) {
    out.push('Nothing new since the last catch-up: no chat got a new reply and nothing new reached the agent inbox.')
    out.push(`Check the apps as the prompt says. If they have nothing new either, answer only: "Nothing new since your last catch-up."${oldChats ? ` You may add one line: "${oldChats} chat${oldChats === 1 ? '' : 's'} from it still open."` : ''}${sent?.list.length ? ' Then the one Clear all line for the finished chats in Sent below, and "Reply clear or clear except N."' : ''} Do not repeat the earlier catch-up.`)
  }
  out.push('', 'Wizard chats (already read for you: the owner\'s last message and the last reply; id is for wizard_catch_up):')
  if (chatsFailed) out.push('- The chat list could not be read right now. Say so in one line; do not guess.')
  else if (!shownChats.length) out.push('- None new.')
  for (const c of shownChats) {
    out.push(`- id ${c.id} | "${c.title}" | ${c.waiting ? `waiting on the owner${c.ask ? `: ${c.ask}` : ''}` : 'finished, not archived'}`)
    if (c.mine) out.push(`  Owner said: ${c.mine}`)
    if (c.reply) out.push(`  Last reply: ${c.reply}`)
  }
  if (chatMore > 0) out.push(`- ${chatMore} more chats not listed: one line "${chatMore} more chats" in Clear all or step two.`)
  if (oldChats && !nothingNew) out.push(`- ${oldChats} chat${oldChats === 1 ? ' was' : 's were'} already in the last catch-up and did not change: one closing line with the count, not listed again.`)
  out.push('', 'Agent inbox (background results, quiet replies and confirm asks since the last catch-up; record id is for wizard_catch_up):')
  if (!inboxOn) out.push('- The agent inbox is off on this Wizard.')
  else {
    out.push('Finished and FYI (each goes in "Clear all", one line each, or one count line when there are many):')
    if (!finished.length) out.push('- None.')
    for (const r of finished) out.push(recordLine(r))
    if (finishedMore > 0) out.push(`- ${finishedMore} more: show as "${finishedMore} more".`)
    out.push('Waiting on the owner (confirm asks; these go in the step-two batches):')
    if (!waiting.length) out.push('- None.')
    for (const r of waiting) out.push(recordLine(r))
    if (waitingMore > 0) out.push(`- ${waitingMore} more: show as "${waitingMore} more".`)
    if (running) out.push(`Still running in the background: ${running} (one count line at most).`)
  }
  if (sent) out.push('', ...sentLines(sent))
  if (deferred?.length) out.push('', `The owner said not now to these; skip them: ${deferred.map(item => `"${item.label}"`).join(', ')}.`)
  out.push('', `Acting on his answer: when he replies "clear" (or "clear except N"), call wizard_catch_up {"action":"clear"} with the chat ids and record ids of the Clear all items he cleared${sent?.list.length ? ', plus "sent": true when the Sent line is cleared (with "keep": [chat ids] for the Sent chats he kept)' : ''}, then show step two.`
    + ' For "drop" or "not now, will mention", call wizard_catch_up {"action":"defer"} with those chat ids, or short labels for app items. Never call it before he answers, and never send, archive, pay or reply without his yes.')
  return out.join('\n')
}
