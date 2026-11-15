// Chats channels phase 3 (issue 441, WIZARD_CHANNEL_AGENT_FILING=1 with the channel store): the status line's
// `channel` field (with `space` as an alias), its refusal rules, the run note, and the scheduler's per-job channel.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelStore } from '../server/channel-store.mjs'
import { createSpaceFiling, CHANNEL_INSTRUCTIONS, subjectFitsChannel } from '../server/thread-spaces.mjs'
import { parseStatus, normalizeStatus } from '../server/thread-status.mjs'
import { Scheduler } from '../server/scheduler.mjs'
import { firstPostOfHistory, readHermesFirstPosts } from '../server/first-post.mjs'
import { DatabaseSync } from 'node:sqlite'

const dirs: string[] = [], closers: any[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c.close(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'channel-filing-')); dirs.push(d); return d }
function setup(opts: any = {}) {
  const d = home(), store = createChannelStore(join(d, 'channels.sqlite')); closers.push(store)
  store.seedAlerts()
  const project = store.create({ name: 'Synthetic project' }), other = store.create({ name: 'Synthetic other' })
  const foreign = store.create({ name: 'Foreign', agent: 'philosopher' })
  const filing = createSpaceFiling(join(d, 'ui-preferences.json'), store, { agentFiling: true, ...opts })
  return { d, store, project, other, foreign, filing }
}
const status = (extra: any) => `Reply\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'done', ask: 'Filed', ...extra })}[/WIZARD_STATUS_V1]`

it('the parser keeps channel and space (the alias), and drops invalid ids', () => {
  expect(parseStatus(status({ channel: 'channel-1' }))).toMatchObject({ channel: 'channel-1' })
  expect(parseStatus(status({ space: 'channel-1' }))).toMatchObject({ space: 'channel-1' })
  expect(normalizeStatus({ state: 'done', ask: 'x', channel: 'Not An Id' })).not.toHaveProperty('channel')
  expect(normalizeStatus({ state: 'done', ask: 'x', channel: 'a'.repeat(49) })).not.toHaveProperty('channel')
})

it('channel files an unfiled chat; space is an alias; channel wins over space', () => {
  const { store, project, other, filing } = setup()
  expect(filing.apply('hermes', 't1', parseStatus(status({ channel: project.id, subject: 'Synthetic' })))).toBe(true)
  expect(store.channelOf('hermes', 't1')).toBe(project.id)
  expect(store.members(project.id)[0].filedBy).toBe('agent')
  expect(filing.apply('hermes', 't2', { space: other.id, subject: 'Synthetic' })).toBe(true)
  expect(store.channelOf('hermes', 't2')).toBe(other.id)
  expect(filing.apply('hermes', 't3', { channel: project.id, space: other.id, subject: 'Synthetic' })).toBe(true)
  expect(store.channelOf('hermes', 't3')).toBe(project.id)
})

it('refuses: an owner-filed chat, Alerts, another agent’s or an archived channel, and a scheduled chat', () => {
  const alertsOf = (store: any) => store.list().channels.find((c: any) => c.kind === 'alerts').id
  const { store, project, other, foreign, filing } = setup({ scheduledThread: (agent: string, t: string) => agent === 'hermes' && t === 'wizard_schedule_x' })
  store.move({ sessionId: 'owned', channelId: other.id })
  expect(filing.apply('hermes', 'owned', { channel: project.id })).toBe(false)
  expect(store.channelOf('hermes', 'owned')).toBe(other.id)
  expect(filing.apply('hermes', 'a1', { channel: alertsOf(store) })).toBe(false)
  expect(filing.apply('hermes', 'a2', { channel: foreign.id })).toBe(false)
  expect(filing.apply('hermes', 'a3', { channel: 'missing' })).toBe(false)
  store.update(project.id, { archived: true })
  expect(filing.apply('hermes', 'a4', { channel: project.id })).toBe(false)
  expect(filing.apply('hermes', 'wizard_schedule_x', { channel: other.id })).toBe(false)
  for (const id of ['a1', 'a2', 'a3', 'a4', 'wizard_schedule_x']) expect(store.channelOf('hermes', id)).toBe('')
  // Another agent's own channel is fine for that agent.
  expect(filing.apply('philosopher', 'p1', { channel: foreign.id, subject: 'Foreign' })).toBe(true)
})

it('the run note gives the channel and post-title rules and the catalogue without Alerts', () => {
  const { store, project, filing } = setup()
  const note = filing.runNote('hermes')
  expect(note.startsWith(CHANNEL_INSTRUCTIONS)).toBe(true)
  expect(note).toContain('post name')
  expect(note).toContain(`"id":"${project.id}"`)
  expect(note).not.toContain('"name":"Alerts"')
  expect(note).not.toContain('Foreign')
  const routed = filing.runNote('philosopher')
  expect(routed).toContain('spaces_list')
  expect(routed).toContain('"name":"Foreign"')
  expect(store.list().channels.some((c: any) => c.kind === 'alerts')).toBe(true)
})

it('switch off: channel is ignored, space files as before, and the run note is unchanged', () => {
  const d = home(), store = createChannelStore(join(d, 'channels.sqlite')); closers.push(store)
  const project = store.create({ name: 'Synthetic project' })
  const off = createSpaceFiling(join(d, 'ui-preferences.json'), store)
  expect(off.apply('hermes', 't1', { channel: project.id })).toBe(false)
  expect(off.apply('hermes', 't1', { space: project.id })).toBe(true)
  expect(off.runNote('hermes')).toBe(`Your existing Spaces (data, agent "hermes"): ${JSON.stringify([{ id: project.id, name: 'Synthetic project' }])}`)
  expect(off.runNote('hermes')).not.toContain('Channels are on')
})

it('the scheduler takes a per-job channel only with the switch on, and the first occurrence opens the chat', async () => {
  const d = home(), clock = Date.parse('2026-11-11T00:00:00Z')
  const make = (channels: boolean, file: string) => { const s = new Scheduler({ statePath: join(d, file), deliver: async () => ({ run_id: 'r' }), now: () => clock, channels }); closers.push(s); return s }
  const job = { name: 'Synthetic', kind: 'remind', prompt: 'Synthetic reminder.', when: { every: 60 }, enabled: false }
  const off = make(false, 'off.sqlite3')
  expect(() => off.create({ ...job, channel: 'channel-1' })).toThrow(/unknown schedule field/)
  const plainOff = off.create(job)
  expect(plainOff).not.toHaveProperty('channel')
  const offOccurrence = off.runNow(plainOff.id)
  expect(offOccurrence).not.toHaveProperty('opensThread')
  expect(offOccurrence).not.toHaveProperty('channel')
  const on = make(true, 'on.sqlite3')
  expect(() => on.create({ ...job, channel: 'Not An Id' })).toThrow(/invalid channel/)
  const filed = on.create({ ...job, channel: 'channel-1' })
  expect(filed.channel).toBe('channel-1')
  const first = on.runNow(filed.id)
  expect(first).toMatchObject({ createThread: true, opensThread: true, channel: 'channel-1' })
  clock && await on.tick(false)
  const second = on.runNow(filed.id)
  expect(second).not.toHaveProperty('opensThread')
  expect(on.create(job).channel).toBeNull()
  // A job into an existing thread never opens (or files) a chat.
  const into = on.runNow(on.create({ ...job, thread: 'existing_thread' }).id)
  expect(into.createThread).toBe(false)
  expect(into).not.toHaveProperty('opensThread')
})

it('an alert the owner replied to stays the agent’s post (agentFirst), in a history page and from state.db', () => {
  const page = [{ role: 'assistant', content: 'Synthetic alert', timestamp: 1 }, { role: 'user', content: 'Synthetic thanks', timestamp: 2 }]
  expect(firstPostOfHistory(page, false)).toEqual({ text: 'Synthetic thanks', attachments: [] }) // switch off: unchanged
  expect(firstPostOfHistory(page, false, { agentFirst: true })).toBeNull()
  const owner = [{ role: 'user', content: 'Synthetic question', timestamp: 1 }, { role: 'assistant', content: 'Synthetic answer', timestamp: 2 }]
  expect(firstPostOfHistory(owner, false, { agentFirst: true })).toEqual({ text: 'Synthetic question', attachments: [] })
  const d = home(), path = join(d, 'state.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT, timestamp REAL)')
  const add = db.prepare('INSERT INTO messages(session_id, role, content, display_kind, timestamp) VALUES(?,?,?,?,?)')
  for (const id of ['alert', 'chat']) db.prepare('INSERT INTO sessions(id) VALUES(?)').run(id)
  add.run('alert', 'user', '[Wizard schedule] reminder\nSynthetic', null, 1); add.run('alert', 'assistant', 'Synthetic alert', null, 2); add.run('alert', 'user', 'Synthetic thanks', null, 3)
  add.run('chat', 'user', 'Synthetic question', null, 1); add.run('chat', 'assistant', 'Synthetic answer', null, 2)
  db.close()
  expect(readHermesFirstPosts(path, ['alert', 'chat']).get('alert')).toEqual({ text: 'Synthetic thanks', attachments: [] })
  const on = readHermesFirstPosts(path, ['alert', 'chat'], { agentFirst: true })
  expect(on.get('alert')).toBeNull()
  expect(on.get('chat')).toEqual({ text: 'Synthetic question', attachments: [] })
})

it('a notification job files its chat on the first occurrence that shows it (the fallback), once', () => {
  const d = home()
  let up = true, clock = Date.parse('2026-11-11T00:00:00Z')
  const s = new Scheduler({ statePath: join(d, 'n.sqlite3'), deliver: async () => ({ run_id: 'r' }), now: () => clock, channels: true,
    notifier: { available: () => up, send: async () => ({}) } }); closers.push(s)
  const job = s.create({ name: 'Synthetic', kind: 'run', prompt: 'Synthetic check.', when: { every: 60 }, enabled: false, deliver: 'notification' })
  const hidden = s.runNow(job.id)
  expect(hidden).toMatchObject({ deliver: 'notification', createThread: true }); expect(hidden).not.toHaveProperty('opensThread')
  s.db.prepare('UPDATE schedule_occurrences SET admitted=1 WHERE key=?').run(hidden.key)
  up = false; clock += 60_000
  const fallback = s.runNow(job.id)
  expect(fallback).toMatchObject({ fallback: true, opensThread: true })
  s.db.prepare('UPDATE schedule_occurrences SET admitted=1 WHERE key=?').run(fallback.key)
  clock += 60_000
  expect(s.runNow(job.id)).not.toHaveProperty('opensThread')
})

it('a timestamp tie between the first reply and the first owner message is broken by database order', () => {
  const d = home(), path = join(d, 'state.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT, timestamp REAL)')
  const add = db.prepare('INSERT INTO messages(session_id, role, content, display_kind, timestamp) VALUES(?,?,?,?,?)')
  for (const id of ['alert', 'chat']) db.prepare('INSERT INTO sessions(id) VALUES(?)').run(id)
  add.run('alert', 'assistant', 'Synthetic alert', null, 5); add.run('alert', 'user', 'Synthetic thanks', null, 5)
  add.run('chat', 'user', 'Synthetic question', null, 5); add.run('chat', 'assistant', 'Synthetic answer', 'final', 5)
  db.close()
  const on = readHermesFirstPosts(path, ['alert', 'chat'], { agentFirst: true })
  expect(on.get('alert')).toBeNull()
  expect(on.get('chat')).toEqual({ text: 'Synthetic question', attachments: [] })
})

// Issue 520: a chat with no clearly matching channel stays unfiled, and a chat the owner took out stays out.
describe('issue 520: wrong-channel filing and owner unfile', () => {
  const launch = (store: any) => {
    const ids: any = {}
    for (const name of ['WizardOS Launch', 'WizardOS Apps', 'WizardOS Chats', 'WizardOS Shell', 'Content']) ids[name] = store.create({ name }).id
    return ids
  }
  it('(a) the 15 Nov status line (subject Hermes, channel Content) files nothing', () => {
    const { store, filing } = setup(), ids = launch(store)
    const line = status({ channel: ids.Content, subject: 'Hermes', title: 'Philosopher transcription' })
    expect(filing.apply('hermes', 'wizard_1794715261676_96e5ef038e7d', parseStatus(line))).toBe(false)
    expect(store.channelOf('hermes', 'wizard_1794715261676_96e5ef038e7d')).toBe('')
    expect(filing.apply('hermes', 'novaire', { channel: ids.Content, subject: 'Music' })).toBe(false)
    expect(filing.apply('hermes', 'reddit', { channel: ids['WizardOS Launch'], subject: 'Hermes' })).toBe(false)
    // No subject: nothing to match, so nothing is filed.
    expect(filing.apply('hermes', 'bare', { channel: ids.Content })).toBe(false)
  })
  it('(b) owner unfile, then an agent status with channel, leaves it unfiled; an owner move back clears that', () => {
    const { store, filing } = setup(), ids = launch(store)
    expect(filing.apply('hermes', 'bug', { channel: ids['WizardOS Apps'], subject: 'WizardOS' })).toBe(true)
    store.move({ sessionId: 'bug', channelId: null })
    expect(store.ownerUnfiled('hermes', 'bug')).toBe(true)
    expect(filing.apply('hermes', 'bug', { channel: ids['WizardOS Apps'], subject: 'WizardOS' })).toBe(false)
    expect(store.fileIfUnfiled('hermes', 'bug', ids['WizardOS Apps'], 'agent')).toBe(false)
    expect(store.channelOf('hermes', 'bug')).toBe('')
    // Unfiling a chat that was in no channel leaves no mark.
    store.move({ sessionId: 'never', channelId: null })
    expect(store.ownerUnfiled('hermes', 'never')).toBe(false)
    store.move({ sessionId: 'bug', channelId: ids['WizardOS Shell'] })
    expect(store.ownerUnfiled('hermes', 'bug')).toBe(false)
    expect(store.channelOf('hermes', 'bug')).toBe(ids['WizardOS Shell'])
    // A deleted chat drops its mark.
    store.move({ sessionId: 'bug', channelId: null }); store.forget('hermes', 'bug')
    expect(store.ownerUnfiled('hermes', 'bug')).toBe(false)
  })
  it('(c) a clear match (Messenger bug, subject WizardOS) still files into WizardOS Apps', () => {
    const { store, filing } = setup(), ids = launch(store)
    expect(filing.apply('hermes', 'messenger', parseStatus(status({ channel: ids['WizardOS Apps'], subject: 'WizardOS', title: 'Messenger sync bug' })))).toBe(true)
    expect(store.channelOf('hermes', 'messenger')).toBe(ids['WizardOS Apps'])
  })
  it('short exact names match; a shared generic word (Google Apps vs WizardOS Apps) does not', () => {
    const { store, filing } = setup(), ids = launch(store)
    const ai = store.create({ name: 'AI' }).id
    expect(subjectFitsChannel('AI', { id: ai, name: 'AI' })).toBe(true)
    expect(filing.apply('hermes', 'ai', { channel: ai, subject: 'AI' })).toBe(true)
    expect(filing.apply('hermes', 'google', { channel: ids['WizardOS Apps'], subject: 'Google Apps' })).toBe(false)
    expect(subjectFitsChannel('Apps', { id: 'x', name: 'WizardOS Apps' })).toBe(false)
    expect(subjectFitsChannel('WizardOS', { id: 'x', name: 'WizardOS Apps' })).toBe(true)
  })
  it('learns a channel’s subjects from owner-filed chats, lists them in the catalogue, and then files that subject', () => {
    const { store, filing } = setup(), ids = launch(store)
    expect(filing.apply('hermes', 'track2', { channel: ids.Content, subject: 'Music' })).toBe(false)
    store.move({ sessionId: 'track1', channelId: ids.Content })
    filing.apply('hermes', 'track1', { subject: 'Music' })
    expect(store.channelSubjects(ids.Content)).toEqual(['music'])
    expect(filing.runNote('hermes')).toContain(JSON.stringify({ id: ids.Content, name: 'Content', subjects: ['music'] }))
    expect(filing.apply('hermes', 'track2', { channel: ids.Content, subject: 'Music' })).toBe(true)
    // An agent-filed chat teaches nothing (no self-reinforcing mistakes).
    filing.apply('hermes', 'track2', { subject: 'Hermes' })
    expect(store.channelSubjects(ids.Content)).toEqual(['music'])
    expect(filing.runNote('hermes')).toContain('never the closest-sounding one')
  })
  it('a migration-filed chat teaches its channel nothing, so a later Hermes chat naming that channel stays unfiled', () => {
    const { d, store, filing } = setup(), ids = launch(store)
    const db = new DatabaseSync(join(d, 'channels.sqlite'))
    db.prepare("INSERT INTO membership(agent,session_id,channel_id,filed_at,filed_by) VALUES('hermes','old-hermes',?,?,'migration')").run(ids['WizardOS Launch'], new Date().toISOString())
    db.close()
    expect(store.channelOf('hermes', 'old-hermes')).toBe(ids['WizardOS Launch'])
    filing.apply('hermes', 'old-hermes', { subject: 'Hermes' })
    expect(store.channelSubjects(ids['WizardOS Launch'])).toEqual([])
    expect(filing.apply('hermes', 'reddit-audit', { channel: ids['WizardOS Launch'], subject: 'Hermes' })).toBe(false)
    expect(store.channelOf('hermes', 'reddit-audit')).toBe('')
  })
  it('drops subjects learned by the first build once, then keeps owner-learned ones across restarts', async () => {
    const d = home(), path = join(d, 'channels.sqlite')
    const first = createChannelStore(path); const c = first.create({ name: 'Content' })
    first.learnSubject(c.id, 'hermes'); await first.close()
    const db = new DatabaseSync(path); db.exec("DELETE FROM meta WHERE key='subjects_owner_only'"); db.close()
    const second = createChannelStore(path)
    expect(second.channelSubjects(c.id)).toEqual([])
    second.learnSubject(c.id, 'music'); await second.close()
    const third = createChannelStore(path); closers.push(third)
    expect(third.channelSubjects(c.id)).toEqual(['music'])
  })
  it('prune drops the marks of deleted chats; deleting a channel drops its subjects', () => {
    const { store, filing } = setup(), ids = launch(store)
    store.move({ sessionId: 'gone', channelId: ids.Content }); store.move({ sessionId: 'gone', channelId: null })
    store.move({ sessionId: 'kept', channelId: ids.Content }); store.move({ sessionId: 'kept', channelId: null })
    store.prune('hermes', (id: string) => id !== 'gone')
    expect(store.ownerUnfiled('hermes', 'gone')).toBe(false)
    expect(store.ownerUnfiled('hermes', 'kept')).toBe(true)
    store.move({ sessionId: 'x', channelId: ids.Content }); filing.apply('hermes', 'x', { subject: 'Music' })
    store.remove(ids.Content)
    expect(store.channelSubjects(ids.Content)).toEqual([])
  })
})
