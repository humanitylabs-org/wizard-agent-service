import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../server/scheduler.mjs'
import { TIPS, TIPS_GROUP, TIPS_THREAD_TITLE, onboardingTools, startTips, stopTips, tipInstants } from '../server/onboarding.mjs'
import { createAgentBridge, renderKernel, KERNEL_LIMIT } from '../server/agent-bridge.mjs'

let root: string
let clock: number
const schedulers: any[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wizard-onboarding-case-'))
  for (const key of ['HOME', 'HERMES_HOME', 'WIZARD_OS_HOME', 'TMPDIR']) {
    const path = join(root, key.toLowerCase()); mkdirSync(path); vi.stubEnv(key, path)
  }
  // 2026-10-23 10:00 Asia/Bangkok
  clock = Date.parse('2026-10-23T03:00:00Z')
})
afterEach(async () => {
  for (const s of schedulers.splice(0)) await s.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
function scheduler(deliver: any = async () => ({ run_id: 'fixture' })) {
  const s = new Scheduler({ statePath: join(root, 'scheduler.sqlite3'), now: () => clock, timezone: 'Asia/Bangkok', deliver, intervalMs: 3_600_000, trickleMs: 0 })
  schedulers.push(s)
  return s
}
const parse = (r: any) => JSON.parse(r.content[0].text)

describe('onboarding tips', () => {
  it('lands tip 1 a minute after opt-in, then one each morning at 08:30 owner time', () => {
    const at = tipInstants(clock, 'Asia/Bangkok').map((t) => new Date(t).toISOString())
    expect(at).toEqual([
      '2026-10-23T03:01:00.000Z',
      '2026-10-24T01:30:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-26T01:30:00.000Z', '2026-10-27T01:30:00.000Z',
    ])
  })

  it('starts five tips in one "Wizard · Tips" thread, idempotently, and stop removes the pending ones', () => {
    const s = scheduler()
    const first = startTips(s, { agent: 'main', timezone: 'Asia/Bangkok', now: clock })
    expect(first.started).toBe(true)
    expect(first.tips).toHaveLength(TIPS.length)
    const jobs = s.list().filter((j: any) => j.group === TIPS_GROUP)
    expect(jobs).toHaveLength(5)
    expect(new Set(jobs.map((j: any) => j.thread))).toEqual(new Set([first.thread]))
    expect(jobs.every((j: any) => j.kind === 'remind' && j.threadTitle === TIPS_THREAD_TITLE && j.createThread)).toBe(true)
    const again = startTips(s, { agent: 'main', timezone: 'Asia/Bangkok', now: clock })
    expect(again.started).toBe(false)
    expect(s.list()).toHaveLength(5)
    expect(stopTips(s, { agent: 'main' })).toEqual({ stopped: 5 })
    expect(s.list()).toHaveLength(0)
  })

  it('a due tip is delivered as an ordinary reminder run into the Tips thread', async () => {
    const delivered: any[] = []
    const s = scheduler(async (o: any) => { delivered.push(o); return { run_id: `run-${delivered.length}` } })
    const { thread } = startTips(s, { agent: 'main', timezone: 'Asia/Bangkok', now: clock })
    clock += 61_000
    await s.tick()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ thread, createThread: true, title: TIPS_THREAD_TITLE, kind: 'remind', agent: 'main' })
    expect(delivered[0].body.input).toContain('Wizard tip 1 of 5 (build an app by voice)')
    expect(delivered[0].body.input).toContain('Say stop tips to turn these off.')
  })

  it('the HTTP schedule body cannot claim the service-only placement fields', () => {
    const s = scheduler()
    expect(() => s.create({ name: 'x', kind: 'remind', prompt: 'p', when: { at: 'morning' }, group: TIPS_GROUP } as any)).toThrow(/unknown schedule field/)
  })
})

describe('wizard_remind / wizard_tips tools', () => {
  const tools = (s: any, running = true): any => onboardingTools({ scheduler: s, running: () => running, timezone: () => 'Asia/Bangkok', now: () => clock, mainAgent: 'hermes' })

  it('sets, lists and cancels a reminder for the calling agent', async () => {
    const s = scheduler()
    const t = tools(s)
    const set = parse(await t.call('wizard_remind', { text: 'call the bank', when: 'morning' }, 'hermes'))
    expect(set).toMatchObject({ kind: 'remind', when: '2026-10-24T01:30:00.000Z', timezone: 'Asia/Bangkok' })
    expect(s.get(set.id)).toMatchObject({ agent: 'main', name: 'Reminder · call the bank', prompt: 'call the bank' })
    await t.call('wizard_remind', { text: 'stretch', when: '2026-10-23T18:00:00+07:00' }, 'private-1')
    const list = parse(await t.call('wizard_remind', { action: 'list' }, 'hermes'))
    expect(list.reminders.map((r: any) => r.id)).toEqual([set.id])
    expect((await t.call('wizard_remind', { action: 'cancel', id: 'nope' }, 'hermes')).isError).toBe(true)
    expect(parse(await t.call('wizard_remind', { action: 'cancel', id: set.id }, 'hermes')).cancelled).toBe(set.id)
    expect(s.list().map((j: any) => j.agent)).toEqual(['private-1'])
  })

  it('tips never show up as reminders, and bad input is a tool error, not a throw', async () => {
    const s = scheduler()
    const t = tools(s)
    expect(parse(await t.call('wizard_tips', { action: 'start' }, 'hermes')).started).toBe(true)
    expect(parse(await t.call('wizard_remind', { action: 'list' }, 'hermes')).reminders).toEqual([])
    expect(parse(await t.call('wizard_tips', { action: 'status' }, 'hermes')).tips).toHaveLength(5)
    expect((await t.call('wizard_remind', { text: 'x', when: 'tomorrow-ish' }, 'hermes')).isError).toBe(true)
    expect((await t.call('wizard_tips', { action: 'go' }, 'hermes')).isError).toBe(true)
    expect(parse(await t.call('wizard_tips', { action: 'stop' }, 'hermes')).stopped).toBe(5)
  })

  it('says so instead of promising when the scheduler timer is off', async () => {
    const s = scheduler()
    const r = await tools(s, false).call('wizard_remind', { text: 'x', when: 'morning' }, 'hermes')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('switched off')
    expect(s.list()).toHaveLength(0)
  })

  it('the gateway lists and dispatches both tools beside wizard_apps', async () => {
    const s = scheduler()
    const appsJsonPath = join(root, 'apps.json')
    writeFileSync(appsJsonPath, JSON.stringify({ apps: [] }))
    const t = tools(s)
    const bridge: any = (createAgentBridge as any)({ appsJsonPath, osHome: root, builtins: { list: () => t.list(), call: (n: string, a: any, id: string) => t.call(n, a, id) }, watchIntervalMs: 3_600_000 })
    try {
      const names = (await bridge.listTools()).map((tool: any) => tool.name)
      expect(names.slice(0, 3)).toEqual(['wizard_apps', 'wizard_remind', 'wizard_tips'])
      const r = await bridge.callTool('wizard_tips', { action: 'start' })
      expect(parse(r).started).toBe(true)
      expect(s.list()).toHaveLength(5)
    } finally { bridge.close() }
  })
})

describe('kernel', () => {
  it('points Hermes at wizard-guide within the size limit', () => {
    const k = renderKernel([])
    expect(k).toContain('load `wizard-guide`')
    expect(k.length).toBeLessThanOrEqual(KERNEL_LIMIT)
  })
})
