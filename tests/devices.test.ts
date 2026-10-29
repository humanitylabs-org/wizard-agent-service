import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createDevices, devicesTool } from '../server/devices.mjs'

const session = { manufacturer: 'Google', model: 'Pixel 10 Pro XL', sdk: 37, appVersion: '0.10.18', versionCode: 82, webviewPackage: 'app.vanadium.webview', webviewVersion: '156.0.8078.47.0' }
let root: string
let clock: number
let path: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devices-')); path = join(root, 'devices.json'); clock = Date.parse('2026-10-29T01:00:00Z') })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const registry = () => createDevices({ statePath: path, now: () => clock })

it('allowlists metadata, strips controls, preserves first seen/count and reloads atomically', () => {
  const d = registry()
  expect(d.record({ ...session, model: 'Pixel\n10', events: ['secret'], accessibilityServices: ['secret'], id: 'secret' })).toBe(true)
  const expected = { ...session, model: 'Pixel10', first_seen: new Date(clock).toISOString(), last_seen: new Date(clock).toISOString(), report_count: 1 }
  expect(d.list()).toEqual([expected])
  expect(registry().list()).toEqual([expected])
  clock += 60000
  d.record({ ...session, model: 'Pixel10' })
  expect(d.list()[0]).toMatchObject({ first_seen: expected.first_seen, last_seen: new Date(clock).toISOString(), report_count: 2 })
  expect(readFileSync(path, 'utf8')).not.toContain('secret')
  const snapshot = d.list(); snapshot[0].model = 'mutated'
  expect(d.list()[0].model).toBe('Pixel10')
})

it('rejects garbage without creating entries', () => {
  const d = registry()
  const invalid = [null, [], {}, 'bad', { ...session, sdk: '37' }, { ...session, sdk: 0 }, { ...session, sdk: 101 }, { ...session, sdk: 37.5 }, { ...session, versionCode: 0 }, { ...session, versionCode: 2147483648 }]
  for (const field of ['manufacturer', 'model', 'appVersion', 'webviewPackage', 'webviewVersion']) {
    for (const value of [null, 5, {}, '', '\n\u0000', 'x'.repeat(81)]) invalid.push({ ...session, [field]: value } as any)
  }
  for (const value of invalid) expect(d.record(value)).toBe(false)
  expect(d.list()).toEqual([])
  expect(d.record({ ...session, model: 'x'.repeat(80), sdk: 100, versionCode: 2147483647 })).toBe(true)
})

it('caps at 20 devices, evicting oldest last seen, keyed by manufacturer and model', () => {
  const d = registry()
  for (let n = 0; n < 20; n++) { d.record({ ...session, model: `Phone ${n}` }); clock += 1000 }
  d.record({ ...session, model: 'Phone 0', id: 'different-session' }); clock += 1000
  d.record({ ...session, model: 'Phone 20' }); clock += 1000
  expect(d.list()).toHaveLength(20)
  expect(d.list().map(x => x.model)).not.toContain('Phone 1')
  expect(d.list()[0].model).toBe('Phone 20')
  expect(d.list().find(x => x.model === 'Phone 0').report_count).toBe(2)
  d.record({ ...session, manufacturer: 'Other', model: 'Phone 20' })
  expect(d.list().filter(x => x.model === 'Phone 20')).toHaveLength(2)
  expect(registry().list()).toHaveLength(20)
})

it('throttles writes for a minute unless any version changes, flushing final metadata on close', () => {
  const d = registry(); d.record(session)
  const first = readFileSync(path, 'utf8')
  clock += 59999; d.record(session)
  expect(d.list()[0].report_count).toBe(2)
  expect(readFileSync(path, 'utf8')).toBe(first)
  clock++; d.record(session)
  expect(registry().list()[0].report_count).toBe(3)
  for (const change of [{ sdk: 38 }, { appVersion: '0.10.19' }, { versionCode: 83 }, { webviewPackage: 'other.webview' }, { webviewVersion: '157' }]) {
    clock++; d.record({ ...d.list()[0], ...change })
    expect(registry().list()[0]).toMatchObject(change)
  }
  clock++; d.record(d.list()[0]); d.flush()
  expect(registry().list()).toEqual(d.list())
})

it('tolerates corrupt files and sanitizes loaded metadata instead of replaying arbitrary keys', () => {
  writeFileSync(path, 'bad json'); expect(registry().list()).toEqual([])
  const row = { ...session, first_seen: new Date(clock).toISOString(), last_seen: new Date(clock).toISOString(), report_count: 10, events: ['secret'] }
  writeFileSync(path, JSON.stringify({ devices: [row, { ...row, model: 'Invalid', report_count: -1 }] }))
  expect(registry().list()).toEqual([expect.not.objectContaining({ events: expect.anything() })])
  const d = registry(); clock += 60000; d.record(session)
  expect(readFileSync(path, 'utf8')).not.toContain('secret')
})

it('exposes the same no-argument builtin to every agent and formats relative last seen', () => {
  const d = registry(); const tool = devicesTool({ devices: d, now: () => clock })
  expect(tool.call('unrelated')).toBeUndefined()
  expect(tool.call('wizard_devices').content[0].text).toBe('No phones have checked in yet. The Wizard OS phone app reports itself while it is open.')
  for (const agent of ['hermes', 'host-profile', 'container', 'restricted']) expect(tool.list(agent).map(x => x.name)).toEqual(['wizard_devices'])
  expect(tool.call('wizard_devices', { session_id: 'nope' }).isError).toBe(true)
  d.record(session); clock += 180000
  expect(tool.call('wizard_devices').content[0].text).toBe('- Google Pixel 10 Pro XL (Android SDK 37): Wizard OS 0.10.18 (code 82), WebView app.vanadium.webview 156.0.8078.47.0, last seen 3 min ago')
})
