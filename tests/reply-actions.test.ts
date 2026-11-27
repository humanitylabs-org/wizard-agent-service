import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scene, post, kinds } from '../qa/agent-parity/fixture.mjs'
import { listen } from '../server/service.mjs'
import { REPLY_ACTIONS_SWITCH, REPLY_ACTIONS_INSTRUCTIONS, actionGroups, machineLine, createReplyActions } from '../server/reply-actions.mjs'
import { REPLY_BUTTONS_SWITCH } from '../server/reply-buttons.mjs'

// Reply buttons that act on an app directly, with no agent turn (wizard-ux issue 1973, part 2; switch
// wizard/reply-actions, off by default). The button's action is read from the thread's own history, the app is called
// through the gateway on the thread's agent's grant, no run is started, and the outcome is saved per thread.
const GROUP = (group: string, buttons: any[]) => `[WIZARD_BUTTONS_V1]${JSON.stringify({ group, buttons })}[/WIZARD_BUTTONS_V1]`
const ACTION = { app: 'checklist-qa', tool: 'tick', args: { step: 'workout' } }
const POSTED = `Morning checklist\n1. Workout\n${GROUP('Workout', [{ id: 'done', label: 'Done', action: ACTION }])}\n2. Read\n${GROUP('Read', [{ id: 'done', label: 'Done' }])}\n3. Water\n${GROUP('Water', [{ id: 'done', label: 'Done', action: { app: 'not-installed', tool: 'tick', args: {} } }])}\n4. Notes\n${GROUP('Notes', [{ id: 'done', label: 'Done', action: { app: 'ungranted-qa', tool: 'tick', args: { step: 'notes' } } }])}`

// A synthetic app on loopback speaking the gateway's MCP (JSON-RPC over HTTP): its own state is a tick list.
async function fakeApp() {
  const state = { ticks: [] as any[], calls: [] as any[], down: false }
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c
    const msg = raw ? JSON.parse(raw) : {}
    const json = (v: any) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'qa' }); res.end(JSON.stringify(v)) }
    if (req.url === '/state') return json(state)
    if (state.down) { res.writeHead(503); res.end('down'); return }
    if (msg.id === undefined) { res.writeHead(202); res.end(); return }
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'qa', version: '1' } } })
    if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'tick', description: 'tick a step', inputSchema: { type: 'object' } }] } })
    if (msg.method === 'tools/call') {
      state.calls.push({ name: msg.params.name, args: msg.params.arguments, agent: req.headers['x-wizard-agent'] || '' })
      if (msg.params.name !== 'tick') return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } })
      state.ticks.push(msg.params.arguments.step)
      return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Workout ticked · ${state.ticks.length} of 4\n(details)` }] } })
    }
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } })
  })
  const port = (await listen(server)).port
  return { state, url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r) }) }
}

const look = (root: string, tweaks: Record<string, boolean>) => {
  const dir = join(root, 'Pages', 'wizard-look'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: Object.fromEntries(Object.entries(tweaks).map(([k, on]) => [k, { on, at: Date.now() }])) }))
}
// The app on the box, granted to the routed agent (main may use every app); `ungranted-qa` is installed but not granted.
const install = (root: string, folder: string, kind: string, url: string) => {
  writeFileSync(join(root, 'apps.json'), JSON.stringify({ apps: [{ id: 'checklist-qa', name: 'Checklist QA', status: 'running', provides: ['checklist'], mcp: { url } }, { id: 'ungranted-qa', name: 'Ungranted QA', status: 'running', provides: ['checklist'], mcp: { url } }] }))
  if (kind === 'main') return
  const path = join(folder, 'agent.json'), agent = JSON.parse(readFileSync(path, 'utf8'))
  agent.permissions = { ...agent.permissions, wizard_apps: ['checklist-qa'] }
  writeFileSync(path, JSON.stringify(agent))
}
const runs = (s: any) => s.seen.filter((r: any) => r.method === 'POST' && /\/(?:v1\/runs|chat\/stream)$/.test(r.path))

describe('reply actions: parsing', () => {
  it('reads each button\'s action as the shell names groups and buttons', () => {
    const groups = actionGroups(POSTED)
    expect(groups.map(g => g.group)).toEqual(['Workout', 'Read', 'Water', 'Notes'])
    expect(groups[0].buttons[0]).toMatchObject({ id: 'done', label: 'Done', action: ACTION, declared: true })
    expect(groups[1].buttons[0]).toMatchObject({ action: null, declared: false })
    // a malformed action is declared but never runnable
    expect(actionGroups(GROUP('X', [{ id: 'a', label: 'A', action: { app: 'Bad App!', tool: 'x' } }]))[0].buttons[0]).toMatchObject({ action: null, declared: true })
    expect(machineLine({ content: [{ type: 'text', text: '\n  Ticked · 1 of 4\nmore' }] })).toBe('Ticked · 1 of 4')
    expect(machineLine({ content: [{ type: 'text', text: '{"line":"Logged"}' }] })).toBe('Logged')
    expect(machineLine({ content: [] }, 'Done · Workout')).toBe('Done · Workout')
    expect(REPLY_ACTIONS_SWITCH).toBe('wizard/reply-actions')
    for (const part of ['"action":{"app":', '"tool":', '"args":', 'no turn for you', 'wizard_apps', 'Retry']) expect(REPLY_ACTIONS_INSTRUCTIONS).toContain(part)
  })
  it('a pick that worked is not run twice; a failure runs again on Retry; outcomes survive a restart', async () => {
    let calls = 0, fail = true
    const dir = join(process.env.TMPDIR || '/tmp', `reply-actions-${process.pid}-${Date.now()}`); mkdirSync(dir, { recursive: true })
    const opts = { statePath: join(dir, 'state.json'), findMessage: async () => ({ role: 'assistant', content: POSTED }),
      callApp: async () => { calls++; return fail ? { isError: true, content: [{ type: 'text', text: 'Checklist is not answering' }] } : { content: [{ type: 'text', text: 'Ticked' }] } } }
    const a = createReplyActions(opts as any)
    const tap = { thread: 'wizard_t', message: '7', group: 'Workout', button: 'done' }
    expect(await a.tap(tap as any)).toMatchObject({ ok: false, error: 'Checklist is not answering' })
    fail = false
    expect(await a.tap(tap as any)).toMatchObject({ ok: true, line: 'Ticked' })
    expect(await a.tap(tap as any)).toMatchObject({ ok: true, replayed: true })
    expect(calls).toBe(2)
    const b = createReplyActions(opts as any)
    expect(b.list('', 'wizard_t').actions).toEqual([expect.objectContaining({ message: '7', group: 'Workout', button: 'done', ok: true, line: 'Ticked' })])
    await expect(b.tap({ ...tap, group: 'Read' } as any)).rejects.toMatchObject({ status: 409, error: 'no_action' })
    await expect(b.tap({ ...tap, button: 'nope' } as any)).rejects.toMatchObject({ status: 404 })
  })
})

describe('reply actions: main and routed threads, no agent run', () => {
  for (const kind of kinds) it(`a tap acts on the app on its agent's grant, saved for reload / ${kind}`, async () => {
    const app = await fakeApp()
    const s: any = await scene(kind, ({ root, folder }: any) => {
      install(root, folder, kind, app.url)
      return { pagesRoot: join(root, 'Pages'), pagesGitDir: join(root, 'pages-history.git'), pagesWatch: false, replyActionsTtlMs: 0, replyButtonsTtlMs: 0,
        agentBridge: true, bridgeWriteSkills: false, mcpToken: 'reply-actions-parity-token', replyActionsStatePath: join(root, 'reply-actions.json') }
    })
    try {
      const agent = kind === 'main' ? '' : s.id
      const id = 'wizard_morning_1973'
      expect((await s.request('/api/sessions', post({ id, source: 'cron', hidden: false }))).status).toBe(201)
      s.sessions.get(id).messages.push({ id: 501, role: 'assistant', content: POSTED, timestamp: Date.now() / 1000 - 60 })
      const tap = (body: any) => s.raw('/wizard/v1/reply-actions', post({ thread: id, message: '501', ...(agent ? { agent } : {}), ...body }))
      const listed = async () => (await (await s.raw(`/wizard/v1/reply-actions?thread=${id}${agent ? `&agent=${agent}` : ''}`)).json()).actions
      // Switch off (no Look file / off): nothing new answers.
      expect((await tap({ group: 'Workout', button: 'done' })).status).toBe(404)
      look(s.root, { [REPLY_BUTTONS_SWITCH]: true, [REPLY_ACTIONS_SWITCH]: false })
      expect((await tap({ group: 'Workout', button: 'done' })).status).toBe(404)
      look(s.root, { [REPLY_BUTTONS_SWITCH]: true, [REPLY_ACTIONS_SWITCH]: true })
      const before = runs(s).length
      const r = await tap({ group: 'Workout', button: 'done' })
      expect(r.status).toBe(200)
      const got = await r.json()
      expect(got).toMatchObject({ ok: true, action: { group: 'Workout', button: 'done', label: 'Done', ok: true, line: 'Workout ticked · 1 of 4' } })
      // The app's own state changed, on the thread's agent's grant; the action came from the history, not the client.
      expect(app.state.ticks).toEqual(['workout'])
      expect(app.state.calls[0]).toMatchObject({ name: 'tick', args: { step: 'workout' } })
      // No run and no model call.
      expect(runs(s).length).toBe(before)
      // A second tap (another device) is the saved outcome, not a second tick.
      expect((await (await tap({ group: 'Workout', button: 'done' })).json()).action).toMatchObject({ ok: true, replayed: true })
      expect(app.state.ticks).toEqual(['workout'])
      // Saved per thread: a reload and a second device read it back, also after a restart.
      await s.restart()
      expect(await listed()).toEqual([expect.objectContaining({ message: '501', group: 'Workout', button: 'done', ok: true, line: 'Workout ticked · 1 of 4' })])
      // An app that is not installed is refused and saved as a failure (shown with Retry); still no run.
      const missing = await (await tap({ group: 'Water', button: 'done' })).json()
      expect(missing).toMatchObject({ ok: false, action: { ok: false, group: 'Water' } })
      expect(missing.action.error).toMatch(/not-installed/)
      // A routed agent's buttons reach only the apps that agent may use (main may use every app).
      const notes = await (await tap({ group: 'Notes', button: 'done' })).json()
      if (kind === 'main') expect(notes).toMatchObject({ ok: true })
      else { expect(notes).toMatchObject({ ok: false }); expect(notes.action.error).toMatch(/not allowed to use Ungranted QA/) }
      // A button the message does not have is refused.
      expect((await tap({ group: 'Workout', button: 'skip' })).status).toBe(404)
      // A button without an action is not this route's (the shell sends it as an owner message as before).
      expect((await tap({ group: 'Read', button: 'done' })).status).toBe(409)
      // A message the thread does not have, or an extra client-sent action, changes nothing.
      expect((await tap({ message: '999', group: 'Workout', button: 'done' })).status).toBe(404)
      expect(runs(s).length).toBe(before)
      // Owner only: an agent's own gateway credential cannot press the owner's buttons.
      const asAgent = await fetch(`${s.origin()}/wizard/v1/reply-actions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer reply-actions-parity-token' }, body: JSON.stringify({ thread: id, message: '501', group: 'Workout', button: 'done' }) })
      expect([401, 403]).toContain(asAgent.status)
    } finally { await s.close(); await app.close() }
  }, 60_000)

  for (const kind of kinds) it(`a failing app shows its error and Retry works once it is back / ${kind}`, async () => {
    const app = await fakeApp()
    const s: any = await scene(kind, ({ root, folder }: any) => {
      install(root, folder, kind, app.url)
      look(root, { [REPLY_BUTTONS_SWITCH]: true, [REPLY_ACTIONS_SWITCH]: true })
      return { pagesRoot: join(root, 'Pages'), pagesGitDir: join(root, 'pages-history.git'), pagesWatch: false, replyActionsTtlMs: 0,
        agentBridge: true, bridgeWriteSkills: false, mcpToken: 'reply-actions-parity-token', replyActionsStatePath: join(root, 'reply-actions.json') }
    })
    try {
      const agent = kind === 'main' ? '' : s.id, id = 'wizard_retry_1973'
      expect((await s.request('/api/sessions', post({ id, source: 'cron' }))).status).toBe(201)
      s.sessions.get(id).messages.push({ id: 601, role: 'assistant', content: POSTED, timestamp: Date.now() / 1000 - 60 })
      const tap = () => s.raw('/wizard/v1/reply-actions', post({ thread: id, message: '601', group: 'Workout', button: 'done', ...(agent ? { agent } : {}) }))
      app.state.down = true
      const failed = await (await tap()).json()
      expect(failed).toMatchObject({ ok: false, action: { ok: false } })
      expect(failed.action.error).toMatch(/Checklist QA could not run tick/)
      expect(app.state.ticks).toEqual([])
      app.state.down = false
      const retried = await (await tap()).json()
      expect(retried).toMatchObject({ ok: true, action: { ok: true, line: 'Workout ticked · 1 of 4' } })
      expect(app.state.ticks).toEqual(['workout'])
      expect(runs(s).length).toBe(0)
    } finally { await s.close(); await app.close() }
  }, 60_000)

  for (const kind of kinds) it(`the run note names action buttons only while both switches are on / ${kind}`, async () => {
    const s: any = await scene(kind, ({ root }: any) => ({ pagesRoot: join(root, 'Pages'), pagesGitDir: join(root, 'pages-history.git'), pagesWatch: false, replyButtonsTtlMs: 0, replyActionsTtlMs: 0 }))
    try {
      let n = 0
      const send = async (input: string) => {
        const id = `wizard_actions_note_${++n}`
        expect((await s.request('/api/sessions', post({ id, source: 'wizard-mobile', hidden: true }))).status).toBe(201)
        expect((await s.request('/v1/runs', post({ session_id: id, input }))).status).toBe(202)
        return String(runs(s).at(-1).body.instructions || '')
      }
      look(s.root, { [REPLY_BUTTONS_SWITCH]: true })
      expect(await send('buttons only')).not.toContain('Action buttons are on')
      look(s.root, { [REPLY_BUTTONS_SWITCH]: true, [REPLY_ACTIONS_SWITCH]: true })
      expect(await send('both')).toContain(REPLY_ACTIONS_INSTRUCTIONS)
      look(s.root, { [REPLY_ACTIONS_SWITCH]: true })
      expect(await send('actions without buttons')).not.toContain('Action buttons are on')
    } finally { await s.close() }
  }, 30_000)
})
