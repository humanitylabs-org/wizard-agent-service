// Issue 440: the Agent Service channel store (channels.sqlite) and its Spaces migration.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChannelStore, channelRequest, CHANNELS_PER_AGENT, PROJECTION_THREADS, ALERTS_ID } from '../server/channel-store.mjs'
import { readWithChannels, patchWithChannels, putWithChannels } from '../server/channel-spaces.mjs'
import { createSpaceFiling } from '../server/thread-spaces.mjs'
import { listRow, FIRST_REQUEST_MAX } from '../server/session-list-view.mjs'
import { createListWindows } from '../server/session-list-window.mjs'
import { readHermesFirstRequests } from '../server/session-truth.mjs'

const dirs: string[] = [], stores: any[] = []
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'channels-')); dirs.push(d); return d }
const open = (d = home()) => { const s = createChannelStore(join(d, 'channels.sqlite')); stores.push(s); return s }
const at = '2026-10-29T10:00:00.000Z'
// The same shape as the live file in the issue: 6 Spaces, 317 memberships, one routed agent, synthetic ids.
function sixSpaces() {
  const sizes = [120, 80, 60, 40, 12, 5], spaces: any[] = []
  let n = 0
  sizes.forEach((size, i) => spaces.push({ id: `space-${i}`, name: `Synthetic ${i}`, ...(i === 5 ? { agent: 'research' } : {}),
    threads: Array.from({ length: size }, () => `wizard_${String(n++).padStart(13, '0')}_aaaaaaaaaaaa`), createdAt: at }))
  return spaces
}
const memberships = (s: any) => Object.fromEntries(s.list().channels.filter((c: any) => c.kind !== 'alerts').map((c: any) => [c.id, s.members(c.id).map((m: any) => m.sessionId)]))

describe('channel store migration', () => {
  it('copies 6 Spaces with 317 memberships exactly, idempotently, and seeds one Alerts channel', () => {
    const d = home(), spaces = sixSpaces(), s = open(d)
    expect(spaces.reduce((n, x) => n + x.threads.length, 0)).toBe(317)
    expect(s.migrateSpaces(spaces)).toEqual({ migrated: true, channels: 6, memberships: 317, duplicates: 0 })
    const alerts = s.seedAlerts()
    expect(alerts).toBe(ALERTS_ID)
    const listed = s.list().channels
    expect(listed.map((c: any) => c.id)).toEqual([ALERTS_ID, ...spaces.map(x => x.id)])
    expect(listed[0]).toMatchObject({ name: 'Alerts', agent: 'hermes', pinned: true, pinOrder: 0, archived: false, kind: 'alerts', count: 0 })
    for (const [i, x] of spaces.entries()) expect(listed[i + 1]).toMatchObject({ id: x.id, name: x.name, agent: x.agent || 'hermes', createdAt: at, count: x.threads.length })
    expect(memberships(s)).toEqual(Object.fromEntries(spaces.map(x => [x.id, x.threads])))
    // Migrating twice (and reopening, as on every boot) changes nothing and adds no second Alerts.
    expect(s.migrateSpaces(spaces).migrated).toBe(false)
    expect(s.seedAlerts()).toBe(null)
    s.close(); stores.pop()
    const again = open(d)
    expect(again.migrateSpaces([...spaces, { id: 'later', name: 'Later', threads: [], createdAt: at }]).migrated).toBe(false)
    expect(again.seedAlerts()).toBe(null)
    expect(again.list().channels.filter((c: any) => c.name === 'Alerts')).toHaveLength(1)
    expect(again.list().channels).toHaveLength(7)
    // The old shells' read-only view gives back the same Spaces (Alerts is a channel like any other).
    expect(again.spacesProjection().filter((x: any) => x.id !== ALERTS_ID)).toEqual(spaces)
  })
  it('a fresh install lists Alerts; an archived or deleted Alerts is never re-created', () => {
    const d = home(), s = open(d)
    s.migrateSpaces([]); s.seedAlerts()
    expect(s.list().channels.map((c: any) => c.name)).toEqual(['Alerts'])
    expect(s.update(ALERTS_ID, { name: 'Notices', archived: true, pinned: false })).toMatchObject({ name: 'Notices', archived: true, pinned: false })
    s.remove(ALERTS_ID)
    s.close(); stores.pop()
    const again = open(d); again.migrateSpaces([]); again.seedAlerts()
    expect(again.list().channels).toEqual([])
  })
  it('keeps a legacy thread listed in two Spaces of one agent in the first only, and counts it', () => {
    const s = open()
    const r = s.migrateSpaces([{ id: 'a', name: 'A', threads: ['t1', 't2'], createdAt: at }, { id: 'b', name: 'B', threads: ['t1'], createdAt: at },
      { id: 'c', name: 'C', agent: 'research', threads: ['t1'], createdAt: at }])
    expect(r).toMatchObject({ memberships: 3, duplicates: 1 })
    expect([s.channelOf('hermes', 't1'), s.channelOf('research', 't1')]).toEqual(['a', 'c'])
  })
  it('the migrate-check script compares a copy of a real file without writing next to it', async () => {
    const d = home(), file = join(d, 'ui-preferences.json'), spaces = sixSpaces()
    writeFileSync(file, JSON.stringify({ compact: true, spaces }))
    const { checkMigration } = await import('../scripts/channels-migrate-check.mjs')
    const report = checkMigration(file)
    expect(report).toMatchObject({ ok: true, spaces: 6, memberships: 317, channels: 6, filed: 317, alerts: true, mismatches: [] })
    expect(JSON.parse(readFileSync(file, 'utf8')).spaces).toEqual(spaces)
  })
})

describe('channel store rules', () => {
  it('holds far more than the old ~790 memberships; the old-shell projection keeps their 500 and 50 limits', () => {
    const s = open(), c = s.create({ name: 'Big' })
    for (let i = 0; i < 2000; i++) s.move({ sessionId: `wizard_t${i}`, channelId: c.id })
    expect(s.get(c.id).count).toBe(2000)
    const p = s.spacesProjection().find((x: any) => x.id === c.id)
    expect(p.threads).toHaveLength(PROJECTION_THREADS)
    expect(p.threads.at(-1)).toBe('wizard_t1999')
    for (let i = 0; i < 60; i++) s.create({ name: `More ${i}` })
    expect(s.spacesProjection()).toHaveLength(50)
  })
  it('caps channels per agent', () => {
    const s = open()
    for (let i = 0; i < CHANNELS_PER_AGENT; i++) s.create({ name: `C${i}` })
    expect(() => s.create({ name: 'one too many' })).toThrow('channels_limit')
    expect(s.create({ name: 'other agent', agent: 'research' }).agent).toBe('research')
  })
  it('one channel per thread per agent: a move leaves the old channel, null unfiles, other agents are separate', () => {
    const s = open(), a = s.create({ name: 'A' }), b = s.create({ name: 'B' }), r = s.create({ name: 'R', agent: 'research' })
    expect(s.move({ sessionId: 't', channelId: a.id })).toEqual({ sessionId: 't', agent: 'hermes', channel: a.id })
    s.move({ sessionId: 't', channelId: b.id })
    expect([s.get(a.id).count, s.get(b.id).count, s.channelOf('hermes', 't')]).toEqual([0, 1, b.id])
    s.move({ sessionId: 't', channelId: r.id })
    expect([s.channelOf('hermes', 't'), s.channelOf('research', 't')]).toEqual([b.id, r.id])
    expect(() => s.move({ sessionId: 't', channelId: r.id, agent: 'hermes' })).toThrow('agent_mismatch')
    expect(s.move({ sessionId: 't', channelId: null })).toEqual({ sessionId: 't', agent: 'hermes', channel: null })
    expect(s.channelOf('hermes', 't')).toBe('')
    expect(() => s.move({ sessionId: 't', channelId: 'missing' })).toThrow('channel_not_found')
    expect(() => s.move({ sessionId: '../x', channelId: a.id })).toThrow('invalid_session')
  })
  it('agent filing files only unfiled threads into an open channel of that agent', () => {
    const s = open(), a = s.create({ name: 'A' }), b = s.create({ name: 'B' }), r = s.create({ name: 'R', agent: 'research' })
    s.move({ sessionId: 'owner-filed', channelId: a.id })
    expect(s.fileIfUnfiled('hermes', 'owner-filed', b.id)).toBe(false)
    expect(s.channelOf('hermes', 'owner-filed')).toBe(a.id)
    expect(s.fileIfUnfiled('hermes', 'new', r.id)).toBe(false)
    expect(s.fileIfUnfiled('hermes', 'new', b.id)).toBe(true)
    expect(s.members(b.id)[0]).toMatchObject({ sessionId: 'new', filedBy: 'agent' })
    s.update(a.id, { archived: true })
    expect(s.fileIfUnfiled('hermes', 'later', a.id)).toBe(false)
    const filing = createSpaceFiling('/nonexistent/ui-preferences.json', s)
    expect(filing.apply('hermes', 'status-filed', { space: b.id })).toBe(true)
    expect(filing.apply('hermes', 'status-filed', { space: a.id })).toBe(false)
    expect(filing.runNote('hermes')).toContain(`"id":"${b.id}"`)
    expect(filing.runNote('hermes')).not.toContain(`"id":"${a.id}"`)
  })
  it('deletes: removing a channel drops its memberships only; forget and prune drop gone threads', () => {
    const s = open(), a = s.create({ name: 'A' }), b = s.create({ name: 'B' })
    for (const t of ['t1', 't2', 't3']) s.move({ sessionId: t, channelId: a.id })
    s.move({ sessionId: 't4', channelId: b.id })
    s.forget('hermes', 't1')
    expect(s.members(a.id).map((m: any) => m.sessionId)).toEqual(['t2', 't3'])
    expect(s.prune('hermes', (id: string) => id === 't3' ? false : id === 't2' ? null : true)).toBe(1)
    expect(s.members(a.id).map((m: any) => m.sessionId)).toEqual(['t2'])
    expect(s.remove(a.id)).toEqual({ deleted: a.id })
    expect([s.channelOf('hermes', 't2'), s.channelOf('hermes', 't4')]).toEqual(['', b.id])
  })
  it('shared sort, pins and archive (issue 447) live in the store', () => {
    const s = open(), a = s.create({ name: 'A' }), b = s.create({ name: 'B' }), c = s.create({ name: 'C' })
    expect(s.list().sort).toBe('az')
    expect(channelRequest(s, 'PATCH', false, new URLSearchParams(), { sort: 'za' }).sort).toBe('za')
    expect(() => channelRequest(s, 'PATCH', false, new URLSearchParams(), { sort: 'newest' })).toThrow('invalid_sort')
    s.update(b.id, { pinned: true }); s.update(c.id, { pinned: true })
    expect(s.list().channels.filter((x: any) => x.pinned).map((x: any) => [x.id, x.pinOrder])).toEqual([[b.id, 0], [c.id, 1]])
    channelRequest(s, 'PATCH', false, new URLSearchParams(), { pinOrder: [c.id] })
    expect(s.get(c.id).pinOrder).toBe(0); expect(s.get(b.id).pinOrder).toBe(1)
    channelRequest(s, 'PATCH', false, new URLSearchParams(), { order: [c.id, a.id] })
    expect(s.list().channels.map((x: any) => x.id)).toEqual([c.id, a.id, b.id])
    const archived = channelRequest(s, 'PATCH', false, new URLSearchParams(), { id: a.id, archived: true })
    expect(archived.archived).toBe(true); expect(Date.parse(archived.archivedAt)).toBeGreaterThan(0)
    expect(channelRequest(s, 'PATCH', false, new URLSearchParams(), { id: a.id, archived: false })).not.toHaveProperty('archivedAt')
    for (const bad of [{ id: a.id }, { id: a.id, colour: 'red' }, { id: a.id, name: '' }, { id: a.id, archived: 'yes' }, { order: [a.id, a.id] }, { order: [a.id], sort: 'az' }])
      expect(() => channelRequest(s, 'PATCH', false, new URLSearchParams(), bad)).toThrow()
    const r = s.create({ name: 'R', agent: 'research' })
    expect(() => s.reorder([a.id, r.id])).toThrow('mixed_agents')
    expect(channelRequest(s, 'GET', false, new URLSearchParams('agent=research'), null).channels.map((x: any) => x.id)).toEqual([r.id])
  })
  it('membership HTTP shapes', () => {
    const s = open(), a = s.create({ name: 'A' }), none = new URLSearchParams()
    expect(channelRequest(s, 'PUT', true, none, { sessionId: 'x', channelId: a.id })).toEqual({ sessionId: 'x', agent: 'hermes', channel: a.id })
    expect(channelRequest(s, 'GET', true, new URLSearchParams('sessionId=x'), null)).toEqual({ sessionId: 'x', agent: 'hermes', channel: a.id })
    expect(channelRequest(s, 'GET', true, new URLSearchParams(`channel=${a.id}`), null).members.map((m: any) => m.sessionId)).toEqual(['x'])
    for (const bad of [{ sessionId: 'x' }, { sessionId: 'x', channelId: 3 }, { sessionId: 'x', channelId: null, extra: 1 }])
      expect(() => channelRequest(s, 'PUT', true, none, bad)).toThrow()
    expect(channelRequest(s, 'PUT', true, none, { sessionId: 'x', channelId: null })).toMatchObject({ channel: null })
  })
})

describe('ui-preferences spaces with the store on', () => {
  it('serves the projection, applies PATCH space ops to the store, ignores PUT spaces and still saves other keys', () => {
    const d = home(), path = join(d, 'ui-preferences.json'), s = open(d)
    const before = { compact: false, spaces: [{ id: 'old', name: 'Old', threads: ['t1'], createdAt: at }] }
    writeFileSync(path, JSON.stringify(before))
    s.migrateSpaces(JSON.parse(readFileSync(path, 'utf8')).spaces)
    expect(readWithChannels(path, s).spaces).toEqual(before.spaces)
    const out = patchWithChannels(path, s, { ops: [
      { op: 'add', key: 'spaces', item: { id: 'new-space', name: 'New', threads: ['t1', 't2'], createdAt: at } },
      { op: 'set', key: 'spaces/old/name', item: 'Renamed' },
      { op: 'remove', key: 'spaces/new-space/threads', item: 't2' },
      { op: 'add', key: 'pinnedChats', item: 't9' },
    ] })
    expect(out.pinnedChats).toEqual(['t9'])
    expect(s.get('old')).toMatchObject({ name: 'Renamed', count: 0 })
    expect(s.members('new-space').map((m: any) => m.sessionId)).toEqual(['t1'])
    expect(() => patchWithChannels(path, s, { ops: [{ op: 'add', key: 'spaces/old/threads', item: '../bad' }] })).toThrow('invalid_preferences')
    // A full snapshot PUT from an older shell cannot erase store memberships.
    const put = putWithChannels(path, s, { compact: true, spaces: [] })
    expect(put.compact).toBe(true)
    expect(s.members('new-space')).toHaveLength(1)
    expect(() => putWithChannels(path, s, { spaces: [{ id: 'BAD ID' }] })).toThrow('invalid_preferences')
    // The file keeps the pre-migration Spaces, so switching the store off shows them as they were.
    expect(JSON.parse(readFileSync(path, 'utf8')).spaces).toEqual(before.spaces)
    patchWithChannels(path, s, { ops: [{ op: 'remove', key: 'spaces', item: 'old' }] })
    expect(() => s.get('old')).toThrow('channel_not_found')
  })
})

describe('Chats list with channels', () => {
  const row = (id: string, extra: any = {}) => ({ id, title: id, started_at: 1_700_000_000, preview: 'Upstream first message head', ...extra })
  it('rows carry their channel and a bounded first request only when the store is on', () => {
    const s = open(), a = s.create({ name: 'A' }), r = s.create({ name: 'R', agent: 'research' })
    s.move({ sessionId: 'main-1', channelId: a.id }); s.move({ sessionId: 'shared-id', channelId: r.id })
    expect(listRow(row('main-1'))).not.toHaveProperty('channel')
    expect(listRow(row('main-1'))).not.toHaveProperty('firstRequest')
    const long = 'Please **plan** the week ' + 'x'.repeat(600)
    const main = listRow(row('main-1', { wizard_first_request: long }), '', s)
    expect(main.channel).toBe(a.id)
    expect(main.firstRequest.length).toBe(FIRST_REQUEST_MAX)
    expect(main.firstRequest.startsWith('Please plan the week')).toBe(true)
    expect(listRow(row('main-1', { wizard_first_request: '' }), '', s)).not.toHaveProperty('firstRequest')
    // Routed rows: the channel of that agent only, and Hermes' own first-message head.
    expect(listRow(row('shared-id', { agent: 'research' }), '', s)).toMatchObject({ channel: r.id, firstRequest: 'Upstream first message head' })
    expect(listRow(row('shared-id'), '', s)).not.toHaveProperty('channel')
  })
  it('view=list&channel=<id> lists only members, oldest first, with offset paging and snapshot rules', async () => {
    let t = 0
    const page = createListWindows({ now: () => t })
    const rows = Array.from({ length: 150 }, (_, i) => row(`t${i}`, { started_at: 1_700_000_000 + (149 - i) }))
    rows.push(row('hidden', { hidden: true }))
    const members = new Set([...rows.filter((_, i) => i % 2 === 0).map(x => x.id), 'hidden', 'gone'])
    const p = (q: string) => new URLSearchParams(q)
    const first = await page({ params: p('view=list&channel=c1&limit=50'), scope: 'hermes', load: async () => rows, members })
    expect(first).toMatchObject({ window: 'channel', channel: 'c1', order: 'oldest', channel_total: 75, has_more: true })
    expect(first.data.map((x: any) => x.id).slice(0, 3)).toEqual(['t148', 't146', 't144'])
    const second = await page({ params: p(`view=list&channel=c1&limit=50&offset=50&snapshot=${first.snapshot}`), scope: 'hermes', load: async () => [], members })
    expect(second.data).toHaveLength(25); expect(second.has_more).toBe(false)
    await expect(page({ params: p(`view=list&channel=c2&offset=50&snapshot=${first.snapshot}`), scope: 'hermes', load: async () => rows, members })).rejects.toMatchObject({ status: 409 })
    t = 31_000
    await expect(page({ params: p(`view=list&channel=c1&offset=50&snapshot=${first.snapshot}`), scope: 'hermes', load: async () => rows, members })).rejects.toMatchObject({ status: 409 })
    await expect(page({ params: p('view=list&channel=c1'), scope: 'hermes', load: async () => rows, members: null })).rejects.toMatchObject({ status: 404 })
    await expect(page({ params: p('view=list&channel=c1&q=x'), scope: 'hermes', load: async () => rows, members })).rejects.toMatchObject({ status: 400 })
  })
  it('reads the first visible owner request from state.db', () => {
    const d = home(), path = join(d, 'state.db'), db = new DatabaseSync(path)
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1, display_kind TEXT)`)
    db.exec(`INSERT INTO sessions VALUES('a',1),('b',1),('c',1)`)
    const msg = db.prepare('INSERT INTO messages(session_id,role,content,timestamp,display_kind) VALUES(?,?,?,?,?)')
    msg.run('a', 'user', '[Wizard follow-through] internal', 1, null)
    msg.run('a', 'user', 'First real request', 2, null)
    msg.run('a', 'user', 'Second request', 3, null)
    msg.run('b', 'assistant', 'Agent-started alert', 1, null)
    db.close()
    const firsts = readHermesFirstRequests(path, ['a', 'b', 'missing'])
    expect([...firsts]).toEqual([['a', 'First real request'], ['b', '']])
  })
})

describe('first-boot migration input', () => {
  it('waits (copies nothing, marks nothing) while ui-preferences.json is unreadable or its spaces invalid', async () => {
    const { spacesForMigration } = await import('../server/channel-spaces.mjs')
    const d = home(), path = join(d, 'ui-preferences.json')
    expect(spacesForMigration(path)).toEqual([])
    writeFileSync(path, '{"spaces": [')
    expect(spacesForMigration(path)).toBe(null)
    writeFileSync(path, JSON.stringify({ spaces: [{ id: 'BAD ID', name: 'x', threads: [], createdAt: at }] }))
    expect(spacesForMigration(path)).toBe(null)
    writeFileSync(path, JSON.stringify({ compact: true }))
    expect(spacesForMigration(path)).toEqual([])
    const good = sixSpaces(); writeFileSync(path, JSON.stringify({ spaces: good }))
    expect(spacesForMigration(path)).toEqual(good)
  })
})
