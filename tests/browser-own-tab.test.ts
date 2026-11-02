import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readApps } from '../server/wizard-os-settings.mjs'

// wizard-os #385 (Files decision, 2 Nov 2026): File Browser is the approved separate-origin exception. With the
// browser boundary on, WAM records it `browser.isolation: own-tab` and publishes it at its own https origin; the
// Service tells the shell `own_tab` so it opens a tab instead of a frame. Default-off: no `browser`, no flag.
test('a reviewed own-tab app on its own https origin is flagged own_tab; nothing else is', () => {
  const root = mkdtempSync(join(tmpdir(), 'own-tab-'))
  try {
    const appsJsonPath = join(root, 'apps.json')
    writeFileSync(appsJsonPath, JSON.stringify({ apps: [
      { id: 'files', name: 'Files', view: { url: 'https://box.tail1234.ts.net:8794/files/' }, browser: { schema: 1, isolation: 'own-tab' } },
      { id: 'files-same-origin', name: 'Old', view: { url: '/files/' }, browser: { schema: 1, isolation: 'own-tab' } },
      { id: 'notifications', name: 'Notifications', view: { url: '/notifications/' }, browser: { schema: 1, contract: { isolation: 'opaque' } } },
      { id: 'boundary-off', name: 'Off', view: { url: '/files/' } },
      { id: 'claims', name: 'Claims', view: { url: 'https://box.tail1234.ts.net:8999/' }, isolation: 'own-tab', own_tab: true },
    ] }))
    const apps = Object.fromEntries(readApps({ appsJsonPath, launcherPath: join(root, 'missing.json') }).apps.map((a: any) => [a.id, a]))
    expect(apps.files).toMatchObject({ own_tab: true, url: 'https://box.tail1234.ts.net:8794/files/' })
    for (const id of ['files-same-origin', 'notifications', 'boundary-off', 'claims']) expect(Object.hasOwn(apps[id], 'own_tab')).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
