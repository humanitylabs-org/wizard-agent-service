// Auto channel emoji (wizard-ux issue 1580): a channel an agent creates with no emoji gets a fitting one in front of its
// name while Channels are on (the channel store); classic Spaces (switch off) keep every name exactly as given.
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelStore } from '../server/channel-store.mjs'
import { createSpacesTools } from '../server/spaces-tools.mjs'
import { readUiPreferences } from '../server/ui-preferences.mjs'
import { CHANNEL_AUTO_EMOJI, channelAutoEmoji, channelAutoName, startsWithEmoji } from '../server/channel-emoji.mjs'

const dirs: string[] = [], closers: any[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c.close(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'channel-emoji-')); dirs.push(d); return d }
const AGENTS = ['hermes', 'host', 'container', 'restricted']
function tools(channelsOn: boolean) {
  const d = home(), store = channelsOn ? createChannelStore(join(d, 'channels.sqlite')) : null
  if (store) closers.push(store)
  const path = join(d, 'ui-preferences.json')
  const t = createSpacesTools({ path, channels: store, loadThreads: async () => [], threadExists: async () => true, agentExists: id => AGENTS.includes(id) })
  const call = async (name: string, args: any, agent = 'hermes') => { const r: any = await t.call(name, args, agent); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text) }
  return { store, path, call }
}

it('the keyword map picks a fitting emoji, or none', () => {
  expect([channelAutoEmoji('Money'), channelAutoEmoji('Podcast'), channelAutoEmoji('Music'), channelAutoEmoji('Health')]).toEqual(['💰', '🎙️', '🎵', '🩺'])
  expect(channelAutoEmoji('Zzzqx')).toBe('')
  expect(channelAutoEmoji('Podcasts')).toBe('🎙️'); expect(channelAutoEmoji('Podcasting')).toBe('🎙️'); expect(channelAutoEmoji('Morning workout')).toBe('🏋️')
  expect(channelAutoEmoji('Carrots')).toBe(''); expect(channelAutoEmoji('Said')).toBe('')
  expect(channelAutoName('Money')).toBe('💰 Money'); expect(channelAutoName('Zzzqx')).toBe('Zzzqx'); expect(channelAutoName('🎯 Money')).toBe('🎯 Money')
  expect(channelAutoName('Money ' + 'x'.repeat(54))).toBe('Money ' + 'x'.repeat(54))
  for (const [e] of CHANNEL_AUTO_EMOJI) expect(startsWithEmoji(`${e} x`)).toBe(true)
  const seen = new Set<string>(); for (const [, ks] of CHANNEL_AUTO_EMOJI) for (const k of ks.split(' ')) { expect(seen.has(k)).toBe(false); seen.add(k) }
})

it('Channels on: an agent\'s new channel gets the emoji in front, for the main and routed agents', async () => {
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

it('Channels on: a channel the owner already named without an emoji is reused as it is', async () => {
  const { store, call } = tools(true)
  const old = store!.create({ name: 'Money', agent: 'hermes' })
  const got = (await call('spaces_create', { name: 'Money' })).space
  expect(got).toMatchObject({ id: old.id, name: 'Money' })
})

it('Channels off (classic Spaces): every name is stored exactly as given', async () => {
  const { path, call } = tools(false)
  for (const name of ['Money', 'Podcast', 'Zzzqx']) expect((await call('spaces_create', { name })).space.name).toBe(name)
  expect(readUiPreferences(path).spaces.map((s: any) => s.name)).toEqual(['Money', 'Podcast', 'Zzzqx'])
})
