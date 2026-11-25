// Optional orb command router: classifies one spoken utterance as a phone/UI command, a reply to
// the window in front, or a request for the agent. It calls any OpenAI-compatible chat endpoint
// the owner configures (WIZARD_ROUTER_URL / _MODEL / _KEY). With no router configured, front ends
// send everything to the agent. Place and time zone come from WizardOS settings, never the code.
//
// Dump route (issue 551, agent inbox switch wizard/agent-inbox, off by default; only for a shell that sends
// accept_dump): a NEW task request becomes {"route":"dump"}, started in the background with no visible thread. It
// stays {"route":"agent"} (a visible thread) when the words say "reply" or "tell me", ask for a conversation, or are
// a short direct question. The model decides in the same call it already makes; dumpIntent() then settles the clear
// cases from the words alone, so a model slip can never hide a question or keep a plain task visible.
import { validTimeZone } from './wizard-os-settings.mjs'

const ROUTER_SYSTEM = `You are the command router inside WizardOS, a voice-first shell.
Classify ONE spoken utterance and reply with ONLY one compact JSON object, no prose.

If it is a direct phone/UI command, reply {"route":"command","action":ACTION,...args}. Actions:
- open_app {"app": name}            open a Wizard app or device app by name
- open_view {"view": "day"|"week"|"month"|"inbox"|"apps", "date": "YYYY-MM-DD" optional}
- zoom {"dir": "in"|"out"}
- desk {"to": "next"|"prev"|"home"|1-5}
- maps_directions {"destination": text}
- maps_search {"query": text}
- play_music {"query": text}
- clear_desk {}
- close_window {}                    close the window in front
- fullscreen {"on": true|false}     make the window in front fill the screen, or tile it again
- move_window {"to": "next"|"prev"|1-5}
- search {"query": text}
If it needs reasoning, memory, writing, research, decisions, or a conversation with the agent, reply {"route":"agent","summary": short restatement}.
If it opens an app AND asks for follow-up work inside it ("open the notes app and add milk"), reply
{"route":"command","action":"open_app","app":name,"then_agent": the follow-up as a short request}.

Known Wizard apps: %APPS%.
%DUMP%Today is %TODAY%. Resolve "yesterday", weekdays, and "last week" to dates when asked for a day view.%PLACE%`

function today(timezone, now = new Date()) {
  const zone = validTimeZone(timezone) || 'UTC'
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' })
    .formatToParts(now).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {})
  return `${parts.year}-${parts.month}-${parts.day} (${parts.weekday}, ${zone})`
}

const DUMP_RULE = `If it hands the agent a NEW task to do on its own (research, write, plan, book, sort out, look into, prepare,
compare, follow up, ...), reply {"route":"dump","title": the task in at most 8 words}. That is the default for a new task.
Keep {"route":"agent"} instead when the words say "reply" or "tell me", ask for a conversation, or are a short direct
question with a short answer (\"what time is it in Tokyo?\").
If you cannot tell whether the owner wants an answer in front of him or a task done in the background, reply {"route":"unsure"}.
You may add "confidence" (0 to 1) to a dump, agent or unsure answer.

`

// The owner's own corrections (wizard-ux issue 1570): each Open on a background task ("I wanted a visible thread") and
// each Send to inbox on a visible thread ("this could have run in the background") is one example. The latest few go
// into the dump rule as few-shot context, so the default drifts toward his habits. No retraining.
const ROUTE_WORDS = { dump: 'dump (background task)', agent: 'agent (visible thread)' }
export function examplesBlock(examples = []) {
  const lines = (Array.isArray(examples) ? examples : [])
    .filter(e => e && ROUTE_WORDS[e.wanted] && typeof e.utterance === 'string' && e.utterance.trim())
    .slice(0, 8).map(e => `- ${JSON.stringify(clip(e.utterance, 200))} -> ${ROUTE_WORDS[e.wanted]}`)
  return lines.length ? `The owner moved these earlier requests himself; route similar requests the way he wanted:\n${lines.join('\n')}\n\n` : ''
}

export function routerSystemPrompt({ settings, apps, timezone, view, force, now, dump = false, examples = [] }) {
  const place = settings?.owner?.place
  let system = ROUTER_SYSTEM
    .replace('%DUMP%', dump ? DUMP_RULE + examplesBlock(examples) : '')
    .replace('%APPS%', apps.length ? apps.join(', ') : 'none')
    .replace('%TODAY%', today(timezone || settings?.clock?.timezone, now))
    .replace('%PLACE%', place
      ? `\nThe user lives in ${place}. Speech-to-text often mangles local place names: map near-misses to the real place and return the corrected name.`
      : '')
  if (force) system += '\nThe user held the orb for COMMAND mode: prefer a command; use agent only if no command fits.'
  if (view && !force) {
    system += `\n\nCONTEXT: the window in front is ${JSON.stringify(view.name)} (${view.kind}). The user may be talking TO that window.`
      + '\nReply {"route":"view"} when the utterance continues or answers what is on that window: confirmations and refusals'
      + ' ("yes", "go ahead", "no, wait"), corrections, follow-ups that use "this", "that", "it", and replies to a question it asked.'
      + '\nKeep {"route":"command"} for phone/UI commands. Use {"route":"agent"} only for a NEW request unrelated to that window.'
  }
  return system
}

const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '')

const GREETING = /^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening|night))\b/iu
const QUESTION = /^(?:what(?:'s| is| are| was)?|who(?:'s)?|whom|whose|when|where(?:'s)?|which|why|how(?:'s)?|is|are|was|were|do|does|did|can|could|will|would|should|shall|has|have|am)\b/iu
// A clear task lead: an optional polite opener, then a verb that starts work with no short answer.
const POLITE = String.raw`(?:(?:hey |ok(?:ay)? )?(?:wizard,? )?)?(?:please |(?:can|could|would|will) you (?:please )?|i (?:need|want|'d like) you to |go and |make sure (?:you )?)?`
const TASK = new RegExp(`^${POLITE}(?:research|look into|dig into|investigate|write(?: up)?|draft|plan|book|organi[sz]e|sort out|compare|summari[sz]e|prepare|put together|figure out|work out|follow up|find out|find me|set up|clean up|review|remind me)\\b`, 'iu')
const words = text => text.split(/\s+/u).filter(Boolean).length

/** From the words alone: 'agent' (keep it visible), 'dump' (a plain new task), or '' (the model decides). */
export function dumpIntent(text) { return replyRules(text).intent }

// Reply rules (issue 607, Sent log; switch wizard/agent-inbox). The owner's own words about a reply win over the model.
// They count as whole phrases said to the Wizard, never as words inside the task itself: "draft a reply to Sam" is a
// task. Order: no-reply phrases first (background; only at the start or the end of the take), then wants-reply phrases
// (a visible thread), a greeting, the plain task lead, then a short question. "urgent" / "priority" at the start or the
// end put the task at the top of Inbox; "#x" / "hashtag x" anywhere are tags.
const LEAD = String.raw`^(?:(?:hey |ok(?:ay)? )?(?:wizard,? )?)?`
const SEP = String.raw`[\s,;:.!—–-]`
const NO_REPLY = String.raw`note to self|no reply(?: needed)?|no need to reply|(?:you )?don'?t (?:need to )?reply|just do it`
const NO_REPLY_LEAD = new RegExp(`${LEAD}(${NO_REPLY}|note)(?=${SEP}|$)`, 'iu')
const NO_REPLY_TAIL = new RegExp(`(?:^|${SEP})(${NO_REPLY})${SEP}*$`, 'iu')
// "reply" said to the Wizard ("reply", "keep replying", "replies with updates"). Never "a reply", "the reply", "draft /
// write / send a reply", "no reply", and never "reply to Sam" or "reply all" (a reply someone else gets is a task);
// "reply to me" and "reply when you're done" are.
const REPLY_WORD = /(?<!\b(?:a|an|the|my|your|his|her|their|our|its|draft|write|send|no|quick|short|any|email|text)\s)\brepl(?:y|ies|ying)(?: back)?\b(?!\s+(?:to|all)\b(?!\s+me\b))/iu
const WANTS = /\b(?:tell me|answer me|let'?s (?:talk|chat|discuss)|talk (?:to|with) me|chat (?:to|with) me|walk me through|explain to me)\b/iu
const URGENT = String.raw`(?:it'?s |this is )?(?:urgent|high priority|top priority|priority)|asap`
const URGENT_LEAD = new RegExp(`${LEAD}(${URGENT})(?=${SEP}|$)${SEP}*`, 'iu')
const URGENT_TAIL = new RegExp(`(?:^|${SEP})(${URGENT})${SEP}*$`, 'iu')
const TAG = /(?:^|[\s(,])#([\p{L}\p{N}][\p{L}\p{N}_-]{0,31})|\bhash ?tag\s+([\p{L}\p{N}][\p{L}\p{N}_-]{0,31})/giu
const REMINDER = new RegExp(`^${POLITE}remind me\\b`, 'iu')
const trimEdges = text => text.replace(/^[\s,;:.!—–-]+|[\s,;:—–-]+$/gu, '').trim()

/** The owner's words about how to route a take: `{ intent: 'dump'|'agent'|'', rules, urgent, tags, reminder }`.
 *  `intent` is what the words alone settle ('' = the model decides); each rule names what matched. */
export function replyRules(text) {
  const out = { intent: '', rules: [], urgent: false, tags: [], reminder: false }
  const t = clip(text, 600).replace(/^[\s"'“]+|[\s"'”.!]+$/gu, '')
  if (!t) return out
  for (const m of t.matchAll(TAG)) {
    const tag = (m[1] || m[2] || '').toLowerCase()
    if (tag && !out.tags.includes(tag) && out.tags.length < 8) out.tags.push(tag)
  }
  // The routing words are read without the tags and without the urgency the owner put at the start or the end.
  let core = trimEdges(t.replace(TAG, ' ').replace(/\s+/gu, ' '))
  const lead = URGENT_LEAD.exec(core), tail = lead ? null : URGENT_TAIL.exec(core)
  if (lead || tail) {
    out.urgent = true
    out.rules.push(`urgent:${(lead || tail)[1].toLowerCase()}`)
    core = trimEdges(core.replace(lead ? URGENT_LEAD : URGENT_TAIL, ' '))
  }
  for (const tag of out.tags) out.rules.push(`tag:${tag}`)
  if (!core) return out
  const quietLead = NO_REPLY_LEAD.exec(core), quiet = quietLead || NO_REPLY_TAIL.exec(core)
  if (quiet) {
    out.intent = 'dump'
    out.rules.unshift(`no_reply:${quiet[1].toLowerCase()}`)
    out.reminder = REMINDER.test(trimEdges(core.replace(quietLead ? NO_REPLY_LEAD : NO_REPLY_TAIL, ' ')))
    return out
  }
  const wants = REPLY_WORD.exec(core) || WANTS.exec(core)
  if (wants) { out.intent = 'agent'; out.rules.unshift(`wants_reply:${wants[0].toLowerCase()}`); return out }
  if (GREETING.test(core)) { out.intent = 'agent'; out.rules.unshift('greeting'); return out }
  if (TASK.test(core)) { out.intent = 'dump'; out.reminder = REMINDER.test(core); out.rules.unshift(out.reminder ? 'reminder' : 'task_verb'); return out }
  if ((core.endsWith('?') || QUESTION.test(core)) && words(core) <= 12) { out.intent = 'agent'; out.rules.unshift('short_question') }
  return out
}

/** The take without the routing words the owner said to the Wizard (tags, no-reply and urgency phrases): the task. */
export function taskWords(text) {
  let t = trimEdges(clip(text, 600).replace(TAG, ' ').replace(/\s+/gu, ' '))
  for (let n = 0; n < 2; n++) t = trimEdges(t.replace(URGENT_LEAD, '').replace(NO_REPLY_LEAD, ''))
  return trimEdges(t.replace(NO_REPLY_TAIL, '').replace(URGENT_TAIL, '')) || clip(text, 600)
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const zoneParts = (zone, at) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'long' })
  .formatToParts(at).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {})
const zoneOffset = (zone, at) => {
  const p = zoneParts(zone, at)
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000
}

/** A deadline the words carry ("today", "tonight", "tomorrow", "by Friday"): the end of that day in the owner's
 *  time zone, as an ISO instant, or null. */
export function deadlineFrom(text, timezone, now = Date.now()) {
  const t = clip(text, 600).toLowerCase()
  const zone = validTimeZone(timezone) || 'UTC'
  let days = null
  if (/\b(?:today|tonight|this evening|end of (?:the )?day)\b/u.test(t)) days = 0
  else if (/\btomorrow\b/u.test(t)) days = 1
  else {
    const named = /\b(by|on|before|for|until|this|next) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u.exec(t)
    if (named) {
      const current = WEEKDAYS.indexOf(zoneParts(zone, now).weekday.toLowerCase())
      days = (WEEKDAYS.indexOf(named[2]) - current + 7) % 7
      if (days === 0 && named[1] === 'next') days = 7
    }
  }
  if (days == null) return null
  const p = zoneParts(zone, now + days * 86_400_000)
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, 23, 59, 0)
  return new Date(local - zoneOffset(zone, local)).toISOString()
}

/** The task's title: the model's short title, else the words without their polite opener. */
export function dumpTitle(cmd, text) {
  const given = clip(cmd?.title, 60)
  if (given) return given
  const bare = taskWords(text).replace(new RegExp(`^${POLITE}`, 'iu'), '').replace(/[?.!]+$/u, '')
  return clip(bare.charAt(0).toUpperCase() + bare.slice(1), 60)
}

/** Route one take. `why` says how it was decided (issue 607): `decided_by` owner_words | correction | model | fallback,
 *  the reply rules that matched, the model's confidence. With `dump`, the owner's no-reply words and an exact earlier
 *  correction settle a take without the model; with `router: null` (none configured) only those settle it, anything
 *  else is the 404 it always was. The model's `unsure`, like an answer it could not give, opens a visible thread. */
export async function routeUtterance({ input, settings, router, fetchImpl = fetch, now, dump = false, examples = [], correction = null, timeoutMs = 30_000 }) {
  const text = clip(input?.text, 600)
  if (!text) throw Object.assign(new Error('empty'), { status: 400 })
  const apps = (Array.isArray(input?.apps) ? input.apps : []).map((name) => clip(name, 40)).filter(Boolean).slice(0, 60)
  const force = input?.force === 'command'
  const view = input?.view && typeof input.view === 'object'
    ? { name: clip(input.view.name, 80), kind: clip(input.view.kind, 40) } : null
  const timezone = clip(input?.timezone, 64)
  const rules = replyRules(text)
  const why = { decided_by: 'model', rules: [...rules.rules], urgent: rules.urgent, tags: [...rules.tags], reminder: false }
  const at = now ? +new Date(now) : Date.now()
  const dumpCmd = (cmd = {}) => ({ route: 'dump', title: dumpTitle(cmd, text), deadline: deadlineFrom(text, timezone || settings?.clock?.timezone, at), summary: clip(cmd.summary, 200) || text })
  // The owner's words win before any model: a no-reply phrase is a background task. An earlier correction of exactly
  // these words routes them the way he wanted, unless a reply phrase of his says otherwise.
  if (dump && rules.intent === 'dump' && rules.rules[0]?.startsWith('no_reply:')) {
    Object.assign(why, { decided_by: 'owner_words', reminder: rules.reminder })
    return { cmd: dumpCmd(), ms: 0, model: '', why }
  }
  // His explicit reply words beat a correction; a correction beats the plain task / question heuristics.
  const explicit = /^(?:no_reply|wants_reply):/u.test(rules.rules[0] || '')
  const wanted = correction?.wanted === 'dump' || correction?.wanted === 'agent' ? correction.wanted : ''
  if (dump && wanted && !explicit) {
    Object.assign(why, { decided_by: 'correction', correction_id: String(correction.id || '') || null, reminder: wanted === 'dump' && REMINDER.test(taskWords(text)) })
    return { cmd: wanted === 'dump' ? dumpCmd() : { route: 'agent', summary: text }, ms: 0, model: '', why }
  }
  if (!router) throw Object.assign(new Error('router_not_configured'), { status: 404 })
  const system = routerSystemPrompt({ settings, apps, timezone, view, force, now, dump, examples })
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let content = ''
  try {
    const upstream = await fetchImpl(router.url, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(router.key ? { Authorization: `Bearer ${router.key}` } : {}) },
      body: JSON.stringify({
        model: router.model, temperature: 0, max_tokens: 400,
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      }),
    })
    if (!upstream.ok) throw new Error(`router ${upstream.status}`)
    const data = await upstream.json()
    content = String(data?.choices?.[0]?.message?.content ?? '')
  } finally { clearTimeout(timer) }
  const match = content.match(/\{[\s\S]*\}/u)
  let cmd = {}
  try { cmd = match ? JSON.parse(match[0]) : {} } catch { cmd = {} }
  const confidence = Number(cmd?.confidence)
  if (cmd?.confidence != null && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) why.confidence = confidence
  if (dump && cmd.route === 'unsure') {
    // Unclear: a visible thread, unless the owner's own words settle it.
    why.rules.push('unsure')
    if (!rules.intent) why.decided_by = 'fallback'
    cmd = { route: rules.intent || 'agent', summary: text }
  }
  if (cmd.route === 'view' && !(view && !force)) cmd = { route: 'agent', summary: text }
  if (!dump && cmd.route === 'dump') cmd = { route: 'agent', summary: text }
  if (!['command', 'agent', 'view', ...(dump ? ['dump'] : [])].includes(cmd.route)) {
    // No usable answer from the model: the visible thread it always was.
    why.rules.push('no_answer')
    if (!rules.intent || !dump) why.decided_by = 'fallback'
    cmd = { route: 'agent', summary: text }
  }
  if (dump && (cmd.route === 'agent' || cmd.route === 'dump')) {
    const route = rules.intent || cmd.route
    if (rules.intent) why.decided_by = 'owner_words'
    cmd = route === 'dump' ? dumpCmd(cmd) : { route: 'agent', summary: clip(cmd.summary, 200) || text }
    why.reminder = route === 'dump' && REMINDER.test(taskWords(text))
  }
  return { cmd, ms: Date.now() - started, model: router.model, why }
}
