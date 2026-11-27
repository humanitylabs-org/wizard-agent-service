// Issue 702: automatic chat tags (switch wizard/auto-tags). The classifier, the covers store and the tagger's rules.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChannelStore, channelRequest, COVERS_MAX } from '../server/channel-store.mjs'
import { chatKind, createAutoTagger, decideTags, seedCoversFor, readRecentChats, MODEL_CONFIDENCE } from '../server/auto-tags.mjs'
import { parseStatus } from '../server/thread-status.mjs'

const dirs: string[] = [], stores: any[] = []
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'auto-tags-')); dirs.push(d); return d }
const open = () => { const s = createChannelStore(join(home(), 'channels.sqlite')); stores.push(s); s.migrateTags(); return s }
const CONTENT_COVERS = ['clips', 'Clips Pipeline', 'TSR', 'podcast', 'episode', 'Shorts', 'DeFleur video', 'thumbnail', 'fact check']
const id = (n: number) => `wizard_17957000000${String(n).padStart(2, '0')}_aaaaaaaaaaaa`

function setup({ on = true, router = null as any, fetchImpl = fetch as any } = {}) {
  const store = open()
  const content = store.create({ name: '🎬 Content' }), reports = store.create({ name: '📊 Reports' }), reminders = store.create({ name: '⏰ Reminders' })
  const wizardos = store.create({ name: 'WizardOS Chats' }), hermes = store.create({ name: 'Hermes' })
  const log: string[] = []
  const state = { on }
  const tagger = createAutoTagger({ store: () => store, on: () => state.on, router: () => router, fetchImpl, log: (l: string) => log.push(l) })
  const names = Object.fromEntries([content, reports, reminders, wizardos, hermes].map(c => [c.id, c.name.replace(/^\W+\s*/u, '')]))
  const tags = (thread: string) => store.tagsOf('hermes', thread).map((t: string) => names[t])
  return { store, tagger, content, reports, reminders, wizardos, hermes, log, state, tags }
}

describe('chat kind', () => {
  it('reads the kind from the first owner message and the source', () => {
    expect(chatKind({ first: 'Remind me to call the dentist tomorrow at 9' })).toBe('reminder')
    expect(chatKind({ first: 'Add renew passport to my to-do list' })).toBe('todo')
    expect(chatKind({ first: '', source: 'cron', title: 'Wizard Topics' })).toBe('digest')
    expect(chatKind({ first: 'anything', scheduled: true })).toBe('digest')
    expect(chatKind({ first: 'Look up whether the security canary token we saw is known' })).toBe('lookup')
    expect(chatKind({ first: 'What is Hermes Enterprise on Microsoft and does it matter for us?' })).toBe('lookup')
    expect(chatKind({ first: 'Evaluate whether Matrix is a good fit for WizardOS messaging' })).toBe('evaluation')
    expect(chatKind({ first: 'Scan job boards for demand for agent builders and report back' })).toBe('report')
    expect(chatKind({ first: 'Give me a roundup of this week\u2019s clips' })).toBe('report')
    expect(chatKind({ first: 'How tall is the Eiffel tower?' })).toBe('question')
  })
  it('never calls a build, bug, app-work or draft chat a question, even when it opens with one', () => {
    for (const first of ['Can you fix the bug where Messenger sync stops?', 'Why does the Hermes pin fail on the box?', 'Draft a message to Jan about the release',
      'Could you build the release and deploy it?', 'Is the clips pipeline render stuck?', 'Write an email to Anna about Friday', 'Reply to Jan about the invoice'])
      expect(chatKind({ first }), first).toBe('work')
  })
})

describe('covers in the channel store', () => {
  it('seeds once, takes the owner\u2019s list, keeps what was learned and drops covers with the channel', () => {
    const s = open(), c = s.create({ name: '🎬 Content' })
    expect(seedCoversFor(c, ['clips'])).toEqual(['Content', 'clips'])
    expect(seedCoversFor({ name: '📊 Reports' })).toEqual(['kind: question', 'kind: lookup', 'kind: evaluation', 'kind: digest', 'kind: report'])
    expect(seedCoversFor({ name: '⏰ Reminders' })).toEqual(['kind: reminder', 'kind: todo'])
    const v0 = s.coversVersion()
    expect(s.seedCovers(c.id, ['Content'])).toBe(true)
    expect(s.seedCovers(c.id, ['Other'])).toBe(false)
    expect(s.coversVersion()).toBeGreaterThan(v0)
    expect(s.learnCover(c.id, 'Clip fact check')).toBe(true)
    expect(s.covers(c.id)).toMatchObject({ covers: ['Content'], learned: ['Clip fact check'], not: [] })
    expect(s.setCovers(c.id, ['clips', 'Kind:  Report', 'clips'])).toMatchObject({ covers: ['clips', 'kind: report'], learned: ['Clip fact check'] })
    expect(() => s.setCovers(c.id, ['kind: nonsense'])).toThrow('invalid_covers')
    expect(() => s.setCovers(c.id, Array.from({ length: COVERS_MAX + 1 }, (_, i) => `w${i}`))).toThrow('invalid_covers')
    expect(() => s.setCovers(c.id, 'clips')).toThrow('invalid_covers')
    expect(s.learnCover(c.id, 'clips', true)).toBe(false) // the owner's own list wins over a removal
    expect(s.learnCover(c.id, 'Hermes', true)).toBe(true)
    expect(s.covers(c.id).not).toEqual(['Hermes'])
    // Alerts and Daily never take a tag from here (Daily keeps one chat per day).
    s.seedDaily(); s.seedAlerts()
    expect(s.tagRefusal('hermes', 'wizard_1795700000001_aaaaaaaaaaaa', 'daily')).toBe('Daily holds one chat per day')
    expect(s.tagRefusal('hermes', 'wizard_1795700000001_aaaaaaaaaaaa', 'alerts')).toBe('Alerts is filed by the Service')
    expect(channelRequest(s, 'GET', 'covers', new URLSearchParams({ id: c.id }), null).covers).toEqual(['clips', 'kind: report'])
    expect(channelRequest(s, 'PUT', 'covers', new URLSearchParams(), { id: c.id, covers: ['podcast'] }).covers).toEqual(['podcast'])
    expect(() => channelRequest(s, 'PUT', 'covers', new URLSearchParams(), { id: c.id, covers: [], extra: 1 })).toThrow('invalid_request')
    // One entry at a time: two devices editing from stale lists both keep their change.
    expect(channelRequest(s, 'PUT', 'covers', new URLSearchParams(), { id: c.id, add: 'TSR' }).covers).toEqual(['podcast', 'TSR'])
    expect(channelRequest(s, 'PUT', 'covers', new URLSearchParams(), { id: c.id, add: 'tsr' }).covers).toEqual(['podcast', 'TSR'])
    expect(channelRequest(s, 'PUT', 'covers', new URLSearchParams(), { id: c.id, remove: 'Podcast' }).covers).toEqual(['TSR'])
    expect(() => channelRequest(s, 'PUT', 'covers', new URLSearchParams(), { id: c.id, add: 'x', remove: 'y' })).toThrow('invalid_request')
    expect(() => channelRequest(s, 'PUT', 'covers', new URLSearchParams(), { id: c.id, add: 'kind: nope' })).toThrow('invalid_covers')
    expect(channelRequest(s, 'GET', false, new URLSearchParams(), null, { autoTags: true }).autoTags).toBe(true)
    expect(channelRequest(s, 'GET', false, new URLSearchParams(), null, {}).autoTags).toBeUndefined()
    s.remove(c.id)
    expect(s.coversAll().has(c.id)).toBe(false)
  })
})

describe('the tagger', () => {
  it('replays the six clips chats into Content (the roundup also into Reports) and the five report chats into Reports', () => {
    const t = setup()
    t.store.setCovers(t.content.id, CONTENT_COVERS)
    const replay: [number, string, string, any][] = [
      [1, 'Clips roundup', 'Give me a roundup of this week\u2019s clips', { channel: t.reports.id, subject: 'Content' }],
      [2, 'Clip fact check', 'Fact check the claims in clip 14', { channel: t.reports.id, subject: 'Content' }],
      [3, 'TSR episode 41 clips', 'Cut the TSR episode 41 into Shorts', { subject: 'Content' }],
      [4, 'Clips Pipeline render queue', 'Why is the clips pipeline render stuck?', { channel: t.content.id, subject: 'Infrastructure' }],
      [5, 'Clips Pipeline captions', 'Add burned-in captions to the clips pipeline', { channel: t.content.id, subject: 'WizardOS' }],
      [6, 'Podcast thumbnail', 'Make a thumbnail for the new podcast episode', { subject: 'Design' }],
      [11, 'Research', 'Look up whether the security canary token we saw is known', { subject: 'Security' }],
      [12, 'Hermes Enterprise on Microsoft', 'What is Hermes Enterprise on Microsoft and does it matter for us?', { subject: 'Hermes' }],
      [13, 'Matrix fit for WizardOS', 'Evaluate whether Matrix is a good fit for WizardOS messaging', { channel: t.wizardos.id, subject: 'WizardOS' }],
      [14, 'Job demand scan', 'Scan job boards for demand for agent builders and report back', { channel: t.reports.id, subject: 'Reports' }],
      [20, 'Hermes engine pin', 'Why does the Hermes pin fail on the box?', { subject: 'Hermes' }],
      [21, 'Messenger sync bug', 'Can you fix the bug where Messenger sync stops?', { channel: t.wizardos.id, subject: 'WizardOS' }],
      [22, 'Draft to Jan', 'Draft a message to Jan about the release', { subject: 'WizardOS' }],
      [23, 'Dentist reminder', 'Remind me to call the dentist tomorrow at 9', { subject: 'Personal' }],
    ]
    for (const [n, title, first, status] of replay) t.tagger.apply('hermes', id(n), status, { title, wizard_first_request: first })
    t.tagger.apply('hermes', 'wizard_topics', { subject: 'Topics' }, { title: 'Wizard Topics', source: 'cron' })
    for (const n of [1, 2, 3, 4, 5, 6]) expect(t.tags(id(n)), `clips chat ${n}`).toContain('Content')
    expect(t.tags(id(1))).toEqual(expect.arrayContaining(['Content', 'Reports']))
    for (const n of [11, 12, 13, 14]) expect(t.tags(id(n)), `report chat ${n}`).toContain('Reports')
    expect(t.tags('wizard_topics')).toContain('Reports')
    // Each keeps or gains its topic tag.
    expect(t.tags(id(12))).toContain('Hermes'); expect(t.tags(id(13))).toContain('WizardOS Chats')
    // Precision: no WizardOS or Hermes chat in Content, no build, bug or draft chat in Reports, remind me in Reminders.
    for (const n of [12, 13, 20, 21, 22]) expect(t.tags(id(n))).not.toContain('Content')
    for (const n of [20, 21, 22, 4]) expect(t.tags(id(n))).not.toContain('Reports')
    expect(t.tags(id(23))).toEqual(['Reminders'])
    // No silent refusals: the fact check's Reports hint is logged and told to the agent once.
    expect(t.log.some(l => l.includes(id(2)) && l.includes('Reports refused (subject Content)'))).toBe(true)
    expect(t.tagger.runNote('hermes', id(2))).toContain('Reports refused: subject Content')
    expect(t.tagger.runNote('hermes', id(2))).not.toContain('Reports refused')
  })

  it('never puts back a tag the owner removed, from a status line or the nightly pass', () => {
    const t = setup()
    t.store.setCovers(t.content.id, CONTENT_COVERS)
    t.tagger.apply('hermes', id(1), { subject: 'Content' }, { title: 'Clips roundup', wizard_first_request: 'Roundup of the clips' })
    expect(t.tags(id(1))).toContain('Content')
    t.store.removeTag({ sessionId: id(1), channelId: t.content.id, agent: 'hermes', by: 'owner' })
    t.tagger.learnOwner('hermes', id(1), t.content.id, false)
    t.tagger.apply('hermes', id(1), { subject: 'Content', title: 'Clips roundup again' }, { title: 'Clips roundup again', wizard_first_request: 'Roundup of the clips' })
    t.tagger.sweep('hermes', [{ id: id(1), title: 'Clips roundup', first: 'Roundup of the clips', subject: 'Content' }])
    expect(t.tags(id(1))).not.toContain('Content')
    expect(t.tagger.agentTags('hermes', id(1), [t.content.id]).refused).toEqual([{ channel: t.content.id, reason: 'the owner removed this tag' }])
    expect(t.tagger.agentTags('hermes', id(1), ['Content']).refused[0].reason).toBe('the owner removed this tag')
    // The removal taught Content the opposite: a chat like it is no longer tagged by learned evidence.
    expect(t.store.covers(t.content.id).not).toEqual(expect.arrayContaining(['Content', 'Clips roundup']))
  })

  it('changes the next decision when the owner edits a channel\u2019s covers, and learns from his tags', () => {
    const t = setup()
    t.tagger.apply('hermes', id(3), { subject: 'Video' }, { title: 'TSR episode 41', wizard_first_request: 'Cut it into Shorts' })
    expect(t.tags(id(3))).toEqual([])
    t.store.setCovers(t.content.id, ['TSR'])
    t.tagger.apply('hermes', id(3), { subject: 'Video' }, { title: 'TSR episode 41', wizard_first_request: 'Cut it into Shorts' })
    expect(t.tags(id(3))).toEqual(['Content'])
    // An owner add teaches: the subject and title of that chat now point at the channel.
    t.tagger.apply('hermes', id(7), { subject: 'Studio' }, { title: 'Lighting for the studio shoot', wizard_first_request: 'Which lights?' })
    t.store.addTag({ sessionId: id(7), channelId: t.content.id, agent: 'hermes', by: 'owner' })
    t.tagger.learnOwner('hermes', id(7), t.content.id, true)
    t.tagger.apply('hermes', id(8), { subject: 'Studio' }, { title: 'Studio microphones', wizard_first_request: 'Which mic?' })
    expect(t.tags(id(8))).toContain('Content')
  })

  it('takes several channels from one status line and inherits a parent chat\u2019s tags', () => {
    const t = setup()
    const status = parseStatus(`ok\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'done', ask: 'x', subject: 'Content', channels: [t.content.id, t.wizardos.id, 'NOT AN ID'] })}[/WIZARD_STATUS_V1]`)
    expect(status?.channels).toEqual([t.content.id, t.wizardos.id])
    t.tagger.apply('hermes', id(30), status, { title: 'Content plan for WizardOS', wizard_first_request: 'Plan the WizardOS launch content' })
    expect(t.tags(id(30))).toEqual(expect.arrayContaining(['Content', 'WizardOS Chats']))
    t.tagger.apply('hermes', id(31), { subject: 'Misc' }, { title: 'Follow up', wizard_first_request: 'continue', parent_session_id: id(30) })
    expect(t.tags(id(31))).toEqual(expect.arrayContaining(['Content', 'WizardOS Chats']))
  })

  it('changes nothing while the switch is off', () => {
    const t = setup({ on: false })
    t.store.setCovers(t.content.id, CONTENT_COVERS)
    expect(t.tagger.apply('hermes', id(1), { channel: t.reports.id, subject: 'Content' }, { title: 'Clips roundup' })).toBe(0)
    expect(t.tags(id(1))).toEqual([])
    expect(t.tagger.runNote('hermes', id(1))).toBe('')
    expect(t.tagger.sweep('hermes', [{ id: id(1), title: 'Clips roundup' }])).toEqual({ seen: 0, tagged: 0, left: 0 })
    expect(t.log).toEqual([])
  })

  it('asks only a private model about an ambiguous chat, and only takes a sure answer', async () => {
    const calls: any[] = []
    const answer = { value: 0.9 }
    const fetchImpl = async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); const ids = JSON.parse(JSON.parse(init.body).messages[1].content).channels.map((c: any) => c.id); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ channels: ids.map((x: string) => ({ id: x, confidence: answer.value })) }) } }] }), { status: 200 }) }
    const t = setup({ router: { url: 'http://127.0.0.1:9/v1/chat/completions', model: 'm' }, fetchImpl })
    t.store.learnCover(t.content.id, 'storyboard')
    t.tagger.apply('hermes', id(40), { subject: 'Planning' }, { title: 'Storyboard ideas for May', wizard_first_request: 'ideas' })
    await t.tagger.settled()
    expect(calls).toHaveLength(1)
    expect(t.tags(id(40))).toEqual(['Content'])
    answer.value = MODEL_CONFIDENCE - 0.2
    t.tagger.apply('hermes', id(41), { subject: 'Planning' }, { title: 'Storyboard for June', wizard_first_request: 'ideas' })
    await t.tagger.settled()
    expect(calls).toHaveLength(2)
    expect(t.tags(id(41))).toEqual([])
    // No private router: nothing is sent anywhere; the chat waits for the nightly pass, and the skip is logged.
    const n = setup({ router: null, fetchImpl })
    n.store.learnCover(n.content.id, 'storyboard')
    n.tagger.apply('hermes', id(42), { subject: 'Planning' }, { title: 'Storyboard for July', wizard_first_request: 'ideas' })
    await n.tagger.settled()
    expect(calls).toHaveLength(2)
    expect(n.log.some(l => l.includes('no private model to ask'))).toBe(true)
  })

  it('lists what the nightly pass could not decide once in the main agent\u2019s run note', () => {
    const t = setup()
    t.store.setCovers(t.content.id, CONTENT_COVERS)
    const r = t.tagger.sweep('hermes', [{ id: id(50), title: 'Clips for Friday', first: 'pick clips' }, { id: id(51), title: 'Garden fence', first: 'Paint the fence' }])
    expect(r).toEqual({ seen: 2, tagged: 1, left: 1 })
    expect(t.tags(id(50))).toEqual(['Content'])
    const note = t.tagger.runNote('hermes', id(60))
    expect(note).toContain('Untagged chats from the nightly tag pass')
    expect(note).toContain(id(51))
    expect(t.tagger.runNote('hermes', id(60))).not.toContain(id(51))
  })

  it('adds no measurable time to a list rebuild: a repeat build of 1,000 rows decides nothing again', () => {
    const t = setup()
    t.store.setCovers(t.content.id, CONTENT_COVERS)
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `wizard_1795${String(i).padStart(9, '0')}_bbbbbbbbbbbb`, title: i % 3 ? `Chat ${i} about gardening` : `Clips batch ${i}`, wizard_first_request: 'hello' }))
    for (const r of rows) t.tagger.apply('hermes', r.id, { subject: 'Life' }, r)
    const started = performance.now()
    for (const r of rows) t.tagger.apply('hermes', r.id, { subject: 'Life' }, r)
    expect(performance.now() - started).toBeLessThan(80)
  })
})

describe('reading recent chats for the passes', () => {
  it('reads visible recent chats with their last status subject, read-only', () => {
    const dir = home(), path = join(dir, 'state.db'), db = new DatabaseSync(path)
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, source TEXT, started_at REAL, last_activity_at REAL, hidden INTEGER, archived INTEGER, parent_session_id TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
    const now = Date.now() / 1000
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)').run(id(1), 'Clips roundup', 'wizard-mobile', now - 100, now - 50, 0, 0, null)
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)').run(id(2), 'Old', 'wizard-mobile', now - 90 * 86400, now - 90 * 86400, 0, 0, null)
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)').run(id(3), 'Hidden', 'wizard-mobile', now - 100, now - 50, 1, 0, null)
    db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run(id(1), 'assistant', `done\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'done', ask: 'x', subject: 'Content' })}[/WIZARD_STATUS_V1]`, now - 50)
    db.close()
    expect(readRecentChats(path, now - 7 * 86400)).toEqual([{ id: id(1), title: 'Clips roundup', source: 'wizard-mobile', parent_session_id: null, subject: 'Content', app_id: '' }])
    expect(readRecentChats(join(dir, 'missing.db'), 0)).toBeNull()
  })
})

describe('decideTags', () => {
  it('refuses the agent\u2019s hint with its reason when nothing about the chat fits', () => {
    const out = decideTags({ title: 'Kitchen tiles', subject: 'Home', first: 'Pick tiles', hints: ['c1'] }, [{ id: 'c1', name: 'Content', kind: '', archived: false, covers: { covers: ['clips'], learned: [], not: [] }, subjects: new Set() }])
    expect(out).toEqual({ tag: [], ambiguous: [], refused: [{ id: 'c1', why: 'subject Home' }] })
  })
})
