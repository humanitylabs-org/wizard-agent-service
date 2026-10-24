// Thread-bound follow-up watchers on the agent's own `wizard` gateway (spec/thread-follow-up-watchers.md).
//
// Every runtime kind already reaches /wizard/mcp with its own gateway key: the main agent and host profiles over
// loopback, containers through the configured gateway URL, restricted agents through their edge and per-agent
// socket. This tool rides that reviewed transport rather than a separate route. The agent is always the key's
// agent, never an argument, and a routed agent may attach a watcher only to a thread it owns.
//
// The main agent calls it through the wizard-os Hermes plugin, which injects the session id Hermes gives the tool
// call, so it is not listed for main. Routed agents see it as an ordinary gateway tool and get their thread id in
// their run instructions (followUpThreadNote).
export const FOLLOW_UP_TOOL = 'wizard_follow_up'
const SESSION = /^[A-Za-z0-9._:-]{1,160}$/u

const TOOL = {
  name: FOLLOW_UP_TOOL,
  description: '[Wizard OS] Create, list or explicitly stop a quiet one-shot follow-up for this Wizard chat thread. Use create when you owe the owner a future result: checks stay silent while pending, and the first finished result, real blocker or required decision comes back in this same thread. Pass this thread\'s id (from your run instructions) as session_id.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'stop'] },
      session_id: { type: 'string', description: 'This Wizard thread\'s id, exactly as given in your run instructions' },
      name: { type: 'string', description: 'create: short label for the promised result' },
      instructions: { type: 'string', description: 'create: what to check and what finished result is owed' },
      every_minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'create: minutes between quiet checks (default 10)' },
      watcher_id: { type: 'string', description: 'stop: one watcher id; omit to stop every watcher on this thread' },
    },
    required: ['action', 'session_id'],
  },
}

/** The one line a routed agent's run instructions carry so it can name its own thread to the tool. */
export const followUpThreadNote = (sessionId) => (typeof sessionId === 'string' && SESSION.test(sessionId)
  ? `This Wizard thread's id is ${sessionId}. If you owe the owner a later result here and have the ${FOLLOW_UP_TOOL} tool, create a follow-up with that session_id.`
  : '')

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

/**
 * A builtin for createAgentBridge({ builtins }). `running()` says whether the scheduler timer is on;
 * `ownsThread(agentId, sessionId)` says whether that agent may watch that thread.
 */
export function followUpTool({ scheduler, running = () => false, mainAgent = 'hermes', ownsThread = () => false }) {
  return {
    list: (agentId) => (scheduler && agentId && agentId !== mainAgent ? [TOOL] : []),
    async call(name, args = {}, agentId) {
      if (name !== FOLLOW_UP_TOOL) return undefined
      if (!scheduler) return bad('Follow-ups are not available on this box (the Wizard scheduler has no state).')
      const sessionId = typeof args.session_id === 'string' && SESSION.test(args.session_id) ? args.session_id : ''
      if (!sessionId) return bad('This run has no Wizard thread to attach the follow-up to.')
      const caller = agentId || mainAgent
      const agent = caller === mainAgent ? 'main' : caller
      try {
        if (!await ownsThread(caller, sessionId)) return bad('That thread does not belong to this agent.')
        const action = String(args.action || '')
        if (action === 'create') {
          if (!running()) return bad('The Wizard scheduler is switched off on this box (WIZARD_SCHEDULER is not 1), so nothing would be delivered. Tell the owner instead of promising a follow-up.')
          const every = args.every_minutes === undefined ? 10 : Number(args.every_minutes)
          if (!Number.isInteger(every) || every < 1 || every > 1440) return bad('every_minutes must be 1 to 1440')
          const job = scheduler.create({ name: args.name, kind: 'watch', when: { every }, prompt: args.instructions, thread: sessionId, agent })
          return ok(scheduler.project(job))
        }
        if (action === 'list') {
          await scheduler.refreshRuns()
          return ok({ follow_ups: scheduler.followUps(sessionId, { agent }).map((job) => scheduler.project(job)) })
        }
        if (action === 'stop') return ok(scheduler.stopFollowUps(sessionId, { watcherId: String(args.watcher_id || ''), agent }))
        return bad('action must be create, list or stop')
      } catch (error) {
        return bad(error?.status ? String(error.message) : 'The follow-up request failed.')
      }
    },
  }
}
