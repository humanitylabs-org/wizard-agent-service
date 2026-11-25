// Issue 608 (switch wizard/chat-tags, off by default): channels become tags. A chat carries several of its agent's
// channels; `membership` keeps the primary tag so Daily, agent filing and older shells keep working.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelStore, channelRequest } from '../server/channel-store.mjs'
import { createSpaceFiling, TAG_INSTRUCTIONS } from '../server/thread-spaces.mjs'
import { listRow } from '../server/session-list-view.mjs'
import { lookSwitchOn, CHAT_TAGS_SWITCH } from '../server/channels-switch.mjs'

const dirs: string[] = [], stores: any[] = []
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'channel-tags-')); dirs.push(d); return d }
function setup() {
  const d = home(), store = createChannelStore(join(d, 'channels.sqlite')); stores.push(store)
  const a = store.create({ name: '🧠 Philosopher' }), b = store.create({ name: 'WizardOS' }), c = store.create({ name: 'Money' })
  const foreign = store.create({ name: 'Foreign', agent: 'research' })
  return { d, store, a, b, c, foreign }
}
const ids = (set: any) => [...(set?.ids || [])].sort()

describe('tag store', () => {
  it('the switch id is wizard/chat-tags and reads off without a Look file', () => {
    expect(CHAT_TAGS_SWITCH).toBe('wizard/chat-tags')
    expect(lookSwitchOn('', CHAT_TAGS_SWITCH)).toBe(false)
    expect(lookSwitchOn(JSON.stringify({ version: 1, tweaks: { 'wizard/chat-tags': { on: true } } }), CHAT_TAGS_SWITCH)).toBe(true)
  })

  it('a store that never had Tags on writes no tag rows (switch off changes nothing)', () => {
    const { d, store, a, b } = setup()
    store.move({ sessionId: 't1', channelId: a.id }); store.move({ sessionId: 't1', channelId: b.id }); store.fileIfUnfiled('hermes', 't2', a.id)
    store.close()
    const again = createChannelStore(join(d, 'channels.sqlite')); stores.push(again)
    expect(again.tagsOf('hermes', 't1')).toEqual([b.id])
    expect(ids(again.memberSet(a.id, { tags: true }))).toEqual(['t2'])
    expect(again.migrateTags()).toEqual({ migrated: true, tags: 2 })
  })

  it('migration makes every chat\'s channel its first tag, once', () => {
    const { store, a, b } = setup()
    store.move({ sessionId: 't1', channelId: a.id, filedBy: 'owner' })
    store.move({ sessionId: 't2', channelId: b.id, filedBy: 'owner' })
    expect(store.migrateTags()).toEqual({ migrated: true, tags: expect.any(Number) })
    expect(store.migrateTags()).toEqual({ migrated: false, tags: 0 })
    expect(store.tagsOf('hermes', 't1')).toEqual([a.id])
    expect(store.tagsOf('hermes', 't2')).toEqual([b.id])
    expect(store.tagsOf('hermes', 'nobody')).toEqual([])
  })

  it('a chat carries several tags; the first stays primary in membership (dual write)', () => {
    const { store, a, b } = setup()
    store.migrateTags()
    expect(store.addTag({ sessionId: 't1', channelId: a.id })).toEqual({ sessionId: 't1', agent: 'hermes', channel: a.id, tags: [a.id] })
    expect(store.addTag({ sessionId: 't1', channelId: b.id })).toEqual({ sessionId: 't1', agent: 'hermes', channel: a.id, tags: [a.id, b.id] })
    expect(store.channelOf('hermes', 't1')).toBe(a.id)
    expect(ids(store.memberSet(a.id, { tags: true }))).toEqual(['t1'])
    expect(ids(store.memberSet(b.id, { tags: true }))).toEqual(['t1'])
    // With Tags off a feed is the one-channel membership, exactly as before.
    expect(ids(store.memberSet(b.id))).toEqual([])
    expect(store.list({ tags: true }).channels.find((c: any) => c.id === b.id).count).toBe(1)
    expect(store.list().channels.find((c: any) => c.id === b.id).count).toBe(0)
    expect(store.list({ tags: true }).tags).toBe(true)
    expect(store.list().tags).toBeUndefined()
  })

  it('removing the primary promotes the oldest other tag; the last one leaves the chat in General', () => {
    const { store, a, b, c } = setup()
    for (const id of [a.id, b.id, c.id]) store.addTag({ sessionId: 't1', channelId: id })
    expect(store.removeTag({ sessionId: 't1', channelId: a.id }).channel).toBe(b.id)
    expect(store.channelOf('hermes', 't1')).toBe(b.id)
    expect(store.removeTag({ sessionId: 't1', channelId: c.id }).tags).toEqual([b.id])
    expect(store.removeTag({ sessionId: 't1', channelId: b.id })).toEqual({ sessionId: 't1', agent: 'hermes', channel: null, tags: [] })
    expect(store.channelOf('hermes', 't1')).toBe('')
    expect(store.ownerUnfiled('hermes', 't1')).toBe(true)
  })

  it('the agent adds a tag, never one the owner removed, never on a chat the owner unfiled, never archived', () => {
    const { store, a, b, c, foreign } = setup()
    store.addTag({ sessionId: 't1', channelId: a.id })
    expect(store.tagIfAllowed('hermes', 't1', b.id)).toBe(true)
    expect(store.tagIfAllowed('hermes', 't1', b.id)).toBe(false)
    store.removeTag({ sessionId: 't1', channelId: b.id })
    expect(store.tagIfAllowed('hermes', 't1', b.id)).toBe(false)
    // The owner adding it again clears his own removal.
    store.addTag({ sessionId: 't1', channelId: b.id })
    expect(store.tagsOf('hermes', 't1')).toEqual([a.id, b.id])
    expect(store.tagIfAllowed('hermes', 't1', foreign.id)).toBe(false)
    store.update(c.id, { archived: true })
    expect(store.tagIfAllowed('hermes', 't1', c.id)).toBe(false)
    // An unfiled chat gets the agent's tag as its primary; one the owner took out of every channel does not.
    expect(store.tagIfAllowed('hermes', 't2', a.id)).toBe(true)
    expect(store.channelOf('hermes', 't2')).toBe(a.id)
    store.move({ sessionId: 't3', channelId: a.id }); store.move({ sessionId: 't3', channelId: null })
    expect(store.tagIfAllowed('hermes', 't3', b.id)).toBe(false)
  })

  it('the one-channel writes keep the tags in step whichever way the switch stood', () => {
    const { store, a, b, c } = setup()
    store.addTag({ sessionId: 't1', channelId: a.id }); store.addTag({ sessionId: 't1', channelId: c.id })
    // An older shell's Move: the primary tag is replaced, the other tag stays.
    store.move({ sessionId: 't1', channelId: b.id })
    expect(store.tagsOf('hermes', 't1')).toEqual([b.id, c.id])
    // Agent filing of an unfiled chat and its removal from every channel.
    expect(store.fileIfUnfiled('hermes', 't2', a.id)).toBe(true)
    expect(store.tagsOf('hermes', 't2')).toEqual([a.id])
    store.move({ sessionId: 't2', channelId: null })
    expect(store.tagsOf('hermes', 't2')).toEqual([])
    // A deleted chat leaves every tag.
    store.forget('hermes', 't1')
    expect(store.tagsOf('hermes', 't1')).toEqual([])
  })

  it('deleting a tag keeps the chat\'s other tags, the oldest becoming primary', () => {
    const { store, a, b } = setup()
    store.addTag({ sessionId: 't1', channelId: a.id }); store.addTag({ sessionId: 't1', channelId: b.id })
    store.remove(a.id)
    expect(store.channelOf('hermes', 't1')).toBe(b.id)
    expect(store.tagsOf('hermes', 't1')).toEqual([b.id])
  })

  it('HTTP: GET and PUT /wizard/v1/channels/tags, one change per request, own agent only', () => {
    const { store, a, b, foreign } = setup()
    const put = (body: any) => channelRequest(store, 'PUT', 'tags', new URLSearchParams(), { sessionId: 't1', ...body })
    expect(put({ add: a.id }).tags).toEqual([a.id])
    expect(put({ add: b.id }).tags).toEqual([a.id, b.id])
    expect(() => put({ add: a.id, remove: b.id })).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => put({})).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => put({ add: foreign.id, agent: 'hermes' })).toThrow(expect.objectContaining({ status: 409 }))
    expect(() => put({ add: 'channel-missing' })).toThrow(expect.objectContaining({ status: 404 }))
    expect(channelRequest(store, 'GET', 'tags', new URLSearchParams('sessionId=t1'), null)).toEqual({ sessionId: 't1', agent: 'hermes', channel: a.id, tags: [a.id, b.id] })
    expect(channelRequest(store, 'GET', 'tags', new URLSearchParams(`channel=${b.id}`), null)).toEqual({ channel: b.id, members: ['t1'] })
    expect(put({ remove: a.id }).channel).toBe(b.id)
    expect(channelRequest(store, 'GET', false, new URLSearchParams(), null, { tags: true }).tags).toBe(true)
  })

  it('list rows carry every tag, primary first, only with Tags on', () => {
    const { store, a, b } = setup()
    store.addTag({ sessionId: 't1', channelId: a.id }); store.addTag({ sessionId: 't1', channelId: b.id })
    const item = { id: 't1', title: 'Synthetic', preview: 'Synthetic', source: 'api_server', message_count: 1, last_active: 1, started_at: 1 }
    expect(listRow(item, '', store, { tags: true })).toMatchObject({ channel: a.id, tags: [a.id, b.id] })
    expect(listRow(item, '', store, null)).not.toHaveProperty('tags')
  })
})

describe('agent filing with Tags on', () => {
  const status = (channel: string) => ({ state: 'done', ask: 'x', channel, subject: 'WizardOS' })
  it('the status line adds a tag to a filed chat, and the run note says so', () => {
    const { d, store, a, b } = setup()
    const filing = createSpaceFiling(join(d, 'ui-preferences.json'), store, { agentFiling: true, tags: true })
    store.addTag({ sessionId: 't1', channelId: a.id })
    expect(filing.apply('hermes', 't1', status(b.id))).toBe(true)
    expect(store.tagsOf('hermes', 't1')).toEqual([a.id, b.id])
    expect(store.channelOf('hermes', 't1')).toBe(a.id)
    expect(filing.runNote('hermes')).toContain(TAG_INSTRUCTIONS)
    // The owner removed it: the next status line does not put it back.
    store.removeTag({ sessionId: 't1', channelId: b.id })
    expect(filing.apply('hermes', 't1', status(b.id))).toBe(false)
    expect(store.tagsOf('hermes', 't1')).toEqual([a.id])
  })
  it('with Tags off a filed chat stays where it is, as before', () => {
    const { d, store, a, b } = setup()
    const filing = createSpaceFiling(join(d, 'ui-preferences.json'), store, { agentFiling: true })
    store.move({ sessionId: 't1', channelId: a.id })
    expect(filing.apply('hermes', 't1', status(b.id))).toBe(false)
    expect(store.channelOf('hermes', 't1')).toBe(a.id)
    expect(filing.runNote('hermes')).not.toContain(TAG_INSTRUCTIONS)
  })
})
