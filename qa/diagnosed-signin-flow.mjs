import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/srv/work/provider-signin-browser/node_modules/playwright/index.mjs');
const origin = process.env.PREVIEW_ORIGIN || 'https://wizard.tailc0f369.ts.net:9455';
const evidence = process.env.QA_EVIDENCE || '/srv/work/signin-v2-evidence';fs.mkdirSync(evidence,{recursive:true});
const skin=process.env.QA_SKIN||'nebula';const offset=Number(process.env.QA_OFFSET||0);
const browser=await chromium.launch({headless:true});const ctx=await browser.newContext({viewport:{width:393,height:852},deviceScaleFactor:1,isMobile:true,hasTouch:true,ignoreHTTPSErrors:true,userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36'});const page=await ctx.newPage();
const errors=[],responses=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&!r.url().includes('/favicon'))responses.push([r.status(),r.url()])});
await page.addInitScript(({skin})=>{localStorage.setItem('wos.skin',skin);localStorage.setItem('wos.welcome-seen','1');localStorage.setItem('wos.coached','true');localStorage.setItem('wos.onboarded','1');localStorage.setItem('wos.android.info.dismissed','1');localStorage.setItem('wos.favouritesCollapsed','1');localStorage.setItem('wos.surface','phone');},{skin});
let n=offset;const screenshots=[];async function snap(){const p=path.join(evidence,`signin-v2-${++n}.png`);await page.screenshot({path:p});screenshots.push(p)}
const wait=async(fn,timeout=20000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,150))}throw Error('timed out: '+fn.toString())};
try{
 const initial=await (await page.request.get(origin+'/__preview/receipt')).json();assert.equal(initial.signedIn,false);assert.equal(initial.admissions.length,0);assert.equal(initial.modelRuns.length,0);
 await page.goto(origin+'/wizard-os-home/?session=chat-recent&shell=phone');await page.locator('.ch-compose textarea:visible').waitFor();await wait(()=>page.evaluate(()=>!!window.WizLive?.session?.('chat-recent')?.model));
 await wait(async()=>/Opus/.test(await page.locator('.ch-thread:visible').innerText()));await snap();
 const words='STAGING one clear path: reply on Claude Opus after sign-in.';
 await page.locator('.ch-compose textarea:visible').fill(words);await page.getByRole('button',{name:'Send',exact:true}).click();
 await wait(()=>page.evaluate(()=>window.WizLive?.session?.('chat-recent')?.status==='failed'));
 if(!await page.locator('.ch-fail.diagnosed').isVisible())await page.locator('[data-chopen="chat-recent"]').first().click();
 const card=page.locator('.ch-fail.diagnosed');await card.waitFor();assert.match(await card.innerText(),/Claude sign-in expired/);assert.match(await card.innerText(),/send to Opus on its own/);assert.equal(await card.locator('button').count(),1);assert.equal(await card.getByRole('button',{name:/Retry|Choose another model/}).count(),0);assert.equal(await page.locator('.ch-thread:visible').getByText('This message is saved.',{exact:false}).count(),1);assert.equal(await page.locator('.msg.a').filter({hasText:/Fix it|hermes auth/}).count(),0);await snap();
 // Phone Back returns to list, never leaves the shell. Inspect the same row's diagnosed action.
 await page.goBack();const row=page.locator('.ch-row-wrap').filter({has:page.locator('[data-chopen="chat-recent"]')});await row.waitFor();assert.match(await row.innerText(),/Claude sign-in expired/);assert.equal(await row.getByRole('button',{name:'Sign in',exact:true}).count(),1);assert.equal(await row.getByRole('button',{name:'Retry',exact:true}).count(),0);await snap();
 await page.locator('[data-chopen="chat-recent"]').first().click();await card.waitFor();await card.getByRole('button',{name:'Sign in to Claude',exact:true}).click();
 const coach=page.getByRole('button',{name:'Got it',exact:true});if(await coach.isVisible())await coach.click();
 const frame=await waitForFrame(/\/troubleshoot\//);await frame.locator('body.diagnosed').waitFor();assert.match(await frame.locator('#reconnect').innerText(),/Claude's sign-in has expired/);assert.equal(await frame.locator('#reconnect .act:visible').count(),1);for(const q of ['#input','#chips','#picker','#welcome'])assert.equal(await frame.locator(q).isVisible(),false,q+' hidden');assert.equal(await frame.locator('#reconnect ol li').count(),3);assert.equal(await frame.getByRole('button',{name:'Something else is wrong'}).count(),1);await snap();
 await frame.getByRole('link',{name:'Sign in to Claude',exact:true}).click();
 const sign=await waitForFrame(/\/wizard-claude\//);await sign.locator('#signin').waitFor();assert.match(await sign.locator('body').innerText(),/STAGING/);await snap();await sign.locator('#signin').click();await wait(async()=>!!(await(await page.request.get(origin+'/__preview/receipt')).json()).signedIn);
 // Walk the nested app history back, but never add a send or Retry action.
 await page.goBack();
 await wait(async()=>frame.locator('[data-back-chat]').isVisible(),30000);assert.match(await frame.locator('#reconnect').innerText(),/Claude is signed in again. Your message was sent./);assert.equal(await frame.locator('#reconnect .act:visible').count(),1);await snap();await frame.getByRole('button',{name:'Back to chat',exact:true}).click();
 await wait(()=>page.locator('.ch-thread:visible').isVisible());await wait(async()=>/Claude Opus \(simulated\): Your sign-in is working again/.test(await page.locator('.ch-thread:visible').innerText()));assert.equal(await page.locator('.ch-fail').count(),0);await snap();
 const receipt=await(await page.request.get(origin+'/__preview/receipt')).json();assert.equal(receipt.modelRuns.length,1);assert.equal(receipt.modelRuns[0].model,'claude-opus-5-5');assert.equal(receipt.modelRuns[0].provider,'anthropic');assert.equal(receipt.admissions[1].input,words);assert.equal(receipt.admissions.length,2);assert(receipt.admissions.every(r=>r.require_model_lock&&r.model==='claude-opus-5-5'&&r.provider==='anthropic'));assert.equal(ctx.pages().length,1);assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(responses.filter(r=>r[0]===403).length,0,JSON.stringify(responses));
 // The opt-out reveals the unchanged generic screen, in this same window, after the proof.
 await page.evaluate(()=>window.WizOpenApp('wizard-troubleshooter','/troubleshoot/'));const generic=await waitForFrame(/\/troubleshoot\//);await generic.locator('#input').waitFor();assert.equal(await generic.locator('#reconnect').isVisible(),false);
 fs.writeFileSync(path.join(evidence,`result-${skin}.json`),JSON.stringify({passed:true,skin,viewport:[393,852],screenshots,receipt,errors,responses},null,2));console.log(JSON.stringify({passed:true,skin,screenshots,receipt,errors,responses}));
}catch(e){await page.screenshot({path:path.join(evidence,`failure-${skin}.png`)});fs.writeFileSync(path.join(evidence,`failure-${skin}.txt`),String(e.stack)+'\n'+await page.locator('body').innerText()+'\nFrames: '+page.frames().map(f=>f.url()).join('\n'));throw e}finally{await browser.close()}
async function waitForFrame(pattern){let f;await wait(()=>{f=page.frames().find(f=>pattern.test(f.url()));return !!f},20000);await wait(async()=>{const el=await f.frameElement();return (await el.boundingBox())?.x>=0},20000);return f}
