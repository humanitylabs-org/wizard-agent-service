// Issue 584: a Chats list build asked the scheduler "did a job open this chat?" once per chat row, and each ask
// re-read and parsed the whole schedules table. One list build now reads it at most once.
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Scheduler, scheduledThreadOf } from '../server/scheduler.mjs'
import { createChannelStore } from '../server/channel-store.mjs'
import { createSpaceFiling } from '../server/thread-spaces.mjs'

const dirs: string[] = [], closers: any[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c.close?.(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'sched-index-')); dirs.push(d); return d }
const scheduler = (d: string) => new Scheduler({ statePath: join(d, 'sched.db'), deliver: async () => ({}), intervalMs: 0 })
const job = (i: number, extra: any = {}) => ({ id: `job-${i}`, agent: i % 3 ? 'hermes' : 'philosopher', enabled: i % 30 === 0, createThread: i % 2 === 0,
  thread: `opened_${i}`, when: { every: 60 }, prompt: 'x'.repeat(2000), ...extra })

it('one list build with 500 schedules and 1,000 chats reads the schedules table at most once', () => {
  const d = home(), s = scheduler(d)
  for (let i = 0; i < 500; i++) s.save(job(i))
  const store = createChannelStore(join(d, 'channels.sqlite')); closers.push(store); store.seedAlerts()
  const channel = store.create({ name: 'Synthetic project' })
  const filing = createSpaceFiling(join(d, 'ui-preferences.json'), store, { agentFiling: true, scheduledThread: (a: string, t: string) => scheduledThreadOf(s, a, t, 'hermes') })
  const build = () => { for (let i = 0; i < 1000; i++) filing.apply('hermes', i < 500 ? `opened_${i}` : `plain_${i}`, { channel: channel.id, subject: 'Synthetic' }) }
  const list = vi.spyOn(s, 'list')
  build() // the first build also files the chats (one store write each)
  expect(list.mock.calls.length).toBeLessThanOrEqual(1)
  // The next list build over the same rows: what every phone poll repeats.
  list.mockClear()
  const started = performance.now()
  build()
  const took = performance.now() - started
  expect(list.mock.calls.length).toBe(0)
  expect(took).toBeLessThan(50)
  // The scheduler check alone, 1,000 rows.
  const t0 = performance.now()
  for (let i = 0; i < 1000; i++) scheduledThreadOf(s, 'hermes', `opened_${i % 500}`, 'hermes')
  expect(performance.now() - t0).toBeLessThan(50)
  // A job-opened chat of this agent stays unfiled; an ordinary chat and another agent's job chat are filed.
  expect(store.channelOf('hermes', 'opened_2')).toBe('')
  expect(store.channelOf('hermes', 'opened_1')).toBe(channel.id) // createThread false
  expect(store.channelOf('hermes', 'opened_6')).toBe(channel.id) // philosopher's job
  expect(store.channelOf('hermes', 'plain_700')).toBe(channel.id)
})

it('the answer follows schedule writes, deletes and another connection’s commits', () => {
  const d = home(), s = scheduler(d)
  expect(scheduledThreadOf(s, 'hermes', 't1')).toBe(false)
  s.save(job(1, { thread: 't1', createThread: true, agent: 'main' }))
  expect(scheduledThreadOf(s, 'hermes', 't1')).toBe(true) // main answers to both names
  expect(scheduledThreadOf(s, 'philosopher', 't1')).toBe(false)
  s.save(job(1, { thread: 't1', createThread: false, agent: 'main' }))
  expect(scheduledThreadOf(s, 'hermes', 't1')).toBe(false)
  s.save(job(2, { thread: 't2', createThread: true, agent: 'philosopher' }))
  expect(scheduledThreadOf(s, 'philosopher', 't2')).toBe(true)
  s.delete('job-2')
  expect(scheduledThreadOf(s, 'philosopher', 't2')).toBe(false)
  // A write from outside this Scheduler (another process on the same file).
  const other = new DatabaseSync(join(d, 'sched.db'))
  other.prepare('INSERT OR REPLACE INTO schedules VALUES (?, ?)').run('job-3', JSON.stringify(job(3, { thread: 't3', createThread: true, agent: 'philosopher' })))
  other.close()
  expect(scheduledThreadOf(s, 'philosopher', 't3')).toBe(true)
  expect(scheduledThreadOf(null, 'hermes', 't1')).toBe(false)
})
