// Wizard-ux issue 1570 (agent inbox step 5): Open moves a hidden worker thread into the chat list, Send to inbox moves
// a visible thread into the background, and each tap is one example the orb router reads as few-shot context.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentInboxStore, SENT_NOTE, ROUTE_EXAMPLES } from '../server/agent-inbox.mjs'
import { routerSystemPrompt, routeUtterance, examplesBlock } from '../server/voice-router.mjs'
import { createWizardServer, listen } from '../server/service.mjs'
import { createChannelStore } from '../server/channel-store.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r))))
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const home = () => { const d = mkdtempSync(join(tmpdir(), 'agent-inbox-move-')); dirs.push(d); return d }
const clock = (start = Date.parse('2026-11-18T10:00:00Z')) => { const c = { at: start, now: () => c.at }; return c }

describe('Send to inbox and Open in the store', () => {
  it('Send to inbox makes a new worker record the Service may hide; an idle thread waits as a result', () => {
    const c = clock(), s = new AgentInboxStore('', { now: c.now })
    expect(s.mayHide('hermes', 'wizard_visible_1')).toBe(false)
    const idle = s.sendToInbox('hermes', 'wizard_visible_1', { title: 'Lisbon flights', ask: 'Research flights to Lisbon' })
    expect(idle).toMatchObject({ worker: true, state: 'new', kind: 'result', last_update: SENT_NOTE, title: 'Lisbon flights', source: 'chats:send' })
    expect(s.mayHide('hermes', 'wizard_visible_1')).toBe(true)
    const busy = s.sendToInbox('hermes', 'wizard_visible_2', { title: 'Porto plan', running: true })
    expect(busy.state).toBe('running')
    // The same thread sent twice is one record; two threads with the same title are two records.
    expect(s.sendToInbox('hermes', 'wizard_visible_1', { title: 'Lisbon flights' }).id).toBe(idle.id)
    expect(s.sendToInbox('hermes', 'wizard_visible_3', { title: 'Lisbon flights' }).id).not.toBe(idle.id)
  })

  it('a thread the owner typed in can be sent again: Send clears owner_turn_at, Open sets it', () => {
    const s = new AgentInboxStore('', { now: clock().now })
    const made = s.capture({ thread_id: 'wizard_worker_1', title: 'Dentist', ask: 'Find a dentist' }, { fields: { worker: true } }).record
    expect(s.mayHide('hermes', 'wizard_worker_1')).toBe(true)
    const opened = s.openFromInbox('hermes', 'wizard_worker_1')
    expect(opened?.id).toBe(made.id)
    expect(opened?.owner_turn_at).toBeGreaterThan(0)
    expect(s.mayHide('hermes', 'wizard_worker_1')).toBe(false)
    const sent = s.sendToInbox('hermes', 'wizard_worker_1', { running: true })
    expect([sent.id, sent.state, sent.owner_turn_at]).toEqual([made.id, 'running', undefined])
    expect(s.mayHide('hermes', 'wizard_worker_1')).toBe(true)
    expect(s.openFromInbox('hermes', 'wizard_none')).toBeNull()
  })

  it('each tap stores one example {utterance, chosen, wanted, at}, newest first, capped, and survives a restart', () => {
    const d = home(), path = join(d, 'agent-inbox.json'), c = clock()
    const s = new AgentInboxStore(path, { now: c.now })
    expect(s.addRouteExample({ utterance: 'Research flights', chosen: 'agent', wanted: 'dump' })).toMatchObject({ utterance: 'Research flights', chosen: 'agent', wanted: 'dump', at: c.at })
    // No words, an unknown route or no correction: nothing stored.
    expect(s.addRouteExample({ utterance: '', chosen: 'agent', wanted: 'dump' })).toBeNull()
    expect(s.addRouteExample({ utterance: 'x', chosen: 'agent', wanted: 'command' })).toBeNull()
    expect(s.addRouteExample({ utterance: 'x', chosen: 'dump', wanted: 'dump' })).toBeNull()
    for (let n = 0; n < ROUTE_EXAMPLES + 5; n++) { c.at += 1000; s.addRouteExample({ utterance: `Task ${n}`, chosen: 'dump', wanted: 'agent' }) }
    const again = new AgentInboxStore(path, { now: c.now })
    expect(again.routeExamples(ROUTE_EXAMPLES + 10).length).toBe(ROUTE_EXAMPLES)
    expect(again.routeExamples(2).map(e => e.utterance)).toEqual([`Task ${ROUTE_EXAMPLES + 4}`, `Task ${ROUTE_EXAMPLES + 3}`])
  })
})

describe('the orb classifier reads the latest examples', () => {
  const examples = [
    { utterance: 'Look into the car insurance renewal', chosen: 'dump', wanted: 'agent', at: 2 },
    { utterance: 'The quarterly numbers for Jan', chosen: 'agent', wanted: 'dump', at: 1 },
  ]
  it('the dump rule carries them as few-shot lines; without the dump route nothing is added', () => {
    const on = routerSystemPrompt({ settings: {}, apps: [], timezone: 'UTC', dump: true, examples })
    expect(on).toContain('The owner moved these earlier requests himself')
    expect(on).toContain('- "Look into the car insurance renewal" -> agent (visible thread)')
    expect(on).toContain('- "The quarterly numbers for Jan" -> dump (background task)')
    expect(routerSystemPrompt({ settings: {}, apps: [], timezone: 'UTC', dump: false, examples })).not.toContain('earlier requests')
    expect(examplesBlock([])).toBe('')
    expect(examplesBlock(Array.from({ length: 12 }, (_, n) => ({ utterance: `t${n}`, wanted: 'dump' }))).split('\n').filter(l => l.startsWith('- ')).length).toBe(8)
  })
  it('routeUtterance sends them to the router', async () => {
    let sent: any = null
    const fetchImpl = (async (_url: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{"route":"agent","summary":"x"}' } }] })) }) as unknown as typeof fetch
    await routeUtterance({ input: { text: 'The quarterly numbers for Jan' }, settings: {}, router: { url: 'http://127.0.0.1:9/v1', model: 'm' }, fetchImpl, dump: true, examples })
    expect(sent.messages[0].content).toContain('"The quarterly numbers for Jan" -> dump (background task)')
  })
})

describe('Open and Send to inbox over HTTP', () => {
  async function start(d: string, extra: any = {}) {
    const sessions = new Map<string, any>([['wizard_visible_1', { id: 'wizard_visible_1', title: 'Lisbon flights', hidden: false }], ['wizard_pinned_1', { id: 'wizard_pinned_1', title: 'Plan with James', pinned: true }],
      ['wizard_daily_1', { id: 'wizard_daily_1', title: 'Today' }], ['wizard_alert_1', { id: 'wizard_alert_1', title: 'Disk almost full' }], ['wizard_filed_1', { id: 'wizard_filed_1', title: 'Trip' }]])
    const patches: any[] = []
    const routerCalls: any[] = []
    const upstream = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const m = /^\/api\/sessions\/([^/?]+)/u.exec(req.url || '')
        const row = m ? sessions.get(decodeURIComponent(m[1])) : null
        res.setHeader('Content-Type', 'application/json')
        if (req.url?.startsWith('/router')) { routerCalls.push(JSON.parse(body)); res.end(JSON.stringify({ choices: [{ message: { content: '{"route":"agent","summary":"x"}' } }] })); return }
        if (!row) { res.statusCode = 404; res.end('{"error":"not_found"}'); return }
        if (req.method === 'PATCH') { const patch = JSON.parse(body); patches.push({ id: row.id, ...patch }); Object.assign(row, patch) }
        res.end(JSON.stringify(row))
      })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    servers.push(upstream)
    const port = (upstream.address() as any).port
    const s = createWizardServer({ wizardOsHome: d, requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false,
      upstreamOrigin: `http://127.0.0.1:${port}`, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, agentInboxStatePath: join(d, 'agent-inbox.json'), ...extra })
    servers.push(s); const a: any = await listen(s)
    return { u: `http://127.0.0.1:${a.port}/wizard/v1/agent-inbox`, sessions, patches, routerCalls, port }
  }
  const json = (method: string, value: any, headers = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) })

  it('switch off: both routes are 404 and nothing is written', async () => {
    const d = home(), { u, patches } = await start(d)
    expect((await fetch(`${u}/send`, json('POST', { thread_id: 'wizard_visible_1' }))).status).toBe(404)
    expect((await fetch(`${u}/open`, json('POST', { thread_id: 'wizard_visible_1' }))).status).toBe(404)
    expect(patches).toEqual([])
    expect(existsSync(join(d, 'agent-inbox.json'))).toBe(false)
  })

  it('Send hides the thread and writes its record and one example; Open shows it again and writes one example', async () => {
    const d = home(), { u, sessions, patches } = await start(d, { agentInbox: true })
    const sent = await fetch(`${u}/send`, json('POST', { thread_id: 'wizard_visible_1', utterance: 'Research flights to Lisbon' }))
    expect(sent.status).toBe(200)
    const body = await sent.json()
    expect(body).toMatchObject({ hidden: true, example: true, record: { thread_id: 'wizard_visible_1', worker: true, state: 'new', kind: 'result', title: 'Lisbon flights' } })
    expect(sessions.get('wizard_visible_1').hidden).toBe(true)
    const opened = await (await fetch(`${u}/open`, json('POST', { thread_id: 'wizard_visible_1' }))).json()
    expect(opened).toMatchObject({ hidden: false, example: true, record: { id: body.record.id } })
    expect(opened.record.owner_turn_at).toBeGreaterThan(0)
    expect(sessions.get('wizard_visible_1').hidden).toBe(false)
    expect(patches).toEqual([{ id: 'wizard_visible_1', hidden: true }, { id: 'wizard_visible_1', hidden: false }])
    const store = new AgentInboxStore(join(d, 'agent-inbox.json'))
    expect(store.routeExamples(5).map(e => [e.utterance, e.chosen, e.wanted])).toEqual([
      ['Research flights to Lisbon', 'dump', 'agent'],
      ['Research flights to Lisbon', 'agent', 'dump'],
    ])
  })

  it('refuses a pinned thread, a routed agent, an unknown thread, bad ids, other methods and cross-site writes', async () => {
    const d = home(), { u, patches } = await start(d, { agentInbox: true })
    const pinned = await fetch(`${u}/send`, json('POST', { thread_id: 'wizard_pinned_1' }))
    expect([pinned.status, (await pinned.json()).error]).toEqual([409, 'pinned'])
    // A pin made in a Wizard client lives in the box's ui-preferences (pinnedChats), not in Hermes.
    const prefs = `http://127.0.0.1:${new URL(u).port}/wizard/v1/ui-preferences`
    expect((await fetch(prefs, json('PATCH', { ops: [{ op: 'add', key: 'pinnedChats', item: 'wizard_visible_1' }] }))).status).toBe(200)
    const pinnedByUi = await fetch(`${u}/send`, json('POST', { thread_id: 'wizard_visible_1' }))
    expect([pinnedByUi.status, (await pinnedByUi.json()).error]).toEqual([409, 'pinned'])
    const routed = await fetch(`${u}/send`, json('POST', { thread_id: 'wizard_visible_1', agent: 'research' }))
    expect([routed.status, (await routed.json()).error]).toEqual([409, 'main_only'])
    expect((await fetch(`${u}/open`, json('POST', { thread_id: 'wizard_missing_1' }))).status).toBe(404)
    expect((await fetch(`${u}/open`, json('POST', { thread_id: '../x' }))).status).toBe(400)
    expect((await fetch(`${u}/open`)).status).toBe(405)
    expect((await fetch(`${u}/send`, json('POST', { thread_id: 'wizard_visible_1' }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
    expect(patches).toEqual([])
    expect(new AgentInboxStore(join(d, 'agent-inbox.json')).routeExamples(5)).toEqual([])
  })

  // Issue 1569 review: one tap must never hide today's Daily thread (where the sweep card is posted) or an Alerts thread.
  for (const channels of [true, false]) {
    it(`refuses Daily and Alerts threads with 409, Channels ${channels ? 'on' : 'off'}`, async () => {
      const d = home()
      const store = createChannelStore(join(d, 'channels.sqlite'))
      store.seedAlerts(); store.seedDaily()
      const listed = store.list({ agent: 'hermes' }).channels
      const alerts = listed.find((c: any) => c.kind === 'alerts'), daily = listed.find((c: any) => c.kind === 'daily')
      const trips = store.create({ name: 'Trips' })
      store.claimDay(daily.id, '2026-11-18', () => 'wizard_daily_1')
      store.move({ sessionId: 'wizard_alert_1', channelId: alerts.id })
      store.move({ sessionId: 'wizard_filed_1', channelId: trips.id })
      const { u, sessions, patches } = await start(d, { agentInbox: true, ...(channels ? { channelStore: true } : {}) })
      for (const [id, code] of [['wizard_daily_1', 'daily_thread'], ['wizard_alert_1', 'alerts_thread']]) {
        const r = await fetch(`${u}/send`, json('POST', { thread_id: id }))
        expect([r.status, (await r.json()).error]).toEqual([409, code])
        expect(sessions.get(id).hidden).toBeUndefined()
      }
      expect(patches).toEqual([])
      // A thread in an ordinary channel can still be sent.
      expect((await fetch(`${u}/send`, json('POST', { thread_id: 'wizard_filed_1' }))).status).toBe(200)
    })
  }
})
