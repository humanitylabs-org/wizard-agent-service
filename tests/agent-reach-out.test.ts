// Routed agents start threads and schedule their own messages (server/agent-reach-out.mjs). Synthetic data only.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../server/scheduler.mjs'
import { agentReachOutTools, localTime, parseWhen, reachOutNote, SCHEDULE_TOOL, START_GROUP, START_THREAD_TOOL } from '../server/agent-reach-out.mjs'

const BKK = 'Asia/Bangkok'
let root: string
let clock: number
const schedulers: any[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wizard-reach-out-case-'))
  for (const key of ['HOME', 'HERMES_HOME', 'WIZARD_OS_HOME', 'TMPDIR']) {
    const path = join(root, key.toLowerCase()); mkdirSync(path); vi.stubEnv(key, path)
  }
  clock = Date.parse('2026-10-31T03:00:00Z') // 10:00 Bangkok
})
afterEach(async () => {
  for (const s of schedulers.splice(0)) await s.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
function scheduler(deliver: any = async () => ({ run_id: 'fixture' })): any {
  const s = new Scheduler({ statePath: join(root, `s-${schedulers.length}.sqlite3`), now: () => clock, timezone: BKK, deliver, intervalMs: 3_600_000, trickleMs: 0 })
  schedulers.push(s)
  return s
}
// Pins: philosopher owns wizard_phil, private owns wizard_priv, main owns wizard_main.
const PINS: Record<string, string> = { wizard_phil: 'philosopher', wizard_priv: 'private', wizard_main: 'hermes' }
const tools = (s: any, extra: any = {}): any => agentReachOutTools({ scheduler: s, running: () => true, mainAgent: 'hermes', timezone: () => BKK, now: () => clock,
  ownsThread: (agentId: string, sessionId: string) => agentId !== 'hermes' && PINS[sessionId] === agentId, settleMs: 1000, ...extra })
const value = (r: any) => JSON.parse(r.content[0].text)

describe('wizard_start_thread', () => {
  it('is listed for routed agents only; the main agent keeps its plugin', async () => {
    const t = tools(scheduler())
    expect(t.list('hermes')).toEqual([])
    expect(t.list('philosopher').map((tool: any) => tool.name)).toEqual([START_THREAD_TOOL, SCHEDULE_TOOL])
    expect(t.list('private').map((tool: any) => tool.name)).toEqual([START_THREAD_TOOL, SCHEDULE_TOOL])
    const refused = await t.call(START_THREAD_TOOL, { title: 'x', instructions: 'y' }, 'hermes')
    expect(refused.isError).toBe(true)
    expect(await t.call('wizard_remind', {}, 'philosopher')).toBeUndefined()
  })

  it('opens one pinned thread for the calling agent, runs its opening turn now, and dedupes a retried call', async () => {
    const delivered: any[] = []
    const s = scheduler(async (o: any) => { delivered.push(o); return { run_id: `run-${delivered.length}` } })
    const t = tools(s)
    const args = { title: 'Stoicism · Morning practice', instructions: 'Open with one question about their morning routine.', from_session_id: 'wizard_phil', agent: 'private' }
    const opened = value(await t.call(START_THREAD_TOOL, args, 'philosopher'))
    expect(opened).toMatchObject({ opened: true, state: 'opened', title: 'Stoicism · Morning practice' })
    expect(opened.session_id).toMatch(/^wizard_agent_[0-9a-f-]{36}$/)
    expect(opened.link).toBe(`/wizard-os-home/?session=${opened.session_id}`)
    expect(delivered).toHaveLength(1)
    // The agent is the key's agent, never the argument.
    expect(delivered[0]).toMatchObject({ agent: 'philosopher', thread: opened.session_id, createThread: true, title: 'Stoicism · Morning practice', kind: 'run', manual: true, report: 'message' })
    expect(delivered[0].body.session_id).toBe(opened.session_id)
    expect(delivered[0].body.input).toMatch(/^\[Wizard schedule\] new thread/)
    expect(delivered[0].body.input).toContain('Open with one question about their morning routine.')
    expect(delivered[0].body.input).toContain('splits off from your thread wizard_phil')
    expect(delivered[0].body.input).not.toContain('Reporter format')
    // Retried tool call: same thread, no second run.
    const again = value(await t.call(START_THREAD_TOOL, args, 'philosopher'))
    expect(again).toMatchObject({ already: true, session_id: opened.session_id })
    // Never a second occurrence later (paused one-shot), and it never shows as a pending schedule.
    clock += 3_600_000; await s.tick()
    expect(delivered).toHaveLength(1)
    expect(value(await t.call(SCHEDULE_TOOL, { action: 'list' }, 'philosopher')).schedules).toEqual([])
    expect(s.list().filter((j: any) => j.group === START_GROUP)).toHaveLength(1)
  })

  it('refuses a from_session_id the agent does not own and reports a failed first admission honestly', async () => {
    const t = tools(scheduler(async () => { throw Error('agent offline') }))
    expect((await t.call(START_THREAD_TOOL, { title: 'A · B', instructions: 'Hi', from_session_id: 'wizard_main' }, 'philosopher')).isError).toBe(true)
    expect((await t.call(START_THREAD_TOOL, { title: 'A · B', instructions: 'Hi', from_session_id: 'wizard_priv' }, 'philosopher')).isError).toBe(true)
    expect((await t.call(START_THREAD_TOOL, { title: '', instructions: 'Hi' }, 'philosopher')).isError).toBe(true)
    const retrying = value(await t.call(START_THREAD_TOOL, { title: 'A · B', instructions: 'Hi' }, 'philosopher'))
    expect(retrying).toMatchObject({ opened: false, state: 'retrying' })
  })

  it('says so when the scheduler is off instead of promising a thread', async () => {
    const t = tools(scheduler(), { running: () => false })
    expect((await t.call(START_THREAD_TOOL, { title: 'A · B', instructions: 'Hi' }, 'philosopher')).content[0].text).toContain('switched off')
  })
})

describe('wizard_schedule for routed agents', () => {
  it('parses everyday schedule words into scheduler times', () => {
    expect(parseWhen('every morning')).toEqual({ cron: '30 8 * * *' })
    expect(parseWhen('daily 08:30')).toEqual({ cron: '30 8 * * *' })
    expect(parseWhen('Daily at 7:05')).toEqual({ cron: '5 7 * * *' })
    expect(parseWhen('weekdays 18:00')).toEqual({ cron: '0 18 * * 1-5' })
    expect(parseWhen('morning')).toEqual({ at: 'morning' })
    expect(parseWhen('overnight')).toEqual({ at: 'overnight' })
    expect(parseWhen('2026-11-01T09:00:00+07:00')).toEqual({ once: '2026-11-01T09:00:00+07:00' })
    expect(parseWhen('0 9 * * 1')).toEqual({ cron: '0 9 * * 1' })
    expect(parseWhen('daily 25:00')).toBeNull()
    expect(parseWhen('soon')).toBeNull()
  })

  it('a daily 08:30 message in its own new thread has nextRun at 08:30 owner time and writes as the agent', async () => {
    const delivered: any[] = []
    const s = scheduler(async (o: any) => { delivered.push(o); return { run_id: `run-${delivered.length}` } })
    const t = tools(s)
    const made = value(await t.call(SCHEDULE_TOOL, { action: 'create', when: 'daily 08:30', title: 'Philosophy · Morning thought', text: 'Share one short Stoic thought for the day.' }, 'philosopher'))
    expect(made).toMatchObject({ kind: 'message', when: { cron: '30 8 * * *' }, timezone: BKK, nextRun: '2026-11-01T01:30:00.000Z' })
    expect(made.nextRunLocal).toBe('Sun, 01 Nov 2026, 08:30')
    expect(made.thread).toMatch(/^wizard_agent_/)
    clock = Date.parse('2026-11-01T01:30:05Z'); await s.tick()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ agent: 'philosopher', thread: made.thread, createThread: true, title: 'Philosophy · Morning thought', report: 'message' })
    expect(delivered[0].body.input).toMatch(/^\[Wizard schedule\] scheduled message/)
    expect(delivered[0].body.input).toContain('[SILENT]')
    expect(delivered[0].body.input).not.toContain('Reporter format')
    // Next morning, same thread.
    expect(value(await t.call(SCHEDULE_TOOL, { action: 'list' }, 'philosopher')).schedules[0]).toMatchObject({ id: made.id, nextRun: '2026-11-02T01:30:00.000Z', thread: made.thread })
    clock = Date.parse('2026-11-02T01:30:05Z'); await s.tick()
    expect(delivered.map((o) => o.thread)).toEqual([made.thread, made.thread])
  })

  it('delivers into a thread only the calling agent owns; run keeps the Reporter, remind stays a reminder', async () => {
    const s = scheduler()
    const t = tools(s)
    expect((await t.call(SCHEDULE_TOOL, { when: 'morning', session_id: 'wizard_main', text: 'x' }, 'philosopher')).content[0].text).toContain('does not belong')
    expect((await t.call(SCHEDULE_TOOL, { when: 'morning', session_id: 'wizard_priv', text: 'x' }, 'philosopher')).content[0].text).toContain('does not belong')
    expect((await t.call(SCHEDULE_TOOL, { when: 'morning', session_id: 'wizard_phil', title: 'A · B', text: 'x' }, 'philosopher')).isError).toBe(true)
    expect((await t.call(SCHEDULE_TOOL, { when: 'morning', text: 'x' }, 'philosopher')).isError).toBe(true)
    expect((await t.call(SCHEDULE_TOOL, { when: 'at some point', session_id: 'wizard_phil', text: 'x' }, 'philosopher')).isError).toBe(true)
    const once = value(await t.call(SCHEDULE_TOOL, { when: 'morning', session_id: 'wizard_phil', text: 'Ask how the reading went.' }, 'philosopher'))
    expect(once).toMatchObject({ kind: 'message', window: 'morning', thread: 'wizard_phil', nextRun: '2026-11-01T01:30:00.000Z' })
    const run = value(await t.call(SCHEDULE_TOOL, { kind: 'run', when: 'weekdays 18:00', session_id: 'wizard_phil', text: 'Check the reading list.' }, 'philosopher'))
    const remind = value(await t.call(SCHEDULE_TOOL, { kind: 'remind', when: '2026-10-31T18:00:00+07:00', session_id: 'wizard_phil', text: 'Call the library' }, 'philosopher'))
    expect([run.kind, remind.kind]).toEqual(['run', 'remind'])
    const input = (id: string) => s.transaction(() => s.reserve(s.get(id), clock)).body.input
    expect(input(once.id)).toContain('scheduled message'); expect(input(once.id)).not.toContain('[SILENT]')
    expect(input(run.id)).toContain('Reporter format')
    expect(input(remind.id)).toContain('reminded')
  })

  it('list and cancel touch only the calling agent\'s jobs; private and main stay separate', async () => {
    const s = scheduler()
    const t = tools(s)
    const phil = value(await t.call(SCHEDULE_TOOL, { when: 'every morning', title: 'Philosophy · Daily', text: 'A thought.' }, 'philosopher'))
    const priv = value(await t.call(SCHEDULE_TOOL, { when: 'every morning', session_id: 'wizard_priv', text: 'A private check-in.' }, 'private'))
    const main = s.create({ name: 'Main job', when: { at: 'morning' }, prompt: 'main', thread: 'wizard_main' })
    expect(value(await t.call(SCHEDULE_TOOL, { action: 'list' }, 'philosopher')).schedules.map((j: any) => j.id)).toEqual([phil.id])
    expect(value(await t.call(SCHEDULE_TOOL, { action: 'list' }, 'private')).schedules.map((j: any) => j.id)).toEqual([priv.id])
    expect(s.get(priv.id).agent).toBe('private')
    for (const id of [priv.id, main.id]) expect((await t.call(SCHEDULE_TOOL, { action: 'cancel', id }, 'philosopher')).content[0].text).toContain('No schedule of yours')
    expect(s.list()).toHaveLength(3)
    expect(value(await t.call(SCHEDULE_TOOL, { action: 'cancel', id: phil.id }, 'philosopher'))).toEqual({ cancelled: phil.id, name: 'Philosophy · Daily' })
    expect(s.list().map((j: any) => j.id).sort()).toEqual([priv.id, main.id].sort())
  })

  it('the run-instruction note tells agents they can reach out', () => {
    expect(reachOutNote()).toContain(START_THREAD_TOOL)
    expect(reachOutNote()).toContain(SCHEDULE_TOOL)
    expect(localTime('2026-11-01T01:30:00.000Z', BKK)).toBe('Sun, 01 Nov 2026, 08:30')
  })

  it('the HTTP schedule body cannot claim the service-only agentMessage placement', () => {
    const s = scheduler()
    expect(() => s.create({ name: 'x', prompt: 'p', when: { at: 'morning' }, agentMessage: 'open' } as any)).toThrow(/unknown schedule field/)
    expect(() => s.create({ name: 'x', kind: 'remind', prompt: 'p', when: { at: 'morning' } }, { agentMessage: 'open' })).toThrow(/invalid agent message/)
  })
})
