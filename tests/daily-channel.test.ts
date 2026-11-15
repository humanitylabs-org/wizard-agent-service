// Issue 527: the Daily channel. One pinned channel per agent holding one real thread per day (05:00 boundary in the
// owner's time zone), its idempotent seed, today's thread created once, /days paging, and scheduler posts into it.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelStore, channelRequest } from '../server/channel-store.mjs'
import { dayOf, mintDailyThreadId, dailyTitle, openerOf, dailyRunNote } from '../server/daily-channel.mjs'
import { Scheduler } from '../server/scheduler.mjs'
import { FRESH_CLIENT_THREAD_ID } from '../server/agents-http.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const dirs: string[] = [], closers: any[] = []
afterEach(async () => {
  for (const c of closers.splice(0)) await (c.close.length ? new Promise<void>(r => c.close(r)) : c.close())
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const home = () => { const d = mkdtempSync(join(tmpdir(), 'daily-channel-')); dirs.push(d); return d }
const openStore = (path: string) => { const s = createChannelStore(path); closers.push(s); return s }

describe('day boundary', () => {
  it('a post at 04:59 local time is still yesterday; 05:00 starts today (fake clock, two time zones)', () => {
    // Bangkok is UTC+7: 04:59 local on 15 Nov is 21:59 UTC on 14 Nov.
    expect(dayOf(Date.parse('2026-11-14T21:59:00Z'), 'Asia/Bangkok')).toBe('2026-11-14')
    expect(dayOf(Date.parse('2026-11-14T22:00:00Z'), 'Asia/Bangkok')).toBe('2026-11-15')
    expect(dayOf(Date.parse('2026-11-15T16:59:00Z'), 'Asia/Bangkok')).toBe('2026-11-15') // 23:59 local
    expect(dayOf(Date.parse('2026-11-15T19:30:00Z'), 'Asia/Bangkok')).toBe('2026-11-15') // 02:30 local: still the evening
    // New York in winter is UTC-5.
    expect(dayOf(Date.parse('2026-11-15T09:59:00Z'), 'America/New_York')).toBe('2026-11-14')
    expect(dayOf(Date.parse('2026-11-15T10:00:00Z'), 'America/New_York')).toBe('2026-11-15')
    // A month and year edge, and an unknown zone reads as UTC.
    expect(dayOf(Date.parse('2027-01-01T04:59:00Z'), 'UTC')).toBe('2026-12-31')
    expect(dayOf(Date.parse('2027-01-01T05:00:00Z'), 'Not/AZone')).toBe('2027-01-01')
  })
  it('mints ids in the shell fresh-chat shape, titles the day, and picks the opener', () => {
    expect(mintDailyThreadId(Date.parse('2026-11-15T05:00:00Z'))).toMatch(FRESH_CLIENT_THREAD_ID)
    expect(dailyTitle('2026-11-15')).toBe('Daily · Sun 15 Nov')
    expect(openerOf([{ role: 'user', content: '[Wizard schedule] scheduled message\nbrief' }, { role: 'assistant', display_kind: 'commentary', content: 'thinking' },
      { role: 'assistant', content: `Signal: ${'x'.repeat(300)}` }])).toMatch(/^Signal: x+…$/u)
    expect(openerOf([{ role: 'assistant', content: 'Signal: synthetic' }]).length).toBeLessThanOrEqual(200)
    expect(openerOf([{ role: 'user', content: [{ type: 'text', text: 'Synthetic owner first' }] }])).toBe('Synthetic owner first')
    expect(dailyRunNote({ day: '2026-11-15', previous: { day: '2026-11-14', sessionId: 'wizard_x' }, openItems: [{ id: 'a', title: 'Synthetic', state: 'needs_you' }] }))
      .toMatch(/2026-11-15[\s\S]*wizard_x \(2026-11-14\)[\s\S]*"needs_you"/u)
  })
})

describe('store', () => {
  it('seeds one Daily for the main agent once, pinned above Alerts; an archive or delete sticks', () => {
    const d = home(), path = join(d, 'channels.sqlite'), store = openStore(path)
    store.seedAlerts()
    const id = store.seedDaily()
    expect(id).toBe('daily')
    expect(store.seedDaily()).toBeNull()
    const pins = store.list().channels.filter((c: any) => c.pinned).sort((a: any, b: any) => a.pinOrder - b.pinOrder).map((c: any) => [c.name, c.kind, c.pinOrder])
    expect(pins).toEqual([['Daily', 'daily', 0], ['Alerts', 'alerts', 1]])
    expect(store.get(id)).toMatchObject({ kind: 'daily', dayStartsAt: '05:00' })
    store.update(id, { archived: true })
    expect(openStore(path).seedDaily()).toBeNull()
    expect(store.dailyChannel('hermes')).toBeNull()
    store.remove(id)
    expect(openStore(path).seedDaily()).toBeNull()
    expect(store.list().channels.filter((c: any) => c.kind === 'daily')).toEqual([])
  })
  it('PATCH kind makes a channel the agent’s one daily channel or turns it back; Alerts stays Alerts', () => {
    const store = openStore(join(home(), 'channels.sqlite'))
    store.seedAlerts(); store.seedDaily()
    const plan = store.create({ name: 'Synthetic plan' }), other = store.create({ name: 'Synthetic other', agent: 'philosopher' })
    const patch = (body: any, daily = true) => channelRequest(store, 'PATCH', false, new URLSearchParams(), body, { daily })
    expect(() => patch({ id: plan.id, kind: 'daily' }, false)).toThrow(/invalid_request/)
    expect(patch({ id: plan.id, kind: 'daily' })).toMatchObject({ kind: 'daily' })
    expect(store.list({ agent: 'hermes' }).channels.filter((c: any) => c.kind === 'daily').map((c: any) => c.id)).toEqual([plan.id])
    expect(patch({ id: other.id, kind: 'daily' })).toMatchObject({ kind: 'daily' }) // another agent has its own
    expect(store.dailyChannel('philosopher')?.id).toBe(other.id)
    expect(() => patch({ id: 'alerts', kind: 'daily' })).toThrow(/alerts_channel/)
    expect(() => patch({ id: plan.id, kind: 'weekly' })).toThrow(/invalid_kind/)
    expect(patch({ id: plan.id, kind: null })).not.toHaveProperty('kind')
    expect(store.dailyChannel('hermes')).toBeNull()
  })
  it('today’s thread is created once, even by two handles racing; it is filed into Daily; days page newest first', () => {
    const path = join(home(), 'channels.sqlite'), a = openStore(path), b = openStore(path)
    a.seedAlerts(); a.seedDaily()
    let n = 0
    const mint = () => `wizard_${String(1763182800000 + ++n)}_${'a'.repeat(12)}`
    const first = a.claimDay('daily', '2026-11-15', mint), second = b.claimDay('daily', '2026-11-15', mint)
    expect(first.created).toBe(true); expect(second.created).toBe(false)
    expect(second.sessionId).toBe(first.sessionId)
    expect(a.members('daily')).toEqual([expect.objectContaining({ sessionId: first.sessionId, filedBy: 'agent' })])
    for (const day of ['2026-11-12', '2026-11-13', '2026-11-14']) a.claimDay('daily', day, mint)
    expect(a.days('daily', { limit: 2 }).map((r: any) => r.day)).toEqual(['2026-11-15', '2026-11-14'])
    expect(a.days('daily', { before: '2026-11-14', limit: 5 }).map((r: any) => r.day)).toEqual(['2026-11-13', '2026-11-12'])
    expect(a.dayOfSession('hermes', first.sessionId)).toEqual({ channelId: 'daily', day: '2026-11-15', previous: { day: '2026-11-14', sessionId: a.dayThread('daily', '2026-11-14') } })
    expect(() => a.claimDay('alerts', '2026-11-15', mint)).toThrow(/channel_not_found/)
    a.forget('hermes', first.sessionId)
    expect(a.dayThread('daily', '2026-11-15')).toBeNull()
  })
})

describe('scheduler', () => {
  const setup = (on = true) => {
    const d = home(), claimed: any[] = []
    const daily = { on: () => on, isDaily: (_a: string, ch: string) => ch === 'daily',
      thread: (agent: string, instant: number) => { claimed.push([agent, instant]); return { thread: 'wizard_1763182800000_aaaaaaaaaaaa', title: 'Daily · Sun 15 Nov', channel: 'daily' } } }
    const s = new Scheduler({ statePath: join(d, 's.sqlite3'), deliver: async () => ({ run_id: 'r' }), now: () => Date.parse('2026-11-15T01:00:00Z'), channels: true, daily }); closers.push(s)
    return { s, claimed }
  }
  const base = { name: 'Synthetic', prompt: 'Synthetic brief.', when: { every: 3600 }, enabled: false }
  it("thread:'daily' jobs and origin-less reminders post into today’s Daily thread", () => {
    const { s, claimed } = setup()
    const brief = s.runNow(s.create({ ...base, kind: 'run', thread: 'daily' }).id)
    expect(brief).toMatchObject({ thread: 'wizard_1763182800000_aaaaaaaaaaaa', createThread: true, daily: 'daily', title: 'Daily · Sun 15 Nov' })
    expect(brief.body.session_id).toBe('wizard_1763182800000_aaaaaaaaaaaa')
    expect(brief).not.toHaveProperty('opensThread')
    const remind = s.runNow(s.create({ ...base, kind: 'remind' }).id)
    expect(remind).toMatchObject({ thread: 'wizard_1763182800000_aaaaaaaaaaaa', daily: 'daily' })
    const named = s.runNow(s.create({ ...base, kind: 'remind', channel: 'daily' }).id)
    expect(named.daily).toBe('daily')
    expect(claimed.map(c => c[0])).toEqual(['main', 'main', 'main'])
    // A reminder in its own origin thread stays there; a watcher or return can't name 'daily'.
    const origin = s.runNow(s.create({ ...base, kind: 'remind', thread: 'wizard_origin' }).id)
    expect(origin).toMatchObject({ thread: 'wizard_origin', createThread: false }); expect(origin).not.toHaveProperty('daily')
    expect(() => s.create({ ...base, kind: 'watch', thread: 'daily' })).toThrow(/watcher needs its thread/)
  })
  it('with the switch off nothing changes', () => {
    const { s, claimed } = setup(false)
    const remind = s.runNow(s.create({ ...base, kind: 'remind' }).id)
    expect(remind.thread).toMatch(/^wizard_schedule_/u); expect(remind).not.toHaveProperty('daily')
    expect(s.runNow(s.create({ ...base, kind: 'run', thread: 'daily' }).id).thread).toBe('daily')
    expect(claimed).toEqual([])
  })
})

describe('HTTP', () => {
  it('switch off: the routes are 404 and no Daily is seeded', async () => {
    const d = home()
    const s = createWizardServer({ wizardOsHome: d, requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, channelStore: true, channelDaily: false })
    closers.push(s); const a: any = await listen(s), u = `http://127.0.0.1:${a.port}/wizard/v1/channels`
    expect((await (await fetch(u)).json()).channels.map((c: any) => c.kind)).toEqual(['alerts'])
    expect((await fetch(`${u}/daily/days`)).status).toBe(404)
    expect((await fetch(`${u}/daily/today`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    expect((await fetch(u, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'alerts', kind: 'daily' }) })).status).toBe(400)
  })
})
