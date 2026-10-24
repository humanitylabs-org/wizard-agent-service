import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
const servers: any[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => { s.closeAllConnections?.(); return new Promise<void>(r => s.close(r)) })); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
function home() { const d = mkdtempSync(join(tmpdir(), 'workspaces-')); dirs.push(d); return d }
async function start(d: string, auth = false) {
  const s = createWizardServer({ wizardOsHome: d, hermesKey: 'test', agentBridge: false, followThrough: false, requireAccess: auth, ...(auth ? { accessVerifier: async () => null } : {}), runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0 })
  servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}/wizard/v1/workspaces`
}
const put = (u: string, body: any, headers = {}) => fetch(u, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const chats = { id: 'w1', app: 'chats' }, files = { id: 'w2', app: 'frame', appId: 'files', url: '/files/' }

describe('workspace sync HTTP contract', () => {
  it('starts empty, saves with compare-and-swap, persists across restart in a private file', async () => {
    const d = home(), u = await start(d)
    expect(await (await fetch(u)).json()).toEqual({ rev: 0, state: { desks: [] }, closed: [], device: '', at: '' })
    const r = await put(u, { baseRev: 0, device: 'iPhone', state: { desks: [{ id: 'a', wins: [chats] }] } })
    expect(r.status).toBe(200); expect((await r.json()).rev).toBe(1)
    const stale = await put(u, { baseRev: 0, device: 'Mac desktop', state: { desks: [] } })
    expect(stale.status).toBe(409); expect((await stale.json()).state.desks[0].id).toBe('a')
    expect((statSync(join(d, 'workspaces.json')).mode & 0o777)).toBe(0o600)
    const j = await (await fetch(await start(d))).json()
    expect(j).toMatchObject({ rev: 1, device: 'iPhone', state: { desks: [{ id: 'a', wins: [chats] }] } })
  })
  it('an unchanged save is not a new revision', async () => {
    const u = await start(home()), state = { desks: [{ id: 'a', wins: [chats] }] }
    await put(u, { baseRev: 0, state }); const r = await put(u, { baseRev: 1, state })
    expect((await r.json()).rev).toBe(1)
  })
  it('keeps closed desks for reopen; a moved window is not a close; reopening or forgetting clears the entry', async () => {
    const u = await start(home())
    await put(u, { baseRev: 0, device: 'Mac desktop', state: { desks: [{ id: 'a', wins: [chats] }, { id: 'b', wins: [files] }] } })
    let j = await (await put(u, { baseRev: 1, state: { desks: [{ id: 'a', wins: [chats, files] }] } })).json()
    expect(j.closed).toEqual([])
    j = await (await put(u, { baseRev: 2, device: 'iPhone', state: { desks: [{ id: 'a', wins: [chats] }] } })).json()
    expect(j.closed).toHaveLength(0) // desk a stays; w2 left desk a (a window close, not a desk close)
    await put(u, { baseRev: 3, state: { desks: [{ id: 'a', wins: [chats] }, { id: 'c', wins: [files] }] } })
    j = await (await put(u, { baseRev: 4, device: 'iPhone', state: { desks: [{ id: 'a', wins: [chats] }] } })).json()
    expect(j.closed).toMatchObject([{ desk: { id: 'c', wins: [files] }, device: 'iPhone' }])
    j = await (await put(u, { baseRev: 5, state: { desks: [{ id: 'a', wins: [chats] }, { id: 'c', wins: [files] }] } })).json()
    expect(j.closed).toEqual([])
    j = await (await put(u, { baseRev: 6, state: { desks: [{ id: 'a', wins: [chats] }] } })).json()
    const f = await fetch(u + '/closed/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ desk: 'c' }) })
    expect((await f.json()).closed).toEqual([])
  })
  it('long-poll answers as soon as another device saves', async () => {
    const u = await start(home())
    const t0 = Date.now(), waiting = fetch(u + '?since=0&wait=20').then(r => r.json())
    await new Promise(r => setTimeout(r, 150))
    await put(u, { baseRev: 0, state: { desks: [{ id: 'a', wins: [chats] }] } })
    const j = await waiting
    expect(j.rev).toBe(1); expect(Date.now() - t0).toBeLessThan(5000)
  })
  it('drops invalid desks and windows, rejects bad bodies, requires owner access and same-site JSON writes', async () => {
    const u = await start(home())
    const j = await (await put(u, { baseRev: 0, state: { desks: [{ id: 'a', wins: [chats, { id: 'x', app: 'shell' }, { id: 'w3', app: 'frame', appId: 'a\nb' }] }, { id: 'bad id!', wins: [files] }, { id: 'e', wins: [] }] } })).json()
    expect(j.state).toEqual({ desks: [{ id: 'a', wins: [chats, { id: 'w3', app: 'frame' }] }] })
    for (const body of [null, [], { state: { desks: [] } }, { baseRev: 'x', state: { desks: [] } }, { baseRev: 1, state: {} }]) expect((await put(u, body)).status).toBe(400)
    expect((await put(u, { baseRev: 1, state: { desks: [] } }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await fetch(u, { method: 'PUT', body: '{}' })).status).toBe(415)
    expect((await fetch(u, { method: 'DELETE' })).status).toBe(405)
    const locked = await start(home(), true)
    expect((await fetch(locked)).status).toBe(403); expect((await put(locked, { baseRev: 0, state: { desks: [] } })).status).toBe(403)
  })
  it('an unreadable stored file serves empty and is replaced by the next save', async () => {
    const d = home(), file = join(d, 'workspaces.json'); writeFileSync(file, '{broken')
    const u = await start(d); expect((await (await fetch(u)).json()).rev).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('{broken')
    expect((await put(u, { baseRev: 0, state: { desks: [{ id: 'a', wins: [chats] }] } })).status).toBe(200)
    expect(JSON.parse(readFileSync(file, 'utf8')).rev).toBe(1)
  })
})
