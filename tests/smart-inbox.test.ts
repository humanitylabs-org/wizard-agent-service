// Issue 667 (Smart inbox, owner switch wizard/smart-inbox, off by default): needs_you means a blocker only. A confirm /
// QA / "try it" ask (a run ending check) becomes one agent-inbox record (kind confirm) and the thread goes quiet; a run
// nobody typed files its result there too; a first message that asked for nothing is quiet like a reply; "let me know
// when" makes the finished result reach Inbox once. Switch off: nothing changes. Synthetic threads only.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SentLog } from '../server/sent-log.mjs'
import { AgentInboxStore } from '../server/agent-inbox.mjs'
import { STATUS_INSTRUCTIONS, STATUS_PROTOCOL_INSTRUCTIONS, withSmartInbox, asksToBeTold } from '../server/thread-status.mjs'
import { planSweep } from '../server/agent-sweep.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { try { s.closeAllConnections?.() } catch {} s.close(() => r()) })))
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const readBody = (req: IncomingMessage) => new Promise<any>(resolve => { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : null) } catch { resolve(null) } }) })
const status = (state: string, ask: string) => `[WIZARD_STATUS_V1]${JSON.stringify({ state, ask })}[/WIZARD_STATUS_V1]`

// A Hermes that answers each run with the reply `answer(input)` gives.
const control = { acceptSteer: true, holding: new Set<string>(), instructions: [] as string[] }
async function fakeHermes(answer: (input: string) => string | null) {
  control.acceptSteer = true; control.holding.clear(); control.instructions = []
  const rows = new Map<string, any>()
  const messages = new Map<string, any[]>()
  const outputs = new Map<string, string | null>()
  let runs = 0
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = await readBody(req)
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/v1/capabilities') return json(200, { features: {} })
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, { data: [...rows.values()] })
    const one = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && one) { const row = rows.get(decodeURIComponent(one[1])); return row ? json(200, { session: row }) : json(404, { error: 'not found' }) }
    const msgs = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'GET' && msgs) return json(200, { object: 'list', data: messages.get(decodeURIComponent(msgs[1])) ?? [] })
    if (req.method === 'POST' && url.pathname === '/v1/runs') {
      runs += 1
      control.instructions.push(String(body.instructions || ''))
      const id = body.session_id, input = typeof body.input === 'string' ? body.input : JSON.stringify(body.input)
      const t = Date.now() / 1000
      const out = answer(input)
      if (!rows.has(id)) rows.set(id, { id, title: 'Clips edit failure', source: 'api_server', archived: false, started_at: t })
      const list = messages.get(id) ?? []
      list.push({ id: list.length + 1, session_id: id, role: 'user', content: input, timestamp: t })
      if (out != null) list.push({ id: list.length + 1, session_id: id, role: 'assistant', content: out, timestamp: t + 0.5 })
      messages.set(id, list)
      Object.assign(rows.get(id), { message_count: list.length, last_active: t + 0.5, preview: input })
      const runId = `run-${runs}`
      outputs.set(runId, out)
      if (/long job/.test(input)) control.holding.add(runId)
      return json(202, { run_id: runId, status: 'started' })
    }
    const steer = url.pathname.match(/^\/v1\/runs\/([^/]+)\/steer$/)
    if (req.method === 'POST' && steer) return json(200, { accepted: control.acceptSteer, run_id: steer[1] })
    const run = url.pathname.match(/^\/v1\/runs\/([^/]+)$/)
    if (req.method === 'GET' && run && control.holding.has(run[1])) return json(200, { run_id: run[1], status: 'running' })
    if (req.method === 'GET' && run) {
      const out = outputs.get(run[1])
      return out == null ? json(200, { run_id: run[1], status: 'failed', error: 'boom' }) : json(200, { run_id: run[1], status: 'completed', output: out })
    }
    json(404, { error: 'nope' })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  servers.push(server)
  return { origin: `http://127.0.0.1:${(server.address() as any).port}`, rows, messages }
}

async function box(answer: (input: string) => string | null, extra: any = {}) {
  const d = mkdtempSync(join(tmpdir(), 'smart-inbox-')); dirs.push(d)
  if (extra.look !== undefined) look(d, extra.look)
  writeFileSync(join(d, 'settings.json'), '{}')
  const hermes = await fakeHermes(answer)
  const s = createWizardServer({ wizardOsHome: d, settingsPath: join(d, 'settings.json'), requireAccess: false, hermesKey: ['fixture', 'key', '667'].join('-'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
    upstreamOrigin: hermes.origin, pagesRoot: join(d, 'files', 'Pages'), pagesGitDir: join(d, 'pages.git'), pagesWatch: false, smartInboxTtlMs: 0, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 20, agentInboxStatePath: join(d, 'agent-inbox.json'), ...extra })
  servers.push(s)
  const base = `http://127.0.0.1:${((await listen(s)) as any).port}`
  return { d, base, hermes }
}
const send = (base: string, thread: string, input: string, key: string) => fetch(`${base}/wizard/hermes/v1/runs`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ session_id: thread, input }) })
const sent = async (base: string) => (await (await fetch(`${base}/wizard/v1/sent`)).json()).rows as any[]
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v) && Date.now() < end) { await new Promise(r => setTimeout(r, 50)); v = await read() }
  return v
}
const listRow = async (base: string, id: string) => {
  const j = await (await fetch(`${base}/wizard/hermes/api/sessions?limit=50`)).json()
  return (j.data || j.sessions || []).find((x: any) => x.id === id)
}

// The owner's Smart inbox switch in his Look file (the shell's Settings > Try new features toggle).
const look = (d: string, on: boolean) => { const p = join(d, 'files', 'Pages', 'wizard-look'); mkdirSync(p, { recursive: true }); writeFileSync(join(p, 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { 'wizard/smart-inbox': { on, at: Date.now() } } })) }
const inbox = async (base: string) => (await (await fetch(`${base}/wizard/v1/agent-inbox`)).json()).records as any[]
const settle = () => new Promise(r => setTimeout(r, 400))
// Synthetic answers in the shape of the 26 Nov list: confirmations ("went through the builder, check it"), a blocker, a
// plain finished answer and agent-started runs (a schedule, a silent watch wake).
const answers = (input: string) => {
  if (/explode/.test(input)) return null
  if (/\[Wizard schedule\] silent/.test(input)) return '[SILENT]'
  if (/\[Wizard schedule\]/.test(input)) return `Nightly report is ready.\n${status('done', 'Nightly report: 3 new mails, nothing urgent.')}`
  if (/approve|ship/i.test(input)) return `Ready.\n${status('needs_you', 'Phone update is ready. Reply ship to send it')}`
  if (/names|video|forum|top bar|switches/i.test(input)) return `Went through the builder and is live.\n${status('check', 'The fix is live. Say if it looks right')}`
  return `Done.\n${status('done', 'Weekend planned: walk Saturday, rest Sunday.')}`
}
const settled = (base: string, text: string) => until(() => sent(base), r => r.some(x => x.text === text && !['running', 'unknown', 'routing'].includes(x.state)))

describe('issue 667: Smart inbox on the box (switch wizard/smart-inbox)', { timeout: 60_000 }, () => {
  it('a confirm ask (check) writes one agent-inbox record and the thread goes quiet; a first message that asked nothing is quiet', async () => {
    const { base } = await box(answers, { agentInbox: true, look: true })
    await send(base, 'wizard_first_1', 'Plan my weekend', 'f-1')
    await settled(base, 'Plan my weekend')
    expect((await until(() => listRow(base, 'wizard_first_1'), r => r?.wizard_quiet_reply === true))?.wizard_quiet_reply).toBe(true)
    await send(base, 'wizard_first_1', 'Fix the Signal names through the builder', 'f-2')
    await settled(base, 'Fix the Signal names through the builder')
    const records = await until(() => inbox(base), r => r.length > 0)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ kind: 'confirm', state: 'new', thread_id: 'wizard_first_1', ask: 'The fix is live. Say if it looks right', filed: 'smart_inbox', started_by: 'owner' })
    expect((await until(() => listRow(base, 'wizard_first_1'), r => r?.wizard_quiet_reply === true))?.wizard_quiet_reply).toBe(true)
    // The Sent row is done (it waits in the agent inbox), not needs_you.
    expect((await sent(base)).find(r => r.text === 'Fix the Signal names through the builder')).toMatchObject({ outcome: 'check', state: 'done' })
    // Polled again: still one record.
    await settle()
    expect(await inbox(base)).toHaveLength(1)
    // A later confirm in the same thread replaces it: one line per thread, never repeated.
    await send(base, 'wizard_first_1', 'And the video playback too', 'f-3')
    await settled(base, 'And the video playback too')
    const open = (await until(() => inbox(base), r => r.length === 2)).filter(r => r.state === 'new')
    expect(open).toHaveLength(1)
    // The contract every agent got said needs_you is a blocker only.
    expect(control.instructions.at(-1)).toContain('a blocker only')
    expect(control.instructions.at(-1)).toContain('confirm ask that can wait')
  })

  it('"let me know when it is ready": the finished result is not quiet (once), and no record is filed for it', async () => {
    const { base } = await box(answers, { agentInbox: true, look: true })
    await send(base, 'wizard_notify_1', 'Plan my weekend', 'n-1')
    await settled(base, 'Plan my weekend')
    await send(base, 'wizard_notify_1', 'Fix the forum setup, let me know when it is ready', 'n-2')
    await settled(base, 'Fix the forum setup, let me know when it is ready')
    const row = (await sent(base)).find(r => r.text === 'Fix the forum setup, let me know when it is ready')
    expect(row).toMatchObject({ notify_when_done: true, wants_reply: true })
    expect(row.notified_run).toBeTruthy()
    await settle()
    expect((await listRow(base, 'wizard_notify_1'))?.wizard_quiet_reply).toBeUndefined()
    expect(await inbox(base)).toHaveLength(0)
    // Told once: the next confirm in the thread goes quiet into the agent inbox again.
    await send(base, 'wizard_notify_1', 'Now the top bar', 'n-3')
    await settled(base, 'Now the top bar')
    expect((await until(() => inbox(base), r => r.length === 1))[0]).toMatchObject({ kind: 'confirm' })
    expect((await until(() => listRow(base, 'wizard_notify_1'), r => r?.wizard_quiet_reply === true))?.wizard_quiet_reply).toBe(true)
  })

  it('a blocking needs_you or a failure is never quiet and never filed', async () => {
    const { base } = await box(answers, { agentInbox: true, look: true })
    await send(base, 'wizard_block_1', 'Plan my weekend', 'b-1')
    await settled(base, 'Plan my weekend')
    await send(base, 'wizard_block_1', 'Ship the phone release', 'b-2')
    await settled(base, 'Ship the phone release')
    await settle()
    expect((await listRow(base, 'wizard_block_1'))?.wizard_quiet_reply).toBeUndefined()
    await send(base, 'wizard_block_1', 'thanks, explode', 'b-3')
    await until(() => sent(base), r => r.some(x => x.text === 'thanks, explode' && x.state === 'failed'))
    await settle()
    expect((await listRow(base, 'wizard_block_1'))?.wizard_quiet_reply).toBeUndefined()
    expect(await inbox(base)).toHaveLength(0)
  })

  it('agent-started runs: a finished result is filed in the agent inbox and quiet; a silent wake is just quiet', async () => {
    const { base } = await box(answers, { agentInbox: true, look: true })
    await send(base, 'wizard_sched_1', '[Wizard schedule] nightly report', 'schedule:nightly-1')
    const records = await until(() => inbox(base), r => r.length > 0)
    expect(records[0]).toMatchObject({ kind: 'result', thread_id: 'wizard_sched_1', started_by: 'agent', ask: 'Nightly report: 3 new mails, nothing urgent.' })
    expect((await until(() => listRow(base, 'wizard_sched_1'), r => r?.wizard_quiet_reply === true))?.wizard_quiet_reply).toBe(true)
    await send(base, 'wizard_sched_2', '[Wizard schedule] silent watch', 'schedule:watch-1')
    await until(() => listRow(base, 'wizard_sched_2'), r => r?.wizard_quiet_reply === true)
    expect((await inbox(base)).filter(r => r.thread_id === 'wizard_sched_2')).toHaveLength(0)
  })

  it('switch off: no records, a check stays loud, the contract is unchanged (as before)', async () => {
    const { base } = await box(answers, { agentInbox: true, look: false })
    await send(base, 'wizard_off_1', 'Plan my weekend', 'o-1')
    await settled(base, 'Plan my weekend')
    await send(base, 'wizard_off_1', 'Fix the Signal names through the builder, let me know when done', 'o-2')
    await settled(base, 'Fix the Signal names through the builder, let me know when done')
    await send(base, 'wizard_off_2', '[Wizard schedule] nightly report', 'schedule:nightly-2')
    await settle(); await settle()
    expect(await inbox(base)).toHaveLength(0)
    expect((await listRow(base, 'wizard_off_1'))?.wizard_quiet_reply).toBeUndefined()
    expect((await listRow(base, 'wizard_off_2'))?.wizard_quiet_reply).toBeUndefined()
    const rows = await sent(base)
    expect(rows.find(r => r.text.startsWith('Fix the Signal'))).toMatchObject({ outcome: 'check', state: 'needs_you' })
    expect(rows.some(r => r.notify_when_done)).toBe(false)
    expect(control.instructions.every(text => !text.includes('a blocker only') && text.includes('own judgment is the missing piece'))).toBe(true)
  })

  it('the Look switch is read live: turning it on needs no restart', async () => {
    const { base, d } = await box(answers, { agentInbox: true, look: false })
    look(d, true)
    await send(base, 'wizard_live_1', 'Plan my weekend', 'l-1')
    await settled(base, 'Plan my weekend')
    await send(base, 'wizard_live_1', 'Fix the Signal names through the builder', 'l-2')
    expect((await until(() => inbox(base), r => r.length > 0))[0]).toMatchObject({ kind: 'confirm' })
  })
})

describe('issue 667: the contract and the stores', () => {
  it('withSmartInbox swaps the needs_you and check definitions in both contracts and only when on', () => {
    for (const text of [STATUS_INSTRUCTIONS, STATUS_PROTOCOL_INSTRUCTIONS]) {
      expect(withSmartInbox(text, false)).toBe(text)
      const on = withSmartInbox(text, true)
      expect(on).toContain('needs_you (a blocker only')
      expect(on).toContain('check (a confirm ask that can wait')
      expect(on).not.toContain('own judgment is the missing piece')
      expect(on).toContain('[WIZARD_STATUS_V1]')
    }
  })
  it('asksToBeTold reads whole phrases', () => {
    for (const t of ['let me know when it is ready', 'Tell me when it lands', 'ping me once the build is done', 'When it is finished, let me know', 'notify me as soon as it ships'])
      expect(asksToBeTold(t), t).toBe(true)
    for (const t of ['tell me about the trip', 'let me know what you think', 'draft a reply to Sam', 'when you can, fix the names'])
      expect(asksToBeTold(t), t).toBe(false)
  })
  it('AgentInboxStore.fileRun: one record per run, the newest per thread stays open, and it is never a worker record', () => {
    const s = new AgentInboxStore('')
    const a = s.fileRun({ thread: 't1', run_id: 'r1', kind: 'confirm', ask: 'Names fix is live. Say if right' })!
    expect(a.created).toBe(true)
    expect(s.fileRun({ thread: 't1', run_id: 'r1', kind: 'confirm', ask: 'Names fix is live. Say if right' })!.created).toBe(false)
    expect(s.linked('hermes', 't1')).toBeNull()
    expect(s.mayHide('hermes', 't1')).toBe(false)
    s.fileRun({ thread: 't1', run_id: 'r2', kind: 'confirm', ask: 'Video playback is live. Say if right' })
    expect(s.list({ state: 'new' }).map(r => r.ask)).toEqual(['Video playback is live. Say if right'])
    expect(s.fileRun({ thread: 't1', run_id: 'r3', kind: 'needs_you', ask: 'x' })).toBeNull()
    // The signal sweep counts it under Later, never as a Waiting item.
    const plan = planSweep(s.list())
    expect(plan.waiting).toHaveLength(0)
    expect(plan.later.map(r => r.kind)).toEqual(['confirm'])
  })
  it('SentLog quiet runs and the notify row survive a restart', () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-log-')); dirs.push(d)
    const log = new SentLog(join(d, 'sent-log.json'))
    const row = log.reply({ thread: 't1', text: 'let me know when done', run_key: 'k1', wants_reply: true })!
    log.update(row.id, { notify_when_done: true })
    expect(log.pendingNotify('t1')?.id).toBe(row.id)
    log.update(row.id, { notified_run: 'wizardq_1' })
    log.markQuiet('t1', ['wizardq_2'])
    const again = new SentLog(join(d, 'sent-log.json'))
    expect(again.pendingNotify('t1')).toBeNull()
    expect(again.notifiedBy('t1', 'wizardq_1')).toBe(true)
    expect(again.quietRun('t1', 'wizardq_2')).toBe(true)
    expect(again.quietRun('t1', 'wizardq_1')).toBe(false)
    expect(again.ownerRowsForRun('t1', '', 'k1')).toHaveLength(1)
  })
})
