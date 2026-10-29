const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert');
const URL=process.env.PREVIEW_URL,OUT=process.env.PREVIEW_QA_OUT;fs.mkdirSync(OUT,{recursive:true});
const r={syntheticOnly:true,checks:[],pageErrors:0};const check=(ok,name)=>{assert(ok,name);r.checks.push({name,pass:true})};
(async()=>{const b=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});try{
const ctx=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
await ctx.addInitScript(()=>{localStorage.setItem('wos.coached','true');localStorage.setItem('wos.tour.done','1')});
const p=await ctx.newPage();p.on('requestfailed',q=>{if(q.url().includes('/incognito'))r.failedRequest=q.failure()?.errorText});p.on('response',response=>{if(response.url().includes('/incognito')&&response.status()>=400){r.incognitoHttpError={status:response.status()};response.text().then(body=>{r.incognitoHttpError.body=body.slice(0,300)}).catch(()=>{})}});p.on('pageerror',e=>{r.pageErrors++;r.lastPageError=e.message.slice(0,150)});
const response=await p.goto(URL,{waitUntil:'domcontentloaded'});check(response.status()===200,'exact HTTPS review URL HTTP 200');
await p.waitForFunction(()=>window.WosAgents?.get('synthetic')?.incognito_available,{},{timeout:30000});
await p.waitForTimeout(1500);await p.evaluate(()=>WizOpenAgentChats('synthetic'));
await p.waitForFunction(()=>Object.values(__wos.wins).some(w=>w.app==='chats'&&(w.agent==='synthetic'||w.focus?.key==='synthetic')));
const wid=await p.evaluate(()=>Object.values(__wos.wins).find(w=>w.app==='chats'&&(w.agent==='synthetic'||w.focus?.key==='synthetic')).id);
await p.evaluate(id=>__wos.goDesk(__wos.desks.findIndex(d=>d.wins.includes(id))),wid);
const pane=p.locator(`[data-chats="${wid}"]`);await pane.locator('[data-chnew]').first().click();
for(const skin of ['nebula','grove']){
 await p.evaluate(s=>WosSkin.set(s),skin);await p.waitForTimeout(350);
 const sw=pane.locator('[data-incog-start]');await sw.waitFor();check(await sw.getAttribute('aria-checked')==='false',skin+' Incognito switch available');
 check(await sw.locator('.sw').evaluate(e=>getComputedStyle(e).backgroundColor!=='rgba(0, 0, 0, 0)'),skin+' track visible');
 await p.screenshot({path:path.join(OUT,skin+'-ready.png')});
}
await pane.locator('[data-incog-start]').click();await p.waitForFunction(id=>document.querySelector(`[data-chats="${id}"] [data-incog-field]:not([disabled])`)||document.querySelector(`[data-chats="${id}"] [role="alert"]`),wid,{timeout:120000});
if(await pane.locator('[role="alert"]').count()){r.startAlert=await pane.locator('[role="alert"]').innerText();await p.waitForTimeout(400);r.startDebug=await p.evaluate(()=>window.__incognitoDebug)}
check(await pane.locator('[role="alert"]').count()===0,'real sealed sibling starts through delivered preview');
await pane.locator('[data-incog-field]').fill('Use web search. Find one news article published today and reply with its headline and cited URL.');
await pane.locator('[data-incog-form] button[type="submit"]').click();
await p.waitForFunction(id=>{const root=document.querySelector(`[data-chats="${id}"]`);return [...root.querySelectorAll('.msg.a .bub')].some(e=>/https?:/.test(e.textContent))||root.querySelector('[role="alert"]')},wid,{timeout:180000});
await p.waitForFunction(id=>{const root=document.querySelector(`[data-chats="${id}"]`);return !root.querySelector('[data-incog-stop]')},wid,{timeout:90000});
check(await pane.locator('[role="alert"]').count()===0,'no Incognito run error');
check(await pane.locator('[data-incog-stop]').count()===0,'search run reaches terminal UI state');
check(await pane.locator('.msg.a .bub').evaluateAll(es=>es.some(e=>/https?:/.test(e.textContent))),'real search reply contains citation');
await p.screenshot({path:path.join(OUT,'search-reply.png')});
p.once('dialog',d=>d.accept());await pane.locator('[data-incog-close]').last().click();await pane.locator('[data-incog-start]').waitFor();
check(await pane.locator('[data-incog-thread]').count()===0,'Close removes temporary conversation');
const fenced=await p.evaluate(async()=>{const v=await fetch('/wizard/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return v.status});check(fenced===403,'unrelated mutations fenced');
check(r.pageErrors===0,'zero browser page errors');await p.screenshot({path:path.join(OUT,'closed.png')});await ctx.close();
}catch(e){r.failure=e.message.split('\n')[0].slice(0,180);process.exitCode=1}finally{await b.close();fs.writeFileSync(path.join(OUT,'receipt.json'),JSON.stringify(r,null,2));console.log(JSON.stringify(r,null,2))}})();
