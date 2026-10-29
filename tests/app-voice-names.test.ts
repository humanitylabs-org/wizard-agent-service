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
      {id:'opt-out',name:'Opt Out',view:{url:'/opt-out/'},voice_names:[]},
      {id:'invalid',name:'Invalid',view:{url:'/invalid/'},voice_names:[null,true,'', 'x'.repeat(41)]},
      {id:'string',name:'String',view:{url:'/string/'},voice_names:'Reading Room'},
      {id:'null',name:'Null',view:{url:'/null/'},voice_names:null},
    ]}))
    const apps: any[] = readApps({appsJsonPath,launcherPath:join(root,'missing.json')}).apps
    expect(apps.find(a => a.id === 'example-reader').voice_names).toEqual(['Reading Room','page turner'])
    expect(Object.hasOwn(apps.find(a => a.id === 'legacy'), 'voice_names')).toBe(false)
    expect(apps.find(a => a.id === 'opt-out').voice_names).toEqual([])
    expect(apps.find(a => a.id === 'invalid').voice_names).toEqual([])
    expect(apps.find(a => a.id === 'string').voice_names).toEqual([])
    expect(apps.find(a => a.id === 'null').voice_names).toEqual([])
  } finally { rmSync(root, {recursive:true,force:true}) }
})
