// Routed agents reach out first (31 Oct 2026). Two gateway tools for every routed agent (container, restricted,
// private), served on its own /wizard/mcp key, so an agent never has to tell the owner "only you can start a chat":
//   wizard_start_thread  open a new Wizard chat thread with the owner now; the agent writes the first message
//   wizard_schedule      message the owner later, once or on a repeating schedule (e.g. every morning at 08:30),
//                        in a thread it owns or in its own new thread; list and cancel its own schedules
// Both write ordinary scheduler jobs (server/scheduler.mjs) with the key's agent, never an argument. The scheduler
// creates the thread through `?agent=<id>`, which pins it to that agent, so the owner's reply goes to the same
// agent. The main agent keeps its Hermes plugin (wizard-schedule) and does not see these tools.
import { randomUUID } from 'node:crypto'

export const START_THREAD_TOOL = 'wizard_start_thread'
export const SCHEDULE_TOOL = 'wizard_schedule'
export const START_GROUP = 'agent-start-thread'
export const SCHEDULE_GROUP = 'agent-schedule'
const SESSION = /^[A-Za-z0-9._:-]{1,160}$/u
const DEDUPE_MS = 10 * 60_000

/** One line for a routed agent's run instructions, beside the follow-up note. */
export const reachOutNote = () => `You can open a new Wizard chat thread with the owner yourself (${START_THREAD_TOOL}), and message them later, once or every day at a set time, in this thread or a new one (${SCHEDULE_TOOL}). Never tell the owner only they can start a chat or that you cannot message them later.`

const TOOLS = [
  {
    name: START_THREAD_TOOL,
    description: '[Wizard OS] Open a new chat thread with the owner right now and write its first message. Use when the owner asks you to split a topic into its own thread, or when something deserves its own conversation. The thread appears in the owner\'s Chats under your name; their reply there comes back to you.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Thread title in "Project · Thing" style, e.g. "Stoicism · Morning practice"' },
        instructions: { type: 'string', description: 'What your opening message should say or do, with any context you want to carry over from this conversation (it is not copied for you)' },
        from_session_id: { type: 'string', description: 'Optional: the id of the thread this one splits off from (from your run instructions)' },
      },
      required: ['title', 'instructions'],
    },
  },
  {
    name: SCHEDULE_TOOL,
    description: '[Wizard OS] Message the owner later: once, or on a repeating schedule such as every morning at 08:30 (owner time). Delivers into this thread (pass session_id) or into your own new thread (pass title). Also lists and cancels your own schedules.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'], description: 'create (default), list or cancel' },
        kind: { type: 'string', enum: ['message', 'run', 'remind'], description: 'create: message (default; you write to the owner), run (background work reported as a short status report) or remind (a short reminder of their words)' },
        text: { type: 'string', description: 'create: what to say or do each time, with the context you will need then' },
        when: { type: 'string', description: 'create: "morning" (next 08:30), "every morning", "overnight", "daily HH:MM", "weekdays HH:MM", an ISO timestamp with offset, or a five-field cron; times are the owner\'s timezone' },
        name: { type: 'string', description: 'create: short label' },
        session_id: { type: 'string', description: 'create: deliver into this thread (its id from your run instructions); omit and pass title for a new thread' },
        title: { type: 'string', description: 'create: title of a new thread for this schedule, "Project · Thing" style' },
        id: { type: 'string', description: 'cancel: the schedule id from list' },
      },
    },
  },
]

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })
const clean = (value, max) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '')
const body = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : '')
const link = (sessionId) => `/wizard-os-home/?session=${encodeURIComponent(sessionId)}`

/** "every morning" | "daily 08:30" | "weekdays 7:05" | ISO | cron | morning | overnight -> scheduler `when`. */
export function parseWhen(value) {
  const when = typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/gu, ' ') : ''
  if (!when) return null
  if (when === 'morning' || when === 'overnight') return { at: when }
  if (when === 'every morning') return { cron: '30 8 * * *' }
  const daily = /^(daily|every day|weekdays|every weekday)(?: at)? ([01]?\d|2[0-3]):([0-5]\d)$/u.exec(when)
  if (daily) return { cron: `${Number(daily[3])} ${Number(daily[2])} * * ${daily[1].includes('week') ? '1-5' : '*'}` }
  if (/^\d{4}-\d\d-\d\dt/u.test(when)) return { once: String(value).trim() }
  const cron = when.replace(/^cron:? ?/u, '')
  if (cron.split(' ').length === 5 && /^[\d*/,\- ]+$/u.test(cron)) return { cron }
  return null
}

/** Owner-clock rendering of an ISO instant, so the agent can say "tomorrow at 08:30" truthfully. */
export function localTime(isoString, timeZone) {
  if (!isoString) return null
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(isoString))
  } catch { return null }
}

/**
 * Built-in gateway tools for createAgentBridge({ builtins }). `ownsThread(agentId, sessionId)` is the follow-ups rule
 * (a routed agent owns a thread it is pinned to). `running()` is the scheduler timer. `settle(ms)` waits for the
 * first admission so the tool can answer "opened" rather than "queued"; it never decides success by itself.
 */
export function agentReachOutTools({ scheduler, running = () => false, mainAgent = 'hermes', ownsThread = () => false, timezone = () => 'UTC', now = Date.now, settleMs = 15_000 }) {
  const project = (job) => {
    const p = scheduler.project(job)
    return { id: p.id, name: p.name, kind: p.agentMessage ? 'message' : p.kind, when: p.when, ...(p.window ? { window: p.window } : {}),
      timezone: p.timezone, nextRun: p.nextRun, nextRunLocal: localTime(p.nextRun, p.timezone), thread: p.thread, link: p.thread ? link(p.thread) : null,
      ...(p.lastRun ? { lastRun: { scheduledFor: p.lastRun.scheduledFor, outcome: p.lastRun.outcome } } : {}) }
  }
  const mine = (agent) => scheduler.list().filter((job) => job.agent === agent && job.kind !== 'watch' && job.group !== START_GROUP)

  async function startThread(args, agent, caller) {
    const title = clean(args.title, 120)
    const instructions = body(args.instructions, 16_000)
    if (!title || !instructions) return bad('wizard_start_thread needs a title and instructions')
    const from = typeof args.from_session_id === 'string' && args.from_session_id ? args.from_session_id : ''
    if (from && (!SESSION.test(from) || !await ownsThread(caller, from))) return bad('from_session_id must be a thread that belongs to this agent')
    // A retried tool call returns the thread it already opened instead of opening a second one.
    const at = now()
    const prompt = `${instructions}${from ? `\n\n(This thread splits off from your thread ${from}.)` : ''}`
    const prior = scheduler.list().find((job) => job.group === START_GROUP && job.agent === agent && job.threadTitle === title
      && job.prompt === prompt && at - Date.parse(job.createdAt) < DEDUPE_MS)
    if (prior) return ok({ opened: true, already: true, session_id: prior.thread, title, link: link(prior.thread) })
    const thread = `wizard_agent_${randomUUID()}`
    // Paused one-shot plus Run now: one manual occurrence, outside the background-work trickle, never repeated.
    const job = scheduler.create({ name: title, kind: 'run', agent, when: { once: new Date(at).toISOString() }, enabled: false, prompt },
      { thread, threadTitle: title, group: START_GROUP, agentMessage: 'open' })
    const occurrence = scheduler.runNow(job.id)
    let state = 'opening'
    try {
      await Promise.race([scheduler.tick(false), new Promise((resolve) => setTimeout(resolve, settleMs).unref?.())])
      const row = scheduler.db.prepare('SELECT admitted, error FROM schedule_occurrences WHERE key=?').get(occurrence.key)
      state = row?.admitted === 1 ? 'opened' : row?.error ? 'retrying' : 'opening'
    } catch { state = 'retrying' }
    return ok({ opened: state === 'opened', state, session_id: thread, title, link: link(thread),
      note: state === 'opened' ? 'The thread is open and your opening turn is running in it now.' : 'The thread is queued; the Wizard scheduler keeps retrying until it opens.' })
  }

  async function schedule(args, agent, caller) {
    const action = String(args.action || 'create')
    const tz = timezone()
    if (action === 'list') {
      await scheduler.refreshRuns()
      return ok({ schedules: mine(agent).filter((job) => scheduler.project(job).nextRun).map(project), timezone: tz })
    }
    if (action === 'cancel') {
      // Another agent's schedule (or a main one) is indistinguishable from a missing id.
      const job = mine(agent).find((j) => j.id === String(args.id || ''))
      if (!job) return bad('No schedule of yours with that id; call wizard_schedule with action list.')
      scheduler.delete(job.id)
      return ok({ cancelled: job.id, name: job.name })
    }
    if (action !== 'create') return bad('action must be create, list or cancel')
    const kind = String(args.kind || 'message')
    if (!['message', 'run', 'remind'].includes(kind)) return bad('kind must be message, run or remind')
    const text = body(args.text, 16_000)
    if (!text) return bad('create needs text: what to say or do each time')
    const when = parseWhen(args.when)
    if (!when) return bad('when must be "morning", "every morning", "overnight", "daily HH:MM", "weekdays HH:MM", an ISO timestamp with offset, or a five-field cron')
    const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : ''
    const title = clean(args.title, 120)
    if (sessionId && title) return bad('pass session_id (this thread) or title (a new thread), not both')
    if (!sessionId && !title) return bad('pass session_id to deliver here, or title for a new thread')
    if (sessionId && (!SESSION.test(sessionId) || !await ownsThread(caller, sessionId))) return bad('That thread does not belong to this agent.')
    const name = clean(args.name, 80) || title || clean(text, 60)
    const input = { name, kind: kind === 'message' ? 'run' : kind, agent, when, prompt: text, ...(sessionId ? { thread: sessionId } : {}) }
    const placement = { group: SCHEDULE_GROUP, ...(kind === 'message' ? { agentMessage: 'scheduled' } : {}),
      ...(title ? { thread: `wizard_agent_${randomUUID()}`, threadTitle: title } : {}) }
    const job = scheduler.create(input, placement)
    return ok({ ...project(job), timezone: tz })
  }

  return {
    list: (agentId) => (scheduler && agentId && agentId !== mainAgent ? TOOLS : []),
    async call(name, args = {}, agentId) {
      if (!TOOLS.some((tool) => tool.name === name)) return undefined
      if (!agentId || agentId === mainAgent) return bad('The main agent uses its own wizard_schedule plugin; this gateway tool is for routed agents.')
      if (!scheduler) return bad('Starting threads and scheduled messages are not available on this box (the Wizard scheduler has no state).')
      if (!running()) return bad('The Wizard scheduler is switched off on this box (WIZARD_SCHEDULER is not 1), so nothing would be delivered. Tell the owner instead of promising it.')
      try {
        return name === START_THREAD_TOOL ? await startThread(args, agentId, agentId) : await schedule(args, agentId, agentId)
      } catch (error) {
        return bad(error?.status ? String(error.message) : 'The request could not be saved.')
      }
    },
  }
}
