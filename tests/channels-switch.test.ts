// wizard-ux issue 1358: one Channels switch. The owner's `wizard/chat-channels` switch in the synced Look file turns
// every Channels part of the service on and off at runtime (no restart); WIZARD_CHANNEL_* env choices still win.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { Scheduler } from '../server/scheduler.mjs'
import { CHANNELS_SWITCH, channelPart, createChannelsSwitch, envChoice, lookSwitchOn } from '../server/channels-switch.mjs'

const servers: any[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r)))); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'channels-switch-')); dirs.push(d); return d }
const look = (on: boolean | null) => JSON.stringify({ version: 1, skin: null, tweaks: on === null ? {} : { [CHANNELS_SWITCH]: { on, at: 1 } } })
const setLook = (d: string, on: boolean | null) => { mkdirSync(join(d, 'Pages', 'wizard-look'), { recursive: true }); writeFileSync(join(d, 'Pages', 'wizard-look', 'look.json'), look(on)) }
async function start(d: string, extra: Record<string, unknown> = {}) {
  const s = createWizardServer({
    wizardOsHome: d, requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false,
    runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0,
    pagesRoot: join(d, 'Pages'), pagesGitDir: join(d, 'pages-history.git'), pagesWatch: false,
    channelsSwitchTtlMs: 0, ...extra,
  })
  servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}/wizard/v1`
}
const json = (method: string, value: any) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
const at = '2026-11-12T10:00:00.000Z'
const spaces = [{ id: 'space-one', name: 'One', threads: ['wizard_a', 'wizard_b'], createdAt: at }]

describe('channels switch: reading the Look file', () => {
  it('is on only for a version 1 Look file with the switch on', () => {
    expect(lookSwitchOn(look(true))).toBe(true)
    expect(lookSwitchOn(look(false))).toBe(false)
    expect(lookSwitchOn(look(null))).toBe(false)
    expect(lookSwitchOn(JSON.stringify({ version: 2, tweaks: { [CHANNELS_SWITCH]: { on: true } } }))).toBe(false)
    expect(lookSwitchOn('{not json')).toBe(false)
    expect(lookSwitchOn(undefined)).toBe(false)
  })
  it('env 1 forces a part on, 0 forces it off, anything else follows the switch', () => {
    expect([envChoice('1'), envChoice('0'), envChoice(undefined), envChoice('')]).toEqual([true, false, undefined, undefined])
    expect([channelPart(true, () => false), channelPart(false, () => true), channelPart(undefined, () => true), channelPart(undefined, () => false)]).toEqual([true, false, true, false])
    expect(channelPart(undefined, () => { throw new Error('x') })).toBe(false)
  })
  it('reads the file at most once per ttl, and an unreadable file is off', () => {
    let reads = 0, t = 0, text: any = look(true)
    const on = createChannelsSwitch({ readLook: () => { reads++; if (text instanceof Error) throw text; return text }, now: () => t, ttlMs: 3000 })
    expect(on()).toBe(true); text = look(false); t = 2999
    expect([on(), reads]).toEqual([true, 1])
    t = 3000; expect([on(), reads]).toEqual([false, 2])
    text = new Error('gone'); t = 7000; expect(on()).toBe(false)
  })
  it('the scheduler takes the channel field only while the switch is on', () => {
    const d = home(); let on = false
    const s = new Scheduler({ statePath: join(d, 'sched.db'), deliver: async () => ({}), channels: () => on, intervalMs: 0 })
    expect(s.channels).toBe(false); on = true; expect(s.channels).toBe(true)
    expect(new Scheduler({ statePath: join(d, 'sched2.db'), deliver: async () => ({}), channels: true, intervalMs: 0 }).channels).toBe(true)
  })
})

describe('channels switch over HTTP', () => {
  it('turns the store and read marks on and off at runtime, and keeps channels for the next time', async () => {
    const d = home(); writeFileSync(join(d, 'ui-preferences.json'), JSON.stringify({ spaces })); setLook(d, null)
    const u = await start(d)
    // Off: Spaces as before, no store file.
    expect((await fetch(`${u}/channels`)).status).toBe(404)
    expect((await fetch(`${u}/channels/read`)).status).toBe(404)
    expect(existsSync(join(d, 'channels.sqlite'))).toBe(false)
    // On, no restart: the store opens, copies the Spaces once, and read marks answer.
    setLook(d, true)
    const listed = await (await fetch(`${u}/channels`)).json()
    expect(listed.channels.map((c: any) => [c.id, c.count])).toEqual([['alerts', 0], ['space-one', 2]])
    expect((await fetch(`${u}/channels/read`)).status).toBe(200)
    const voice = await (await fetch(`${u}/channels`, json('POST', { name: 'Voice' }))).json()
    expect((await fetch(`${u}/channels/membership`, json('PUT', { sessionId: 'wizard_a', channelId: voice.id }))).status).toBe(200)
    // Off again: today's behaviour, with the file's own Spaces untouched.
    setLook(d, false)
    expect((await fetch(`${u}/channels`)).status).toBe(404)
    expect((await fetch(`${u}/channels/read`)).status).toBe(404)
    expect((await (await fetch(`${u}/ui-preferences`)).json()).spaces).toEqual(spaces)
    expect(existsSync(join(d, 'channels.sqlite'))).toBe(true)
    // On again: the same channels and memberships, not migrated a second time.
    setLook(d, true)
    const after = (await (await fetch(`${u}/channels`)).json()).channels
    expect(after.map((c: any) => [c.name, c.count])).toEqual([['Alerts', 0], ['One', 1], ['Voice', 1]])
    expect((await (await fetch(`${u}/channels/membership?sessionId=wizard_a`)).json()).channel).toBe(voice.id)
  })
  it('env choices still win over the switch', async () => {
    const off = home(); setLook(off, true)
    const u1 = await start(off, { channelStore: false })
    expect((await fetch(`${u1}/channels`)).status).toBe(404)
    expect(existsSync(join(off, 'channels.sqlite'))).toBe(false)
    const on = home(); setLook(on, false)
    const u2 = await start(on, { channelStore: true })
    expect((await fetch(`${u2}/channels`)).status).toBe(200)
    // Read marks follow their own choice: forced off here even though the store is on.
    const u3 = await start(home(), { channelStore: true, channelReadSync: false })
    expect((await fetch(`${u3}/channels/read`)).status).toBe(404)
  })
  it('a box without a Look file stays off', async () => {
    const d = home()
    const u = await start(d)
    expect((await fetch(`${u}/channels`)).status).toBe(404)
    expect(existsSync(join(d, 'channels.sqlite'))).toBe(false)
  })
})
