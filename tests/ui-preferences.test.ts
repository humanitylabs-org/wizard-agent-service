import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { DEFAULT_UI_PREFERENCES } from '../server/ui-preferences.mjs'
const servers: any[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r)))); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
function home() { const d = mkdtempSync(join(tmpdir(), 'ui-prefs-')); dirs.push(d); return d }
async function start(d: string, auth = false) {
  const s = createWizardServer({ wizardOsHome: d, hermesKey: 'test', agentBridge: false, followThrough: false, requireAccess: auth, ...(auth ? { accessVerifier: async () => null } : {}), runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0 })
  servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}/wizard/v1/ui-preferences`
}
const put = (u: string, value: any, headers = {}) => fetch(u, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) })
describe('box-wide UI preferences HTTP contract', () => {
  it('defaults, merges only specified keys, persists across restart and leaves settings untouched', async () => {
    const d = home(), original = '{"owner":{"name":"Fixture"},"future":true}\n'; writeFileSync(join(d, 'settings.json'), original)
    const u = await start(d); expect(await (await fetch(u)).json()).toEqual(DEFAULT_UI_PREFERENCES)
    expect((await put(u, { archiveAfterDays: 0, compact: true })).status).toBe(200)
    expect((await put(u, { readyOrder: 'oldest' })).status).toBe(200)
    const u2 = await start(d)
    expect(await (await fetch(u2)).json()).toEqual({ archiveAfterDays: 0, compact: true, chatLayout: 'day', readyOrder: 'oldest', subjectOrder: [], pinnedChats: [], spaces: [] })
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe(original)
    expect((await fetch(u2)).headers.get('cache-control')).toBe('no-store')
  })
  it('validates strictly and never mutates on invalid payload', async () => {
    const u = await start(home())
    for (const value of [null, [], { extra: true }, { compact: 1 }, { archiveAfterDays: -1 }, { archiveAfterDays: '7' }, { readyOrder: 'bad' }, { chatLayout: 'bad' }, { chatLayout: true }, { subjectOrder: [1] }, { subjectOrder: ['a', 'a'] }, { pinnedChats: ['a', 'a'] }, { pinnedChats: ['<x>'] }, { pinnedChats: 'wizard_a' }, JSON.parse('{"__proto__":{}}')]) expect((await put(u, value)).status).toBe(400)
    expect(await (await fetch(u)).json()).toEqual(DEFAULT_UI_PREFERENCES)
    for (const readyOrder of ['newest', 'oldest', 'priority', 'subject']) expect((await put(u, { readyOrder })).status).toBe(200)
    for (const chatLayout of ['status', 'day']) expect((await put(u, { chatLayout })).status).toBe(200)
    expect((await put(u, { chatLayout: 'status' })).status).toBe(200)
    expect((await (await fetch(u)).json()).chatLayout).toBe('status')
    // Pinned chats are box-wide: one device pins, every device reads the same ordered list.
    expect((await put(u, { pinnedChats: ['wizard_1', 'wizardop_2'] })).status).toBe(200)
    expect((await (await fetch(u)).json()).pinnedChats).toEqual(['wizard_1', 'wizardop_2'])
  })
  it('validates owner-created spaces, persists membership and preserves other fields', async () => {
    const u = await start(home())
    const space = { id: 'launch', name: 'Wizard OS launch', threads: ['wizard_1', 'wizardop_2'], createdAt: '2026-10-24T12:00:00.000Z' }
    expect((await put(u, { spaces: [space], compact: true })).status).toBe(200)
    expect((await (await fetch(u)).json()).spaces).toEqual([space])
    const invalid = [null, {}, 'x', Array(51).fill(space), [space, space],
      ...[{ id: 'Bad ID' }, { id: 'a'.repeat(49) }, { name: '' }, { name: ' ' }, { name: 'x'.repeat(61) }, { name: 'bad\nname' },
        { threads: ['a', 'a'] }, { threads: ['<x>'] }, { threads: Array.from({length:501}, (_,i)=>'id'+i) },
        { createdAt: 'yesterday' }, { createdAt: '2026-10-24' }, { createdAt: '2026-02-31T00:00:00Z' }, { createdAt: '2026-10-24T25:00:00Z' }, { extra: true }, { id: undefined }].map(p => [{ ...space, ...p }])]
    for (const spaces of invalid) expect((await put(u, { spaces })).status).toBe(400)
    expect((await (await fetch(u)).json()).spaces).toEqual([space])
    // Accepted maximum shape exceeds the former 32 KB file/body ceiling; it must survive a GET.
    // Distinct thread IDs per Space: a chat is in one Space at a time (full writes keep only one copy).
    const large = Array.from({length:50}, (_,i) => ({...space, id:'space-'+i, threads:Array.from({length:500},(_,j)=>'w'+String(i).padStart(2,'0')+'_'+String(j).padStart(176,'x'))}))
    expect((await put(u, { spaces: large })).status).toBe(200)
    expect((await (await fetch(u)).json()).spaces).toEqual(large)
    expect((await put(u, { spaces: [] })).status).toBe(200)
    expect((await (await fetch(u)).json()).compact).toBe(true)
  })
  it('requires owner access, JSON and same-site writes, rejects unsupported methods', async () => {
    const u = await start(home(), true); expect((await fetch(u)).status).toBe(403); expect((await put(u, { compact: true })).status).toBe(403)
    const open = await start(home()); expect((await put(open, {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await fetch(open, { method: 'PUT', body: '{}' })).status).toBe(415)
    expect((await fetch(open, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(open, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400)
  })
  it('reads leniently: an unknown stored key is dropped, valid keys kept, defaults filled', async () => {
    const d = home(), file = join(d, 'ui-preferences.json'), stored = '{"compact":true,"futureShellKey":{"x":1}}\n'
    writeFileSync(file, stored); const u = await start(d)
    const r = await fetch(u); expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...DEFAULT_UI_PREFERENCES, compact: true })
    expect(readFileSync(file, 'utf8')).toBe(stored)
    // A write from this (older) version keeps the newer key on disk for a later roll-forward.
    expect((await put(u, { readyOrder: 'priority' })).status).toBe(200)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ compact: true, futureShellKey: { x: 1 }, readyOrder: 'priority' })
    expect(await (await fetch(u)).json()).toEqual({ ...DEFAULT_UI_PREFERENCES, compact: true, readyOrder: 'priority' })
  })
  it('reads leniently: an invalid stored value defaults only that key', async () => {
    const d = home(); writeFileSync(join(d, 'ui-preferences.json'), JSON.stringify({ archiveAfterDays: 9999, compact: true, readyOrder: 'chaos', subjectOrder: ['a', 'b'] }))
    const u = await start(d); const r = await fetch(u); expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ archiveAfterDays: 7, compact: true, chatLayout: 'day', readyOrder: 'newest', subjectOrder: ['a', 'b'], pinnedChats: [], spaces: [] })
    expect((await put(u, { archiveAfterDays: 9999 })).status).toBe(400)
  })
  it('unparseable stored state serves defaults without overwriting it until the next valid PUT', async () => {
    const d = home(), file = join(d, 'ui-preferences.json'); writeFileSync(file, '{broken'); const u = await start(d)
    const r = await fetch(u); expect(r.status).toBe(200); expect(await r.json()).toEqual(DEFAULT_UI_PREFERENCES)
    expect(readFileSync(file, 'utf8')).toBe('{broken')
    expect((await put(u, { extra: true })).status).toBe(400); expect(readFileSync(file, 'utf8')).toBe('{broken')
    expect((await put(u, { compact: true })).status).toBe(200)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ compact: true })
    for (const bad of ['[1,2]', 'null', '"x"']) { writeFileSync(file, bad); const g = await fetch(u); expect(g.status).toBe(200); expect(await g.json()).toEqual(DEFAULT_UI_PREFERENCES) }
  })
  it('concurrent partial writes preserve all unrelated preferences', async () => {
    const u = await start(home()); await Promise.all([put(u, { compact: true }), put(u, { readyOrder: 'subject' }), put(u, { archiveAfterDays: 14 })])
    expect(await (await fetch(u)).json()).toEqual({ compact: true, chatLayout: 'day', readyOrder: 'subject', archiveAfterDays: 14, subjectOrder: [], pinnedChats: [], spaces: [] })
  })
})

const patch = (u: string, ops: any, headers = {}) => fetch(u, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ops }) })
describe('item operations on shared lists (PATCH)', () => {
  const space = (id: string, threads: string[] = []) => ({ id, name: 'Space ' + id, threads, createdAt: '2026-10-28T08:00:00.000Z' })
  it('two devices editing the same list at the same moment both keep their change', async () => {
    const u = await start(home())
    expect((await put(u, { spaces: [space('work', ['wizard_1'])], pinnedChats: ['wizard_1'], subjectOrder: ['Home', 'Work'] })).status).toBe(200)
    // Each device only knows its own item; neither sends a whole list, so neither can erase the other.
    const r = await Promise.all([
      patch(u, [{ op: 'add', key: 'spaces/work/threads', item: 'wizard_desk' }, { op: 'add', key: 'pinnedChats', item: 'wizard_desk' }]),
      patch(u, [{ op: 'add', key: 'spaces/work/threads', item: 'wizard_phone' }, { op: 'remove', key: 'pinnedChats', item: 'wizard_1' }, { op: 'add', key: 'spaces', item: space('home') }]),
      patch(u, [{ op: 'front', key: 'subjectOrder', items: ['Work', 'Ideas'] }]),
    ])
    expect(r.map(x => x.status)).toEqual([200, 200, 200])
    const got = await (await fetch(u)).json()
    expect(got.spaces.map((s: any) => [s.id, s.threads])).toEqual([['work', ['wizard_1', 'wizard_desk', 'wizard_phone']], ['home', []]])
    expect(got.pinnedChats).toEqual(['wizard_desk'])
    expect(got.subjectOrder).toEqual(['Work', 'Ideas', 'Home'])
    expect(await (await patch(u, [{ op: 'add', key: 'pinnedChats', item: 'wizard_x' }])).json()).toMatchObject({ pinnedChats: ['wizard_desk', 'wizard_x'], compact: false })
  })
  it('operations are idempotent and a gone Space is a no-op, not an error', async () => {
    const u = await start(home())
    const ops = [{ op: 'add', key: 'spaces', item: space('a', ['wizard_1']) }, { op: 'add', key: 'spaces/a/threads', item: 'wizard_2' }, { op: 'set', key: 'spaces/a/name', item: 'Renamed' }]
    const once = await (await patch(u, ops)).json(), twice = await (await patch(u, ops)).json()
    expect(twice).toEqual(once); expect(once.spaces).toEqual([{ ...space('a', ['wizard_1', 'wizard_2']), name: 'Renamed' }])
    expect((await patch(u, [{ op: 'remove', key: 'spaces', item: 'a' }, { op: 'add', key: 'spaces/a/threads', item: 'wizard_3' }])).status).toBe(200)
    expect((await (await fetch(u)).json()).spaces).toEqual([])
  })
  it('rejects malformed operations and results that break a list limit without writing anything', async () => {
    const d = home(), u = await start(d)
    expect((await put(u, { subjectOrder: ['A'], pinnedChats: Array.from({ length: 300 }, (_, i) => 'wizard_' + i) })).status).toBe(200)
    const before = readFileSync(join(d, 'ui-preferences.json'), 'utf8')
    for (const ops of [undefined, [], {}, [null], [{ op: 'add', key: 'compact', item: true }], [{ op: 'add', key: 'pinnedChats', item: 1 }], [{ op: 'add', key: 'pinnedChats', item: '<x>' }],
      [{ op: 'add', key: 'pinnedChats', item: 'wizard_new' }], [{ op: 'front', key: 'pinnedChats', items: ['a'] }], [{ op: 'add', key: 'spaces', item: { id: 'Bad ID' } }],
      [{ op: 'set', key: 'spaces/a/name', item: '' }], [{ op: 'add', key: 'spaces/a/threads', item: 'x', extra: 1 }], [{ op: 'move', key: 'subjectOrder', item: 'A' }],
      [{ op: 'remove', key: 'pinnedChats', item: '<invalid>' }], [{ op: 'remove', key: 'subjectOrder', item: 'bad\nsubject' }], [{ op: 'front', key: 'subjectOrder', items: ['x'.repeat(121)] }],
      [{ op: 'remove', key: 'spaces', item: 'Bad ID' }], [{ op: 'remove', key: 'spaces/a/threads', item: '<x>' }], Array(101).fill({ op: 'remove', key: 'pinnedChats', item: 'x' })])
      expect((await fetch(u, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }) })).status).toBe(400)
    expect((await fetch(u, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [], compact: true }) })).status).toBe(400)
    expect(readFileSync(join(d, 'ui-preferences.json'), 'utf8')).toBe(before)
  })
  it('keeps PUT working for older shells, and PATCH needs the same access, JSON and same-site write as PUT', async () => {
    const u = await start(home(), true); expect((await patch(u, [{ op: 'add', key: 'pinnedChats', item: 'wizard_1' }])).status).toBe(403)
    const open = await start(home())
    expect((await patch(open, [{ op: 'add', key: 'pinnedChats', item: 'wizard_1' }], { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await fetch(open, { method: 'PATCH', body: '{"ops":[]}' })).status).toBe(415)
    const allowed = await fetch(open, { method: 'DELETE' }); expect(allowed.status).toBe(405); expect(allowed.headers.get('allow')).toBe('GET, PUT, PATCH')
    expect((await put(open, { pinnedChats: ['wizard_old_shell'] })).status).toBe(200)
    expect((await (await patch(open, [{ op: 'add', key: 'pinnedChats', item: 'wizard_new_shell' }])).json()).pinnedChats).toEqual(['wizard_old_shell', 'wizard_new_shell'])
  })
  it('keeps stored keys this version does not know', async () => {
    const d = home(), file = join(d, 'ui-preferences.json'); writeFileSync(file, JSON.stringify({ future: { x: 1 }, compact: true }))
    const u = await start(d); expect((await patch(u, [{ op: 'add', key: 'pinnedChats', item: 'wizard_1' }])).status).toBe(200)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ future: { x: 1 }, compact: true, pinnedChats: ['wizard_1'] })
  })
})
