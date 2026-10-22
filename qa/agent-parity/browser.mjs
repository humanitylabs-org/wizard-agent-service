// Run directly on Thales; synthetic gateways, real Service and unmodified shell/DOM.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { scene, kinds } from './fixture.mjs'
import { checks } from './checks.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.QA_PLAYWRIGHT || 'playwright-core')
const ux = resolve(process.env.QA_UX_ROOT || '')
const out = resolve(process.env.QA_OUT || '')
if (process.platform !== 'darwin' || !ux.startsWith('/Volumes/ThalesMedia/') || !out.startsWith('/Volumes/ThalesMedia/')) throw new Error('Browser QA requires Thales external-volume source/evidence')
mkdirSync(out, { recursive: true })
const cells = [], errors = [], requests = []
const features = ['image-thumbnail', 'back-contract']
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const source = { service: Object.fromEntries(['server/service.mjs','server/agents-http.mjs'].map(f => [f,hash(new URL('../../'+f,import.meta.url))])), ux: Object.fromEntries(['core/chats.js','core/chat-kit.js','app.js','styles.css'].map(f => [f,hash(join(ux,'web',f))])) }
const persist = completed => writeFileSync(join(out,'browser.json'),JSON.stringify({ schema_version:1, mode:'browser-synthetic', completed, source, cells, errors, requests, cleanup:{ existing_agents_opened:false }, summary:Object.fromEntries(['pass','fail'].map(s=>[s,cells.filter(c=>c.status===s).length])) },null,2)+'\n')
const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
try {
 for (const kind of kinds) {
  let s, context, page
  const record = (feature,status,reason) => { cells.push({ feature,kind,status,reason,evidence:'real Chrome DOM against synthetic runtime gateways', screenshots:[`${kind}-thread.png`,`${kind}-viewer.png`] }); persist(false) }
  try {
   s = await scene(kind,{ uxDir:join(ux,'web'),sttConfigured:true })
   await checks['session-create'](s)
   await checks['native-images'](s)
   const row = s.sessions.get('wizard_parity'); row.hidden=false; row.title='Parity QA · Synthetic'
   for (const run of s.runs.values()) { run.status='completed'; run.output='Synthetic assistant answer'; run.updated_at=Date.now()/1000 }
   row.messages.push({ id:'synthetic-reply',role:'assistant',content:'Synthetic assistant answer.',timestamp:Date.now()/1000+1 })
   await s.request('/api/sessions?view=list') // synchronize the main read-only truth fixture
   context=await browser.newContext({ viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',extraHTTPHeaders:s.ownerHeaders })
   await context.addInitScript(()=>{try{localStorage.setItem('wos.coached','true');localStorage.setItem('wos.tour.done','1')}catch{}})
   await context.route('**/*',route=>{
    if (!route.request().url().startsWith(s.origin()) && !/^(data:|blob:)/.test(route.request().url())) { requests.push({kind,refused:route.request().url()}); return route.fulfill({status:403,body:''}) }
    return route.continue()
   })
   page=await context.newPage();page.on('pageerror',e=>errors.push({kind,error:String(e)}))
   await page.goto(s.origin()+'/wizard-os-home/',{waitUntil:'domcontentloaded'})
   await page.waitForFunction(()=>window.__wos?.live?.ok,null,{timeout:45000})
   await page.evaluate(()=>WosAgents.load(true))
   const open = async () => { await page.evaluate(id=>WizOpenAgentChats(id,{thread:'wizard_parity'}),s.id); await page.waitForSelector('.msg.u img',{timeout:20000}) }
   await open()
   await page.reload({waitUntil:'domcontentloaded'})
   await page.waitForFunction(()=>window.__wos?.live?.ok,null,{timeout:45000})
   await page.evaluate(()=>WosAgents.load(true));await open()
   const image=page.locator('.msg.u img').first()
   await image.scrollIntoViewIfNeeded()
   const decoded=await image.evaluate(async e=>{await e.decode();const r=e.getBoundingClientRect();return {width:r.width,height:r.height,naturalWidth:e.naturalWidth,complete:e.complete}})
   assert.ok(decoded.complete && decoded.naturalWidth>0 && decoded.width>0 && decoded.height>0,JSON.stringify(decoded))
   assert.ok(!(await page.locator('.msg.u').allTextContents()).join(' ').includes('[screenshot]'))
   await page.screenshot({path:join(out,`${kind}-thread.png`)})
   await image.click();await page.waitForSelector('.mviewer:not([hidden]) .mv-stage img')
   await page.screenshot({path:join(out,`${kind}-viewer.png`)})
   await page.evaluate(()=>window.__wosNativeBack())
   await page.waitForSelector('.mviewer[hidden]')
   assert.ok(await page.locator('.ch-thread').count()>0)
   record('image-thumbnail','pass',`Decoded ${decoded.width}x${decoded.height}; viewer opens and Back returns to same thread after reload`)
   await page.evaluate(()=>window.__wosNativeBack())
   await page.waitForSelector('[data-chnew]',{timeout:10000})
   assert.ok(!page.isClosed() && page.url().startsWith(s.origin()))
   await page.evaluate(()=>window.__wosNativeBack())
   assert.ok(!page.isClosed() && page.url().startsWith(s.origin()))
   await page.evaluate(()=>window.__wosNativeBack())
   assert.ok(!page.isClosed() && page.url().startsWith(s.origin()))
   record('back-contract','pass','Media overlay → thread → list → shell root stays open on first Back')
  } catch(error) {
   if(page) await page.screenshot({path:join(out,`${kind}-failure.png`)}).catch(()=>{})
   for(const feature of features) if(!cells.some(c=>c.feature===feature&&c.kind===kind)) record(feature,'fail',String(error.stack||error))
  } finally { if(context) await context.close(); if(s) await s.close() }
 }
} finally { await browser.close(); persist(true) }
console.log(JSON.stringify({out,cells:cells.map(({feature,kind,status,reason})=>({feature,kind,status,reason})),errors}))
if(cells.some(c=>c.status==='fail')||errors.length) process.exitCode=1
