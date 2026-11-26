// Auto channel emoji (wizard-ux issue 1580, owner switch wizard/channel-auto-emoji, off by default): a channel an agent
// creates with no emoji gets a fitting one in front of its name while the switch is on; switch off (and classic Spaces)
// keep every name exactly as given.
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelStore } from '../server/channel-store.mjs'
import { createSpacesTools } from '../server/spaces-tools.mjs'
import { readUiPreferences } from '../server/ui-preferences.mjs'
import { createChannelsSwitch } from '../server/channels-switch.mjs'
import { CHANNEL_AUTO_EMOJI, CHANNEL_AUTO_EMOJI_SWITCH, bareChannelName, channelAutoEmoji, channelAutoName, startsWithEmoji } from '../server/channel-emoji.mjs'

const dirs: string[] = [], closers: any[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c.close(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'channel-emoji-')); dirs.push(d); return d }
const AGENTS = ['hermes', 'host', 'container', 'restricted']
function tools(channelsOn: boolean, autoEmoji: () => boolean = () => true) {
  const d = home(), store = channelsOn ? createChannelStore(join(d, 'channels.sqlite')) : null
  if (store) closers.push(store)
  const path = join(d, 'ui-preferences.json')
  const t = createSpacesTools({ path, channels: store, loadThreads: async () => [], threadExists: async () => true, agentExists: id => AGENTS.includes(id), autoEmoji })
  const call = async (name: string, args: any, agent = 'hermes') => { const r: any = await t.call(name, args, agent); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text) }
  return { store, path, call }
}

it('the keyword map picks a fitting emoji, or none', () => {
  expect([channelAutoEmoji('Money'), channelAutoEmoji('Podcast'), channelAutoEmoji('Music'), channelAutoEmoji('Health')]).toEqual(['💰', '🎙️', '🎵', '🩺'])
  expect(channelAutoEmoji('Zzzqx')).toBe('')
  expect(channelAutoEmoji('Podcasts')).toBe('🎙️'); expect(channelAutoEmoji('Podcasting')).toBe('🎙️'); expect(channelAutoEmoji('Morning workout')).toBe('🏋️')
  expect(channelAutoEmoji('Shopping')).toBe('🛒'); expect(channelAutoEmoji('Photos')).toBe('📷')
  expect(channelAutoEmoji('Carrots')).toBe(''); expect(channelAutoEmoji('Said')).toBe('')
  expect(channelAutoName('Money')).toBe('💰 Money'); expect(channelAutoName('Zzzqx')).toBe('Zzzqx'); expect(channelAutoName('🎯 Money')).toBe('🎯 Money')
  expect(channelAutoName('Money ' + 'x'.repeat(54))).toBe('Money ' + 'x'.repeat(54))
  for (const [e] of CHANNEL_AUTO_EMOJI) expect(startsWithEmoji(`${e} x`)).toBe(true)
  const seen = new Set<string>(); for (const [, ks] of CHANNEL_AUTO_EMOJI) for (const k of ks.split(' ')) { expect(seen.has(k)).toBe(false); seen.add(k) }
})

it('switch on: an agent\'s new channel gets the emoji in front, for the main and routed agents', async () => {
  for (const agent of AGENTS) {
    const { call } = tools(true)
    const money = (await call('spaces_create', { name: 'Money' }, agent)).space
    expect(money.name).toBe('💰 Money')
    expect((await call('spaces_create', { name: 'money' }, agent)).space.id).toBe(money.id) // never a second one
    expect((await call('spaces_create', { name: '💰 Money' }, agent)).space.id).toBe(money.id)
    expect((await call('spaces_create', { name: 'Podcast' }, agent)).space.name).toBe('🎙️ Podcast')
    expect((await call('spaces_create', { name: 'Zzzqx' }, agent)).space.name).toBe('Zzzqx')
    expect((await call('spaces_create', { name: '🎯 Plans' }, agent)).space.name).toBe('🎯 Plans')
    expect((await call('spaces_list', {}, agent)).spaces.map((s: any) => s.name)).toEqual(['💰 Money', '🎙️ Podcast', 'Zzzqx', '🎯 Plans'])
  }
})

it('switch on: a channel the owner already named without an emoji is reused as it is', async () => {
  const { store, call } = tools(true)
  const old = store!.create({ name: 'Money', agent: 'hermes' })
  const got = (await call('spaces_create', { name: 'Money' })).space
  expect(got).toMatchObject({ id: old.id, name: 'Money' })
  expect((await call('spaces_create', { name: '💰 Money' })).space.id).toBe(old.id) // words match without the emoji
  expect((await call('spaces_create', { name: '🎯 money' })).space.id).toBe(old.id)
  const exact = store!.create({ name: '💰 Money', agent: 'hermes' })
  expect((await call('spaces_create', { name: '💰 Money' })).space.id).toBe(exact.id) // an exact name wins
  expect(bareChannelName('💰 Money')).toBe('Money'); expect(bareChannelName('🚀')).toBe('🚀'); expect(bareChannelName('Money')).toBe('Money')
})

it('Channels off (classic Spaces): every name is stored exactly as given', async () => {
  const { path, call } = tools(false)
  for (const name of ['Money', 'Podcast', 'Zzzqx']) expect((await call('spaces_create', { name })).space.name).toBe(name)
  expect(readUiPreferences(path).spaces.map((s: any) => s.name)).toEqual(['Money', 'Podcast', 'Zzzqx'])
})

it('switch off (the default): an agent\'s new channel keeps its name exactly as given, for the main and routed agents', async () => {
  for (const agent of AGENTS) {
    const { store, call } = tools(true, () => false)
    for (const name of ['Money', 'Podcast', 'Zzzqx', '🎯 Plans']) expect((await call('spaces_create', { name }, agent)).space.name).toBe(name)
    expect((await call('spaces_create', { name: 'money' }, agent)).space.name).toBe('Money') // same name reused, as before
    store!.create({ name: '💰 Bank', agent })
    expect((await call('spaces_create', { name: 'Bank' }, agent)).space.name).toBe('Bank') // no emoji-less word matching
  }
  // Without the option at all (older callers), nothing is added either.
  const d = home(), store = createChannelStore(join(d, 'channels.sqlite')); closers.push(store)
  const bare = createSpacesTools({ path: join(d, 'ui-preferences.json'), channels: store, loadThreads: async () => [], threadExists: async () => true })
  const r: any = await bare.call('spaces_create', { name: 'Money' }, 'hermes')
  expect(JSON.parse(r.content[0].text).space.name).toBe('Money')
})

it('the switch is read from the owner\'s Look file at each create, with no restart', async () => {
  let look: string | undefined = undefined, t = 0
  const on = createChannelsSwitch({ id: CHANNEL_AUTO_EMOJI_SWITCH, readLook: () => look, now: () => t, ttlMs: 3000 })
  const { call } = tools(true, on)
  expect((await call('spaces_create', { name: 'Money' })).space.name).toBe('Money') // no Look file: off
  look = JSON.stringify({ version: 1, tweaks: { [CHANNEL_AUTO_EMOJI_SWITCH]: { on: true } } }); t += 3001
  expect((await call('spaces_create', { name: 'Podcast' })).space.name).toBe('🎙️ Podcast')
  look = JSON.stringify({ version: 1, tweaks: { [CHANNEL_AUTO_EMOJI_SWITCH]: { on: false } } }); t += 3001
  expect((await call('spaces_create', { name: 'Music' })).space.name).toBe('Music')
  expect(CHANNEL_AUTO_EMOJI_SWITCH).toBe('wizard/channel-auto-emoji')
})
