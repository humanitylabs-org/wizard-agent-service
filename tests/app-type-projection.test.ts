import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readApps } from '../server/wizard-os-settings.mjs'

test('declared app type and category survive the service projection; unknown values are dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-type-'))
  try {
    const appsJsonPath = join(root, 'apps.json')
    writeFileSync(appsJsonPath, JSON.stringify({ apps: [
      { id: 'wizard-brightdata', name: 'Bright Data', summary: 'Web data for your agent and apps.', type: 'external', category: 'app', view: { url: '/brightdata/' } },
      { id: 'money', name: 'Money', type: 'view', category: 'app', view: { url: '/money/' } },
      { id: 'transcriber', name: 'Transcriber', type: 'service', category: 'system' },
      { id: 'weird', name: 'Weird', type: 'External', category: '<b>x</b>', view: { url: '/weird/' } },
      { id: 'legacy', name: 'Legacy', view: { url: '/legacy/' } },
    ] }))
    const apps = Object.fromEntries(readApps({ appsJsonPath, launcherPath: join(root, 'missing.json') }).apps.map((a: any) => [a.id, a]))
    expect(apps['wizard-brightdata'].type).toBe('external')
    expect(apps['wizard-brightdata'].category).toBe('app')
    expect(apps.money.type).toBe('view')
    expect(apps.transcriber).toMatchObject({ type: 'service', category: 'system' })
    for (const id of ['weird', 'legacy']) {
      expect(Object.hasOwn(apps[id], 'type')).toBe(false)
      expect(Object.hasOwn(apps[id], 'category')).toBe(false)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
