// Home-screen pin capabilities (wizard.md home_screen) survive the Agent Service app projection, re-validated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readApps } from '../server/wizard-os-settings.mjs'

function read(apps) {
  const root = mkdtempSync(join(tmpdir(), 'home-screen-'))
  try {
    const appsJsonPath = join(root, 'apps.json')
    writeFileSync(appsJsonPath, JSON.stringify({ apps }))
    return readApps({ appsJsonPath, launcherPath: join(root, 'missing.json') }).apps
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('installed home-screen capabilities survive the projection, validated', () => {
  const apps = read([
    { id: 'reader', name: 'Reader', view: { url: '/reader/' }, home_screen: { offline: true, position_keys: ['reader:*:pos:*'], route_state: 'reader' } },
    { id: 'legacy', name: 'Legacy', view: { url: '/legacy/' } },
    { id: 'off', name: 'Off', view: { url: '/off/' }, home_screen: { offline: false, position_keys: [] } },
    { id: 'loose', name: 'Loose', view: { url: '/loose/' }, home_screen: { offline: 'true', position_keys: ['*', 'ab*', 'abc\n', 5, 'ok-key:*'], route_state: '1bad' } },
    { id: 'string', name: 'String', view: { url: '/string/' }, home_screen: 'offline' },
    { id: 'array', name: 'Array', view: { url: '/array/' }, home_screen: [true] },
    { id: 'many', name: 'Many', view: { url: '/many/' }, home_screen: { position_keys: Array.from({ length: 12 }, (_, i) => `key${i}:*`) } },
  ])
  const by = id => apps.find(a => a.id === id)
  assert.deepEqual(by('reader').home_screen, { offline: true, position_keys: ['reader:*:pos:*'], route_state: 'reader' })
  for (const id of ['legacy', 'off', 'string', 'array']) assert.equal(Object.hasOwn(by(id), 'home_screen'), false, id)
  assert.deepEqual(by('loose').home_screen, { position_keys: ['ok-key:*'] })
  assert.equal(by('many').home_screen.position_keys.length, 8)
})
