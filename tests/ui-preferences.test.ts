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
    expect(await (await fetch(u2)).json()).toEqual({ archiveAfterDays: 0, compact: true, readyOrder: 'oldest', subjectOrder: [], pinnedChats: [], spaces: [] })
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe(original)
    expect((await fetch(u2)).headers.get('cache-control')).toBe('no-store')
  })
  it('validates strictly and never mutates on invalid payload', async () => {
    const u = await start(home())
    for (const value of [null, [], { extra: true }, { compact: 1 }, { archiveAfterDays: -1 }, { archiveAfterDays: '7' }, { readyOrder: 'bad' }, { subjectOrder: [1] }, { subjectOrder: ['a', 'a'] }, { pinnedChats: ['a', 'a'] }, { pinnedChats: ['<x>'] }, { pinnedChats: 'wizard_a' }, JSON.parse('{"__proto__":{}}')]) expect((await put(u, value)).status).toBe(400)
    expect(await (await fetch(u)).json()).toEqual(DEFAULT_UI_PREFERENCES)
    for (const readyOrder of ['newest', 'oldest', 'priority', 'subject']) expect((await put(u, { readyOrder })).status).toBe(200)
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
        { createdAt: 'yesterday' }, { createdAt: '2026-10-24' }, { extra: true }, { id: undefined }].map(p => [{ ...space, ...p }])]
    for (const spaces of invalid) expect((await put(u, { spaces })).status).toBe(400)
    expect((await (await fetch(u)).json()).spaces).toEqual([space])
    // Accepted maximum shape exceeds the former 32 KB file/body ceiling; it must survive a GET.
    const large = Array.from({length:50}, (_,i) => ({...space, id:'space-'+i, threads:Array.from({length:500},(_,j)=>'wizard_'+String(j).padStart(173,'x'))}))
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
    expect(await r.json()).toEqual({ archiveAfterDays: 7, compact: true, readyOrder: 'newest', subjectOrder: ['a', 'b'], pinnedChats: [], spaces: [] })
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
    expect(await (await fetch(u)).json()).toEqual({ compact: true, readyOrder: 'subject', archiveAfterDays: 14, subjectOrder: [], pinnedChats: [], spaces: [] })
  })
})
