// wizard-ux issue 1258: Channels are on for everyone. The owner's old `wizard/chat-channels` switch (issue 1358) is
// gone, an old value for it in the Look file is ignored, and only a box's WIZARD_CHANNEL_* env 0 turns a part off.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { Scheduler } from '../server/scheduler.mjs'
import { channelOn, channelPart, envChoice, lookSwitchOn } from '../server/channels-switch.mjs'

const CHANNELS_SWITCH = 'wizard/chat-channels'

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
    ...extra,
  })
  servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}/wizard/v1`
}
const json = (method: string, value: any) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
const at = '2026-11-12T10:00:00.000Z'
const spaces = [{ id: 'space-one', name: 'One', threads: ['wizard_a', 'wizard_b'], createdAt: at }]

describe('channels: on for everyone', () => {
  it('the Look file reader still reads other switches by id', () => {
    expect(lookSwitchOn(look(true), CHANNELS_SWITCH)).toBe(true)
    expect(lookSwitchOn(look(false), CHANNELS_SWITCH)).toBe(false)
    expect(lookSwitchOn('{not json', CHANNELS_SWITCH)).toBe(false)
  })
  it('a part is on unless env 0 forces it off', () => {
    expect([envChoice('1'), envChoice('0'), envChoice(undefined), envChoice('')]).toEqual([true, false, undefined, undefined])
    expect([channelOn(true), channelOn(false), channelOn(undefined)]).toEqual([true, false, true])
    // Other Look-file switches (private first, agent inbox) still follow the owner's choice.
    expect([channelPart(true, () => false), channelPart(false, () => true), channelPart(undefined, () => true), channelPart(undefined, () => false)]).toEqual([true, false, true, false])
  })
  it('the scheduler takes the channel field only while the switch is on', () => {
    const d = home(); let on = false
    const s = new Scheduler({ statePath: join(d, 'sched.db'), deliver: async () => ({}), channels: () => on, intervalMs: 0 })
    expect(s.channels).toBe(false); on = true; expect(s.channels).toBe(true)
    expect(new Scheduler({ statePath: join(d, 'sched2.db'), deliver: async () => ({}), channels: true, intervalMs: 0 }).channels).toBe(true)
  })
})

describe('channels over HTTP', () => {
  it('are on with no Look file and with an old switch-off Look file, and copy the Spaces once', async () => {
    const d = home(); writeFileSync(join(d, 'ui-preferences.json'), JSON.stringify({ spaces })); setLook(d, false)
    const u = await start(d)
    const listed = await (await fetch(`${u}/channels`)).json()
    // The Daily channel (issue 527) is on too: seeded on top, once.
    expect(listed.channels.map((c: any) => [c.id, c.count])).toEqual([['daily', 0], ['alerts', 0], ['space-one', 2]])
    expect((await fetch(`${u}/channels/read`)).status).toBe(200)
    const voice = await (await fetch(`${u}/channels`, json('POST', { name: 'Voice' }))).json()
    expect((await fetch(`${u}/channels/membership`, json('PUT', { sessionId: 'wizard_a', channelId: voice.id }))).status).toBe(200)
    // The file's own Spaces are never rewritten.
    expect(JSON.parse(readFileSync(join(d, 'ui-preferences.json'), 'utf8')).spaces).toEqual(spaces)
    // An old on value changes nothing either.
    setLook(d, true)
    const after = (await (await fetch(`${u}/channels`)).json()).channels
    expect(after.map((c: any) => [c.name, c.count])).toEqual([['Daily', 0], ['Alerts', 0], ['One', 1], ['Voice', 1]])
    expect((await (await fetch(`${u}/channels/membership?sessionId=wizard_a`)).json()).channel).toBe(voice.id)
  })
  it('a box without a Look file has Channels', async () => {
    const d = home()
    const u = await start(d)
    expect((await fetch(`${u}/channels`)).status).toBe(200)
    expect(existsSync(join(d, 'channels.sqlite'))).toBe(true)
  })
  it('env 0 still turns a part off', async () => {
    const off = home()
    const u1 = await start(off, { channelStore: false })
    expect((await fetch(`${u1}/channels`)).status).toBe(404)
    expect(existsSync(join(off, 'channels.sqlite'))).toBe(false)
    // Read marks follow their own choice: forced off here even though the store is on.
    const u3 = await start(home(), { channelReadSync: false })
    expect((await fetch(`${u3}/channels`)).status).toBe(200)
    expect((await fetch(`${u3}/channels/read`)).status).toBe(404)
  })
})
