// Issue 471: channel read watermarks shared by the owner's devices (/wizard/v1/channels/read), forward only.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { createChannelStore, validReadKey, READ_MARKS_MAX } from '../server/channel-store.mjs'

const servers: any[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r)))); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'channel-reads-')); dirs.push(d); return d }
async function start(d: string, options: Record<string, boolean>) {
  const s = createWizardServer({ wizardOsHome: d, requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, ...options })
  servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}/wizard/v1/channels/read`
}
const put = (body: any, headers = {}) => ({ method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('channel read marks: store', () => {
  it('moves each key forward only, clamps a clock ahead of the box, and keeps the newest marks', () => {
    const d = home(), store = createChannelStore(join(d, 'channels.sqlite'))
    try {
      const now = Date.now()
      expect(store.reads()).toEqual({ schema: 'wizard.channel-reads/1', at: {} })
      store.markRead({ general: now - 5000, 'hermes|launch': now - 4000, 'general|research': now - 3000 })
      store.markRead({ general: now - 9000, 'hermes|launch': now - 1000 })
      expect(store.reads().at).toEqual({ general: now - 5000, 'hermes|launch': now - 1000, 'general|research': now - 3000 })
      store.markRead({ 'research|notes': now + 864e5 })
      expect(store.reads().at['research|notes']).toBeLessThanOrEqual(Date.now() + 60_000)
      for (const bad of [{}, [], { 'bad key': 1 }, { 'hermes|Launch': 1 }, { general: 'x' }, { general: -1 }, { general: Infinity }]) expect(() => store.markRead(bad)).toThrow()
      expect(['general', 'general|research', 'hermes|launch', 'research|alerts-1'].every(validReadKey)).toBe(true)
      expect(['general|', '|x', 'hermes|', 'a|b|c', 'x'.repeat(60) + '|y'].some(validReadKey)).toBe(false)
      for (let i = 0; i < 4; i++) store.markRead(Object.fromEntries(Array.from({ length: 300 }, (_, j) => [`hermes|c-${i}-${j}`, 1000 + i * 300 + j])))
      const kept = store.reads().at
      expect(Object.keys(kept)).toHaveLength(READ_MARKS_MAX)
      expect(kept.general).toBe(now - 5000)
      expect(kept['hermes|c-0-0']).toBeUndefined()
    } finally { store.close() }
  })
})

describe('channel read marks: HTTP', () => {
  it('switch off (or store off): 404, nothing else changes', async () => {
    expect((await fetch(await start(home(), { channelStore: true }))).status).toBe(404)
    expect((await fetch(await start(home(), { channelReadSync: true }))).status).toBe(404)
  })
  it('switch on: one device writes, the other reads the same marks; older marks never move it back', async () => {
    const d = home(), u = await start(d, { channelStore: true, channelReadSync: true }), t = Date.now() - 60_000
    expect(await (await fetch(u)).json()).toEqual({ schema: 'wizard.channel-reads/1', at: {} })
    const phone = await fetch(u, put({ at: { general: t, 'hermes|launch': t } }))
    expect(phone.status).toBe(200)
    expect((await phone.json()).at).toEqual({ general: t, 'hermes|launch': t })
    const desktop = await fetch(u, put({ at: { general: t - 10_000, 'research|notes': t } }))
    expect((await desktop.json()).at).toEqual({ general: t, 'hermes|launch': t, 'research|notes': t })
    expect((await fetch(u, { cache: 'no-store' })).headers.get('cache-control')).toBe('no-store')
    // Same rules as the other channel routes.
    expect((await fetch(u, put({ at: { general: t }, since: 1 }))).status).toBe(400)
    expect((await fetch(u, put({ at: { 'Not A Key': t } }))).status).toBe(400)
    expect((await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(405)
    expect((await fetch(u, { method: 'PUT', body: 'at=1' })).status).toBe(415)
    expect((await fetch(u, put({ at: { general: Date.now() } }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
    // Durable across a restart.
    await new Promise<void>(r => servers.shift().close(r))
    const again = await start(d, { channelStore: true, channelReadSync: true })
    expect((await (await fetch(again)).json()).at['hermes|launch']).toBe(t)
  })
})
