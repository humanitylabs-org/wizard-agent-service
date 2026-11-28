// Chat replies on the phone through the per-app notification path (wizard-ux issue 1619, on for
// everyone; switch wizard/phone-chat-replies removed). The real Service, auth, run queues, app bridge and notifier; only Hermes and the
// Notifications app's MCP are synthetic. Every agent kind: a routed thread's reply is followed through its own agent.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kinds, post } from '../qa/agent-parity/fixture.mjs'
import { notificationScene } from '../qa/agent-parity/scheduler-notify.mjs'
import { replyExcerpt, replyNote, threadLink, nextReadMs, createPhoneReplyNotes } from '../server/phone-reply-notes.mjs'

const SHELL = 'https://box.example.ts.net:8796/wizard-os-home/'
const on = { phoneReplyShellUrl: SHELL, phoneReplyTickMs: 25 }
const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)) }
}

async function send(s: any, thread: string, text = 'plan my trip') {
  expect((await s.request('/api/sessions', post({ id: thread, title: 'Trip plan' }))).status).toBeLessThan(300)
  const r = await s.request('/v1/runs', post({ session_id: thread, input: text }))
  expect(r.status).toBe(202)
  return (await r.json()).run_id as string
}
const register = (s: any, body: object) => fetch(`${s.origin()}/wizard/v1/phone/reply-notes`, post(body))
const upstream = (s: any, thread: string) => [...s.runs.values()].filter((r: any) => r.session_id === thread).at(-1)
const notes = (s: any) => s.appCalls.filter((c: any) => /(^|__)notify$/.test(c.name)).map((c: any) => c.arguments)

describe('phone reply notes: pure rules', () => {
  it('says what the phone shows for each run state', () => {
    expect(replyNote({ status: 'running' }, 'Trip')).toBe(null)
    expect(replyNote({ status: 'completed', output: '## Plan\n**Day 1**: [Lisbon](https://x.test)' }, 'Trip')).toEqual({ kind: 'reply', title: 'Trip', message: 'Plan Day 1: Lisbon' })
    expect(replyNote({ status: 'completed', output: '' }, '')).toEqual({ kind: 'reply', title: 'Reply ready', message: 'Reply ready' })
    expect(replyNote({ status: 'failed' }, 'Trip').message).toBe('That request stopped with an error')
    expect(replyNote({ status: 'cancelled' }, 'Trip').message).toBe('That request was stopped')
    expect(replyNote({ status: 'waiting_for_approval' }, 'Trip').kind).toBe('ask')
    expect(replyExcerpt('word '.repeat(100)).length).toBeLessThanOrEqual(281)
  })
  it('links the thread on the shell, https only', () => {
    expect(threadLink(SHELL, 'abc_1')).toBe('https://box.example.ts.net:8796/wizard-os-home/?session=abc_1')
    expect(threadLink('http://box.local/wizard-os-home/', 'abc')).toBe('')
    expect(threadLink('', 'abc')).toBe('')
  })
  it('reads young runs often and old ones rarely', () => {
    expect(nextReadMs(1000, false)).toBe(4000)
    expect(nextReadMs(20 * 60_000, false)).toBe(30_000)
    expect(nextReadMs(2 * 3600_000, false)).toBe(120_000)
  })
  it('refuses bad input and a box with no Notifications app or shell address', () => {
    const n = createPhoneReplyNotes({ readRun: async () => null, notify: async () => {}, shellUrl: () => SHELL })
    expect(() => n.watch({ session: '../x', run: 'r' })).toThrow()
    expect(() => n.watch({ session: 's', run: 'r', agent: 'Bad Agent' })).toThrow()
    expect(() => createPhoneReplyNotes({ readRun: async () => null, notify: async () => {}, shellUrl: () => SHELL, available: () => false }).watch({ session: 's', run: 'r' })).toThrow(/no notifications/)
    expect(() => createPhoneReplyNotes({ readRun: async () => null, notify: async () => {}, shellUrl: () => '' }).watch({ session: 's', run: 'r' })).toThrow(/shell/)
    expect(n.watch({ session: 's', run: 'r1' }).ok).toBe(true)
    n.watch({ session: 's', run: 'r2' })
    expect(n.list()).toEqual([{ session: 's', run: 'r2', agent: '', asked: false }]) // newest run per thread wins
    n.stop()
  })
  it('keeps a reply that could not be posted and tries again on the next read', async () => {
    let fail = true, clock = 1_000_000
    const sent: any[] = []
    const n: any = createPhoneReplyNotes({ readRun: async () => ({ status: 200, payload: { status: 'completed', output: 'Done' } }),
      notify: async (x: any, agent: any) => { if (fail) throw new Error('down'); sent.push([x, agent]) }, shellUrl: () => SHELL, now: () => clock, tickMs: 60_000 } as any)
    n.watch({ session: 's', run: 'r', agent: 'helper' })
    await n.tick(); expect(sent).toEqual([]); expect(n.list().length).toBe(1)
    fail = false
    await n.tick(); expect(sent).toEqual([]) // not due yet: no read
    clock += 4_000
    await n.tick()
    expect(sent).toEqual([[{ title: 'Reply ready', message: 'Done', link: `${SHELL}?session=s` }, 'helper']])
    expect(n.list()).toEqual([])
    n.stop()
  })
  it('forgets a run the box no longer knows and one older than 6 hours', async () => {
    let clock = 1_000_000
    const n: any = createPhoneReplyNotes({ readRun: async (run: string) => run === 'gone' ? { status: 404 } : { status: 200, payload: { status: 'running' } },
      notify: async () => {}, shellUrl: () => SHELL, now: () => clock, tickMs: 60_000 } as any)
    n.watch({ session: 'a', run: 'gone' }); n.watch({ session: 'b', run: 'slow' })
    await n.tick()
    expect(n.list().map((w: any) => w.run)).toEqual(['slow'])
    clock += 6 * 3600_000 + 1
    await n.tick()
    expect(n.list()).toEqual([])
    n.stop()
  })
  it('keeps watches across a Service restart', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'reply-notes-')), 'phone-reply-notes.json')
    const a: any = createPhoneReplyNotes({ statePath, readRun: async () => null, notify: async () => {}, shellUrl: () => SHELL, tickMs: 60_000 } as any)
    a.watch({ session: 's1', run: 'r1', title: 'Trip' }); a.stop()
    const b: any = createPhoneReplyNotes({ statePath, readRun: async () => null, notify: async () => {}, shellUrl: () => SHELL, tickMs: 60_000 } as any)
    expect(b.list()).toEqual([{ session: 's1', run: 'r1', agent: '', asked: false }])
    b.stop()
  })
})

describe.each(kinds)('phone reply notes / %s', { timeout: 20_000 }, kind => {
  it('only the owner can hand a run over', async () => {
    const s = await notificationScene(kind, true, on)
    try {
      const r = await fetch(`${s.origin()}/wizard/v1/phone/reply-notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 'x', run: 'y' }) })
      expect([401, 403]).toContain(r.status)
      const g = await fetch(`${s.origin()}/wizard/v1/phone/reply-notes`, { headers: s.ownerHeaders })
      expect(g.status).toBe(405)
    } finally { await s.close() }
  })

  it('no switch needed: the reply is posted once to Notifications under Chats, linked to its thread', async () => {
    const s = await notificationScene(kind, true, on)
    try {
      const thread = 'phone-1619-on'
      const run = await send(s, thread)
      const r = await register(s, { session: thread, run, title: 'Trip plan', ...(kind === 'main' ? {} : { agent: s.id }) })
      expect(r.status).toBe(202)
      await new Promise(r => setTimeout(r, 120))
      expect(notes(s)).toEqual([]) // still working: nothing yet
      Object.assign(upstream(s, thread), { status: 'completed', output: 'Here is your **trip** plan.' })
      await until(() => notes(s).length > 0)
      await new Promise(r => setTimeout(r, 120))
      expect(notes(s)).toEqual([{ message: 'Here is your trip plan.', title: 'Trip plan', link: `${SHELL}?session=${thread}`, app: 'chats', tags: 'chat-reply' }])
      const saved = JSON.parse(readFileSync(join(s.root, 'os', 'phone-reply-notes.json'), 'utf8'))
      expect(saved.watches).toEqual([])
    } finally { await s.close() }
  })

  it('an approval wait is told once, then the reply', async () => {
    const s = await notificationScene(kind, true, on)
    try {
      const thread = 'phone-1619-ask'
      const run = await send(s, thread)
      expect((await register(s, { session: thread, run, title: 'Deploy', ...(kind === 'main' ? {} : { agent: s.id }) })).status).toBe(202)
      Object.assign(upstream(s, thread), { status: 'waiting_for_approval' })
      await until(() => notes(s).length > 0)
      await new Promise(r => setTimeout(r, 150))
      expect(notes(s).map((n: any) => n.title)).toEqual(['Deploy'])
      expect(notes(s)[0].message).toBe('Your Wizard is waiting on you')
      Object.assign(upstream(s, thread), { status: 'completed', output: 'Deployed.' })
      // An asked watch is read once a minute; a fresh handover of the same run reads it at once.
      expect((await register(s, { session: thread, run, title: 'Deploy', ...(kind === 'main' ? {} : { agent: s.id }) })).status).toBe(202)
      await until(() => notes(s).length > 1)
      expect(notes(s)[1].message).toBe('Deployed.')
    } finally { await s.close() }
  })

  it('the thread\'s agent cannot reach Notifications: refused so the phone keeps its own watcher', async () => {
    const s = await notificationScene(kind, false, on)
    try {
      const run = await send(s, 'phone-1619-none')
      const r = await register(s, { session: 'phone-1619-none', run, ...(kind === 'main' ? {} : { agent: s.id }) })
      expect(r.status).toBe(409)
      expect((await r.json()).error).toBe('notifications_unavailable')
      expect(existsSync(join(s.root, 'os', 'phone-reply-notes.json'))).toBe(false)
    } finally { await s.close() }
  })
})
