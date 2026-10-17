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
    expect(await (await fetch(u2)).json()).toEqual({ archiveAfterDays: 0, compact: true, readyOrder: 'oldest', subjectOrder: [] })
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe(original)
    expect((await fetch(u2)).headers.get('cache-control')).toBe('no-store')
  })
  it('validates strictly and never mutates on invalid payload', async () => {
    const u = await start(home())
    for (const value of [null, [], { extra: true }, { compact: 1 }, { archiveAfterDays: -1 }, { archiveAfterDays: '7' }, { readyOrder: 'bad' }, { subjectOrder: [1] }, { subjectOrder: ['a', 'a'] }, JSON.parse('{"__proto__":{}}')]) expect((await put(u, value)).status).toBe(400)
    expect(await (await fetch(u)).json()).toEqual(DEFAULT_UI_PREFERENCES)
    for (const readyOrder of ['newest', 'oldest', 'priority', 'subject']) expect((await put(u, { readyOrder })).status).toBe(200)
  })
  it('requires owner access, JSON and same-site writes, rejects unsupported methods', async () => {
    const u = await start(home(), true); expect((await fetch(u)).status).toBe(403); expect((await put(u, { compact: true })).status).toBe(403)
    const open = await start(home()); expect((await put(open, {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await fetch(open, { method: 'PUT', body: '{}' })).status).toBe(415)
    expect((await fetch(open, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(open, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400)
  })
  it('fails closed on corrupted stored state rather than overwriting it', async () => {
    const d = home(); writeFileSync(join(d, 'ui-preferences.json'), '{broken'); const u = await start(d)
    expect((await fetch(u)).status).toBe(503); expect((await put(u, { compact: true })).status).toBe(503)
    expect(readFileSync(join(d, 'ui-preferences.json'), 'utf8')).toBe('{broken')
  })
  it('concurrent partial writes preserve all unrelated preferences', async () => {
    const u = await start(home()); await Promise.all([put(u, { compact: true }), put(u, { readyOrder: 'subject' }), put(u, { archiveAfterDays: 14 })])
    expect(await (await fetch(u)).json()).toEqual({ compact: true, readyOrder: 'subject', archiveAfterDays: 14, subjectOrder: [] })
  })
})
