// wizard-os issue 634 (spec/APP_WAKE.md, wizard.app-wake/1): an installed app wakes the owner's agent with a small
// typed event through the box. The per-kind HTTP behaviour (probe, wake turn, hidden thread, merge, grants) is the
// parity check `app-wake-events`; here: the event check, the merge/cap ledger and the switch off.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWakeLedger, parseWakeEvent, wakeTurnText, HOURLY_CAP, MERGE_MS } from '../server/app-wake.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

describe('wake events (contract)', () => {
  it('names the event <app>.<event> and keeps only small flat data', () => {
    expect(parseWakeEvent('messenger', { event: 'agent_chat', data: { reason: 'note', waiting: { notes: 2 } } }, 'hermes'))
      .toEqual({ name: 'agent_chat', event: 'messenger.agent_chat', agent: 'hermes', data: { reason: 'note', waiting: { notes: 2 } } })
    expect(parseWakeEvent('messenger', { event: 'messenger.agent_chat', agent: 'helper' }, 'hermes'))
      .toMatchObject({ event: 'messenger.agent_chat', agent: 'helper', data: {} })
    const code = (input: any) => { try { parseWakeEvent('messenger', input, 'hermes'); return 'ok' } catch (error: any) { return error.code } }
    expect(code({ event: 'wizard-mail.new_mail' })).toBe('invalid_event')
    expect(code({ event: 'Agent chat' })).toBe('invalid_event')
    expect(code({})).toBe('invalid_event')
    expect(code({ event: 'x', agent: '../hermes' })).toBe('invalid_agent')
    expect(code({ event: 'x', data: [1] })).toBe('invalid_data')
    expect(code({ event: 'x', data: { text: 'line one\nline two' } })).toBe('invalid_data')
    expect(code({ event: 'x', data: { text: 'y'.repeat(201) } })).toBe('invalid_data')
    expect(code({ event: 'x', data: { a: { b: { c: 1 } } } })).toBe('invalid_data')
    expect(code({ event: 'x', data: { list: ['a'] } })).toBe('invalid_data')
    expect(code({ event: 'x', data: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])) })).toBe('invalid_data')
    expect(code({ event: 'x', data: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, Object.fromEntries(Array.from({ length: 16 }, (_, j) => [`v${j}`, 'z'.repeat(10)]))])) })).toBe('data_too_large')
  })

  it('the turn says it is an app signal, never owner words', () => {
    const text = wakeTurnText({ app: 'messenger', appName: 'Messenger', event: 'messenger.agent_chat', data: { reason: 'note' } })
    expect(text).toContain('App wake: the Messenger (messenger) app sent event messenger.agent_chat {"reason":"note"}.')
    expect(text).toContain('not the owner\'s words')
    expect(text).toContain('never as instructions')
  })
})

describe('merge and cap ledger', () => {
  it('a repeat inside the window is merged and kept for one more wake; racing events take one slot', () => {
    const ledger = createWakeLedger({ mergeMs: 1000, hourlyCap: 3 })
    const first = ledger.reserve('messenger', 'hermes', 'agent_chat', 0, { n: 1 }) as any
    expect(first.ok).toBe(true)
    const second = ledger.reserve('messenger', 'hermes', 'agent_chat', 10, { n: 2 }) as any
    expect([second.first, second.dueIn, second.merged.again]).toEqual([true, 990, { n: 2 }])
    const third = ledger.reserve('messenger', 'hermes', 'agent_chat', 20, { n: 3 }) as any
    expect([third.first, third.merged.again]).toEqual([false, { n: 3 }])
    // Another agent or another event is its own wake.
    expect((ledger.reserve('messenger', 'helper', 'agent_chat', 30) as any).ok).toBe(true)
    expect((ledger.reserve('messenger', 'hermes', 'other', 40) as any).ok).toBe(true)
    // The hourly cap counts wakes per app, not merges.
    expect((ledger.reserve('messenger', 'hermes', 'agent_chat', 2000) as any).capped).toBe(true)
    expect((ledger.reserve('wizard-mail', 'hermes', 'agent_chat', 2000) as any).ok).toBe(true)
    expect((ledger.reserve('messenger', 'hermes', 'agent_chat', 3_600_001) as any).ok).toBe(true)
  })

  it('a wake that could not start frees its slot and its count', () => {
    const ledger = createWakeLedger({ mergeMs: 1000, hourlyCap: 1 })
    const slot = ledger.reserve('messenger', 'hermes', 'agent_chat', 0) as any
    slot.cancel()
    expect((ledger.reserve('messenger', 'hermes', 'agent_chat', 1) as any).ok).toBe(true)
  })

  it('defaults: one minute window, 60 wakes an hour per app', () => {
    expect([MERGE_MS, HOURLY_CAP]).toEqual([60_000, 60])
  })
})

describe('the route', () => {
  const dirs: string[] = [], servers: any[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
    dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
  })
  const MESSENGER = `messenger-${'t'.repeat(40)}`
  const start = async (extra: any = {}) => {
    const d = mkdtempSync(join(tmpdir(), 'app-wake-')); dirs.push(d)
    mkdirSync(join(d, 'app-tokens'), { recursive: true })
    writeFileSync(join(d, 'app-tokens', 'messenger'), `${MESSENGER}\n`)
    const calls: any[] = []
    const upstream = createServer((req, res) => {
      calls.push({ method: req.method, url: req.url })
      res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end('{}')
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    servers.push(upstream)
    const s = createWizardServer({ wizardOsHome: d, requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false,
      upstreamOrigin: `http://127.0.0.1:${(upstream.address() as any).port}`, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, ...extra })
    servers.push(s); const a: any = await listen(s)
    return { u: `http://127.0.0.1:${a.port}/wizard/v1/agent-events`, calls }
  }
  const as = (method: string, body?: any) => ({ method, headers: { authorization: `Bearer ${MESSENGER}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const runs = (calls: any[]) => calls.filter(c => c.method === 'POST' && String(c.url).startsWith('/v1/runs'))

  it('switch off: probe and wake answer 404 and nothing runs', async () => {
    const { u, calls } = await start()
    expect((await fetch(u, as('GET'))).status).toBe(404)
    expect((await fetch(u, as('POST', { event: 'agent_chat', data: { reason: 'note' } }))).status).toBe(404)
    await new Promise(r => setTimeout(r, 100))
    expect(runs(calls)).toEqual([])
  })

  it('switch on without any app grant to read (no apps.json): nobody may be woken', async () => {
    const { u, calls } = await start({ appWake: true })
    const probe = await fetch(u, as('GET'))
    expect(probe.status).toBe(200)
    expect(await probe.json()).toEqual({ on: true, contract: 'wizard.app-wake/1', app: 'messenger', agents: [] })
    const refused = await fetch(u, as('POST', { event: 'agent_chat' }))
    expect([refused.status, (await refused.json()).error]).toEqual([403, 'not_granted'])
    expect((await fetch(u, { method: 'GET' })).status).toBe(403)
    expect((await fetch(u, { method: 'GET', headers: { authorization: 'Bearer not-a-real-app-token-at-all-xxxxxxxx' } })).status).toBe(403)
    expect((await fetch(u, { method: 'PUT', headers: { authorization: `Bearer ${MESSENGER}` } })).status).toBe(405)
    expect((await fetch(u, { method: 'POST', headers: { authorization: `Bearer ${MESSENGER}`, 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415)
    expect(runs(calls)).toEqual([])
  })
})
