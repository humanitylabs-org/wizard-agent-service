// Onboarding drip and agent reminders (wizard-os launch, 23 Oct 2026).
//
// Two agent tools served by the `wizard` MCP gateway on every box, so a container agent on a fresh install can
// do what the host-only `wizard-schedule` Hermes plugin does for an alongside box:
//   wizard_remind  set / list / cancel a reminder (the existing scheduler, kind `remind`)
//   wizard_tips    opt in to (or stop) one Wizard feature tip a day for the first five days
// Both write ordinary scheduler jobs; nothing here runs a model or posts by itself. A tip is a `remind`
// occurrence, so it arrives through the ordinary run queue in one "Wizard · Tips" thread.
import { randomUUID } from 'node:crypto'
import { resolveWindow } from './scheduler.mjs'

export const TIPS_GROUP = 'wizard-tips'
export const TIPS_THREAD_TITLE = 'Wizard · Tips'
const DAY = 24 * 3600_000

/** Five tips, one per day. Each names the thing to say or tap; the agent delivers it in its own words. */
export const TIPS = [
  { topic: 'build an app by voice', text: 'Build an app by talking. Tap the mic in any chat and describe what you want, for example "build me an app that tracks my runs". I build it, install it, and it appears in your Apps. Say "change it so…" any time to change it.' },
  { topic: 'change your skin', text: 'Make Wizard look the way you like. Pick a skin in Settings → Appearance, then ask me "change my skin so the background is dark green" (or anything else). I edit your own My skin file in Files, Skins/My skin/skin.css, which stays on top of the skin you picked and survives updates. If a change goes wrong, open Wizard with ?myskin=off and ask me to undo it.' },
  { topic: 'set reminders', text: 'Ask me to remind you of things: "remind me tomorrow morning to call the bank" or "remind me at 6pm to stretch". The reminder arrives here in Chats at that time. Say "what reminders do I have?" to see them, or "cancel the bank reminder".' },
  { topic: 'the Store and connectors', text: 'The Store adds apps and connectors. Say what you want rather than hunting for it: "make me a website" brings in the Cloudflare connector (you tap Get once and sign in), and from then on I can publish your site and look after its domain. Open the Store from Home to browse everything else.' },
  { topic: 'report a change request', text: 'Want something to work differently? Say "change request:" and describe it. For your own apps and your skin I make the change straight away. For Wizard itself I write it up as a short request and, with your OK, send it to the Wizard OS team.' },
]

const tipPrompt = (index) => `Wizard tip ${index + 1} of ${TIPS.length} (${TIPS[index].topic}). Share this with the owner in two or three friendly sentences and suggest one thing to try now:\n${TIPS[index].text}\nEnd with: "Say stop tips to turn these off."`

/** When each tip lands: day 1 a minute after opting in, then each following morning (08:30 owner time). */
export function tipInstants(now, timezone) {
  const out = [now + 60_000]
  let after = now + 12 * 3600_000
  for (let i = 1; i < TIPS.length; i += 1) {
    const at = resolveWindow('morning', timezone, after, () => 0)
    out.push(at)
    after = at + 3600_000
  }
  return out
}

const agentOf = (agentId, mainId) => (!agentId || agentId === mainId ? 'main' : agentId)
const pending = (scheduler, job) => Boolean(scheduler.project(job).nextRun)
const brief = (scheduler, job) => {
  const p = scheduler.project(job)
  return { id: job.id, name: job.name, kind: job.kind, when: p.nextRun, text: job.kind === 'remind' ? job.prompt.slice(0, 200) : '' }
}

/** Start the drip once per agent. Re-asking while tips are pending returns the same series (no duplicates). */
export function startTips(scheduler, { agent = 'main', timezone = 'UTC', now = Date.now() } = {}) {
  const existing = scheduler.list().filter((job) => job.group === TIPS_GROUP && job.agent === agent)
  if (existing.some((job) => pending(scheduler, job))) return { started: false, already: true, thread: existing[0].thread, tips: existing.map((job) => brief(scheduler, job)) }
  for (const job of existing) scheduler.delete(job.id)
  const thread = `wizard_tips_${randomUUID()}`
  const jobs = tipInstants(now, timezone).map((at, index) => scheduler.create({
    name: `Wizard tip ${index + 1} of ${TIPS.length}`, kind: 'remind', agent, when: { once: new Date(at).toISOString() }, prompt: tipPrompt(index),
  }, { thread, threadTitle: TIPS_THREAD_TITLE, group: TIPS_GROUP }))
  return { started: true, thread, tips: jobs.map((job) => brief(scheduler, job)) }
}

export function stopTips(scheduler, { agent = 'main' } = {}) {
  const jobs = scheduler.list().filter((job) => job.group === TIPS_GROUP && job.agent === agent && pending(scheduler, job))
  for (const job of jobs) scheduler.delete(job.id)
  return { stopped: jobs.length }
}

const TOOLS = [
  {
    name: 'wizard_remind',
    description: '[Wizard OS] Set, list or cancel a reminder for the owner. It arrives in Wizard Chats at the time, in its own "Reminder · …" thread. Use for "remind me…", "what reminders do I have?", "cancel the … reminder".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'cancel'], description: 'set (default), list or cancel' },
        text: { type: 'string', description: 'set: what to remind the owner about, in their words' },
        when: { type: 'string', description: 'set: "morning" (next 08:30 owner time), "overnight", or an ISO timestamp with offset, e.g. 2026-10-24T18:00:00+07:00' },
        name: { type: 'string', description: 'set: optional short label' },
        id: { type: 'string', description: 'cancel: the reminder id from list' },
      },
    },
  },
  {
    name: 'wizard_tips',
    description: '[Wizard OS] Opt the owner in to one Wizard feature tip a day for five days (build an app by voice, My skin, reminders, Store and connectors, change requests), or stop them. Only start when the owner says yes.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start, stop or status' } }, required: ['action'] },
  },
]

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

/**
 * Built-in gateway tools for createAgentBridge({ builtins }). `scheduler` may be null (no state path); `running()`
 * says whether the timer is on (WIZARD_SCHEDULER=1). Off means the tools say so rather than promise a delivery.
 */
export function onboardingTools({ scheduler, running = () => false, timezone = () => 'UTC', now = Date.now, mainAgent = 'hermes' }) {
  return {
    list: () => (scheduler ? TOOLS : []),
    async call(name, args = {}, agentId) {
      if (!TOOLS.some((tool) => tool.name === name)) return undefined
      if (!scheduler) return bad('Reminders are not available on this box (the Wizard scheduler has no state).')
      if (!running()) return bad('The Wizard scheduler is switched off on this box (WIZARD_SCHEDULER is not 1), so nothing would be delivered. Tell the owner instead of promising a reminder.')
      const agent = agentOf(agentId, mainAgent)
      const tz = timezone()
      try {
        if (name === 'wizard_tips') {
          const action = String(args.action || '')
          if (action === 'start') return ok(startTips(scheduler, { agent, timezone: tz, now: now() }))
          if (action === 'stop') return ok(stopTips(scheduler, { agent }))
          if (action === 'status') return ok({ tips: scheduler.list().filter((job) => job.group === TIPS_GROUP && job.agent === agent && pending(scheduler, job)).map((job) => brief(scheduler, job)) })
          return bad('action must be start, stop or status')
        }
        const action = String(args.action || 'set')
        const mine = () => scheduler.list().filter((job) => job.agent === agent && job.kind === 'remind' && job.group !== TIPS_GROUP && pending(scheduler, job))
        if (action === 'list') return ok({ reminders: mine().map((job) => brief(scheduler, job)), timezone: tz })
        if (action === 'cancel') {
          const job = mine().find((j) => j.id === String(args.id || ''))
          if (!job) return bad('No pending reminder with that id; call wizard_remind with action list.')
          scheduler.delete(job.id)
          return ok({ cancelled: job.id, name: job.name })
        }
        if (action !== 'set') return bad('action must be set, list or cancel')
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        const when = typeof args.when === 'string' ? args.when.trim() : ''
        if (!text || !when) return bad('set needs text and when')
        const label = (typeof args.name === 'string' && args.name.trim() ? args.name.trim() : text).replace(/\s+/gu, ' ').slice(0, 60)
        const job = scheduler.create({
          name: `Reminder · ${label}`, kind: 'remind', agent, prompt: text,
          when: ['morning', 'overnight'].includes(when) ? { at: when } : { once: when },
        })
        return ok({ ...brief(scheduler, job), timezone: tz })
      } catch (error) {
        return bad(error?.status ? String(error.message) : 'The reminder could not be saved.')
      }
    },
  }
}
