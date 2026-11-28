// Reply buttons that act on an app directly, with no agent turn (wizard-ux issue 1973, part 2; switch
// wizard/reply-actions in the owner's Look file, off by default, on top of the reply buttons, wizard-ux issue 1889).
//
// A button in a [WIZARD_BUTTONS_V1] line may declare an app action:
//   {"id":"done","label":"Done","action":{"app":"<installed app id>","tool":"<tool name>","args":{...}}}
// The shell sends only which button was tapped (thread, message, group, button). The action itself is read here from
// that message in the thread's OWN history (never from the client), and the app is called through the same gateway
// tool call agents use (agent-bridge callTool), under the thread's agent's app grant: an app the agent may not use, an
// unknown app or an unknown tool is refused and saved as a failure. No run is started and no model is called.
// Each tap's outcome (the picked button and one machine line from the app's answer, or the failure) is saved on the box
// per thread, so a reload and every other device show it. A button without an `action` keeps today's behaviour.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicStoreWrite } from './store-migration.mjs'

export const REPLY_ACTIONS_SWITCH = 'wizard/reply-actions'
export const REPLY_ACTIONS_SCHEMA = 'wizard.reply-actions/1'

export const REPLY_ACTIONS_INSTRUCTIONS = [
  'Action buttons are on for this owner. A button can also act on an installed app directly when tapped, with no turn for you: add "action":{"app":"<installed app id>","tool":"<that app\'s tool name>","args":{...}} to the button, for example',
  '[WIZARD_BUTTONS_V1]{"group":"Workout","buttons":[{"id":"done","label":"Done","action":{"app":"<app id>","tool":"<tool>","args":{"step":"workout"}}}]}[/WIZARD_BUTTONS_V1]',
  'Use it for taps that only need logging or ticking in an app (a checklist step, a habit), where you have nothing to add. The app\'s answer shows as a small line under your post and you are not asked to reply; the owner sees a failure inline with Retry. Use only apps and tools you can call yourself (wizard_apps lists them) with the exact arguments that tool takes. Leave "action" out when you want to hear about the tap: those taps still come to you as before.',
].join('\n')

/** The run note while both switches are on, else ''. */
export function replyActionsNote(on) {
  try { return on?.() === true ? REPLY_ACTIONS_INSTRUCTIONS : '' } catch { return '' }
}

// The same reading of a [WIZARD_BUTTONS_V1] line as the shell's (wizard-ux core/chat-kit.js buttonGroup), so a group
// and a button are named here exactly as the shell named them in the tap.
const BUTTONS_RE = /\[WIZARD_BUTTONS_V1\]\s*([\s\S]*?)\s*\[\/WIZARD_BUTTONS_V1\]/g
const RB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const TOOL = /^[A-Za-z0-9_.-]{1,160}$/
const THREAD = /^[A-Za-z0-9._:-]{1,180}$/
const AGENT = /^[a-z0-9][a-z0-9-]{0,63}$/
const one = (v, n) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : ''
const plainObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

function actionOf(raw) {
  if (!plainObject(raw)) return null
  const app = typeof raw.app === 'string' ? raw.app.trim() : '', tool = typeof raw.tool === 'string' ? raw.tool.trim() : ''
  const args = raw.args === undefined ? {} : raw.args
  if (!APP_ID.test(app) || !TOOL.test(tool) || !plainObject(args)) return null
  try { if (JSON.stringify(args).length > 4096) return null } catch { return null }
  return { app, tool, args }
}

/** The groups of one message text, each button with its parsed action (or null). */
export function actionGroups(text) {
  const out = []
  for (const m of String(text || '').matchAll(BUTTONS_RE)) {
    let p
    try { p = JSON.parse(m[1]) } catch { continue }
    const group = one(p?.group, 60), seen = new Set(), buttons = []
    for (const b of Array.isArray(p?.buttons) ? p.buttons : []) {
      const id = typeof b?.id === 'string' ? b.id.trim() : '', label = one(b?.label, 40)
      if (RB_ID.test(id) && label && !seen.has(id) && buttons.length < 6) {
        seen.add(id); buttons.push({ id, label, action: b?.action === undefined ? null : actionOf(b.action), declared: b?.action !== undefined })
      }
    }
    if (group && buttons.length && !out.some(g => g.group === group) && out.length < 12) out.push({ group, buttons })
  }
  return out
}

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(p => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('\n') : ''

/** One plain line from an MCP tool result: its first non-empty text line, clipped. */
export function machineLine(result, fallback = '') {
  const parts = Array.isArray(result?.content) ? result.content : []
  for (const p of parts) {
    if (p?.type !== 'text' || typeof p.text !== 'string') continue
    let text = p.text.trim()
    // A tool that answers JSON: its own short words when it has them.
    try { const j = JSON.parse(text); const w = plainObject(j) ? j.line || j.summary || j.message || j.status : ''; if (typeof w === 'string' && w.trim()) text = w.trim() } catch { /* plain text */ }
    const line = text.split('\n').map(s => s.trim()).find(Boolean)
    if (line) return line.slice(0, 140)
  }
  return fallback.slice(0, 140)
}

const refusal = (status, error, detail = '') => Object.assign(new Error(detail || error), { status, error, detail })

/**
 * The store and the tap. Injected:
 *   findMessage(agent, thread, message) -> the history row (role, content) of that message in that thread, or null
 *   callApp(agent, app, tool, args)     -> an MCP tool result ({ content, isError }); refusals come back as isError
 */
export function createReplyActions({ statePath = '', findMessage, callApp, now = Date.now, maxThreads = 2000, maxPerThread = 200 } = {}) {
  let threads = new Map() // `${agent}\n${thread}` -> [record]
  if (statePath && existsSync(statePath)) {
    try {
      const doc = JSON.parse(readFileSync(statePath, 'utf8'))
      if (doc?.schema === REPLY_ACTIONS_SCHEMA && plainObject(doc.threads)) threads = new Map(Object.entries(doc.threads).filter(([, v]) => Array.isArray(v)))
    } catch { threads = new Map() }
  }
  const save = () => {
    if (!statePath) return
    while (threads.size > maxThreads) threads.delete(threads.keys().next().value)
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    atomicStoreWrite(statePath, JSON.stringify({ schema: REPLY_ACTIONS_SCHEMA, threads: Object.fromEntries(threads) }))
  }
  const keyOf = (agent, thread) => `${agent || ''}\n${thread}`
  const inflight = new Map()
  const view = r => ({ message: r.message, group: r.group, button: r.button, label: r.label, ok: r.ok === true, ...(r.ok ? { line: r.line } : { error: r.error }), at: r.at })

  function list(agent, thread) {
    if (!THREAD.test(String(thread || ''))) throw refusal(400, 'invalid_thread')
    return { schema: REPLY_ACTIONS_SCHEMA, thread, actions: (threads.get(keyOf(agent, thread)) || []).map(view) }
  }

  async function run(agent, thread, message, group, button) {
    const row = await findMessage(agent, thread, message)
    if (!row || row.role !== 'assistant') throw refusal(404, 'message_not_found', 'That message is not in this thread')
    const g = actionGroups(textOf(row.content)).find(x => x.group === group)
    const b = g?.buttons.find(x => x.id === button)
    if (!b) throw refusal(404, 'button_not_found', 'That button is not in this message')
    if (!b.declared) throw refusal(409, 'no_action', 'This button has no app action')
    const at = now()
    let result
    if (!b.action) result = { isError: true, content: [{ type: 'text', text: 'This button\'s app action is not one Wizard can run' }] }
    else {
      try { result = await callApp(agent, b.action.app, b.action.tool, b.action.args) }
      catch (error) { result = { isError: true, content: [{ type: 'text', text: `The app could not be reached: ${one(error?.message, 120) || 'no answer'}` }] } }
    }
    const ok = !!result && !result.isError
    const record = { message, group, button, label: b.label, ok, at, app: b.action?.app || '', tool: b.action?.tool || '',
      ...(ok ? { line: machineLine(result, `${b.label} · ${group}`) } : { error: machineLine(result, 'The app did not do it') }) }
    const key = keyOf(agent, thread), rows = (threads.get(key) || []).filter(r => !(r.message === message && r.group === group))
    rows.push(record)
    threads.delete(key); threads.set(key, rows.slice(-maxPerThread)) // newest thread last, so the oldest go first
    save()
    return record
  }

  /** The owner tapped `button` of `group` in `message`. Resolves the saved record (ok or failed). */
  async function tap({ agent = '', thread, message, group, button } = {}) {
    agent = typeof agent === 'string' ? agent.trim() : ''
    if (agent && !AGENT.test(agent)) throw refusal(400, 'invalid_agent')
    if (!THREAD.test(String(thread || ''))) throw refusal(400, 'invalid_thread')
    message = one(message, 200); group = one(group, 60); button = typeof button === 'string' ? button.trim() : ''
    if (!message || !group || !RB_ID.test(button)) throw refusal(400, 'invalid_tap')
    const key = keyOf(agent, thread)
    // The same pick that already worked is not run twice (a double tap, a second device, a stale page).
    const done = (threads.get(key) || []).find(r => r.message === message && r.group === group)
    if (done?.ok && done.button === button) return { ...view(done), replayed: true }
    const flight = `${key}\n${message}\n${group}`
    if (inflight.has(flight)) return inflight.get(flight).then(r => ({ ...view(r), replayed: true }))
    const task = run(agent, thread, message, group, button)
    inflight.set(flight, task)
    try { return view(await task) } finally { inflight.delete(flight) }
  }

  return { list, tap, _threads: threads }
}
