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

`

export function routerSystemPrompt({ settings, apps, timezone, view, force, now, dump = false }) {
  const place = settings?.owner?.place
  let system = ROUTER_SYSTEM
    .replace('%DUMP%', dump ? DUMP_RULE : '')
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

// Words that keep a thread visible: the owner wants an answer in front of them.
const VISIBLE = /\b(?:(?<!\b(?:a|the|my|your|his|her|their|draft|write|send) )repl(?:y|ies|ying)\b|tell me|let'?s (?:talk|chat|discuss)|talk (?:to|with) me|chat (?:to|with) me|walk me through|explain to me)\b/iu
const GREETING = /^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening|night))\b/iu
const QUESTION = /^(?:what(?:'s| is| are| was)?|who(?:'s)?|whom|whose|when|where(?:'s)?|which|why|how(?:'s)?|is|are|was|were|do|does|did|can|could|will|would|should|shall|has|have|am)\b/iu
// A clear task lead: an optional polite opener, then a verb that starts work with no short answer.
const POLITE = String.raw`(?:(?:hey |ok(?:ay)? )?(?:wizard,? )?)?(?:please |(?:can|could|would|will) you (?:please )?|i (?:need|want|'d like) you to |go and |make sure (?:you )?)?`
const TASK = new RegExp(`^${POLITE}(?:research|look into|dig into|investigate|write(?: up)?|draft|plan|book|organi[sz]e|sort out|compare|summari[sz]e|prepare|put together|figure out|work out|follow up|find out|find me|set up|clean up|review|remind me)\\b`, 'iu')
const words = text => text.split(/\s+/u).filter(Boolean).length

/** From the words alone: 'agent' (keep it visible), 'dump' (a plain new task), or '' (the model decides). */
export function dumpIntent(text) {
  const t = clip(text, 600).replace(/^[\s"'“]+|[\s"'”.!]+$/gu, '')
  if (!t) return ''
  if (VISIBLE.test(t) || GREETING.test(t)) return 'agent'
  if (TASK.test(t)) return 'dump'
  if ((t.endsWith('?') || QUESTION.test(t)) && words(t) <= 12) return 'agent'
  return ''
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
  const bare = clip(text, 600).replace(new RegExp(`^${POLITE}`, 'iu'), '').replace(/[?.!]+$/u, '')
  return clip(bare.charAt(0).toUpperCase() + bare.slice(1), 60)
}

export async function routeUtterance({ input, settings, router, fetchImpl = fetch, now, dump = false }) {
  const text = clip(input?.text, 600)
  if (!text) throw Object.assign(new Error('empty'), { status: 400 })
  const apps = (Array.isArray(input?.apps) ? input.apps : []).map((name) => clip(name, 40)).filter(Boolean).slice(0, 60)
  const force = input?.force === 'command'
  const view = input?.view && typeof input.view === 'object'
    ? { name: clip(input.view.name, 80), kind: clip(input.view.kind, 40) } : null
  const timezone = clip(input?.timezone, 64)
  const system = routerSystemPrompt({ settings, apps, timezone, view, force, now, dump })
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
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
  if (cmd.route === 'view' && !(view && !force)) cmd = { route: 'agent', summary: text }
  if (!dump && cmd.route === 'dump') cmd = { route: 'agent', summary: text }
  if (!['command', 'agent', 'view', ...(dump ? ['dump'] : [])].includes(cmd.route)) cmd = { route: 'agent', summary: text }
  if (dump && (cmd.route === 'agent' || cmd.route === 'dump')) {
    const route = dumpIntent(text) || cmd.route
    cmd = route === 'dump'
      ? { route: 'dump', title: dumpTitle(cmd, text), deadline: deadlineFrom(text, timezone || settings?.clock?.timezone, now ? +new Date(now) : Date.now()), summary: clip(cmd.summary, 200) || text }
      : { route: 'agent', summary: clip(cmd.summary, 200) || text }
  }
  return { cmd, ms: Date.now() - started, model: router.model }
}
