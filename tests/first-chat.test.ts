// Issue 650: five-choice first chat (on for everyone; the wizard/first-chat-goals switch was removed).
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../server/scheduler.mjs'
import { TIPS, TIPS_GROUP, TIPS_THREAD_TITLE, onboardingTools, startTips } from '../server/onboarding.mjs'
import * as firstChat from '../server/first-chat.mjs'
import { FIRST_CHAT_CHOICES, FIRST_CHAT_NOTE, goalShaped, normalizePick, personalTips } from '../server/first-chat.mjs'

let root: string
let clock: number
const schedulers: any[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wizard-first-chat-case-'))
  for (const key of ['HOME', 'HERMES_HOME', 'WIZARD_OS_HOME', 'TMPDIR']) {
    const path = join(root, key.toLowerCase()); mkdirSync(path); vi.stubEnv(key, path)
  }
  clock = Date.parse('2026-10-23T03:00:00Z') // 10:00 Asia/Bangkok
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
const tools = (s: any): any => onboardingTools({ scheduler: s, running: () => true, timezone: () => 'Asia/Bangkok', now: () => clock, mainAgent: 'hermes' })

describe('five choices and the run note', () => {
  it('names the five choices in the issue order and points the agent at wizard-guide', () => {
    expect('FIRST_CHAT_SWITCH' in firstChat).toBe(false)
    expect(FIRST_CHAT_CHOICES).toEqual(['Get on top of my inbox', 'Organize my digital life', 'Grow my business', 'Find a job', 'Something else'])
    expect(FIRST_CHAT_NOTE).toContain('wizard-guide')
    expect(FIRST_CHAT_NOTE).toContain('First chat: five choices')
    expect(FIRST_CHAT_NOTE.length).toBeLessThan(200)
  })

  it('keeps the owner pick: a listed choice in its own words, anything else as their own short text', () => {
    expect(normalizePick('  get ON top of my INBOX ')).toBe('Get on top of my inbox')
    expect(normalizePick('learn\nSpanish\u202e')).toBe('learn Spanish')
    expect(normalizePick('x'.repeat(200))).toHaveLength(80)
    expect(normalizePick('')).toBe('')
    expect(goalShaped('Grow my business')).toBe(true)
    expect(goalShaped('Find a job')).toBe(true)
    expect(goalShaped('Get on top of my inbox')).toBe(false)
    expect(goalShaped('Organize my digital life')).toBe(false)
    expect(goalShaped('Something else')).toBe(false)
  })
})

describe('tips built from the pick', () => {
  it('four day 2-5 tips from the pick and the owner words, context only', () => {
    const tips = personalTips({ pick: 'Get on top of my inbox', about: 'I run a bakery and drown in supplier mail' })
    expect(tips).toHaveLength(4)
    for (const tip of tips) {
      expect(tip.prompt).toContain('picked "Get on top of my inbox"')
      expect(tip.prompt).toContain('I run a bakery and drown in supplier mail')
      expect(tip.prompt).toContain('Never ask how they are getting on, predict anything or track progress')
      expect(tip.prompt).toContain('Say stop tips to turn these off.')
      expect(tip.prompt).not.toMatch(/Goals app/)
    }
    // None of the five fixed topics.
    for (const fixed of TIPS) expect(tips.map((t) => t.prompt).join('\n')).not.toContain(fixed.text)
  })

  it('only a goal-shaped pick may get the Goals app, and only when one is installed', () => {
    for (const pick of ['Grow my business', 'Find a job']) {
      const tips = personalTips({ pick })
      expect(tips.slice(0, 3).some((t) => /Goals app/.test(t.prompt))).toBe(false)
      expect(tips[3].prompt).toContain('if `wizard_apps` lists a Goals app')
    }
    for (const pick of ['Organize my digital life', 'Something else']) expect(personalTips({ pick }).some((t) => /Goals/.test(t.prompt))).toBe(false)
  })

  it('a personal series lands on the next four mornings at 08:30 in the Tips thread (the first chat was day 1)', () => {
    const s = scheduler()
    const started = startTips(s, { agent: 'main', timezone: 'Asia/Bangkok', now: clock, pick: 'Find a job', about: 'product design roles' })
    expect(started).toMatchObject({ started: true, pick: 'Find a job' })
    const jobs = s.list().filter((j: any) => j.group === TIPS_GROUP).sort((a: any, b: any) => a.name.localeCompare(b.name))
    expect(jobs).toHaveLength(4)
    expect(jobs.map((j: any) => j.when.once)).toEqual(['2026-10-24T01:30:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-26T01:30:00.000Z', '2026-10-27T01:30:00.000Z'])
    expect(jobs.every((j: any) => j.kind === 'remind' && j.threadTitle === TIPS_THREAD_TITLE && j.thread === started.thread)).toBe(true)
    expect(jobs[0].name).toBe('Wizard tip 1 of 4')
    expect(jobs[0].prompt).toContain('product design roles')
  })
})

describe('wizard_tips builds the tips from the pick for everyone', () => {
  it('a pick builds the tips; no pick still starts the fixed five', async () => {
    const s = scheduler()
    const t = tools(s)
    expect(parse(await t.call('wizard_tips', { action: 'start', pick: 'Grow my business', about: 'a small pottery shop' }, 'hermes')).pick).toBe('Grow my business')
    expect(s.list()).toHaveLength(4)
    expect(s.list().some((j: any) => /a small pottery shop/.test(j.prompt))).toBe(true)
    expect(parse(await t.call('wizard_tips', { action: 'stop' }, 'hermes')).stopped).toBe(4)
    const fixed = parse(await t.call('wizard_tips', { action: 'start' }, 'hermes'))
    expect(fixed.started).toBe(true)
    expect(fixed.pick).toBeUndefined()
    expect(s.list()).toHaveLength(5)
    expect(s.list().some((j: any) => j.prompt.includes('Wizard tip 1 of 5 (build an app by voice)'))).toBe(true)
  })

  it('the tool offers pick and about as optional inputs', () => {
    const tips = tools(scheduler()).list().find((t: any) => t.name === 'wizard_tips')
    expect(Object.keys(tips.inputSchema.properties)).toEqual(['action', 'pick', 'about'])
    expect(tips.inputSchema.required).toEqual(['action'])
  })
})
