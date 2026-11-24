// System capability registry (issue 463, switch `wizard/capability-registry`, env WIZARD_CAPABILITY_REGISTRY).
//
// Agents learned what a box can do only from apps.json (kernel, wizard-job-* pointers, wizard_apps), so a built-in
// such as wizard_transcribe or the host Wizard Voice Service was invisible and an agent installed its own Whisper.
// This module builds ONE registry per agent at call time from what that agent is really served:
//   - the gateway's own built-in tools (transcription, reminders, scheduling, follow-ups, threads, devices, spaces),
//   - every app job (`provides`) the agent may use, and the non-private apps it may not use (`not-granted`),
//   - the live health of the Wizard Voice Service for transcription.
// It serves the `wizard_capabilities` gateway tool (index, or one job's details), the generated kernel index line,
// the routed agents' run note and the data the Hermes install guard (capability_guard.py) matches installs against.
// Private agents keep the privacy seal: no private app of another agent and no transcription (the shared voice
// service keeps owner buffers), exactly as the gateway already serves them.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const CAPABILITY_TOOL = 'wizard_capabilities'
export const CAPABILITY_SWITCH = 'wizard/capability-registry'
export const CAPABILITY_SCHEMA = 'wizard.capabilities/1'
const GAP_LIMIT = 200

// Built-in jobs, in the order the index lists them. `tool` is the gateway tool that does it; a job is on the index
// only while the gateway serves that tool to this agent. `equivalents` are package, model and repo words the install
// guard treats as a second copy of the job (lower case; a word matches a whole name or one of its -_./ parts).
export const BUILTIN_JOBS = [
  {
    job: 'transcription', tool: 'wizard_transcribe', provider: { kind: 'host-service', id: 'wizard-voice-service', name: 'Wizard Voice Service' },
    words: ['transcribe', 'transcription', 'speech to text', 'speech-to-text', 'stt', 'audio', 'voice note', 'voice memo', 'recording', 'dictation', 'subtitles', 'captions'],
    equivalents: ['whisper', 'faster-whisper', 'openai-whisper', 'whisperx', 'whisper.cpp', 'whisper-cpp', 'pywhispercpp', 'insanely-fast-whisper', 'distil-whisper', 'stable-ts', 'vosk', 'deepspeech', 'coqui-stt', 'speechrecognition', 'speech_recognition', 'voxtral', 'parakeet', 'nemo_toolkit', 'nemo-toolkit', 'wav2vec2', 'speechbrain'],
    example: { path: '/opt/data/inbox/2026-11-11/note.m4a' },
    limits: 'Any length up to 2 GB; the service splits long recordings itself. Call again with the same arguments while it answers status "working".',
  },
  {
    job: 'reminders', tool: 'wizard_remind', provider: { kind: 'agent-service', id: 'wizard-agent-service', name: 'Wizard scheduler' },
    words: ['remind', 'reminder', 'reminders', 'nudge', 'alarm'], equivalents: [],
    example: { action: 'set', text: 'Call the bank', when: 'morning' },
    limits: 'Arrives in Wizard Chats at the time, in its own Reminder thread.',
  },
  {
    job: 'scheduling', tool: 'wizard_schedule', provider: { kind: 'agent-service', id: 'wizard-agent-service', name: 'Wizard scheduler' },
    words: ['schedule', 'scheduled', 'every day', 'every morning', 'recurring', 'later', 'cron', 'timer'],
    equivalents: ['cron', 'cronie', 'crontab', 'python-crontab', 'apscheduler', 'node-cron', 'node-schedule'],
    example: { action: 'create', kind: 'message', text: 'Morning summary', when: 'every morning' },
    limits: 'Times are in the owner\'s timezone; delivers into this thread or a new one.',
  },
  {
    job: 'follow-ups', tool: 'wizard_follow_up', provider: { kind: 'agent-service', id: 'wizard-agent-service', name: 'Wizard follow-ups' },
    words: ['follow up', 'follow-up', 'check back', 'keep watching', 'watch', 'poll'], equivalents: [],
    example: { action: 'create', session_id: '<this thread id>', name: 'Build result', instructions: 'Check the build; report when it finishes' },
    limits: 'Checks stay silent until there is a finished result, a blocker or a decision.',
  },
  {
    job: 'new threads', tool: 'wizard_start_thread', provider: { kind: 'agent-service', id: 'wizard-agent-service', name: 'Wizard Chats' },
    words: ['new thread', 'new chat', 'split this topic', 'start a conversation'], equivalents: [],
    example: { title: 'Project · Thing', instructions: 'What the first message says' }, limits: '',
  },
  {
    job: 'spaces', tool: 'spaces_list', provider: { kind: 'agent-service', id: 'wizard-agent-service', name: 'Wizard Spaces' },
    words: ['space', 'spaces', 'channel', 'organise chats', 'organize chats', 'folder of chats'], equivalents: [],
    example: {}, limits: 'Only your own Spaces and threads.',
  },
  {
    job: 'devices', tool: 'wizard_devices', provider: { kind: 'agent-service', id: 'wizard-agent-service', name: 'Wizard devices' },
    words: ['phone', 'device', 'app version', 'android', 'webview'], equivalents: [],
    example: {}, limits: 'The owner\'s phones running the WizardOS app.',
  },
  {
    job: 'tips', tool: 'wizard_tips', provider: { kind: 'agent-service', id: 'wizard-agent-service', name: 'Wizard tips' },
    words: ['tips', 'feature tips', 'what can wizard do'], equivalents: [],
    example: { action: 'status' }, limits: 'Only start when the owner says yes.',
  },
]

const clean = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max) : '')
const words = (job) => clean(String(job || '').replace(/[-_]+/gu, ' '), 60)
const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const text = (value) => ({ content: [{ type: 'text', text: value }] })
const bad = (value) => ({ content: [{ type: 'text', text: value }], isError: true })

/** The words of a free-text ask, for matching ("Transcribe this audio!" -> transcribe, this, audio). */
export function askWords(value) {
  return clean(String(value || ''), 300).toLowerCase().split(/[^a-z0-9.+#]+/u).filter((w) => w.length > 1)
}

// A short score of how well an ask matches one record: the job name, any of its words, the provider's name.
function score(record, ask) {
  const asked = askWords(ask)
  if (!asked.length) return 0
  const phrase = asked.join(' ')
  let best = 0
  for (const w of [record.job, ...record.words, record.provider?.name || '']) {
    const target = String(w || '').toLowerCase()
    if (!target) continue
    if (phrase === target) return 100
    if (target.includes(' ') ? phrase.includes(target) : asked.includes(target)) best = Math.max(best, 10 + target.length)
    else if (target.length > 3 && asked.some((a) => a.length > 3 && (a.startsWith(target) || target.startsWith(a)))) best = Math.max(best, 5)
  }
  return best
}

function readJson(path, fallback) {
  try { return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback } catch { return fallback }
}
function writeJson(path, value) {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(value))
  renameSync(`${path}.tmp`, path)
}

/**
 * `on()` is the switch. `apps(agentId)` -> bridge apps that agent may use; `allApps()` -> every installed bridge app.
 * `builtins(agentId)` -> the gateway built-in tools served to the agent (without this one). `isPrivate(agentId)`,
 * `agentLabel(agentId)`. `voice()` -> {ready, reachable, name} of the Wizard Voice Service. `statePath` keeps the
 * per-agent guard choice and the recorded gaps (job words + agent id, never content).
 */
export function createCapabilities({ on = () => false, apps = () => [], allApps = () => [], builtins = () => [], isPrivate = () => false, agentLabel = () => 'This agent', voice = async () => ({ ready: true, reachable: true }), statePath = '', now = Date.now, log = () => {} } = {}) {
  const state = () => {
    const value = readJson(statePath, {})
    return { guard_off: Array.isArray(value?.guard_off) ? value.guard_off.filter((id) => typeof id === 'string') : [], gaps: Array.isArray(value?.gaps) ? value.gaps : [] }
  }
  const save = (value) => { try { writeJson(statePath, value) } catch (error) { log(`state not saved: ${clean(error?.message, 120)}`) } }

  // The built-in tools this agent is served, by name.
  const served = (agentId) => {
    const out = new Map()
    for (const tool of builtins(agentId) || []) if (tool?.name) out.set(tool.name, tool)
    return out
  }

  // Records without live status: sync, for the kernel index and the run note.
  function base(agentId) {
    const tools = served(agentId)
    const out = []
    for (const b of BUILTIN_JOBS) {
      if (!tools.has(b.tool)) continue
      out.push({ ...b, provider: { ...b.provider }, tool: b.tool, inputs: tools.get(b.tool).inputSchema || null, status: 'ready' })
    }
    const mine = apps(agentId) || []
    const allowed = new Set(mine.map((a) => a.id))
    const seen = new Set(out.map((r) => r.job))
    const add = (app, status) => {
      for (const job of app.jobs?.length ? app.jobs : []) {
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(job)) continue
        const key = `${job}|${app.id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          job, words: [words(job), clean(app.name, 60).toLowerCase(), ...askWords(app.summary).slice(0, 12)].filter(Boolean), equivalents: [],
          provider: { kind: 'app', id: app.id, name: app.name }, tool: `${app.prefix}__*`, docs: `wizard-job-${job}`,
          status: status ?? (app.status === 'running' ? 'ready' : 'unavailable'), ...(app.status !== 'running' && !status ? { reason: `${app.name} is ${app.status}` } : {}),
          limits: '', example: {},
        })
      }
    }
    for (const app of mine) add(app)
    // Installed apps this agent is not allowed to use: say so (ask the owner), never a missing tool. A private app
    // stays unnamed to an agent that may not use it (the gateway's #58/#59 seal).
    if (!isPrivate(agentId)) for (const app of allApps() || []) if (!allowed.has(app.id) && !app.private) add(app, 'not-granted')
    return out
  }

  /** Job names on this agent's index, built-ins first (the kernel line, the run note). */
  function jobs(agentId) {
    if (!on()) return null
    return [...new Set(base(agentId).map((r) => r.job))]
  }

  async function records(agentId) {
    const list = base(agentId)
    const label = clean(agentLabel(agentId), 60) || 'This agent'
    for (const r of list) {
      if (r.status === 'not-granted') r.ask = `${r.provider.name} does ${words(r.job)} on this box but is not granted to ${label}. Ask the owner to allow ${r.provider.name} for ${label} in Connections; do not install or build your own.`
    }
    const stt = list.find((r) => r.job === 'transcription' && r.provider.kind === 'host-service')
    if (stt) {
      let health = null
      try { health = await voice() } catch { health = null }
      if (health && health.ready !== true) {
        stt.status = 'unavailable'
        stt.reason = health.reachable ? `${health.name || 'The Wizard Voice Service'} is not ready` : 'the Wizard Voice Service is not answering'
      }
    }
    return list
  }

  const guardOn = (agentId) => !state().guard_off.includes(agentId)

  function recordGap(agentId, ask) {
    const asked = askWords(ask).slice(0, 12).join(' ')
    if (!asked) return
    const current = state()
    const gaps = [...current.gaps, { at: new Date(now()).toISOString(), agent: String(agentId).slice(0, 64), words: asked.slice(0, 160) }].slice(-GAP_LIMIT)
    save({ ...current, gaps })
    log(`gap ${agentId}: ${asked.slice(0, 80)}`)
  }

  const brief = (r) => ({
    job: r.job, provider: r.provider, tool: r.tool, status: r.status,
    ...(r.reason ? { reason: r.reason } : {}), ...(r.ask ? { ask: r.ask } : {}),
  })

  const TOOL = {
    name: CAPABILITY_TOOL,
    description: '[WizardOS] What this box can already do for you: transcription, reminders, scheduling, app jobs and more, with the tool that does each and whether you may use it. Call it with no arguments for the list, or with `job` (a job name or the owner\'s words, e.g. "transcribe audio") for the tool, its inputs, an example and limits. Call it BEFORE installing software, downloading a model, signing up for an outside service or telling the owner the box cannot do something.',
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: 'Optional: a job name from the list or the owner\'s words, e.g. "transcribe audio" or "remind me".' },
        format: { type: 'string', enum: ['text', 'json'], description: 'Optional: json returns the registry as data (for programs).' },
      },
      additionalProperties: false,
    },
  }

  async function call(name, args = {}, agentId) {
    if (name !== CAPABILITY_TOOL || !on()) return undefined
    if (!args || typeof args !== 'object' || Array.isArray(args)) return bad('Arguments must be an object.')
    const list = await records(agentId)
    if (args.format === 'json') {
      return ok({ schema: CAPABILITY_SCHEMA, agent: agentId, guard: guardOn(agentId), capabilities: list.map((r) => ({ ...brief(r), words: r.words, equivalents: r.equivalents })) })
    }
    const ask = clean(String(args.job ?? ''), 300)
    if (!ask) {
      const lines = list.map((r) => `- ${words(r.job)}: ${r.provider.name} (${r.provider.kind}), tool \`${r.tool}\`, ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.ask ? `. ${r.ask}` : ''}`)
      return text(lines.length
        ? `Built into this box (call ${CAPABILITY_TOOL} with job for details):\n${lines.join('\n')}\nUnavailable ones: tell the owner (\`wam doctor\`). Use these instead of installing software or models.`
        : 'Nothing is built into this box for you yet. Tell the owner plainly what you cannot do here.')
    }
    const ranked = list.map((r) => [score(r, ask), r]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])
    if (!ranked.length) {
      recordGap(agentId, ask)
      return text(`Nothing on this box does "${ask.slice(0, 80)}" yet. Tell the owner plainly that the box does not do this yet. If they want it, it can be added as an app; only install something yourself when the owner agrees.`)
    }
    const top = ranked.filter(([s]) => s === ranked[0][0]).map(([, r]) => r)
    return ok({
      matches: top.map((r) => ({
        ...brief(r), ...(r.docs ? { docs: r.docs } : {}), ...(r.inputs ? { inputs: r.inputs } : {}),
        ...(r.example && Object.keys(r.example).length ? { example: r.example } : {}), ...(r.limits ? { limits: r.limits } : {}),
        how: r.status === 'ready'
          ? (r.provider.kind === 'app' ? `Load the \`${r.docs}\` skill for the exact tool names, then call it on the wizard MCP server.` : `Call \`${r.tool}\` on the wizard MCP server.`)
          : r.status === 'not-granted' ? r.ask : `It is unavailable right now (${r.reason || 'not answering'}): tell the owner (\`wam doctor\`); do not install a replacement.`,
      })),
    })
  }

  /** Routed agents get no kernel: one line in their run note with the same index. */
  function runNote(agentId) {
    const names = jobs(agentId)
    if (!names) return ''
    return `Built into this box for you: ${names.map(words).join(', ') || 'see the list'}. Before doing one of these yourself, installing software, downloading a model or saying the box cannot do something, call ${CAPABILITY_TOOL}.`
  }

  /** The owner's view: the main agent's registry, the agents with the guard off and the recorded gaps. */
  async function ownerView(mainAgent = 'hermes') {
    const s = state()
    return { schema: CAPABILITY_SCHEMA, on: on() === true, capabilities: on() ? (await records(mainAgent)).map(brief) : [], guard_off: s.guard_off, gaps: s.gaps.slice(-100).reverse() }
  }

  /** The owner turns the install guard off (or back on) for one agent. */
  function setGuard(agent, guard) {
    if (typeof agent !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(agent) || typeof guard !== 'boolean') throw Object.assign(new Error('invalid'), { status: 400, code: 'invalid_request' })
    const s = state()
    const off = new Set(s.guard_off)
    if (guard) off.delete(agent); else off.add(agent)
    save({ ...s, guard_off: [...off].sort() })
    return { agent, guard }
  }

  return { tool: TOOL, list: () => (on() ? [TOOL] : []), call, jobs, records, runNote, ownerView, setGuard, guardOn }
}
