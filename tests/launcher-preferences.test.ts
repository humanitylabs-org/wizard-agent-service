import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { readUiPreferences, seedUiPreferences, updateUiPreferences, validateUiPreferences } from '../server/ui-preferences.mjs'
const dirs: string[] = [], servers: any[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r)))); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'launcher-')); dirs.push(d); return d }
const launcher = { nativeLinks: [{ id: 'camera', name: 'Camera', icon: 'mic', colors: ['#ffffff'], href: 'intent:#Intent;action=android.media.action.STILL_IMAGE_CAMERA;end', phoneOnly: true }], recents: ['wizard'], desktopQuick: [], autoOpen: ['topics'], hostedThreadApps: ['wisdom'], displayNames: { 'wizard-signal': 'Signal' } }
const seed = { marker: 'launcher-seed-v1', launcher }
it('seeds marker and missing keys once, preserves existing launcher choices and unrelated values', () => {
  const file = join(home(), 'ui-preferences.json')
  const before = { compact: true, archiveAfterDays: 14, future: { opaque: [1, 2, 3] }, launcher: { autoOpen: [] } }
  writeFileSync(file, JSON.stringify(before))
  const first: any = seedUiPreferences(file, seed)
  expect(first.seeded).toBe(true)
  expect(first.preferences.launcher).toEqual({ ...launcher, autoOpen: [] })
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  for (const key of ['compact', 'archiveAfterDays', 'future']) expect(JSON.stringify(disk[key])).toBe(JSON.stringify(before[key as keyof typeof before]))
  expect(disk.migrations[seed.marker]).toMatch(/^\d{4}-.*Z$/)
  const bytes = readFileSync(file), mtime = statSync(file).mtimeMs
  expect(seedUiPreferences(file, { ...seed, launcher: { autoOpen: ['changed'] } }).seeded).toBe(false)
  expect(readFileSync(file)).toEqual(bytes); expect(statSync(file).mtimeMs).toBe(mtime)
  updateUiPreferences(file, { readyOrder: 'oldest' })
  expect((readUiPreferences(file) as any).launcher).toEqual(first.preferences.launcher)
})
it('rejects invalid bounded fields, schemes, duplicate ids, timestamps, unknown keys and prototype tricks', () => {
  for (const value of [null, [], { extra: [] }, { recents: ['Bad ID'] }, { recents: ['wizard\n'] }, { displayNames: { 'wizard\n': 'Wizard' } }, { autoOpen: ['a', 'a'] }, { desktopQuick: Array(101).fill('a') }, { hostedThreadApps: true }, { displayNames: { x: '' } },
    ...[{ href: 'javascript:alert(1)' }, { href: '//evil/' }, { href: 'file:///x' }, { name: 'x'.repeat(81) }, { icon: 'x'.repeat(161) }, { phoneOnly: 1 }, { colors: ['red'] }, { colors: ['#fff\n'] }, { extra: true }].map(p => ({ nativeLinks: [{ ...launcher.nativeLinks[0], ...p }] })),
    { nativeLinks: [launcher.nativeLinks[0], launcher.nativeLinks[0]] }, { nativeLinks: Array(51).fill(launcher.nativeLinks[0]) }, JSON.parse('{"__proto__":[]}')]) expect(() => validateUiPreferences({ launcher: value })).toThrow('invalid_preferences')
  for (const migrations of [{ a: 'yesterday' }, { a: '2026-10-26T00:00:00Z\n' }, { 'marker\n': '2026-10-26T00:00:00Z' }, { a: '2026-02-31T00:00:00Z' }, { a: '2026-10-26T25:00:00Z' }, { 'Bad marker': '2026-10-26T00:00:00Z' }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['x'+i, '2026-10-26T00:00:00Z']))]) expect(() => validateUiPreferences({ migrations })).toThrow()
  expect(() => seedUiPreferences(join(home(), 'bad-marker.json'), { ...seed, marker: 'marker\n' })).toThrow('invalid_preferences')
  for (const href of ['https://example.com/', 'tel:', 'sms:', 'intent://#Intent;package=example.app;end']) expect(() => validateUiPreferences({ launcher: { nativeLinks: [{ ...launcher.nativeLinks[0], href }] } })).not.toThrow()
})
it('never seeds over corrupt or invalid owner data; failed writes leave no marker', () => {
  const file = join(home(), 'ui-preferences.json')
  for (const raw of ['{broken', '{"launcher":{"extra":true}}', '{"migrations":{"x":"bad"}}']) {
    writeFileSync(file, raw); expect(() => seedUiPreferences(file, seed)).toThrow(); expect(readFileSync(file, 'utf8')).toBe(raw)
  }
})
it('HTTP seed is owner-only, JSON-only, same-site, bounded and concurrent-seed safe with PUT', async () => {
  const d = home()
  async function start(auth = false, ownerProof = '') {
    const s = createWizardServer({ wizardOsHome: d, ownerProof, hermesKey: 'test', agentBridge: false, followThrough: false, requireAccess: auth, ...(auth ? { accessVerifier: async () => null } : {}), runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0 })
    servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}/wizard/v1/ui-preferences`
  }
  const u = await start(), post = (url = u, headers = {}) => fetch(url+'/seed', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(seed) })
  expect((await post(await start(true))).status).toBe(403)
  const protectedUrl = await start(false, 'test-owner-proof-for-launcher-isolation')
  expect((await post(protectedUrl)).status).toBe(403)
  expect((await post(protectedUrl, { 'X-Wizard-Owner-Proof': 'wrong-proof' })).status).toBe(403)
  // Correct proof admits the route (malformed seed is 400 instead of owner-only 403).
  expect((await fetch(protectedUrl+'/seed', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Wizard-Owner-Proof': 'test-owner-proof-for-launcher-isolation' }, body: '{}' })).status).toBe(400)
  expect((await post(u, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  expect((await fetch(u+'/seed', { method: 'POST', body: '{}' })).status).toBe(415)
  expect((await fetch(u+'/seed')).status).toBe(405)
  const results = await Promise.all([post(), post(), fetch(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ compact: true, readyOrder: 'subject' }) })])
  expect(results.map(r => r.status)).toEqual([200, 200, 200])
  const seeds = await Promise.all(results.slice(0,2).map(r => r.json()))
  expect(seeds.map(r => r.seeded).sort()).toEqual([false, true])
  const prefs = await (await fetch(u)).json()
  expect(prefs.launcher).toEqual(launcher); expect(prefs.compact).toBe(true); expect(prefs.readyOrder).toBe('subject')
  const bad = await fetch(u+'/seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...seed, extra: true }) })
  expect(bad.status).toBe(400)
})
