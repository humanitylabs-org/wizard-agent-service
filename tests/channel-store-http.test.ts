// Issue 440: /wizard/v1/channels and the ui-preferences spaces projection over HTTP, switch off and on.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: any[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r)))); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'channels-http-')); dirs.push(d); return d }
async function start(d: string, channelStore: boolean, auth = false) {
  const s = createWizardServer({ wizardOsHome: d, requireAccess: auth, ...(auth ? { accessVerifier: async () => null } : {}), hermesKey: 'test', agentBridge: false, followThrough: false, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, channelStore })
  servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}/wizard/v1`
}
const json = (method: string, value: any, headers = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) })
const at = '2026-10-29T10:00:00.000Z'
const spaces = [{ id: 'space-one', name: 'One', threads: ['wizard_a', 'wizard_b'], createdAt: at }, { id: 'space-two', name: 'Two', agent: 'research', threads: ['wizard_a'], createdAt: at }]

describe('channels HTTP', () => {
  it('switch off: no channel routes, no store file, ui-preferences spaces unchanged', async () => {
    const d = home(); writeFileSync(join(d, 'ui-preferences.json'), JSON.stringify({ spaces }))
    const u = await start(d, false)
    expect((await fetch(`${u}/channels`)).status).toBe(404)
    expect((await fetch(`${u}/channels/membership?sessionId=wizard_a`)).status).toBe(404)
    expect((await (await fetch(`${u}/ui-preferences`)).json()).spaces).toEqual(spaces)
    expect(existsSync(join(d, 'channels.sqlite'))).toBe(false)
  })
  it('switch on: migrates on boot, serves channels, moves atomically, and old shells still read spaces', async () => {
    const d = home(), file = join(d, 'ui-preferences.json'); writeFileSync(file, JSON.stringify({ compact: true, spaces }))
    const u = await start(d, true)
    expect(statSync(join(d, 'channels.sqlite')).mode & 0o777).toBe(0o600)
    const listed = await (await fetch(`${u}/channels`)).json()
    expect(listed).toMatchObject({ schema: 'wizard.channels/1', sort: 'az' })
    expect(listed.channels.map((c: any) => [c.id, c.agent, c.count])).toEqual([['alerts', 'hermes', 0], ['space-one', 'hermes', 2], ['space-two', 'research', 1]])
    const created = await fetch(`${u}/channels`, json('POST', { name: 'Voice' }))
    expect(created.status).toBe(201)
    const voice = await created.json()
    expect(voice).toMatchObject({ name: 'Voice', agent: 'hermes', count: 0, archived: false })
    expect((await fetch(`${u}/channels`, json('PATCH', { id: voice.id, name: 'Voice notes', pinned: true }))).status).toBe(200)
    const moved = await fetch(`${u}/channels/membership`, json('PUT', { sessionId: 'wizard_a', channelId: voice.id }))
    expect(await moved.json()).toEqual({ sessionId: 'wizard_a', agent: 'hermes', channel: voice.id })
    expect(await (await fetch(`${u}/channels/membership?sessionId=wizard_a`)).json()).toEqual({ sessionId: 'wizard_a', agent: 'hermes', channel: voice.id })
    expect(await (await fetch(`${u}/channels/membership?sessionId=wizard_a&agent=research`)).json()).toMatchObject({ channel: 'space-two' })
    // Older shells: spaces is the store's projection; a full PUT cannot change it.
    const prefs = await (await fetch(`${u}/ui-preferences`)).json()
    expect(prefs.compact).toBe(true)
    expect(prefs.spaces.find((s: any) => s.id === 'space-one').threads).toEqual(['wizard_b'])
    expect(prefs.spaces.find((s: any) => s.id === voice.id)).toMatchObject({ name: 'Voice notes', threads: ['wizard_a'] })
    expect((await fetch(`${u}/ui-preferences`, json('PUT', { compact: false, spaces: [] }))).status).toBe(200)
    expect((await (await fetch(`${u}/ui-preferences`)).json()).spaces).toHaveLength(4)
    // The phase 1 shell's PATCH ops still file chats, now into the store.
    expect((await fetch(`${u}/ui-preferences`, json('PATCH', { ops: [{ op: 'add', key: 'spaces/space-one/threads', item: 'wizard_c' }] }))).status).toBe(200)
    expect((await (await fetch(`${u}/channels/membership?sessionId=wizard_c`)).json()).channel).toBe('space-one')
    // Errors: unknown keys, wrong method, non-JSON, cross-site writes, missing channel.
    expect((await fetch(`${u}/channels`, json('PATCH', { id: voice.id, colour: 'red' }))).status).toBe(400)
    expect((await fetch(`${u}/channels`, json('DELETE', {}))).status).toBe(405)
    expect((await fetch(`${u}/channels`, { method: 'POST', body: 'name=x' })).status).toBe(415)
    expect((await fetch(`${u}/channels`, json('POST', { name: 'x' }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
    const missing = await fetch(`${u}/channels/membership`, json('PUT', { sessionId: 'wizard_a', channelId: 'nope' }))
    expect([missing.status, (await missing.json()).error]).toEqual([404, 'channel_not_found'])
    const mismatch = await fetch(`${u}/channels/membership`, json('PUT', { sessionId: 'wizard_a', channelId: 'space-two', agent: 'hermes' }))
    expect([mismatch.status, (await mismatch.json()).error]).toEqual([409, 'agent_mismatch'])
    // Restart: durable, not migrated again, still one Alerts. The file's own Spaces are untouched.
    const again = await start(d, true)
    const after = (await (await fetch(`${again}/channels`)).json()).channels
    expect(after.map((c: any) => c.name)).toEqual(['Alerts', 'One', 'Two', 'Voice notes'])
    expect(JSON.parse(readFileSync(file, 'utf8')).spaces).toEqual(spaces)
  })
  it('needs the same verified access as ui-preferences', async () => {
    const u = await start(home(), true, true)
    for (const path of ['/channels', '/channels/membership?sessionId=wizard_a', '/ui-preferences']) expect((await fetch(`${u}${path}`)).status).toBe(403)
  })
})
