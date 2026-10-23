import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readApps } from '../server/wizard-os-settings.mjs'

test('installed launch names survive the service projection', () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-names-'))
  try {
    const appsJsonPath = join(root, 'apps.json')
    writeFileSync(appsJsonPath, JSON.stringify({apps: [
      {id:'example-reader',name:'Example Reader',view:{url:'/reader/'},voice_names:['Reading Room','page turner']},
      {id:'legacy',name:'Legacy',view:{url:'/legacy/'}},
      {id:'invalid',name:'Invalid',view:{url:'/invalid/'},voice_names:[null,true,'', 'x'.repeat(41)]},
    ]}))
    const apps = readApps({appsJsonPath,launcherPath:join(root,'missing.json')}).apps
    expect(apps.find(a => a.id === 'example-reader').voice_names).toEqual(['Reading Room','page turner'])
    expect(apps.find(a => a.id === 'legacy').voice_names).toEqual([])
    expect(apps.find(a => a.id === 'invalid').voice_names).toEqual([])
  } finally { rmSync(root, {recursive:true,force:true}) }
})
