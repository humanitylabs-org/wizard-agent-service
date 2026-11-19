// Issue 569: an app (Messenger's Agent chat) is a second door to the box's one agent inbox. Its own app token opens
// capture, sweep, answer / Yes to all on its own card, the door probe and pings; a sweep from any door is one event.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentInboxStore, SWEEP_SHARE_MS, appDoor, recordApp } from '../server/agent-inbox.mjs'
import { appForToken } from '../server/app-bindings.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const home = () => { const d = mkdtempSync(join(tmpdir(), 'agent-inbox-doors-')); dirs.push(d); return d }
const line = (value: any) => `Reply text\n[WIZARD_STATUS_V1]${JSON.stringify(value)}[/WIZARD_STATUS_V1]`
// Each read of the clock moves it on 1 ms, so records keep their creation order.
const clock = (start = Date.parse('2026-11-19T10:00:00Z')) => { const c = { at: start, now: () => c.at++ }; return c }
let seq = 0
const waiting = (s: any, extra: any = {}, capture: any = {}) => {
  const thread = `wizard_worker_${++seq}`
  const r = s.capture({ thread_id: thread, title: `Synthetic ask ${seq}`, ask: `Synthetic question ${seq}`, ...capture }).record
  s.noteRun('hermes', thread, { id: `run_${seq}`, status: 'completed', output: line({ state: 'needs_you', ask: `Synthetic question ${seq}`,
    recommendation: `Say yes to synthetic ask ${seq}.`, options: { yes: `Yes: go ahead with synthetic ask ${seq}.`, no: `No: leave synthetic ask ${seq}.` }, default_option: 'yes', ...extra }) })
  return s.get(r.id)
}
const done = (s: any) => {
  const thread = `wizard_worker_${++seq}`
  const r = s.capture({ thread_id: thread, title: `Synthetic job ${seq}`, ask: `Synthetic job ${seq}` }).record
  s.noteRun('hermes', thread, { id: `run_${seq}`, status: 'completed', output: line({ state: 'done', ask: `Synthetic job ${seq} finished` }) })
  return s.get(r.id)
}

describe('one sweep event across doors (store)', () => {
  it('Daily then Messenger draw the same card: same items and counts, each item seen once, Done archived once', () => {
    const c = clock(), s = new AgentInboxStore('', { now: c.now, log: () => undefined })
    const w = waiting(s), d = done(s)
    const daily = s.drawSweep({ door: 'daily', thread_id: 'wizard_daily_1', day: '2026-11-19' })
    const messenger = s.drawSweep({ door: appDoor('messenger') })
    expect([daily.shared, messenger.shared]).toEqual([false, true])
    expect(messenger.card.id).toBe(daily.card.id)
    expect(messenger.card.doors).toEqual(['daily', 'app:messenger'])
    const pick = (card: any) => ({ waiting: card.waiting.items.map((i: any) => [i.id, i.seen]), done: card.done.items.map((i: any) => i.id), running: card.running, later: card.later, parked: card.parked })
    expect(pick(s.sweepView(messenger.card))).toEqual(pick(s.sweepView(daily.card)))
    expect(pick(daily.card).waiting).toEqual([[w.id, 1]])
    expect(pick(daily.card).done).toEqual([d.id])
    expect(s.get(w.id)).toMatchObject({ state: 'surfaced', surfaced_count: 1 })
    // The same door again is a new sweep event: seen goes to 2 once, and the archived Done item is gone.
    const again = s.drawSweep({ door: appDoor('messenger') })
    expect(again.shared).toBe(false)
    expect(again.card.waiting.items.map((i: any) => i.seen)).toEqual([2])
    expect(again.card.done.items).toEqual([])
    // Daily draws Messenger's newer card within the window and gives it today's thread (where the card row shows).
    const dailyAgain = s.drawSweep({ door: 'daily', thread_id: 'wizard_daily_1', day: '2026-11-19' })
    expect([dailyAgain.shared, dailyAgain.card.id]).toEqual([true, again.card.id])
    expect(s.latestSweep({ thread: 'wizard_daily_1' })?.id).toBe(again.card.id)
    expect(s.get(w.id)?.surfaced_count).toBe(2)
  })

  it('after the share window a door that has not drawn the card still gets a new sweep', () => {
    const c = clock(), s = new AgentInboxStore('', { now: c.now, log: () => undefined })
    waiting(s)
    const first = s.drawSweep({ door: 'daily', thread_id: 'wizard_daily_1' })
    c.at += SWEEP_SHARE_MS
    const later = s.drawSweep({ door: appDoor('messenger') })
    expect(later.shared).toBe(false)
    expect(later.card.id).not.toBe(first.card.id)
  })

  it('an app door answers only items on a card it drew and never another app\'s record', () => {
    const c = clock(), s = new AgentInboxStore('', { now: c.now, log: () => undefined })
    const own = waiting(s), mail = waiting(s, {}, { source: { app: 'wizard-mail', item: 'acct:1' } })
    const door = appDoor('messenger')
    expect(s.doorMayAnswer(door, own.id)).toBe(false) // no card drawn yet
    s.drawSweep({ door })
    expect(recordApp(s.get(mail.id))).toBe('wizard-mail')
    expect(s.doorMayAnswer(door, own.id)).toBe(true)
    expect(s.doorMayAnswer(door, mail.id)).toBe(false)
    expect(s.doorMayAnswer(appDoor('wizard-mail'), mail.id)).toBe(false) // Mail never drew a card
    // Once it is no longer waiting (answered, parked, archived), a door never answers or reopens it again.
    s.patch(own.id, { action: 'answer', option: 'yes' })
    expect(s.doorMayAnswer(door, own.id)).toBe(false)
  })

  it('pings: only alerts delivered after the door asked, each once per door, and they survive a restart', () => {
    const d = home(), path = join(d, 'agent-inbox.json'), c = clock()
    const s = new AgentInboxStore(path, { now: c.now, log: () => undefined })
    const alert = (n: number) => s.captureAlertUnderCap('2026-11-19', 10, { thread_id: `alert_${n}`, title: `Synthetic alert ${n}`, ask: `Synthetic alert ${n}`, severity: 'urgent' })
    alert(1)
    const door = appDoor('messenger')
    expect(s.takePings(door)).toEqual([]) // never registered
    expect(s.registerDoor(door, { pings: true })).toMatchObject({ pings: true })
    alert(2)
    const first = s.takePings(door)
    expect(first.map((p: any) => p.title)).toEqual(['Synthetic alert 2'])
    expect(s.takePings(door)).toEqual([])
    alert(3)
    const again = new AgentInboxStore(path, { now: c.now, log: () => undefined })
    expect(again.takePings(door).map((p: any) => p.title)).toEqual(['Synthetic alert 3'])
    expect(again.takePings(door)).toEqual([])
    expect(again.registerDoor(door, { pings: false })).toMatchObject({ pings: false })
    alert(4)
    expect(again.takePings(door)).toEqual([])
    expect(() => again.registerDoor('daily', { pings: true })).toThrow()
  })

  it('pings stay pending until the door acks them, so a crash between read and store never loses one (issue 325)', () => {
    const d = home(), path = join(d, 'agent-inbox.json'), c = clock()
    const s = new AgentInboxStore(path, { now: c.now, log: () => undefined })
    const door = appDoor('messenger')
    s.registerDoor(door, { pings: true })
    s.captureAlertUnderCap('2026-11-19', 10, { thread_id: 'alert_a', title: 'Synthetic alert A', ask: 'Synthetic alert A', severity: 'urgent' })
    const read = s.pendingPings(door)
    expect(read.map((p: any) => p.title)).toEqual(['Synthetic alert A'])
    // The door crashes before it stores the ping: a fresh store (restart) still hands it out.
    const after = new AgentInboxStore(path, { now: c.now, log: () => undefined })
    expect(after.pendingPings(door).map((p: any) => p.id)).toEqual([read[0].id])
    // Stored now: the ack marks it, and it is never handed out again, also after a restart.
    expect(after.ackPings(door, [read[0].id, read[0].id, 'rec_unknown', 7])).toEqual([read[0].id])
    expect(after.pendingPings(door)).toEqual([])
    expect(after.ackPings(door, [read[0].id])).toEqual([])
    expect(new AgentInboxStore(path, { now: c.now, log: () => undefined }).pendingPings(door)).toEqual([])
    // Another door's ack never touches this door, and a door that never asked acks nothing.
    expect(after.ackPings(appDoor('wizard-mail'), [read[0].id])).toEqual([])
  })

  it('appForToken names the app whose token file matches, and nothing for a short or unknown bearer', () => {
    const d = home(), dir = join(d, 'app-tokens')
    mkdirSync(dir)
    writeFileSync(join(dir, 'messenger'), 'm'.repeat(43) + '\n')
    writeFileSync(join(dir, 'wizard-mail'), 'w'.repeat(43) + '\n')
    writeFileSync(join(dir, 'Bad Name'), 'x'.repeat(43))
    expect(appForToken(dir, 'm'.repeat(43))).toBe('messenger')
    expect(appForToken(dir, 'w'.repeat(43))).toBe('wizard-mail')
    expect(appForToken(dir, 'x'.repeat(43))).toBe('')
    expect(appForToken(dir, 'short')).toBe('')
    expect(appForToken(join(d, 'missing'), 'm'.repeat(43))).toBe('')
  })
})

describe('app doors over HTTP', () => {
  const MESSENGER = 'messenger-token-' + 'a'.repeat(30), MAIL = 'mail-token-' + 'b'.repeat(30)
  async function start(d: string, extra: any = {}, seed?: (s: AgentInboxStore) => void) {
    mkdirSync(join(d, 'app-tokens'), { recursive: true })
    writeFileSync(join(d, 'app-tokens', 'messenger'), `${MESSENGER}\n`)
    writeFileSync(join(d, 'app-tokens', 'wizard-mail'), `${MAIL}\n`)
    if (seed) seed(new AgentInboxStore(join(d, 'agent-inbox.json'), { log: () => undefined }))
    const calls: any[] = []
    const rows = new Map<string, any>()
    const upstream = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null
        const path = new URL(req.url || '/', 'http://x').pathname
        calls.push({ method: req.method, url: path, body })
        const send = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
        if (path === '/health') return send(200, { status: 'ok' })
        if (path === '/v1/capabilities') return send(200, { features: {} })
        if (req.method === 'POST' && path === '/api/sessions') { rows.set(body.id, { id: body.id, title: body.title || '' }); return send(201, { session: rows.get(body.id) }) }
        const one = /^\/api\/sessions\/([^/]+)$/u.exec(path)
        if (one) {
          const id = decodeURIComponent(one[1])
          if (!rows.has(id)) rows.set(id, { id, title: id })
          if (req.method === 'PATCH') Object.assign(rows.get(id), body)
          return send(200, { session: rows.get(id) })
        }
        if (req.method === 'POST' && path === '/v1/runs') return send(202, { run_id: `run_up_${calls.length}`, status: 'started' })
        if (/^\/v1\/runs\/[^/]+$/u.test(path)) return send(200, { run_id: path.split('/').at(-1), status: 'running' })
        send(404, { error: 'nope' })
      })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    servers.push(upstream)
    const port = (upstream.address() as any).port
    const s = createWizardServer({ wizardOsHome: d, requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false,
      upstreamOrigin: `http://127.0.0.1:${port}`, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, agentInboxStatePath: join(d, 'agent-inbox.json'), ...extra })
    servers.push(s); const a: any = await listen(s)
    return { u: `http://127.0.0.1:${a.port}/wizard/v1/agent-inbox`, calls, store: () => new AgentInboxStore(join(d, 'agent-inbox.json'), { log: () => undefined }) }
  }
  const json = (method: string, value: any, token = '') => ({ method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) })
  const get = (token = ''): RequestInit => (token ? { headers: { authorization: `Bearer ${token}` } } : {})
  const settle = () => new Promise(r => setTimeout(r, 150))

  it('switch off: every door route answers 404 and nothing is written', async () => {
    const d = home(), { u, calls } = await start(d)
    expect((await fetch(`${u}/doors`, get(MESSENGER))).status).toBe(404)
    expect((await fetch(`${u}/pings`, get(MESSENGER))).status).toBe(404)
    expect((await fetch(u, json('POST', { source: { app: 'messenger', item_id: 'note_1' }, text: 'Book the dentist' }, MESSENGER))).status).toBe(404)
    expect((await fetch(`${u}/sweep`, json('POST', { door: 'messenger' }, MESSENGER))).status).toBe(404)
    await settle()
    expect(calls).toEqual([])
    expect(existsSync(join(d, 'agent-inbox.json'))).toBe(false)
  })

  it('the door probe answers on with the sweep caps; a note is one hidden worker record, a resend the same record', async () => {
    const d = home(), { u, calls, store } = await start(d, { agentInbox: true })
    const probe = await fetch(`${u}/doors`, get(MESSENGER))
    expect([probe.status, await probe.json()]).toEqual([200, { on: true, sweep_caps: { waiting: 7, done: 10 }, door: 'messenger', pings: false }])
    const note = { source: { app: 'messenger', item_id: 'note_1' }, text: 'Book the dentist for next week' }
    const first = await fetch(u, json('POST', note, MESSENGER))
    expect(first.status).toBe(201)
    const made = (await first.json()).record
    expect(made).toMatchObject({ source: 'app:messenger/note_1', worker: true, state: 'running', agent: 'hermes' })
    await settle()
    expect(calls.some(c => c.method === 'PATCH' && c.url === `/api/sessions/${made.thread_id}` && c.body?.hidden === true)).toBe(true)
    const again = await fetch(u, json('POST', { ...note, text: 'Book the dentist (sent again)' }, MESSENGER))
    expect([again.status, (await again.json()).record.id]).toEqual([200, made.id])
    expect(store().list().filter(r => r.source.startsWith('app:messenger/'))).toHaveLength(1)
  })

  it('the app credential is refused on owner-only routes and as another app', async () => {
    const d = home(), { u } = await start(d, { agentInbox: true })
    for (const [path, init] of [[u, get(MESSENGER)], [`${u}/rules`, get(MESSENGER)], [`${u}/alert-log`, get(MESSENGER)],
      [`${u}/send`, json('POST', { thread_id: 'wizard_x' }, MESSENGER)], [`${u}/open`, json('POST', { thread_id: 'wizard_x' }, MESSENGER)]] as const) {
      const r = await fetch(path, init as any)
      expect([path, r.status, (await r.json()).error]).toEqual([path, 403, 'owner_only'])
    }
    const asMail = await fetch(u, json('POST', { source: { app: 'wizard-mail', item_id: 'n1' }, text: 'x' }, MESSENGER))
    expect([asMail.status, (await asMail.json()).error]).toEqual([403, 'wrong_app'])
    const eventAsMail = await fetch(`${u}/events`, json('POST', { type: 'mail', source: { app: 'wizard-mail', item: 'a:1' }, title: 'x' }, MESSENGER))
    expect(eventAsMail.status).toBe(403)
    const sweepAsMail = await fetch(`${u}/sweep`, json('POST', { door: 'wizard-mail' }, MESSENGER))
    expect(sweepAsMail.status).toBe(403)
    // A wrong bearer is no app: on this box-only test server it falls back to the box owner, as before.
    expect((await fetch(`${u}/doors`, get('not-a-token-' + 'z'.repeat(30)))).status).toBe(200)
    expect((await fetch(`${u}/doors`, json('POST', { pings: true }))).status).toBe(403)
  })

  it('Messenger sweeps and answers on the shared card; Yes to all never covers confirm items or another app\'s records', async () => {
    // Posting an answer's resume message into a thread is covered per runtime by the parity check agent-inbox-doors.
    const d = home()
    let confirm: any, mail: any, later: any
    const { u, store } = await start(d, { agentInbox: true }, s => {
      confirm = waiting(s, { confirm: true }); mail = waiting(s, {}, { source: { app: 'wizard-mail', item: 'acct:7' } }); later = waiting(s, { default_option: undefined })
    })
    // Before Messenger drew a card it may answer nothing.
    const early = await fetch(`${u}/${later.id}`, json('PATCH', { action: 'answer', option: 'later' }, MESSENGER))
    expect([early.status, (await early.json()).error]).toEqual([403, 'not_on_door_card'])
    const swept = await fetch(`${u}/sweep`, json('POST', { door: 'messenger' }, MESSENGER))
    expect(swept.status).toBe(201)
    const { card, shared } = await swept.json()
    expect(shared).toBe(false)
    expect(card.waiting.items.map((i: any) => i.id).sort()).toEqual([confirm.id, mail.id, later.id].sort())
    // The owner's newest card and the door's GET are the same card.
    expect((await (await fetch(`${u}/sweep`)).json()).card.id).toBe(card.id)
    expect((await (await fetch(`${u}/sweep`, get(MESSENGER))).json()).card.id).toBe(card.id)
    // Later from Messenger snoozes the item to the next sweep; the owner's card shows its current state.
    const snoozed = await fetch(`${u}/${later.id}`, json('PATCH', { action: 'answer', option: 'later' }, MESSENGER))
    expect([snoozed.status, (await snoozed.json()).record.state]).toEqual([200, 'new'])
    expect((await (await fetch(`${u}/sweep`)).json()).card.waiting.items.find((i: any) => i.id === later.id).state).toBe('new')
    // Once archived (e.g. its worker finished), Later from the door cannot reopen it.
    expect((await fetch(`${u}/${later.id}`, json('PATCH', { action: 'archive' }))).status).toBe(200)
    const reopened = await fetch(`${u}/${later.id}`, json('PATCH', { action: 'answer', option: 'later' }, MESSENGER))
    expect([reopened.status, (await reopened.json()).error]).toEqual([403, 'not_on_door_card'])
    expect(store().get(later.id)?.state).toBe('archived')
    // Mail's record is on the card but not Messenger's to answer; other actions stay the owner's.
    const notMine = await fetch(`${u}/${mail.id}`, json('PATCH', { action: 'answer', option: 'yes' }, MESSENGER))
    expect([notMine.status, (await notMine.json()).error]).toEqual([403, 'not_on_door_card'])
    expect((await fetch(`${u}/${confirm.id}`, json('PATCH', { action: 'archive' }, MESSENGER))).status).toBe(403)
    expect((await fetch(`${u}/${confirm.id}`, get(MESSENGER))).status).toBe(403)
    // Yes to all from Messenger: never the confirm item, never Mail's (which has a default and would otherwise go).
    const yes = await fetch(`${u}/${card.id}/yes-to-all`, json('POST', {}, MESSENGER))
    expect(yes.status).toBe(200)
    expect((await yes.json()).answered).toEqual([])
    expect([store().get(confirm.id)?.state, store().get(mail.id)?.state]).toEqual(['surfaced', 'surfaced'])
    // A card id the door never drew is not found for it.
    expect((await fetch(`${u}/sweep_${'0'.repeat(24)}/yes-to-all`, json('POST', {}, MESSENGER))).status).toBe(404)
    expect(store().get(confirm.id)?.surfaced_count).toBe(1)
  })

  it('urgent alerts reach a door that asked for pings once, through /pings', async () => {
    const d = home(), { u, store } = await start(d, { agentInbox: true })
    expect((await (await fetch(`${u}/doors`, json('POST', { pings: true }, MESSENGER))).json()).pings).toBe(true)
    // The alert decided by the rules (issue 552) at the moment Mail posts its event.
    const rules = await fetch(`${u}/rules`, json('PUT', { senders: ['boss@example.com'] }))
    expect(rules.status).toBe(200)
    const event = await fetch(`${u}/events`, json('POST', { type: 'mail', source: { app: 'wizard-mail', item: 'acct:1' }, sender: 'Boss <boss@example.com>', title: 'Synthetic urgent mail', ask: 'Synthetic' }, MAIL))
    expect(event.status).toBe(201)
    expect(store().list({ kind: 'alert' })).toHaveLength(1)
    const pings = await (await fetch(`${u}/pings`, get(MESSENGER))).json()
    expect(pings.pings.map((p: any) => p.title)).toEqual(['Synthetic urgent mail'])
    // A read consumes nothing (issue 325): the door got no answer or crashed, so it reads the same ping again.
    expect((await (await fetch(`${u}/pings`, get(MESSENGER))).json()).pings.map((p: any) => p.id)).toEqual([pings.pings[0].id])
    // Only the door acks its pings; the owner, a bad body or a big list is refused.
    expect((await fetch(`${u}/pings`, json('POST', { ack: [pings.pings[0].id] }))).status).toBe(403)
    expect((await fetch(`${u}/pings`, json('POST', { ack: 'x' }, MESSENGER))).status).toBe(400)
    expect((await fetch(`${u}/pings`, json('POST', { ack: Array(501).fill('x') }, MESSENGER))).status).toBe(400)
    const ack = await fetch(`${u}/pings`, json('POST', { ack: [pings.pings[0].id] }, MESSENGER))
    expect([ack.status, await ack.json()]).toEqual([200, { acked: [pings.pings[0].id] }])
    expect((await (await fetch(`${u}/pings`, get(MESSENGER))).json()).pings).toEqual([])
    // The same event posted again is the same record: no second alert, no second ping.
    expect((await fetch(`${u}/events`, json('POST', { type: 'mail', source: { app: 'wizard-mail', item: 'acct:1' }, sender: 'Boss <boss@example.com>', title: 'Synthetic urgent mail', ask: 'Synthetic' }, MAIL))).status).toBe(200)
    expect((await (await fetch(`${u}/pings`, get(MESSENGER))).json()).pings).toEqual([])
  })
})
