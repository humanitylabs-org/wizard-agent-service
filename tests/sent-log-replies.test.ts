// wizard-ux issue 1808: with the quiet inbox on (wizard/agent-inbox), every message the owner sends inside an existing
// thread gets a Sent row (source reply, the thread id, route thread), written before the agent runs. Where the answer
// goes follows the reply rules: a statement or confirmation ("Sent to Miguel, done") answered done/fyi stays out of
// Inbox/Ready (the list row says wizard_quiet_reply, the Sent row is Done with the agent's one-line answer); a question
// ("is the mac app ready?") or an answer that is needs_you / check / failed goes to Inbox as today. Switch off: no
// reply row and no quiet flag.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SentLog } from '../server/sent-log.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { try { s.closeAllConnections?.() } catch {} s.close(() => r()) })))
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const readBody = (req: IncomingMessage) => new Promise<any>(resolve => { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : null) } catch { resolve(null) } }) })
const status = (state: string, ask: string) => `[WIZARD_STATUS_V1]${JSON.stringify({ state, ask })}[/WIZARD_STATUS_V1]`

// A Hermes that answers each run with the reply `answer(input)` gives.
const control = { acceptSteer: true, holding: new Set<string>() }
async function fakeHermes(answer: (input: string) => string | null) {
  control.acceptSteer = true; control.holding.clear()
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
  const d = mkdtempSync(join(tmpdir(), 'sent-replies-')); dirs.push(d)
  writeFileSync(join(d, 'settings.json'), '{}')
  const hermes = await fakeHermes(answer)
  const s = createWizardServer({ wizardOsHome: d, settingsPath: join(d, 'settings.json'), requireAccess: false, hermesKey: ['fixture', 'key', '1808'].join('-'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
    upstreamOrigin: hermes.origin, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 20, agentInboxStatePath: join(d, 'agent-inbox.json'), ...extra })
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
// The James case (25 Nov): first a question that opened the thread, then his update in it.
const answers = (input: string) => {
  if (/Sent to Miguel/.test(input)) return `Great, the clip edit is with Miguel now. Nothing needed from you.\n${status('fyi', 'Clip edit is with Miguel. Nothing needed from you.')}`
  if (/mac app ready/.test(input)) return `Not yet, the build is still running.\n${status('fyi', 'The Mac app build is still running.')}`
  if (/approve/.test(input)) return `Ready to ship.\n${status('needs_you', 'Phone update is ready. Reply ship to send it')}`
  if (/explode/.test(input)) return null
  return `Looked into the clips edit failure.\n${status('done', 'The clips edit failed on a codec; fixed.')}`
}

describe('issue 1808: replies typed in a thread', { timeout: 30_000 }, () => {
  it('a reply gets a Sent row written before the agent runs; "Sent to Miguel, done" answered fyi stays out of Inbox', async () => {
    const { base, d } = await box(answers, { agentInbox: true })
    const thread = 'wizard_clips_1'
    expect((await send(base, thread, 'Why did the clips edit fail?', 'out-1')).status).toBe(202)
    await until(() => sent(base), rows => rows.length === 1 && rows[0].state === 'done')
    expect((await send(base, thread, 'Sent to Miguel, done', 'out-2')).status).toBe(202)
    // Written at admission: on disk before the run's answer is read.
    const disk = JSON.parse(readFileSync(join(d, 'sent-log.json'), 'utf8')).rows
    expect(disk[0]).toMatchObject({ source: 'reply', thread_id: thread, route: 'thread', text: 'Sent to Miguel, done', wants_reply: false })
    const rows = await until(() => sent(base), r => r[0]?.source === 'reply' && r[0]?.state === 'done')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ source: 'reply', thread_id: thread, route: 'thread', decided_by: 'owner_words', state: 'done', quiet: true,
      answer: 'Clip edit is with Miguel. Nothing needed from you.' })
    expect(rows[1]).toMatchObject({ source: 'typed', thread_id: thread })
    // The list row tells every client the newest answer needs nothing: no Ready, no unread dot.
    const row = await until(() => listRow(base, thread), r => r?.wizard_quiet_reply === true)
    expect(row?.wizard_quiet_reply).toBe(true)
    // The shell's own list read (view=list): the same fact as quietReply.
    const slim = await (await fetch(`${base}/wizard/hermes/api/sessions?view=list&window=archive-50&limit=100&offset=0&include_children=false`)).json()
    expect((slim.data || slim.sessions || []).find((x: any) => x.id === thread)).toMatchObject({ quietReply: true })
    // A question after it brings the thread back: the newest answer is for him.
    await send(base, thread, 'what did Miguel say?', 'out-3')
    await until(() => sent(base), r => r[0]?.text === 'what did Miguel say?' && r[0]?.state === 'done')
    await new Promise(r => setTimeout(r, 300))
    expect((await listRow(base, thread))?.wizard_quiet_reply).toBeUndefined()
  })

  it('a question in the thread ("is the mac app ready?") answered fyi still goes to Inbox', async () => {
    const { base } = await box(answers, { agentInbox: true })
    const thread = 'wizard_mac_1'
    await send(base, thread, 'Build the mac app', 'q-1')
    await until(() => sent(base), rows => rows[0]?.state === 'done')
    await send(base, thread, 'is the mac app ready?', 'q-2')
    const rows = await until(() => sent(base), r => r[0]?.source === 'reply' && r[0]?.state === 'done')
    expect(rows[0]).toMatchObject({ source: 'reply', route: 'thread', wants_reply: true, state: 'done', quiet: false })
    await new Promise(r => setTimeout(r, 200))
    expect((await listRow(base, thread))?.wizard_quiet_reply).toBeUndefined()
  })

  it('needs_you, or a failed run, always goes to Inbox whatever the owner wrote', async () => {
    const { base } = await box(answers, { agentInbox: true })
    await send(base, 'wizard_t_a', 'Start the phone release', 'a-1')
    await until(() => sent(base), rows => rows[0]?.state === 'done')
    await send(base, 'wizard_t_a', 'ok, approve it when ready', 'a-2')
    const a = await until(() => sent(base), r => r[0]?.source === 'reply' && r[0]?.state !== 'running' && r[0]?.state !== 'unknown')
    expect(a[0]).toMatchObject({ wants_reply: false, state: 'needs_you', quiet: false })
    await send(base, 'wizard_t_a', 'thanks, explode', 'a-3')
    const b = await until(() => sent(base), r => r[0]?.text === 'thanks, explode' && r[0]?.state === 'failed')
    expect(b[0]).toMatchObject({ state: 'failed', quiet: false })
    await new Promise(r => setTimeout(r, 200))
    expect((await listRow(base, 'wizard_t_a'))?.wizard_quiet_reply).toBeUndefined()
  })

  it('a steer while the turn runs is a reply row on that run once Hermes takes it; a refused steer leaves none', async () => {
    const { base } = await box(answers, { agentInbox: true })
    const thread = 'wizard_steer_1'
    await send(base, thread, 'Why did the clips edit fail?', 's-1')
    await until(() => sent(base), rows => rows[0]?.state === 'done')
    const admitted = await (await send(base, thread, 'thanks, start the long job', 's-2')).json()
    const runId = admitted.run_id || admitted.id
    await until(() => sent(base), r => r[0]?.source === 'reply' && r[0]?.state === 'running')
    const steer = (text: string, key: string) => fetch(`${base}/wizard/hermes/v1/runs/${runId}/steer`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ input: text }) })
    control.acceptSteer = false
    expect((await steer('also do the audio', 'st-1')).status).toBe(200)
    expect((await sent(base)).filter(r => r.text === 'also do the audio')).toHaveLength(0)
    control.acceptSteer = true
    expect((await steer('and tell me when?', 'st-2')).status).toBe(200)
    const rows = await sent(base)
    expect(rows[0]).toMatchObject({ source: 'reply', route: 'thread', text: 'and tell me when?', wants_reply: true, state: 'running' })
  })

  it('switch off: no reply row, no quiet flag (unchanged from today)', async () => {
    const { base, d } = await box(answers)
    await send(base, 'wizard_off_1', 'Why did the clips edit fail?', 'o-1')
    await send(base, 'wizard_off_1', 'Sent to Miguel, done', 'o-2')
    await new Promise(r => setTimeout(r, 400))
    expect((await fetch(`${base}/wizard/v1/sent`)).status).toBe(404)
    expect(existsSync(join(d, 'sent-log.json'))).toBe(false)
    expect((await listRow(base, 'wizard_off_1'))?.wizard_quiet_reply).toBeUndefined()
  })
})

describe('SentLog.reply (store)', () => {
  it('one row per run key; the outcome is kept once; a new key in the thread is a new row', () => {
    const log = new SentLog('')
    const a = log.reply({ thread: 't1', text: 'Sent to Miguel, done', run_key: 'k1', wants_reply: false })!
    expect(log.reply({ thread: 't1', text: 'Sent to Miguel, done', run_key: 'k1', wants_reply: false })!.id).toBe(a.id)
    expect(log.reply({ thread: 't1', text: 'thanks', run_key: 'k2', wants_reply: false })!.id).not.toBe(a.id)
    log.update(a.id, { run_id: 'wizardq_1' })
    expect(log.noteRun({ thread: 't1', run_id: 'wizardq_1', state: 'fyi', answer: 'Nothing needed.' })).toHaveLength(1)
    expect(log.get(a.id)).toMatchObject({ outcome: { state: 'fyi', answer: 'Nothing needed.' } })
    // Read again (the poller): kept as it was.
    expect(log.noteRun({ thread: 't1', run_id: 'wizardq_1', state: 'failed', answer: '' })).toHaveLength(0)
    expect(log.quietFor('t1', 'wizardq_1')).toBe(true)
    expect(log.quietFor('t1', 'wizardq_2')).toBe(false)
  })
})
