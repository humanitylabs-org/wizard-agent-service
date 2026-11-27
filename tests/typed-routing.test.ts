// Issue 669 (Smart inbox, owner switch wizard/smart-inbox, off by default): typed messages can go quiet too. The Sent log
// judges each typed message's shadow guess against what the owner did and serves the match rate; once 90% of at least
// 50 judged background guesses were right, a typed task with no reply phrase runs in the background like an orb dump.
// Reply phrases, a question, "let me know when" and anything unclear stay visible. Switch off: nothing changes.
// Synthetic threads only.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { keepsVisible, typedGuessOf, judgeTyped, typedMatch, TYPED_SETTLE_MS } from '../server/typed-routing.mjs'
import { SentLog } from '../server/sent-log.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { try { s.closeAllConnections?.() } catch {} s.close(() => r()) })))
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const HOUR = 3600_000, NOW = Date.UTC(2026, 10, 27, 12, 0, 0)
const readBody = (req: IncomingMessage) => new Promise<any>(resolve => { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : null) } catch { resolve(null) } }) })
const status = (state: string, ask: string) => `[WIZARD_STATUS_V1]${JSON.stringify({ state, ask })}[/WIZARD_STATUS_V1]`

async function fakeHermes() {
  const rows = new Map<string, any>(), messages = new Map<string, any[]>(), outputs = new Map<string, string>(), patches: any[] = []
  let runs = 0
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = await readBody(req)
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/v1/capabilities') return json(200, { features: {} })
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, { data: [...rows.values()].filter(r => !r.hidden) })
    if (req.method === 'POST' && url.pathname === '/api/sessions') { rows.set(body.id, { id: body.id, title: body.title || '', source: 'api_server', archived: false, started_at: Date.now() / 1000 }); return json(201, { session: rows.get(body.id) }) }
    const one = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'PATCH' && one) { patches.push({ id: decodeURIComponent(one[1]), ...body }); const row = rows.get(decodeURIComponent(one[1])); if (row) Object.assign(row, body); return json(200, { session: row ?? {} }) }
    if (req.method === 'GET' && one) { const row = rows.get(decodeURIComponent(one[1])); return row ? json(200, { session: row }) : json(404, { error: 'not found' }) }
    const msgs = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'GET' && msgs) return json(200, { object: 'list', data: messages.get(decodeURIComponent(msgs[1])) ?? [] })
    if (req.method === 'POST' && url.pathname === '/v1/runs') {
      runs += 1
      const id = body.session_id, input = typeof body.input === 'string' ? body.input : JSON.stringify(body.input)
      const t = Date.now() / 1000
      if (!rows.has(id)) rows.set(id, { id, title: '', source: 'api_server', archived: false, started_at: t })
      const out = `Done.\n${status('done', 'Synthetic task done.')}`
      const list = messages.get(id) ?? []
      list.push({ id: list.length + 1, session_id: id, role: 'user', content: input, timestamp: t }, { id: list.length + 2, session_id: id, role: 'assistant', content: out, timestamp: t + 0.5 })
      messages.set(id, list)
      Object.assign(rows.get(id), { message_count: list.length, last_active: t + 0.5, preview: input })
      const runId = `run-${runs}`
      outputs.set(runId, out)
      return json(202, { run_id: runId, status: 'started' })
    }
    const run = url.pathname.match(/^\/v1\/runs\/([^/]+)$/)
    if (req.method === 'GET' && run) return json(200, { run_id: run[1], status: 'completed', output: outputs.get(run[1]) ?? '' })
    json(404, { error: 'nope' })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  servers.push(server)
  return { origin: `http://127.0.0.1:${(server.address() as any).port}`, rows, patches, runs: () => runs }
}

const look = (d: string, on: boolean) => { const p = join(d, 'files', 'Pages', 'wizard-look'); mkdirSync(p, { recursive: true }); writeFileSync(join(p, 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { 'wizard/smart-inbox': { on, at: Date.now() } } })) }
const id = () => `sent_${randomUUID().replaceAll('-', '').slice(0, 24)}`
// A recorded set of typed messages (synthetic): `right` background guesses he left alone for a day, `wrong` ones he
// replied in, and some visible guesses (questions) he did reply in.
function recorded({ right = 0, wrong = 0, questions = 0, blockers = 0 } = {}) {
  const rows: any[] = []
  let n = 0
  const typed = (text: string, would: string, outcome: string) => {
    n += 1
    const at = NOW - 48 * HOUR - n * 60_000, thread = `wizard_rec_${n}`
    rows.push({ id: id(), idempotency_key: null, at, source: 'typed', agent: 'hermes', text, route: 'agent', decided_by: 'owner_words', rules_matched: ['typed'], model: '', tags: [], urgent: false,
      correction_id: null, thread_id: thread, record_id: null, run_key: `rec-${n}`, routed_at: at, would_route: would, would_decided_by: 'owner_words', would_rules: ['task_verb'],
      outcome: { state: outcome, answer: 'Synthetic answer', at: at + 60_000 } })
    return thread
  }
  const reply = (thread: string) => rows.push({ id: id(), idempotency_key: null, at: NOW - 40 * HOUR, source: 'reply', agent: 'hermes', text: 'Synthetic follow-up', route: 'thread', decided_by: 'owner_words',
    rules_matched: ['statement'], model: '', tags: [], urgent: false, correction_id: null, thread_id: thread, record_id: null, run_key: `rep-${thread}`, run_id: null, routed_at: NOW - 40 * HOUR, wants_reply: false })
  for (let k = 0; k < right; k++) typed(`Research synthetic topic ${k}`, 'dump', 'done')
  for (let k = 0; k < wrong; k++) reply(typed(`Plan synthetic trip ${k}`, 'dump', 'done'))
  for (let k = 0; k < questions; k++) reply(typed(`What is synthetic fact ${k}?`, 'agent', 'done'))
  for (let k = 0; k < blockers; k++) reply(typed(`Book synthetic table ${k}`, 'dump', 'needs_you'))
  return rows.sort((a, b) => b.at - a.at)
}

async function box({ on = true, rows = [] as any[], extra = {} as any } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'typed-routing-')); dirs.push(d)
  look(d, on)
  writeFileSync(join(d, 'settings.json'), '{}')
  writeFileSync(join(d, 'sent-log.json'), JSON.stringify({ schema: 1, rows, check: null }))
  const hermes = await fakeHermes()
  const s = createWizardServer({ wizardOsHome: d, settingsPath: join(d, 'settings.json'), requireAccess: false, hermesKey: ['fixture', 'key', '669'].join('-'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
    upstreamOrigin: hermes.origin, pagesRoot: join(d, 'files', 'Pages'), pagesGitDir: join(d, 'pages.git'), pagesWatch: false, smartInboxTtlMs: 0, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 20,
    agentInbox: true, agentInboxStatePath: join(d, 'agent-inbox.json'), agentInboxNow: () => NOW, ...extra })
  servers.push(s)
  const base = `http://127.0.0.1:${((await listen(s)) as any).port}`
  return { d, base, hermes }
}
const route = (base: string, text: string, extra: any = {}) => fetch(`${base}/wizard/v1/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, timezone: 'UTC', source: 'typed', accept_dump: true, ...extra }) })
const sentPage = async (base: string) => (await (await fetch(`${base}/wizard/v1/sent?limit=200`)).json())
const records = async (base: string) => (await (await fetch(`${base}/wizard/v1/agent-inbox`)).json()).records as any[]

describe('issue 669: the typed rule', () => {
  it('reply phrases, a question and "let me know when" always keep a typed message visible', () => {
    for (const t of ['Reply when you have looked at the budget', 'Tell me what you find about flights', 'Research flights to Lisbon?', 'Research flights, let me know when it is done', 'Hi there', 'what time is it in Tokyo'])
      expect(keepsVisible(t), t).not.toBe('')
    for (const t of ['Research flights to Lisbon for March', 'Draft a reply to Sam about Friday', 'Remind me to call the bank tomorrow', 'note to self: renew the passport'])
      expect(keepsVisible(t), t).toBe('')
  })
  it('the guess on a row: a reply phrase beats the router, unclear is visible, not classified yet is no guess', () => {
    expect(typedGuessOf({ source: 'typed', text: 'Research flights', would_route: 'dump' })).toBe('background')
    expect(typedGuessOf({ source: 'typed', text: 'Research flights and tell me', would_route: 'dump' })).toBe('visible')
    expect(typedGuessOf({ source: 'typed', text: 'Hmm the garden', would_route: null, would_decided_by: 'fallback' })).toBe('visible')
    expect(typedGuessOf({ source: 'typed', text: 'Hmm the garden' })).toBeNull()
    expect(typedGuessOf({ source: 'typed', text: 'Research flights', route: 'dump' })).toBe('background')
    expect(typedGuessOf({ source: 'orb', text: 'Research flights', would_route: 'dump' })).toBeNull()
  })
  it('the judge: his correction first, a blocker is neutral, a reply means visible, a day left alone means background', () => {
    const row = { source: 'typed', text: 'Research flights', would_route: 'dump', at: NOW - 30 * HOUR }
    const done = { state: 'done', at: NOW - 29 * HOUR }
    expect(judgeTyped({ ...row, corrected: { should_reply: true } }, { ended: done, now: NOW })?.verdict).toBe('miss')
    expect(judgeTyped({ ...row, corrected: { should_reply: false } }, { ended: done, replied: true, now: NOW })?.verdict).toBe('match')
    expect(judgeTyped(row, { ended: { state: 'needs_you', at: NOW - 29 * HOUR }, replied: true, now: NOW })?.verdict).toBe('neutral')
    expect(judgeTyped(row, { ended: done, replied: true, now: NOW })?.verdict).toBe('miss')
    expect(judgeTyped(row, { ended: done, now: NOW })?.verdict).toBe('match')
    expect(judgeTyped(row, { ended: { state: 'done', at: NOW - 2 * HOUR }, now: NOW })?.verdict).toBe('pending')
    expect(judgeTyped(row, { ended: { state: 'check', at: NOW - 29 * HOUR }, now: NOW })?.verdict).toBe('match')
    expect(judgeTyped(row, { now: NOW })?.verdict).toBe('pending')
    expect(TYPED_SETTLE_MS).toBe(24 * HOUR)
  })
  it('the gate: 90% of at least 50 judged background guesses; visible guesses are reported but do not gate', () => {
    const ctx = (row: any) => ({ ended: row.outcome, replied: row.replied === true })
    const make = (n: number, wrong: number) => Array.from({ length: n }, (_, k) => ({ id: `r${k}`, source: 'typed', text: `Research topic ${k}`, would_route: 'dump', at: NOW - 30 * HOUR,
      outcome: { state: 'done', at: NOW - 29 * HOUR }, replied: k < wrong }))
    expect(typedMatch(make(49, 0), ctx, { now: NOW }).graduated).toBe(false)
    const fifty = typedMatch(make(50, 5), ctx, { now: NOW })
    expect([fifty.background.judged, fifty.background.matched, fifty.background.rate, fifty.graduated]).toEqual([50, 45, 0.9, true])
    expect(typedMatch(make(50, 6), ctx, { now: NOW }).graduated).toBe(false)
    const questions = Array.from({ length: 20 }, (_, k) => ({ id: `q${k}`, source: 'typed', text: `What is ${k}?`, would_route: 'agent', at: NOW - 30 * HOUR, outcome: { state: 'done', at: NOW - 29 * HOUR } }))
    const mixed = typedMatch([...make(50, 0), ...questions], ctx, { now: NOW })
    expect(mixed.visible).toMatchObject({ judged: 20, matched: 0 })
    expect(mixed.all).toMatchObject({ judged: 70, matched: 50 })
    expect(mixed.graduated).toBe(true)
  })
  it('a typed row keeps its first run outcome (it is how the guess is judged)', () => {
    const log = new SentLog('')
    const row = log.typed({ thread: 'wizard_t1', text: 'Research flights', run_key: 'k1' })!
    expect(log.noteRun({ thread: 'wizard_t1', run_id: 'wizardq_1', run_key: 'k1', state: 'done', answer: 'Flights found' })).toHaveLength(1)
    expect(log.get(row.id)).toMatchObject({ outcome: { state: 'done', answer: 'Flights found' }, run_id: 'wizardq_1' })
    expect(log.all().map(r => r.id)).toEqual([row.id])
  })
})

describe('issue 669: typed messages on the box', { timeout: 60_000 }, () => {
  it('measures: the recorded set shows the routed / visible split and the match rate (Sent log and /sent/typed)', async () => {
    const { base } = await box({ rows: recorded({ right: 46, wrong: 4, questions: 10, blockers: 3 }) })
    const page = await sentPage(base)
    expect(page.typed_routing).toMatchObject({ on: true, switch: true, graduated: true, typed: 63, neutral: 3, pending: 0,
      background: { judged: 50, matched: 46, rate: 0.92 }, visible: { judged: 10, matched: 10, rate: 1 }, all: { judged: 60, matched: 56 }, gate: { min: 50, rate: 0.9 } })
    const wrong = page.rows.find((r: any) => r.text === 'Plan synthetic trip 0')
    expect(wrong).toMatchObject({ typed_guess: 'background', typed_verdict: 'miss', outcome: 'done' })
    expect(page.rows.find((r: any) => r.text === 'Research synthetic topic 0')).toMatchObject({ typed_guess: 'background', typed_verdict: 'match' })
    expect(page.rows.find((r: any) => r.text === 'Book synthetic table 0')).toMatchObject({ typed_verdict: 'neutral' })
    const alone = await (await fetch(`${base}/wizard/v1/sent/typed`)).json()
    expect(alone.typed_routing.background).toEqual(page.typed_routing.background)
  })

  it('graduated: a typed task runs in the background (record, hidden worker, Sent row route dump); reply phrases, questions, "let me know when" and unclear stay visible', async () => {
    const { base, hermes } = await box({ rows: recorded({ right: 50 }) })
    let r = await route(base, 'Research flights to Lisbon for March', { idempotency_key: 'typed-1' })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.cmd).toMatchObject({ route: 'dump', title: 'Research flights to Lisbon for March' })
    expect(j.cmd.record_id).toMatch(/^inbox_[a-f0-9]{24}$/)
    expect(j.typed).toEqual({ background: true })
    const all = await records(base)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ source: 'typed:dump', thread_id: j.cmd.thread_id })
    // The worker started on the hidden thread, as an orb dump does.
    for (let n = 0; n < 80 && !hermes.patches.some(p => p.id === j.cmd.thread_id && p.hidden === true); n++) await new Promise(res => setTimeout(res, 25))
    expect(hermes.patches.some(p => p.id === j.cmd.thread_id && p.hidden === true)).toBe(true)
    const row = (await sentPage(base)).rows.find((x: any) => x.id === j.sent_id)
    expect(row).toMatchObject({ source: 'typed', route: 'dump', record_id: j.cmd.record_id, thread_id: j.cmd.thread_id, would_route: 'dump', typed_guess: 'background' })
    // The same send replayed (a reload): one task, one row.
    const again = await (await route(base, 'Research flights to Lisbon for March', { idempotency_key: 'typed-1' })).json()
    expect(again.cmd.record_id).toBe(j.cmd.record_id)
    expect((await sentPage(base)).rows.filter((x: any) => x.route === 'dump')).toHaveLength(1)
    // Ask 3: these stay visible, with no row and no record.
    for (const [text, why] of [['Research flights to Porto and tell me what you find', 'wants_reply:tell me'], ['Research flights to Porto?', 'question'],
      ['Research flights to Porto, let me know when it is done', 'notify_when_done'], ['The garden this weekend', 'unclear']]) {
      const k = await (await route(base, text)).json()
      expect(k.cmd, text).toEqual({ route: 'agent', summary: text })
      expect(k.typed, text).toEqual({ background: false, why })
    }
    expect(await records(base)).toHaveLength(1)
  })

  it('"Should have replied" on a typed task that went to the background opens its thread and counts as a miss', async () => {
    const { base, hermes } = await box({ rows: recorded({ right: 50 }) })
    const j = await (await route(base, 'Compare phone plans for the family')).json()
    expect(j.cmd.route).toBe('dump')
    for (let n = 0; n < 80 && !hermes.rows.has(j.cmd.thread_id); n++) await new Promise(res => setTimeout(res, 25))
    const fixed = await fetch(`${base}/wizard/v1/sent/${j.sent_id}/correct`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ should_reply: true }) })
    expect(fixed.status).toBe(200)
    expect((await fixed.json()).changed).toBe(true)
    expect(hermes.patches.some(p => p.id === j.cmd.thread_id && p.hidden === false)).toBe(true)
    const page = await sentPage(base)
    expect(page.rows.find((x: any) => x.id === j.sent_id)).toMatchObject({ typed_verdict: 'miss' })
    expect(page.typed_routing.background).toMatchObject({ judged: 51, matched: 50 })
  })

  it('not proven yet (49 of 50) or a bad rate: typed tasks stay visible, the numbers say why', async () => {
    const few = await box({ rows: recorded({ right: 49 }) })
    let k = await (await route(few.base, 'Research flights to Lisbon for March')).json()
    expect(k).toMatchObject({ cmd: { route: 'agent' }, typed: { background: false, why: 'not_proven' } })
    expect((await sentPage(few.base)).typed_routing).toMatchObject({ on: false, switch: true, graduated: false, background: { judged: 49 } })
    const bad = await box({ rows: recorded({ right: 44, wrong: 6 }) })
    k = await (await route(bad.base, 'Research flights to Lisbon for March')).json()
    expect(k.typed.why).toBe('not_proven')
    expect(await records(bad.base)).toHaveLength(0)
  })

  it('switch off: a typed send asked about stays visible, nothing is captured, the rest of the route is today\'s', async () => {
    const { base, hermes } = await box({ on: false, rows: recorded({ right: 60 }) })
    const k = await (await route(base, 'Research flights to Lisbon for March')).json()
    expect(k).toMatchObject({ cmd: { route: 'agent', summary: 'Research flights to Lisbon for March' }, typed: { background: false, why: 'switch_off' } })
    expect(await records(base)).toHaveLength(0)
    expect(hermes.runs()).toBe(0)
    const page = await sentPage(base)
    expect(page.typed_routing).toMatchObject({ on: false, switch: false, graduated: true })
    expect(page.rows.some((r: any) => r.route === 'dump')).toBe(false)
    // An orb take (no source typed) routes exactly as before: no router configured is the 404 it always was.
    const orb = await fetch(`${base}/wizard/v1/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Research flights', accept_dump: true }) })
    expect(orb.status).toBe(404)
  })

  it('a typed message the shell sends as today (a visible thread) keeps its first run outcome on its Sent row', async () => {
    const { base } = await box({ rows: [] })
    await fetch(`${base}/wizard/hermes/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'wizard_typed_live' }) })
    await fetch(`${base}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'live-1' }, body: JSON.stringify({ session_id: 'wizard_typed_live', input: 'Research flights to Lisbon for March' }) })
    let row: any
    for (let n = 0; n < 160; n++) {
      await fetch(`${base}/wizard/hermes/api/sessions?limit=50`)
      row = (await sentPage(base)).rows.find((x: any) => x.thread_id === 'wizard_typed_live')
      if (row?.outcome) break
      await new Promise(res => setTimeout(res, 50))
    }
    expect(row).toMatchObject({ source: 'typed', would_route: 'dump', outcome: 'done', typed_guess: 'background', typed_verdict: 'pending' })
  })
})
