// Real Service and UX, disposable synthetic gateways for every route kind. No production agents.
// QA_UX_ROOT points to a wizard-ux checkout; QA_PLAYWRIGHT uses the standard QA browser resolver.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { scene, kinds, post } from './fixture.mjs'
const require = createRequire(import.meta.url)
const {chromium} = require(join(resolve(process.env.QA_UX_ROOT), 'tools/qa-playwright.cjs'))
const browser = await chromium.launch()
let assertions = 0
try {
  for (const kind of kinds) {
    const s = await scene(kind, {uxDir: join(resolve(process.env.QA_UX_ROOT), 'web')})
    const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,extraHTTPHeaders:s.ownerHeaders})
    try {
      const create = async (id, days) => {
        const response = await s.request('/api/sessions', post({id, title:'Synthetic history '+id, source:'wizard-mobile'}))
        assert.equal(response.status,201)
        const row=s.sessions.get(id), at=Date.now()/1000-days*86400
        Object.assign(row,{hidden:false,created_at:at,updated_at:at})
        row.messages=[{role:'user',content:'Synthetic list entry',timestamp:at-1},{role:'assistant',content:'Synthetic completed entry',timestamp:at,finish_reason:'stop'}]
      }
      await create('qa_history_now',0)
      await context.addInitScript(()=>{localStorage.setItem('wos.coached','true');localStorage.setItem('wos.tour.v1','true')})
      await context.route('**/*',route=>route.request().url().startsWith(s.origin())?route.continue():route.fulfill({status:403,body:''}))
      const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(String(e)))
      await page.goto(s.origin()+'/wizard-os-home/?view=home')
      await page.waitForFunction(()=>window.WizLive?.ok)
      await page.evaluate(()=>WosAgents.load(true))
      const open=async()=>{
        await page.evaluate(id=>WizOpenAgentChats(id),s.id)
        const id=await page.evaluate(agent=>Object.values(__wos.wins).find(w=>w.app==='chats'&&(w.agent||WosAgents.defaultId())===agent)?.id,s.id)
        assert.ok(id);return page.locator(`[data-chats="${id}"]`)
      }
      let chat=await open();await chat.locator('[data-chopen="qa_history_now"]').waitFor()
      for(const section of ['yesterday','pastWeek']) {assert.equal(await chat.locator(`[data-sec="${section}"]`).count(),0);assertions++}
      await create('qa_history_yesterday',1);await create('qa_history_past',3)
      await s.request('/api/sessions?view=list')
      await page.evaluate(async()=>{await WizLive.refresh();await WizLive.refreshAgents()})
      chat=await open()
      for(const section of ['yesterday','pastWeek']) {await chat.locator(`[data-sec="${section}"]`).waitFor();assertions++}
      assert.deepEqual(errors,[]);assertions++
      console.log('PASS',kind,'empty history hidden; populated history remains available')
    } finally {await context.close();await s.close()}
  }
  console.log('PASS',assertions,'main/routed history assertions (synthetic gateways, real Service and UX)')
} finally {await browser.close()}
