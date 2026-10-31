import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readApps } from '../server/wizard-os-settings.mjs'

// The App Manager resolves an installed app's own silhouette into apps.json `icon` (`/<view>/icon.svg`); the
// launcher list passes it through so the shell can draw it the next time it loads, with no shell release.
test('an installed app keeps its own same-origin icon file; anything outside its view path is dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-icon-'))
  try {
    const appsJsonPath = join(root, 'apps.json')
    writeFileSync(appsJsonPath, JSON.stringify({ apps: [
      { id: 'wizard-health', name: 'Health', view: { url: '/wizard-health/', local: 'http://127.0.0.1:8826/' }, icon: '/wizard-health/icon.svg' },
      { id: 'own-png', name: 'Png', view: { url: '/own-png' }, icon: '/own-png/img/mark.png' },
      { id: 'other', name: 'Other', view: { url: '/other/' }, icon: '/wizard-health/icon.svg' },
      { id: 'remote', name: 'Remote', view: { url: '/remote/' }, icon: 'https://evil.example/remote/icon.svg' },
      { id: 'proto', name: 'Proto', view: { url: '/proto/' }, icon: '//evil.example/proto/icon.svg' },
      { id: 'dots', name: 'Dots', view: { url: '/dots/' }, icon: '/dots/../wizard-health/icon.svg' },
      { id: 'inject', name: 'Inject', view: { url: '/inject/' }, icon: "/inject/x.svg') ; background:red" },
      { id: 'gif', name: 'Gif', view: { url: '/gif/' }, icon: '/gif/icon.gif' },
      { id: 'cross', name: 'Cross', view: { url: 'https://box.example:9000/' }, icon: '/cross/icon.svg' },
      { id: 'noview', name: 'No view', icon: '/noview/icon.svg' },
      { id: 'emoji', name: 'Emoji', view: { url: '/emoji/' }, icon: '🙂' },
      { id: 'legacy', name: 'Legacy', view: { url: '/legacy/' } },
    ] }))
    writeFileSync(join(root, 'launcher.json'), JSON.stringify({ links: [{ id: 'mine', name: 'Mine', url: '/mine/', icon: 'files' }] }))
    const apps = Object.fromEntries(readApps({ appsJsonPath, launcherPath: join(root, 'launcher.json') }).apps.map((a: any) => [a.id, a]))
    expect(apps['wizard-health'].icon).toBe('/wizard-health/icon.svg')
    expect(apps['own-png'].icon).toBe('/own-png/img/mark.png')
    for (const id of ['other', 'remote', 'proto', 'dots', 'inject', 'gif', 'cross', 'noview', 'emoji', 'legacy'])
      expect(Object.hasOwn(apps[id], 'icon'), id).toBe(false)
    // launcher.json links keep their glyph names as before
    expect(apps.mine.icon).toBe('files')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
