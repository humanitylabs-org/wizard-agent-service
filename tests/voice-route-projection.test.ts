import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readApps, voiceRoutes } from '../server/wizard-os-settings.mjs'
const routes = [{words:['music','shazam'],open:'?view=identify&listen=1',rest_param:'q'}]
test('installed manifests and launcher-only apps project the same declarative route data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'voice-routes-'))
 try {
  const appsJsonPath=join(dir,'apps.json'),launcherPath=join(dir,'launcher.json')
  writeFileSync(appsJsonPath,JSON.stringify({apps:[{id:'installed',view:'/installed/',voice_routes:routes}]}))
  writeFileSync(launcherPath,JSON.stringify({links:[{id:'music',url:'/wizard-music/',voice_routes:routes},{id:'legacy',url:'/legacy/'}]}))
  const apps=readApps({appsJsonPath,launcherPath}).apps
  expect(apps.find(a=>a.id==='installed').voice_routes).toEqual(routes)
  expect(apps.find(a=>a.id==='music').voice_routes).toEqual(routes)
  expect(apps.find(a=>a.id==='legacy').voice_routes).toEqual([])
 } finally {rmSync(dir,{recursive:true,force:true})}
})
test('malformed routes never escape the projection boundary',()=>{
 expect(voiceRoutes([{words:['two words'],open:'?x=1'}, {words:['music'],open:'//evil.test/'}, {words:['music'],open:'https://evil.test/'}, {words:['music'],open:'?x=1',rest_param:'bad key'}, {words:['music'],open:'?x=1\\bad'}])).toEqual([])
 expect(voiceRoutes(null)).toEqual([])
})
