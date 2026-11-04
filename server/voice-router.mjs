// Optional orb command router: classifies one spoken utterance as a phone/UI command, a reply to
// the window in front, or a request for the agent. It calls any OpenAI-compatible chat endpoint
// the owner configures (WIZARD_ROUTER_URL / _MODEL / _KEY). With no router configured, front ends
// send everything to the agent. Place and time zone come from Wizard OS settings, never the code.
import { validTimeZone } from './wizard-os-settings.mjs'

const ROUTER_SYSTEM = `You are the command router inside Wizard OS, a voice-first shell.
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
Today is %TODAY%. Resolve "yesterday", weekdays, and "last week" to dates when asked for a day view.%PLACE%`

function today(timezone, now = new Date()) {
  const zone = validTimeZone(timezone) || 'UTC'
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' })
    .formatToParts(now).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {})
  return `${parts.year}-${parts.month}-${parts.day} (${parts.weekday}, ${zone})`
}

export function routerSystemPrompt({ settings, apps, timezone, view, force, now }) {
  const place = settings?.owner?.place
  let system = ROUTER_SYSTEM
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

export async function routeUtterance({ input, settings, router, fetchImpl = fetch, now }) {
  const text = clip(input?.text, 600)
  if (!text) throw Object.assign(new Error('empty'), { status: 400 })
  const apps = (Array.isArray(input?.apps) ? input.apps : []).map((name) => clip(name, 40)).filter(Boolean).slice(0, 60)
  const force = input?.force === 'command'
  const view = input?.view && typeof input.view === 'object'
    ? { name: clip(input.view.name, 80), kind: clip(input.view.kind, 40) } : null
  const system = routerSystemPrompt({ settings, apps, timezone: clip(input?.timezone, 64), view, force, now })
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
  if (!['command', 'agent', 'view'].includes(cmd.route)) cmd = { route: 'agent', summary: text }
  return { cmd, ms: Date.now() - started, model: router.model }
}
