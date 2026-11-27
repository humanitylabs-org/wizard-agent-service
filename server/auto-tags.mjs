// Automatic chat tags (issue 702, switch wizard/auto-tags, off by default): the Service decides each chat's channel
// tags from what the chat is about, not only from the agent's status-line `channel`.
//
// Each channel has a "covers" list (channel-store.mjs `channel_covers`): plain words or phrases ("clips", "TSR",
// "fact check") and kind entries (`kind: report`). On every status line and list row the chat's title, subject,
// app id and first owner message are matched against every channel's covers. Deterministic matching decides first;
// only a chat whose only evidence is weak (a learned title, a first-message mention of a learned phrase) goes to the
// owner's PRIVATE fast model (the same private-router rule Alert rules use) with a strict confidence bar, and never on
// the list path. The agent's `channel` / `channels` are hints. Every refusal is logged with its reason and told to the
// agent once in its next run note. A tag the owner removed is never put back (channel-store `tag_removed`).
import { subjectKey } from './thread-subjects.mjs'
import { subjectFitsChannel } from './thread-spaces.mjs'
import { CHAT_KINDS } from './channel-store.mjs'
import { parseStatus } from './thread-status.mjs'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

export const AUTO_TAGS_SWITCH = 'wizard/auto-tags'
export const REPORT_KINDS = ['question', 'lookup', 'evaluation', 'digest', 'report']
export const REMINDER_KINDS = ['reminder', 'todo']
// The private model's answer must be at least this sure before a tag goes on.
export const MODEL_CONFIDENCE = 0.85
const MODEL_CALLS_PER_HOUR = 30
const FIRST_MAX = 400
const NOTES_MAX = 2000
const MEMO_MAX = 20000
const THREAD_ID = /^[A-Za-z0-9._:-]{1,180}$/u
const CHANNEL_ID = /^[a-z0-9-]{1,48}$/u

const GENERIC = new Set(['the', 'and', 'for', 'with', 'your', 'our', 'my', 'misc', 'other', 'others', 'general', 'stuff', 'thing', 'things', 'note', 'notes',
  'chat', 'chats', 'new', 'old', 'all', 'app', 'apps', 'project', 'projects', 'work', 'team', 'idea', 'ideas', 'misc', 'of', 'a', 'an', 'to', 'in', 'on'])
const stem = w => w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w
/** Lower-case words (letters and digits), plural s dropped, so "Clips" matches "clip". */
export const words = text => (String(text || '').toLocaleLowerCase().replace(/['\u2019]/gu, '').match(/[\p{L}\p{N}]+/gu) || []).map(stem)
const key = text => words(text).join(' ')
const kindOf = phrase => { const m = /^kind\s*:\s*([a-z-]+)$/iu.exec(String(phrase || '').trim()); return m && CHAT_KINDS.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : '' }
const clip = (v, n) => String(v ?? '').replace(/\s+/gu, ' ').trim().slice(0, n)
// Phrase words found together, in order, in a field's words.
function hasPhrase(fieldWords, phraseWords) {
  if (!phraseWords.length || phraseWords.length > fieldWords.length) return false
  outer: for (let i = 0; i <= fieldWords.length - phraseWords.length; i++) {
    for (let j = 0; j < phraseWords.length; j++) if (fieldWords[i + j] !== phraseWords[j]) continue outer
    return true
  }
  return false
}

// ---- chat kind (James's 27 Nov addition): from the first owner message plus the chat's source ----
const REMIND = /\bremind me\b|\bset (?:a |an )?reminder\b|\bdon[’']?t let me forget\b/iu
const TODO = /\b(?:add|put)\b[^.?!]{0,60}\b(?:to-?do|todo|task list|tasks)\b|\bmy to-?do\b/iu
// Build, bug, app-work and draft-to-a-person chats: never a Reports kind, even when they open with a question.
const WORK = /\b(?:fix|fixe[ds]|fixing|bug|bugs|build|building|rebuild|deploy|deploying|ship|merge|implement|refactor|release|pull request|pr|commit|install|reinstall|configure|set up|setup|debug|patch|upgrade|downgrade|migrate|draft|redraft|compose|reply to|respond to|write (?:a |an |the )?(?:message|email|e-mail|mail|reply|note|post|letter|text) to|(?:message|email|e-mail|text|tell) (?:him|her|them|[A-Z][a-z]+)\b|fail|fails|failed|failing|broken|breaks|error|errors|crash|crashes|crashed|stuck|not working|doesn[’']?t work|won[’']?t (?:load|start|open|work))\b/iu
const EVALUATION = /\b(?:evaluate|evaluation|assess|assessment|compare|comparison|pros and cons|is (?:it|this|that|\w+) (?:a )?(?:good |right )?fit|good fit|worth (?:it|using|buying)|should (?:we|i) (?:use|adopt|switch|buy|pick))\b/iu
const REPORT = /\b(?:report|reports|research|investigate|scan|survey|summari[sz]e|summary of|roundup|round-up|digest|overview|extract|compress|transcribe|transcript|triage)\b/iu
const LOOKUP = /\b(?:look up|lookup|look into|find out|what is|what are|what['’]s|who is|who are|check (?:whether|if)|is there|are there|does (?:it|this|anyone)|when (?:is|does|did))\b/iu
const QUESTION_LEAD = /^(?:what|why|how|who|when|where|which|is|are|does|do|did|can|could|should|would|will)\b/iu
const DIGEST_TITLE = /\b(?:digest|roundup|round-up|daily brief|weekly brief|report)\b/iu
/**
 * The chat's kind: one of CHAT_KINDS, 'work' (a build, bug, app-work or draft chat: never a Reports kind), or ''.
 * `scheduled`: a chat the scheduler opened or a cron-delivered thread (a digest unless it is a reminder).
 */
export function chatKind({ first = '', title = '', source = '', scheduled = false } = {}) {
  const t = clip(first, FIRST_MAX)
  if (REMIND.test(t)) return 'reminder'
  if (TODO.test(t)) return 'todo'
  if (scheduled || /^(?:cron|schedule|scheduler)$/iu.test(String(source || ''))) return 'digest'
  if (!t) return DIGEST_TITLE.test(title) ? 'report' : ''
  if (WORK.test(t)) return 'work'
  if (EVALUATION.test(t)) return 'evaluation'
  if (REPORT.test(t)) return 'report'
  if (LOOKUP.test(t)) return 'lookup'
  if (/\?\s*$/u.test(t) || QUESTION_LEAD.test(t)) return 'question'
  return DIGEST_TITLE.test(title) ? 'report' : ''
}

/** What a channel starts with: its name's own words (Reports and Reminders channels: their kinds instead), its
 *  learned subjects. */
export function seedCoversFor(channel, subjects = []) {
  const nameWords = words(channel?.name).filter(w => !GENERIC.has(w))
  const out = []
  if (nameWords.some(w => w === 'report')) out.push(...REPORT_KINDS.map(k => `kind: ${k}`))
  else if (nameWords.some(w => w === 'reminder' || w === 'remind' || w === 'todo')) out.push(...REMINDER_KINDS.map(k => `kind: ${k}`))
  else {
    // Plain name words, written as the owner wrote them (emoji dropped).
    const raw = String(channel?.name || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []
    for (const w of raw) if (!GENERIC.has(stem(w.toLocaleLowerCase())) && w.length > 1) out.push(w)
  }
  for (const s of subjects) if (typeof s === 'string' && s && !out.some(x => key(x) === key(s))) out.push(s)
  return out.slice(0, 40)
}

/**
 * The deterministic decision for one chat against its agent's channels.
 * chat: {title, subject, appId, first, kind, hints: [channel ids], parentTags: [ids]}
 * channels: [{id, name, kind, archived, covers: {covers, learned, not}, subjects: Set}]
 * -> {tag: [{id, why}], ambiguous: [{id, why}], refused: [{id, why}]}
 */
const compiled = new WeakMap()
// A channel's covers as word lists, worked out once per snapshot (a list rebuild decides every row against them).
function compile(c) {
  let k = compiled.get(c)
  if (k) return k
  const listed = (c.covers?.covers || []).map(p => ({ p, kind: kindOf(p), w: words(p) })).filter(x => x.kind || x.w.length)
  const learned = (c.covers?.learned || []).map(p => ({ p, w: words(p), k: key(p) })).filter(x => x.w.length)
  k = { listed, learned, not: new Set((c.covers?.not || []).map(key).filter(Boolean)) }
  compiled.set(c, k)
  return k
}
export function decideTags(chat, channels) {
  const fields = { title: words(chat.title), subject: words(chat.subject), app: words(String(chat.appId || '').replace(/[-_]/gu, ' ')), first: words(clip(chat.first, FIRST_MAX)) }
  const subjectKeyOf = subjectKey(chat.subject || '')
  const titleKey = fields.title.join(' '), subjectPlain = fields.subject.join(' ')
  const hints = new Set((chat.hints || []).filter(id => typeof id === 'string'))
  const out = { tag: [], ambiguous: [], refused: [] }
  for (const c of channels) {
    if (c.archived || c.kind === 'alerts' || c.kind === 'daily') { if (hints.has(c.id)) out.refused.push({ id: c.id, why: c.kind === 'alerts' ? 'Alerts is filed by the Service' : c.kind === 'daily' ? 'Daily holds one chat per day' : 'channel archived' }); continue }
    const cc = compile(c)
    // What the owner's removals taught: a chat like that one does not belong here, unless his own list says so in its title.
    const negated = (titleKey && cc.not.has(titleKey)) || (subjectPlain && cc.not.has(subjectPlain))
    let strong = '', weak = ''
    for (const x of cc.listed) {
      if (x.kind) { if (!strong && !negated && x.kind === chat.kind) strong = `kind ${x.kind}`; continue }
      // The owner's listed phrase in the title always decides; elsewhere only when none of his removals says no.
      const where = hasPhrase(fields.title, x.w) ? 'title' : negated ? '' : hasPhrase(fields.subject, x.w) ? 'subject' : hasPhrase(fields.app, x.w) ? 'app' : hasPhrase(fields.first, x.w) ? 'the first message' : ''
      if (where) { strong = `covers "${x.p}" in ${where}`; break }
    }
    if (!strong && !negated && subjectKeyOf && c.subjects?.has(subjectKeyOf)) strong = `learned subject ${chat.subject}`
    if (!strong && !negated) {
      for (const x of cc.learned) {
        if (x.k === titleKey || x.k === subjectPlain) { strong = `learned "${x.p}"`; break }
        if (!weak && (hasPhrase(fields.title, x.w) || hasPhrase(fields.subject, x.w) || hasPhrase(fields.first, x.w))) weak = `learned "${x.p}"`
      }
    }
    if (!strong && !negated && (chat.parentTags || []).includes(c.id)) strong = 'inherited from the chat it came from'
    if (strong) { out.tag.push({ id: c.id, why: strong }); continue }
    if (hints.has(c.id)) {
      // The agent's hint: taken when the old subject rule agrees or something weaker points here too.
      if (!negated && (weak || subjectFitsChannel(chat.subject, c, (id, k) => c.subjects?.has(k) === true))) { out.tag.push({ id: c.id, why: weak ? `agent channel + ${weak}` : 'agent channel, subject fits' }); continue }
      out.refused.push({ id: c.id, why: negated ? 'the owner removed a chat like this from it' : chat.subject ? `subject ${clip(chat.subject, 40)}` : 'no subject' })
      continue
    }
    if (weak) out.ambiguous.push({ id: c.id, why: weak })
  }
  return out
}

/** The private model's check of an ambiguous chat. -> [{id, confidence}] (throws on any failure). */
export async function decideTagsWithModel(chat, candidates, { router, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const system = 'You file one chat into the owner\u2019s channels. A channel fits only when its covers clearly describe what this chat is about. '
    + 'Answer with JSON only: {"channels":[{"id":"<channel id>","confidence":0.0-1.0}]}. List only channels that fit; an empty list is a fine answer. Never invent ids.'
  const facts = { title: clip(chat.title, 120), subject: clip(chat.subject, 40), app: clip(chat.appId, 60), first_message: clip(chat.first, FIRST_MAX), kind: chat.kind || '',
    channels: candidates.map(c => ({ id: c.id, name: clip(c.name, 60), covers: [...(c.covers?.covers || []), ...(c.covers?.learned || [])].slice(0, 30) })) }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let content = ''
  try {
    const upstream = await fetchImpl(router.url, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(router.key ? { Authorization: ['Bearer', router.key].join(' ') } : {}) },
      body: JSON.stringify({ model: router.model, temperature: 0, max_tokens: 160, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(facts) }] }),
    })
    if (!upstream.ok) throw new Error(`model ${upstream.status}`)
    content = String((await upstream.json())?.choices?.[0]?.message?.content ?? '')
  } finally { clearTimeout(timer) }
  const match = content.match(/\{[\s\S]*\}/u)
  const reply = match ? JSON.parse(match[0]) : null
  if (!reply || !Array.isArray(reply.channels)) throw new Error('model reply unreadable')
  const ids = new Set(candidates.map(c => c.id))
  return reply.channels.filter(x => x && ids.has(x.id) && typeof x.confidence === 'number').map(x => ({ id: x.id, confidence: x.confidence }))
}

/**
 * The tagger. `store()` is the channel store (or null), `on()` the switch, `scheduled(agent, thread)` whether the
 * scheduler opened that chat, `firstMessage(agent, thread)` the first owner message when a row does not carry one,
 * `router()` the PRIVATE fast router or null, `log(line)`.
 */
export function createAutoTagger({ store = () => null, on = () => false, scheduled = () => false, firstMessage = () => '', router = () => null, fetchImpl = fetch, log = line => console.log(line), now = Date.now, defer = false } = {}) {
  const memo = new Map() // agent\0thread -> signature of the last decision
  const facts = new Map() // agent\0thread -> {title, subject, appId, first, source, parent}
  const firsts = new Map()
  const notes = new Map() // agent\0thread -> [lines] for the next run note
  let leftovers = [] // main agent: untagged chats the nightly pass could not decide, for the agent's sweep
  let snapshot = { version: -1, agents: new Map() }
  const modelTried = new Set()
  let modelCalls = [], modelBusy = Promise.resolve()
  const pair = (agent, thread) => `${agent}\u0000${thread}`
  const bound = (map, max) => { if (map.size > max) map.delete(map.keys().next().value) }
  const note = (agent, thread, line) => {
    const k = pair(agent, thread), list = notes.get(k) || []
    if (!list.includes(line)) list.push(line)
    notes.delete(k); notes.set(k, list.slice(-5)); bound(notes, NOTES_MAX)
  }
  // Every channel of an agent with its covers, seeded the first time they are seen. Re-read only when the store changed.
  const channelsOf = (channels, agent) => {
    const version = channels.coversVersion?.() ?? 0
    if (snapshot.version !== version) snapshot = { version, agents: new Map() }
    if (snapshot.agents.has(agent)) return snapshot.agents.get(agent)
    let rows = channels.list({ agent }).channels
    let seeded = false
    for (const c of rows) {
      if (c.kind === 'alerts' || c.kind === 'daily' || c.archived) continue
      try { if (channels.seedCovers?.(c.id, seedCoversFor(c, channels.channelSubjects?.(c.id, 12) || []))) seeded = true } catch { /* seeding is best effort */ }
    }
    if (seeded) { snapshot = { version: channels.coversVersion?.() ?? 0, agents: new Map() }; rows = channels.list({ agent }).channels }
    const all = channels.coversAll?.() || new Map()
    const list = rows.map(c => ({ id: c.id, name: c.name, kind: c.kind || '', archived: c.archived === true, covers: all.get(c.id) || { covers: [], learned: [], not: [] }, subjects: new Set(channels.channelSubjects?.(c.id, 12) || []) }))
    snapshot.agents.set(agent, list)
    return list
  }
  const firstOf = (agent, thread, row) => {
    const own = typeof row?.wizard_first_request === 'string' ? row.wizard_first_request : typeof row?.firstRequest === 'string' ? row.firstRequest : ''
    if (own) return own
    const k = pair(agent, thread)
    if (firsts.has(k)) return firsts.get(k)
    let text = ''
    try { text = clip(firstMessage(agent, thread) || '', FIRST_MAX) } catch { text = '' }
    if (!text && typeof row?.preview === 'string') return clip(row.preview, FIRST_MAX)
    firsts.set(k, text); bound(firsts, MEMO_MAX)
    return text
  }
  // Tag writes found while a list is built wait for the next turn of the event loop and go in one transaction, so a
  // list rebuild never waits on the store (issue 584); a status line's own tags go on at once.
  let pending = [], flushing = false, sweeping = false
  const flush = () => {
    flushing = false
    const work = pending; pending = []
    if (!work.length) return 0
    const channels = store()
    if (!channels || !on()) return 0
    let added = 0
    try {
      const done = channels.tagMany ? channels.tagMany(work.map(w => ({ agent: w.agent, sessionId: w.thread, channelId: w.id })))
        : work.map(w => channels.tagIfAllowed(w.agent, w.thread, w.id, 'agent'))
      work.forEach((w, i) => { if (done[i]) { added++; log(`[auto-tags] ${w.agent} ${w.thread}: tagged ${w.name} (${w.why})`) } })
    } catch (error) { log(`[auto-tags] tags not written: ${clip(error?.message || error, 120)}`) }
    return added
  }
  const tagOne = (channels, agent, thread, id, why, name, later = false) => {
    const refusal = channels.tagRefusal?.(agent, thread, id) ?? ''
    if (refusal === 'already tagged') return false
    if (refusal) {
      log(`[auto-tags] ${agent} ${thread}: ${name} not tagged (${refusal}; would have been: ${why})`)
      if (refusal !== 'the owner removed this tag' && refusal !== 'the owner took this chat out of every channel') note(agent, thread, `${name} refused: ${refusal}`)
      return false
    }
    pending.push({ agent, thread, id, why, name })
    if (later) { if (!flushing) { flushing = true; setImmediate(flush) } return true }
    return flush() > 0
  }
  const modelCheck = (agent, thread, chat, candidates) => {
    const r = router()
    const k = `${pair(agent, thread)}\u0000${candidates.map(c => c.id).join(',')}`
    if (!r || modelTried.has(k)) return false
    const t = now()
    modelCalls = modelCalls.filter(at => t - at < 3600_000)
    if (modelCalls.length >= MODEL_CALLS_PER_HOUR) return false
    modelTried.add(k); bound(modelTried, MEMO_MAX); modelCalls.push(t)
    modelBusy = modelBusy.then(async () => {
      const channels = store()
      if (!channels || !on()) return
      try {
        const picks = await decideTagsWithModel(chat, candidates, { router: r, fetchImpl })
        for (const p of picks) {
          const c = candidates.find(x => x.id === p.id)
          if (p.confidence >= MODEL_CONFIDENCE) tagOne(channels, agent, thread, p.id, `private model ${p.confidence.toFixed(2)}`, c.name)
          else log(`[auto-tags] ${agent} ${thread}: ${c.name} skipped (private model only ${p.confidence.toFixed(2)} sure)`)
        }
      } catch (error) { log(`[auto-tags] private model unavailable (${clip(error?.message || error, 80)}); ${thread} waits for the nightly pass`) }
    })
    return true
  }
  /** One chat, from a status line and/or a list row. -> how many tags were added (sync part only). */
  function apply(agent, thread, status, row = null) {
    if (!on() || typeof thread !== 'string' || !THREAD_ID.test(thread)) return 0
    const channels = store()
    if (!channels) return 0
    const k = pair(agent, thread)
    const prev = facts.get(k) || {}
    const hints = [...new Set([status?.channel, status?.space, ...(Array.isArray(status?.channels) ? status.channels : [])].filter(v => typeof v === 'string' && CHANNEL_ID.test(v)))].slice(0, 8)
    const chat = {
      title: clip(row?.title || status?.title || prev.title || '', 160),
      subject: clip(status?.subject || prev.subject || '', 40),
      appId: clip(status?.app_id || row?.app_id || prev.appId || '', 80),
      source: clip(row?.source || prev.source || '', 40),
      parent: typeof row?.parent_session_id === 'string' && THREAD_ID.test(row.parent_session_id) ? row.parent_session_id : prev.parent || '',
    }
    chat.first = row || prev.first === undefined ? firstOf(agent, thread, row) : prev.first
    facts.delete(k); facts.set(k, { ...chat, hints: hints.length ? hints : prev.hints || [] }); bound(facts, MEMO_MAX)
    let isScheduled = false
    try { isScheduled = scheduled(agent, thread) === true } catch { isScheduled = false }
    // A chat the scheduler opened is filed by its job (issue 441): the status line's channel is no hint there.
    if (isScheduled) hints.length = 0
    const version = channels.coversVersion?.() ?? 0
    const sig = JSON.stringify([version, chat.title, chat.subject, chat.appId, chat.first, chat.parent, hints, isScheduled])
    if (memo.get(k) === sig) return 0
    memo.delete(k); memo.set(k, sig); bound(memo, MEMO_MAX)
    let list
    try { list = channelsOf(channels, agent) } catch { return 0 }
    if (!list.length) return 0
    let parentTags = []
    if (chat.parent) { try { parentTags = channels.tagsOf(agent, chat.parent) } catch { parentTags = [] } }
    const decided = decideTags({ ...chat, kind: chatKind({ first: chat.first, title: chat.title, source: chat.source, scheduled: isScheduled }), hints, parentTags }, list)
    const name = id => list.find(c => c.id === id)?.name || id
    let added = 0
    const later = defer && row !== null && !sweeping
    for (const t of decided.tag) if (tagOne(channels, agent, thread, t.id, t.why, name(t.id), later)) added++
    for (const r of decided.refused) {
      log(`[auto-tags] ${agent} ${thread}: ${name(r.id)} refused (${r.why})`)
      note(agent, thread, `${name(r.id)} refused: ${r.why}`)
    }
    const already = new Set(decided.tag.map(t => t.id))
    const open = decided.ambiguous.filter(a => !already.has(a.id) && !channels.hasTag(agent, thread, a.id))
    if (open.length) {
      const sent = modelCheck(agent, thread, { ...chat, kind: chatKind({ first: chat.first, title: chat.title, source: chat.source, scheduled: isScheduled }) }, open.map(a => list.find(c => c.id === a.id)))
      if (!sent) for (const a of open) log(`[auto-tags] ${agent} ${thread}: ${name(a.id)} skipped (only ${a.why}; no private model to ask)`)
    }
    return added
  }
  return {
    apply,
    /** The agent's note for this chat: what was refused since its last run (said once), and the nightly leftovers. */
    runNote(agent, thread) {
      if (!on()) return ''
      const parts = ['Tags: the Service tags each chat itself from its title, subject, app and first owner message against each channel\u2019s covers; your channel is a hint. You may name several: "channels": ["<id>", ...] (channel still works). To add a tag to an existing chat: PATCH /wizard/hermes/api/sessions/<id> with {"tags": ["<channel id or name>"]}; a tag the owner removed is refused.']
      const k = pair(agent, thread || '')
      if (thread && notes.has(k)) { parts.push(`Tag refusals in this chat: ${notes.get(k).join('; ')}.`); notes.delete(k) }
      if (agent === 'hermes' && leftovers.length) {
        parts.push(`Untagged chats from the nightly tag pass (tag the ones that clearly fit, with the PATCH above): ${JSON.stringify(leftovers.slice(0, 20))}`)
        leftovers = []
      }
      return parts.join(' ')
    },
    /** What an owner tag edit teaches. `added` true for an add, false for a removal. */
    learnOwner(agent, thread, channelId, added) {
      const channels = store()
      if (!channels || !on()) return
      const f = facts.get(pair(agent, thread))
      if (!f) return
      try {
        const subject = subjectKey(f.subject || '')
        if (added && subject) channels.learnSubject?.(channelId, subject)
        for (const phrase of [f.subject, f.title].filter(Boolean)) channels.learnCover?.(channelId, phrase, !added)
      } catch (error) { log(`[auto-tags] lesson not kept: ${clip(error?.message || error, 120)}`) }
      memo.delete(pair(agent, thread))
    },
    /** The agent's own add-tag route: ids or channel names. -> {sessionId, tags, added, refused} */
    agentTags(agent, thread, list) {
      const channels = store()
      if (!channels) throw Object.assign(new Error('channels_unavailable'), { status: 503 })
      if (!Array.isArray(list) || !list.length || list.length > 10) throw Object.assign(new Error('invalid_tags'), { status: 400 })
      if (!THREAD_ID.test(thread)) throw Object.assign(new Error('invalid_session'), { status: 400 })
      const own = channels.list({ agent }).channels
      const added = [], refused = []
      for (const v of list) {
        const c = typeof v === 'string' ? own.find(x => x.id === v) || own.find(x => key(x.name) === key(v)) : null
        if (!c) { refused.push({ channel: clip(v, 60), reason: 'unknown channel' }); continue }
        const why = channels.tagRefusal?.(agent, thread, c.id) || ''
        if (why === 'already tagged') { added.push(c.id); continue }
        if (why) { refused.push({ channel: c.id, reason: why }); log(`[auto-tags] ${agent} ${thread}: agent's ${c.name} refused (${why})`); continue }
        if (channels.tagIfAllowed(agent, thread, c.id, 'agent')) { added.push(c.id); log(`[auto-tags] ${agent} ${thread}: tagged ${c.name} (the agent asked)`) }
        else refused.push({ channel: c.id, reason: 'refused' })
      }
      return { sessionId: thread, agent, tags: channels.tagsOf(agent, thread), added, refused }
    },
    /** The nightly pass / one-time backfill over rows [{id, title, first, source, subject, app_id, parent_session_id}]:
     *  decided tags go on now; chats still untagged afterwards are kept for the agent's sweep. -> {seen, tagged, left} */
    sweep(agent, rows) {
      const channels = store()
      if (!channels || !on()) return { seen: 0, tagged: 0, left: 0 }
      let tagged = 0
      const left = []
      const seen = []
      sweeping = true
      try {
        for (const row of rows) {
          if (!row || !THREAD_ID.test(String(row.id || ''))) continue
          memo.delete(pair(agent, row.id))
          tagged += apply(agent, row.id, { subject: row.subject || '', ...(row.app_id ? { app_id: row.app_id } : {}) }, { title: row.title || '', wizard_first_request: row.first || '', source: row.source || '', parent_session_id: row.parent_session_id || null })
          seen.push(row)
        }
      } finally { sweeping = false }
      tagged += flush()
      for (const row of seen) { try { if (!channels.tagsOf(agent, row.id).length) left.push({ id: row.id, title: clip(row.title, 80) }) } catch { /* unknown */ } }
      if (agent === 'hermes') leftovers = left.slice(0, 50)
      log(`[auto-tags] pass over ${rows.length} chats: ${tagged} tagged, ${left.length} left for the agent's sweep`)
      return { seen: rows.length, tagged, left: left.length }
    },
    leftovers: () => leftovers.slice(),
    flush,
    settled: () => modelBusy,
  }
}

/**
 * The main agent's visible chats active since `sinceSeconds`, read-only from its Hermes state.db, for the nightly pass
 * and the backfill: [{id, title, source, parent_session_id, subject, app_id}] newest first. The first owner message is
 * added by the caller (session-truth readHermesFirstRequests). [] when the file is missing or unreadable.
 */
export function readRecentChats(path, sinceSeconds, { limit = 2000 } = {}) {
  if (!path || !existsSync(path)) return []
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const cols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(r => r.name))
    const at = cols.has('last_activity_at') ? 'COALESCE(last_activity_at, started_at)' : 'started_at'
    const where = [`${at} >= ?`, ...(cols.has('hidden') ? ['COALESCE(hidden,0)=0'] : []), ...(cols.has('archived') ? ['COALESCE(archived,0)=0'] : [])].join(' AND ')
    const rows = db.prepare(`SELECT id, title, ${cols.has('source') ? 'source' : "'' AS source"}, ${cols.has('parent_session_id') ? 'parent_session_id' : 'NULL AS parent_session_id'} FROM sessions WHERE ${where} ORDER BY ${at} DESC LIMIT ?`).all(sinceSeconds, limit)
    const last = db.prepare("SELECT content FROM messages WHERE session_id=? AND role='assistant' AND content LIKE '%[WIZARD_STATUS_V1]%' ORDER BY timestamp DESC LIMIT 1")
    return rows.filter(r => typeof r.id === 'string' && THREAD_ID.test(r.id)).map(r => {
      let status = null
      try { status = parseStatus(String(last.get(r.id)?.content || '')) } catch { status = null }
      return { id: r.id, title: String(r.title || ''), source: String(r.source || ''), parent_session_id: r.parent_session_id || null, subject: status?.subject || '', app_id: status?.app_id || '' }
    })
  } catch { return [] } finally { try { db?.close() } catch { /* read-only */ } }
}
