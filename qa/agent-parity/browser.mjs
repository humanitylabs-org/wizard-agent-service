// Admitted-worker browser acceptance. Real Service/unmodified UX; synthetic gateways (not real agent processes).
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { scene, kinds, post } from './fixture.mjs'
import { checks } from './checks.mjs'
const require=createRequire(import.meta.url),{chromium}=require(process.env.QA_PLAYWRIGHT||'playwright-core')
const ux=resolve(process.env.QA_UX_ROOT||''),out=resolve(process.env.QA_OUT||'')
const externalRoot=process.env.QA_EXTERNAL_ROOT ? resolve(process.env.QA_EXTERNAL_ROOT)+'/' : '';
const forumMedia=process.platform==='linux'&&process.env.QA_GROUP==='media'&&process.env.QA_FORUM_MEDIA==='1'
// Stream resume and offline start need no fake media devices: a Linux worker with its own Chromium runs them too.
const linuxBrowser=process.platform==='linux'&&['resume','offline'].includes(process.env.QA_GROUP)&&!!process.env.QA_CHROMIUM
if((process.platform!=='darwin'&&!forumMedia&&!linuxBrowser)||!externalRoot||!ux.startsWith(externalRoot)||!out.startsWith(externalRoot)||!realpathSync(ux).startsWith(realpathSync(externalRoot)+'/'))throw Error('Use verified worker root via QA_EXTERNAL_ROOT (Linux is media-only)')
mkdirSync(out,{recursive:true})
const selectedGroup=process.env.QA_GROUP||'';assert.ok(['','static','compose','working','media','resume','offline'].includes(selectedGroup))
const selectedKinds=process.env.QA_KINDS?process.env.QA_KINDS.split(','):kinds;assert.ok(selectedKinds.every(k=>kinds.includes(k)))
const mediaShells=process.env.QA_MEDIA_SHELLS?process.env.QA_MEDIA_SHELLS.split(','):['phone','desktop'];assert.ok(mediaShells.length&&new Set(mediaShells).size===mediaShells.length&&mediaShells.every(s=>['phone','desktop'].includes(s)));assert.ok(!process.env.QA_MEDIA_SHELLS||selectedGroup==='media')
const features=JSON.parse(readFileSync(new URL('./features.json',import.meta.url))).features.filter(f=>f.layer==='ux').map(f=>f.id)
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
const source={service:Object.fromEntries(['server/service.mjs','server/agents-http.mjs','server/routed-run-queue.mjs','server/run-queue.mjs','server/routed-presentation.mjs','server/agent-chat-inputs.mjs','server/chat-presentation.mjs'].map(f=>[f,hash(new URL('../../'+f,import.meta.url))])),ux:Object.fromEntries(['core/chats.js','core/chat-kit.js','core/chat-power.js','core/chat-models.js','core/chat-work.js','app.js','styles.css','outbox.js','live.js'].map(f=>[f,hash(join(ux,'web',f))]))}
const cells=[],errors=[],requests=[],network=[],mediaEvidence=[]
const persist=completed=>writeFileSync(join(out,'browser.json'),JSON.stringify({schema_version:1,mode:'browser-synthetic',selectedGroup,selectedKinds,mediaShells,completed:completed&&!selectedGroup&&selectedKinds.length===kinds.length,source,cells,errors,requests,mediaEvidence,cleanup:{existing_agents_opened:false,all_fixtures_closed:completed},summary:Object.fromEntries(['pass','fail'].map(s=>[s,cells.filter(c=>c.status===s).length]))},null,2)+'\n')
const browser=await chromium.launch({headless:true,executablePath:forumMedia||linuxBrowser?process.env.QA_CHROMIUM:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--disable-background-networking']})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function until(f,reason,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await f())return;await sleep(100)}throw Error('Timeout: '+reason)}
async function stage(kind,group,featureIds,run){
 let s,context,page;const upstreamFailures=[];let mediaReadOnly=false
 const record=(feature,reason)=>{assert.ok(!cells.some(c=>c.feature===feature&&c.kind===kind),'duplicate cell');cells.push({feature,kind,status:'pass',reason,evidence:forumMedia?'forum-browser-real-service-synthetic-runtime':linuxBrowser?'linux-browser-real-service-synthetic-runtime':'real-thales-browser',screenshots:[`${kind}-${group}.png`]});persist(false)}
 try{
  s=await scene(kind,{uxDir:join(ux,'web'),sttConfigured:true,fixtureHoldEvents:true,fixtureEventScript:group==='resume',fixtureReadOnly:()=>mediaReadOnly,fetchImpl:async(...args)=>{if(mediaReadOnly&&!['GET','HEAD'].includes(args[1]?.method||'GET'))throw Error('Media fixture origin forbids runtime mutations');try{const r=await fetch(...args);if(!r.ok)upstreamFailures.push({url:String(args[0]),status:r.status,body:(await r.clone().text()).slice(0,700)});return r}catch(e){upstreamFailures.push({url:String(args[0]),exception:String(e),cause:String(e.cause)});throw e}}})
  await checks['session-create'](s)
  if(group==='media')mediaReadOnly=true
  context=await browser.newContext({serviceWorkers:group==='offline'?'allow':'block',viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:['clipboard-read','clipboard-write','microphone'],userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',extraHTTPHeaders:s.ownerHeaders})
  if(group==='media')await context.routeWebSocket('**',ws=>ws.close())
  await context.addInitScript(()=>{try{localStorage.setItem('wos.coached','true');localStorage.setItem('wos.tour.done','1')}catch{};/* Regenerate is skin opt-in (wizard-ux #395); parity covers it */const regen=()=>document.documentElement?.style.setProperty('--wos-reply-regenerate','on');regen();document.addEventListener('readystatechange',regen)})
  await context.route('**/*',route=>{const u=route.request().url();if((group==='media'&&!['GET','HEAD'].includes(route.request().method()))||(!u.startsWith(s.origin()+'/')&&!/^(data:|blob:)/.test(u))){requests.push({kind,group,refused:u});return route.fulfill({status:403,body:''})}return route.continue()})
  page=await context.newPage();page.setDefaultTimeout(12000);page.on('response',async r=>{if(r.request().method()==='POST')network.push({kind,group,url:r.url(),status:r.status(),body:(await r.text().catch(()=>'' )).slice(0,300)});if(r.status()>=400)requests.push({kind,group,status:r.status(),url:r.url(),body:(await r.text().catch(()=>'' )).slice(0,500)})});page.on('requestfailed',r=>requests.push({kind,group,url:r.url(),failure:r.failure()}));page.on('pageerror',e=>errors.push({kind,group,error:String(e)}))
  const load=async()=>{await s.request('/api/sessions?view=list');await page.goto(s.origin()+'/wizard-os-home/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__wos?.live?.ok,null,{timeout:45000});await page.evaluate(()=>WosAgents.load(true))}
  const reload=async()=>{await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__wos?.live?.ok,null,{timeout:45000});await page.evaluate(()=>WosAgents.load(true))}
  const root=async()=>{await page.evaluate(id=>WizOpenAgentChats(id),s.id);const win=await page.evaluate(id=>Object.values(__wos.wins).find(w=>w.app==='chats'&&(w.focus?.kind==='agent'?w.focus.key:w.agent||WosAgents.defaultId())===id)?.id,s.id);assert.ok(win);await page.evaluate(id=>__wos.focusWin(id),win);return{win,chat:page.locator(`[data-chats="${win}"]`)}}
  const open=async(sid='wizard_parity')=>{let{win,chat}=await root();if(await page.evaluate(w=>__wos.wins[w]?.thread,win)!==sid){if(await page.evaluate(w=>!!__wos.wins[w]?.thread,win))await page.evaluate(()=>__wosNativeBack());if(await page.evaluate(w=>__wos.wins[w]?.thread,win)===sid){await chat.locator('.ch-thread').waitFor();return{win,chat}}const row=chat.locator(`[data-chopen="${sid}"]`).first();await row.waitFor({timeout:20000});await row.click()}await chat.locator('.ch-thread').waitFor({timeout:20000});return{win,chat}}
  const refresh=async()=>{await page.evaluate(async()=>{await WizLive.refresh();await WizLive.refreshAgents()});await sleep(150)}
  const settle=async(output='Synthetic assistant answer.')=>{
    for(const r of s.runs.values()){Object.assign(r,{status:'completed',output,updated_at:Date.now()/1000});const row=s.sessions.get(r.session_id);if(row&&row.messages.at(-1)?.content!==output)row.messages.push({role:'assistant',content:output,timestamp:Date.now()/1000,finish_reason:'stop'})}
    const listing=await (await s.request('/api/sessions')).json();for(const row of listing.data||listing.sessions||[]){const id=row.wizard_run_id||row.wizard_last_run_id;if(id)await s.request(`/v1/runs/${id}`)}await s.request('/api/sessions?view=list')
  }
  const sends=()=>s.seen.filter(x=>x.method==='POST'&&(x.path.endsWith('/v1/runs')||x.path.endsWith('/chat/stream'))).map(x=>({...x,body:x.path.endsWith('/chat/stream')?{...x.body,input:x.body.message,session_id:x.path.match(/sessions\/([^/]+)/)[1]}:x.body}))
  await run({s,context,page,record,load,reload,root,open,refresh,settle,sends})
  await page.screenshot({path:join(out,`${kind}-${group}.png`)})
 }catch(error){if(page&&s)writeFileSync(join(out,`${kind}-${group}-diagnostic.json`),JSON.stringify({upstreamFailures,network:network.filter(x=>x.kind===kind&&x.group===group),seen:s.seen.filter(x=>x.method==='POST').map(x=>({method:x.method,path:x.path,body:x.path.endsWith('/v1/runs')||x.path.endsWith('/steer')?x.body:undefined})),live:await page.evaluate(()=>({voiceError:window.__qaVoiceError,voiceEndpoint:WizConfig.endpoint('transcribe'),session:WizLive.session('wizard_parity'),outbox:WosOutbox.unsent().map(x=>({state:x.state,error:x.error,text:x.text,model:x.model,agent:x.agent,how:x.how}))})).catch(()=>null),history:await (await s.request('/api/sessions/wizard_parity/messages?view=wizard')).json(),dom:await page.locator('[data-chats]').allInnerTexts(),responses:requests.filter(x=>x.kind===kind&&x.group===group&&x.status>=400)},null,2));if(page)await page.screenshot({path:join(out,`${kind}-${group}-failure.png`)}).catch(()=>{});for(const feature of featureIds)if(!cells.some(c=>c.feature===feature&&c.kind===kind))cells.push({feature,kind,status:'fail',reason:String(error.stack||error),evidence:forumMedia?'forum-browser-real-service-synthetic-runtime':linuxBrowser?'linux-browser-real-service-synthetic-runtime':'real-thales-browser',screenshots:[`${kind}-${group}-failure.png`]});persist(false)}
 finally{if(context)await context.close();if(s)await s.close()}
}
// One feature boundary, four genuinely different Service routes. Media comes from
// the scoped synthetic transcript/artifact resolver, never a global viewer.open.
async function mediaChecks({s,context,page,record}){
 const evidence={kind:s.kind,agent:s.id,runtime:'synthetic upstream; real Wizard HTTP',screens:[],blocked:[],upstream:[]};mediaEvidence.push(evidence)
 // Tiny deterministic solid PNGs, generated in the disposable agent home.
 const png=(w,h)=>{const crc=b=>{let c=0xffffffff;for(const x of b){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0};const chunk=(type,data)=>{const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c])};const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=2;const pixels=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*(w*3+1)+1+x*3;pixels[i]=25;pixels[i+1]=y<20?220:80;pixels[i+2]=150}return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))])}
 const mediaHome=s.agentHome
 const names=['media-wide.png','media-portrait.png','media-square.png'];for(const [i,size] of [[2400,900],[786,1704],[1200,1200]].entries())writeFileSync(join(mediaHome,names[i]),png(...size))
 const artifact=n=>['container','restricted'].includes(s.kind)?'/opt/data/'+n:join(mediaHome,n)
 const row=s.sessions.get('wizard_parity');row.hidden=false;row.title='Synthetic scoped media';row.messages=[{role:'user',content:'Synthetic gallery request',timestamp:Date.now()/1000-2},{role:'assistant',content:names.map(n=>'MEDIA:'+artifact(n)).join('\n\n'),timestamp:Date.now()/1000-1,finish_reason:'stop'}]
 assert.equal((await s.request('/api/sessions?view=list')).status,200)
 if(s.kind==='restricted'){const socket=join(s.root,'os','agents',s.id,'gateway','ingress.sock');assert.equal(statSync(socket).mode&0o777,0o600);evidence.ingress={transport:'unix',mode:'0600'}}
 const before=s.seen.length
 const boot=async(p,phone,cold=false)=>{
  if(cold)await p.reload({waitUntil:'domcontentloaded'});else await p.goto(s.origin()+'/wizard-os-home/'+(phone?'':'desktop.html'),{waitUntil:'domcontentloaded'})
  await p.waitForFunction(phone=>window[phone?'__wos':'__wux']?.live?.ok,phone,{timeout:30000});await p.evaluate(()=>WosAgents.load(true))
  assert.equal(await p.evaluate(()=>document.documentElement.dataset.shell),phone?'phone':'desktop')
  // This disposable runtime has no connected provider: Welcome legitimately opens.
  // Wait for its real async boot decision before trusted setup-only Back input;
  // an early Escape would instead suppress boot through the owner's acted flag.
  await p.waitForFunction(()=>window.WosWelcome?.log.some(x=>x.startsWith('boot:')),null,{timeout:10000})
  const setup={shell:phone?'phone':'desktop',cold,boot:await p.evaluate(()=>WosWelcome.log.slice()),escapes:0}
  for(let i=0;i<2&&await p.locator('#wosWelcome.wl-overlay').isVisible();i++){await p.keyboard.press('Escape');setup.escapes++}
  await p.locator('#wosWelcome.wl-overlay').waitFor({state:'hidden',timeout:2000})
  assert.equal(await p.evaluate(()=>WosWelcome.active),false,'Welcome setup complete before any thread/viewer action')
  setup.closed=true;setup.log=await p.evaluate(()=>WosWelcome.log.slice());(evidence.bootstrap??=[]).push(setup)
 }
 const selected=async p=>p.evaluate(id=>{const shell=document.documentElement.dataset.shell;const api=window[shell==='phone'?'__wos':'__wux'];const w=Object.values(api.wins).find(w=>w.app==='chats'&&w.focus?.kind==='agent'&&w.focus.key===id);return w?{id:w.id,agent:w.focus.key,thread:w.thread}:null},s.id)
 // Capture the actual desktop before fixture thread setup and before its context closes.
 // Hidden list rows are diagnostic evidence, not a reason to force input or mutate DOM.
 const desktopSnapshot=async(p,phase)=>{
  const stem=`${s.kind}-media-desktop-${phase}`;const diagnostic={phase,selected:await selected(p).catch(()=>null)}
  diagnostic.page=await p.evaluate(()=>{const api=window.__wux;const inspect=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return{tag:e.tagName,id:e.id,class:e.className,hidden:e.hidden,display:c.display,visibility:c.visibility,rect:r.toJSON()}};return{url:location.href,shell:document.documentElement.dataset.shell,viewport:{width:innerWidth,height:innerHeight},active:document.activeElement?.outerHTML.slice(0,2000),homeOpen:api?.homeOpen,cur:api?.cur,windows:Object.values(api?.wins||{}).map(w=>({id:w.id,app:w.app,focus:w.focus,thread:w.thread})),rows:[...document.querySelectorAll('[data-chopen="wizard_parity"]')].map(e=>({self:inspect(e),ancestors:[e.parentElement,e.parentElement?.parentElement,e.closest('[data-chats]'),e.closest('[data-win]')].filter(Boolean).map(inspect)})),dom:document.documentElement.outerHTML.slice(0,200000)}}).catch(error=>({captureError:String(error)}))
  writeFileSync(join(out,stem+'.json'),JSON.stringify(diagnostic,null,2)+'\n');await p.screenshot({path:join(out,stem+'.png')});(evidence.desktopDiagnostics??=[]).push({phase,json:stem+'.json',screenshot:stem+'.png'})
 }
 const thread=async(p,select=true)=>{
  if(select)await p.evaluate(id=>WizOpenAgentChats(id),s.id)
  await until(async()=>!!await selected(p),'actual selected agent window');const w=await selected(p);const chat=p.locator(`[data-chats="${w.id}"]`)
  const desktop=await p.evaluate(()=>document.documentElement.dataset.shell==='desktop')
  if(desktop){
   await desktopSnapshot(p,select?'before-thread-open':'cold-before-thread-assert')
   assert.equal(await p.evaluate(()=>WizLive.agentOf('wizard_parity')||WosAgents.defaultId()),s.id)
   // Production desktop openThread delegates to CHATS.openChat without changing Focus.
   // Bootstrap only the first open. A cold missing thread must fail, never be repaired.
   if(select&&w.thread!=='wizard_parity')await p.evaluate(()=>window.__wux.openThread('wizard_parity'))
   else assert.equal(w.thread,'wizard_parity','cold desktop thread restored without bootstrap')
  }else if(w.thread!=='wizard_parity'){const button=chat.locator('[data-chopen="wizard_parity"]').first();await button.waitFor();await button.click()}
  await chat.locator('.ch-thread').waitFor();assert.equal(await p.evaluate(()=>WizLive.agentOf('wizard_parity')||WosAgents.defaultId()),s.id);assert.equal((await selected(p)).thread,'wizard_parity');return chat
 }
 const ready=async p=>p.waitForFunction(()=>{const i=document.querySelector('.mviewer img');return i&&i.complete&&i.naturalWidth>0})
 const geometry=async p=>p.evaluate(()=>{const v=document.querySelector('.mviewer'),i=v.querySelector('.mv-stage img'),s=v.querySelector('.mv-stage').getBoundingClientRect(),r=i.getBoundingClientRect(),k=Math.min(r.width/i.naturalWidth,r.height/i.naturalHeight),w=i.naturalWidth*k,h=i.naturalHeight*k;return{stage:s.toJSON(),image:{left:r.left+(r.width-w)/2,right:r.left+(r.width+w)/2,top:r.top+(r.height-h)/2,bottom:r.top+(r.height+h)/2},state:WosChat.viewer.state,viewport:{w:innerWidth,h:innerHeight}}})
 const runScreen=async(p,phone)=>{
  await boot(p,phone);let chat=await thread(p);await chat.locator('.ch-compose textarea').fill('Synthetic retained media draft')
  // Reload without re-selecting the agent: a main fallback cannot pass.
  await boot(p,phone,true);chat=await thread(p,false);assert.equal(await chat.locator('.ch-compose textarea').inputValue(),'Synthetic retained media draft')
  const buttons=chat.locator('.msg.a button.mimg[data-mi]');assert.equal(await buttons.count(),3);const opener=buttons.nth(1);await opener.scrollIntoViewIfNeeded();await opener.click();await ready(p)
  assert.equal((await p.evaluate(()=>WosChat.viewer.state)).i,1);assert.equal(await p.locator('.mv-ti small').textContent(),'2 of 3');assert.equal(await p.evaluate(()=>document.activeElement.classList.contains('mviewer')),true)
  const screen={shell:phone?'phone':'desktop',coldAgent:(await selected(p)).agent,geometries:[],keys:[]};evidence.screens.push(screen)
  await p.screenshot({path:join(out,`${s.kind}-media-${screen.shell}-viewer.png`)})
  if(!phone){
   for(const width of [1440,760]){await p.setViewportSize({width,height:900});for(const [key,index] of [['ArrowRight',2],['ArrowRight',0],['ArrowRight',1]]){await p.keyboard.press(key);await ready(p);const g=await geometry(p);screen.geometries.push(g);screen.keys.push({key,index:g.state.i});assert.equal(g.state.i,index);assert.equal(g.state.long,false);assert.ok(g.image.left>=g.stage.left-1&&g.image.right<=g.stage.right+1&&g.image.top>=g.stage.top-1&&g.image.bottom<=g.stage.bottom+1,'entire painted photo fits desktop stage');assert.ok(g.stage.top>=0&&g.stage.bottom<=g.viewport.h)}}
   await p.keyboard.press('ArrowLeft');await ready(p);assert.equal((await p.evaluate(()=>WosChat.viewer.state)).i,0)
   await p.keyboard.press('Escape')
  }else{await p.evaluate(()=>__wosNativeBack())}
  await p.locator('.mviewer').waitFor({state:'hidden'});assert.equal((await selected(p)).thread,'wizard_parity');assert.equal(await chat.locator('.ch-compose textarea').inputValue(),'Synthetic retained media draft')
  // Outside dismissal is a trusted pointer action, not direct viewer.close.
  await buttons.nth(phone?0:1).click();await ready(p);const g=await geometry(p);if(phone)await p.touchscreen.tap(g.stage.left+4,g.stage.top+4);else await p.mouse.click(g.stage.left+4,g.stage.top+4);await p.locator('.mviewer').waitFor({state:'hidden'});assert.equal((await selected(p)).thread,'wizard_parity')
  await p.screenshot({path:join(out,`${s.kind}-media-${screen.shell}.png`)});screen.restoredDraft=await chat.locator('.ch-compose textarea').inputValue();assert.equal(screen.restoredDraft,'Synthetic retained media draft')
 }
 // The stage's ordinary context is a real phone UA/touch context.
 if(mediaShells.includes('phone'))await runScreen(page,true)
 if(mediaShells.includes('desktop')){const desktop=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block',extraHTTPHeaders:s.ownerHeaders});let p;try{
  await desktop.addInitScript(()=>{localStorage.setItem('wos.coached','true');localStorage.setItem('wos.tour.done','1');localStorage.setItem('wos.desktop-view.v1','classic')})
  await desktop.routeWebSocket('**',ws=>ws.close())
  await desktop.route('**/*',r=>{const q=r.request(),u=q.url();if(!['GET','HEAD'].includes(q.method())||(!u.startsWith(s.origin()+'/')&&!/^(data:|blob:)/.test(u))){evidence.blocked.push({method:q.method(),url:u});return r.fulfill({status:403,body:''})}return r.continue()})
  p=await desktop.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push({kind:s.kind,group:'media',error:String(e)}));await runScreen(p,false)
 }catch(error){if(p)await desktopSnapshot(p,'failure').catch(captureError=>{evidence.desktopDiagnosticError=String(captureError)});throw error}finally{await desktop.close()}}
 evidence.upstream=s.seen.slice(before).filter(x=>x.method==='GET'&&/\/api\/sessions/.test(x.path)).map(x=>({method:x.method,path:x.path,localPort:x.localPort}));assert.ok(evidence.upstream.some(x=>x.path.endsWith('/api/sessions/wizard_parity/messages')),'scoped HTTP history really read')
 if(s.kind==='host-profile')assert.ok(evidence.upstream.every(x=>x.path.startsWith('/p/parity-profile/')),'profile really traverses /p/<profile>')
 const scoped=evidence.upstream.filter(x=>x.path.endsWith('/api/sessions/wizard_parity/messages'));if(s.kind==='restricted')assert.ok(scoped.every(x=>x.localPort===null),'restricted history really arrived on Unix ingress');else assert.ok(scoped.every(x=>x.localPort===s.runtimePorts[s.kind==='container'?'container':'main']));if(s.kind==='container')assert.notEqual(s.runtimePorts.container,s.runtimePorts.main)
 assert.equal(s.runs.size,0);assert.equal(s.seen.filter(x=>x.method==='POST'&&/\/v1\/runs|\/chat\/stream/.test(x.path)).length,0)
 evidence.noRuntimeAdmissions=true;record('viewer-desktop-fit-keys','Scoped rendered MEDIA buttons open shared viewer; requested shells '+mediaShells.join(',')+' retain cold-selected agent, exact thread and draft; desktop contain/Left/Right/focus/Escape/outside or phone open/Back/outside as selected. Real Service HTTP, synthetic runtime; no real containers/providers or physical device proof.')
}
async function staticChecks({s,context,page,record,load,reload,root,open,refresh,settle,sends}){
 await checks['native-images'](s);await settle();await checks['nonimage-files'](s)
 const archivedId='wizard_archived_running';const archivedCreate=await s.request('/api/sessions',post({id:archivedId,source:'wizard-mobile',title:'Synthetic archived stale run'}));assert.equal(archivedCreate.status,201)
 const archivedRow=s.sessions.get(archivedId);archivedRow.hidden=false;archivedRow.messages=[{role:'user',content:'Synthetic completed archive task',timestamp:Date.now()/1000-2},{role:'assistant',content:'Synthetic task complete.',timestamp:Date.now()/1000-1}];archivedRow.updated_at=Date.now()/1000
 const archivedRun=await s.request('/v1/runs',post({session_id:archivedId,input:'Synthetic stale active run',model:'fixture-model'}));assert.equal(archivedRun.status,202)
 const archivedPatch=await s.request(`/api/sessions/${archivedId}`,{...post({archived:true}),method:'PATCH'});assert.equal(archivedPatch.status,200)
 await s.request('/api/sessions?view=list');await load();const archivedRoot=await root();const projected=await page.evaluate(([agent,id])=>{const row=WizLive.sessionsFor(agent).find(s=>s.id===id);return row?{status:row.status,archived:row.archived}:null},[s.id,archivedId]);assert.deepEqual(projected,{status:'running',archived:true})
 const archiveSection=archivedRoot.chat.locator('[data-sec="archive"]');await archiveSection.waitFor();if(!await archiveSection.evaluate(e=>e.classList.contains('open')))await archiveSection.locator('[data-sectoggle]').click();const archivedOpen=archiveSection.locator(`[data-chopen="${archivedId}"]`);await archivedOpen.waitFor();assert.equal(await archivedRoot.chat.locator(`[data-sec="working"] [data-chopen="${archivedId}"]`).count(),0);await archivedOpen.click();await archivedRoot.chat.locator('.ch-thread').waitFor();assert.equal(await archivedRoot.chat.locator('.ch-thread .ti').getAttribute('title'),'Archived');await archivedRoot.chat.locator('[data-chact="restore"]').waitFor({timeout:20000});assert.deepEqual((await archivedRoot.chat.locator('[data-chact]').evaluateAll(rows=>rows.map(row=>row.dataset.chact).sort())),['restore','snooze']);await page.evaluate(()=>__wosNativeBack());record('archive-placement','Rendered Archive alone contains the authoritative running thread; opening it says Archived and offers Restore plus Snooze')
 const target=await s.request('/api/sessions',post({id:'wizard_target',source:'wizard-mobile',title:'Synthetic linked target'}));assert.equal(target.status,201)
 s.sessions.get('wizard_target').hidden=false;s.sessions.get('wizard_target').messages=[{role:'user',content:'Synthetic target question',timestamp:Date.now()/1000},{role:'assistant',content:'Synthetic target answer',timestamp:Date.now()/1000+1}]
 const status='\n[WIZARD_STATUS_V1]\n'+JSON.stringify({state:'needs_you',ask:'Inspect the synthetic diagram',subject:'Parity QA',title:'Synthetic parity result'})+'\n[/WIZARD_STATUS_V1]'
 const reply='## Synthetic parity result\n\n'+Array.from({length:35},(_,i)=>`Paragraph ${i}: synthetic reader position material.`).join('\n\n')+'\n\n[Continue to synthetic target](/wizard-os-home/?session=wizard_target)\n\n```text\nsynthetic-copy-code\n```\n\n> Synthetic quoted text\n\nMEDIA:'+s.media.png+'\n\nInline image explanation continues here.\n\nMEDIA:'+s.media.text+status
 const row=s.sessions.get('wizard_parity');row.hidden=false;row.title='Synthetic parity result';row.messages.push({id:'synthetic-final',role:'assistant',content:reply,timestamp:Date.now()/1000+2});row.updated_at=Date.now()/1000+2
 await settle(reply);await s.raw('/wizard/thread-seen',{...post({initializedAt:Date.now()-60000,threads:{}}),method:'PUT'});await load();let{chat}=await root()
 const ready=chat.locator('.ch-sec[data-sec="ready"] [data-chopen="wizard_parity"]');await ready.waitFor({timeout:20000});assert.match(await ready.innerText(),/Needs you/);assert.match(await ready.innerText(),/Inspect the synthetic diagram/)
 assert.equal(await page.evaluate(()=>WizLive.isNew(WizLive.session('wizard_parity'))),true)
 let opened=await open();chat=opened.chat;await chat.locator('.msg.u img').first().waitFor();await reload();({chat}=await open())
 const image=chat.locator('.msg.u img').first();const decoded=await image.evaluate(async e=>{await e.decode();const r=e.getBoundingClientRect();return{width:r.width,height:r.height,naturalWidth:e.naturalWidth}});assert.ok(decoded.width>0&&decoded.height>0&&decoded.naturalWidth>0)
 assert.ok(!(await chat.locator('.msg.u').allTextContents()).join(' ').includes('[screenshot]'));assert.ok((await chat.locator('.msg.u').allTextContents()).join(' ').includes('fixture.txt'),'reloaded owner file card retains filename')
 await sleep(1500);await image.evaluate(e=>{e.closest('.ch-msgs').dispatchEvent(new Event('pointerdown',{bubbles:true}));e.scrollIntoView({block:'center'})});await sleep(400);await page.screenshot({path:join(out,`${s.kind}-thumbnail.png`)})
 await image.click();await page.waitForSelector('.mviewer:not([hidden]) .mv-stage img');await page.evaluate(()=>__wosNativeBack());await page.locator('.mviewer').waitFor({state:'hidden'});assert.ok(await chat.locator('.ch-thread').count());record('image-thumbnail','After reload native image decoded, user attachment chips remain, viewer Back returns to same thread')
 assert.ok(!(await chat.innerText()).includes('WIZARD_STATUS_V1'));assert.ok(! (await chat.innerText()).includes('"state"'))
 assert.equal(await page.evaluate(()=>WizLive.isNew(WizLive.session('wizard_parity'))),false)
 record('ready-needs-you','Unread Ready card shows ask and subject/agent; opening marks read; status envelope is hidden from thread')
 const inlineOrder=await chat.locator('.msg.a .bub').last().evaluate(b=>{const image=b.querySelector('.mimg');const after=[...b.querySelectorAll('p')].find(p=>p.textContent.includes('Inline image explanation continues here.'));return !!image&&!!after&&image.compareDocumentPosition(after)&Node.DOCUMENT_POSITION_FOLLOWING});assert.ok(inlineOrder,'assistant image is before its following explanation');assert.equal(await chat.locator('.msg.a .mimg').count(),1,'inline image has no bottom duplicate')
 const inlineWindow=await chat.getAttribute('data-chats'),inlineThread=await page.evaluate(win=>__wos.wins[win]?.thread,inlineWindow);assert.equal(inlineThread,'wizard_parity')
 const media=chat.locator('.msg.a [data-mi]');assert.ok(await media.count()>=2,'MEDIA image and document render as cards');await media.first().click();await page.locator('.mviewer').waitFor();await page.evaluate(()=>__wosNativeBack());await page.locator('.mviewer').waitFor({state:'hidden'});assert.equal(await page.evaluate(win=>__wos.wins[win]?.thread,inlineWindow),inlineThread,'Back keeps the same thread');record('inline-agent-images','MEDIA image keeps its position without duplication; shared viewer opens and Back returns to the same thread')
 await chat.locator('[data-mcopy]').last().click();await until(async()=> (await page.evaluate(()=>navigator.clipboard.readText())).includes('Synthetic parity result'),'response clipboard');assert.ok(!(await page.evaluate(()=>navigator.clipboard.readText())).includes('MEDIA:'))
 await chat.locator('[data-mshare]').last().click();await until(async()=> (await page.evaluate(()=>navigator.clipboard.readText())).includes('Synthetic parity result'),'share fallback clipboard')
 await chat.locator('[data-codecopy]').last().click();await until(async()=> (await page.evaluate(()=>navigator.clipboard.readText())).includes('synthetic-copy-code'),'code clipboard')
 await chat.locator('[data-quotecopy]').last().click();await until(async()=> (await page.evaluate(()=>navigator.clipboard.readText()))==='Synthetic quoted text','quote clipboard')
 record('copy-share','Real response Copy/Share clipboard fallback, code and quote Copy; MEDIA image/document cards open without leaking internal paths')
 const palettes=[];for(const skin of ['nebula','sepia']){assert.equal(await page.evaluate(id=>WosSkin.set(id),skin),skin);await sleep(350);const style=await chat.evaluate(e=>({skin:document.documentElement.dataset.skin,color:getComputedStyle(e).color,bg:getComputedStyle(document.documentElement).getPropertyValue('--bg')}));palettes.push(style);assert.ok(style.color!=='rgb(255, 255, 255)'||skin==='nebula');await page.screenshot({path:join(out,`${s.kind}-${skin}.png`)})}assert.notDeepEqual(palettes[0],palettes[1]);record('appearance','Unmodified in-shell Chats re-dresses live in Nebula and Sepia; per-kind screenshots retained')
 await page.evaluate(()=>WosSkin.set('nebula'));const box=chat.locator('.ch-msgs');await box.evaluate(e=>{e.dispatchEvent(new Event('pointerdown',{bubbles:true}));e.scrollTop=Math.min(600,e.scrollHeight-e.clientHeight);e.dispatchEvent(new Event('scroll'))});await sleep(900);const before=await box.evaluate(e=>e.scrollTop);assert.ok(before>50)
 await reload();({chat}=await open());await sleep(3300);const after=await chat.locator('.ch-msgs').evaluate(e=>e.scrollTop);assert.ok(Math.abs(after-before)<100,`reading place ${before} -> ${after}`)
 row.messages.push({role:'user',content:'Synthetic background follow-up',timestamp:Date.now()/1000+3},{role:'assistant',content:'Synthetic appended update',timestamp:Date.now()/1000+4});row.updated_at=Date.now()/1000+4;await s.request('/api/sessions?view=list');await refresh();await sleep(500);const held=await chat.locator('.ch-msgs').evaluate(e=>e.scrollTop);assert.ok(Math.abs(held-after)<100,`background update must not steal reading place ${after} -> ${held}`);record('reading-position',`Read thread reload anchor ${before}→${after}; background update preserves position`);row.messages.splice(-2);await refresh()
 await chat.locator('[data-session="wizard_target"]').first().click();await until(async()=>page.evaluate(()=>Object.values(__wos.wins).some(w=>w.app==='chats'&&w.thread==='wizard_target')),'linked target opens');const targetScope=await page.evaluate(()=>WizLive.agentOf('wizard_target'));assert.equal(targetScope||'hermes',s.id);record('thread-links','Canonical thread link opens exact same-agent target in-shell; no literal agent/session IDs rendered as fallback')
 ;({chat}=await open());const cdp=await context.newCDPSession(page);const swipe=async(x0,x1,ms)=>{const y=420;await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x0,y}]});for(let i=1;i<=10;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x0+(x1-x0)*i/10,y}]});await sleep(ms/10)}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(700)}
 const thread=()=>chat.locator('.ch-thread').count(),indent=()=>chat.locator('[data-part="thread"]').first().evaluate(e=>e.style.transform+'|'+e.style.opacity)
 assert.ok((await page.evaluate(()=>WosSkinHost.builtinState)).includes('core:thread-swipe-back'),'swipe-back built-in runs')
 await swipe(150,215,60);assert.ok(await thread(),'subtle flick keeps the thread');await swipe(150,250,600);assert.ok(await thread(),'short drag keeps the thread');assert.equal(await indent(),'|','short drag snaps fully back')
 await swipe(120,330,300);await until(async()=>!(await thread()),'intentional swipe returns to the list');assert.ok(await chat.locator('[data-chopen="wizard_parity"]').count(),'same agent list');assert.ok(!page.isClosed()&&page.url().startsWith(s.origin()))
 await swipe(120,330,300);assert.ok(!page.isClosed()&&page.url().startsWith(s.origin()),'swipe on the list never exits');record('swipe-gestures','Subtle flick and short drag keep the thread and snap back; intentional swipe right returns one step to the same agent list; never exits')
 ;({chat}=await open());const baseline=sends().length,previous=sends().at(-1).body;await chat.locator('[data-mregen]').last().click();await until(()=>sends().length===baseline+1,'one regeneration runtime admission');await sleep(500);assert.equal(sends().length,baseline+1);const regenerated=sends().at(-1).body;assert.equal(regenerated.session_id,'wizard_parity');assert.ok(JSON.stringify(regenerated.input).includes('Read the attached document'));assert.equal(regenerated.model,previous.model||'fixture-model');assert.match(JSON.stringify(regenerated.input),/fixture\.txt/);record('regenerate','Real Regenerate button admits once on same agent/thread/model, preserving original user words and document attachment')
 await settle('Synthetic regenerated answer.');await refresh();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('wizard:open',{detail:{thread:'wizard_parity'}})));({chat}=await open());await chat.locator('.ch-compose textarea').fill('Synthetic notification reply');await chat.locator('.ch-send').click();await until(()=>sends().some(x=>JSON.stringify(x.body.input).includes('Synthetic notification reply')),'safe notification reply');assert.equal(sends().at(-1).body.session_id,'wizard_parity');record('notifications','Background completion produces unread Ready attribution; notification bridge opens exact thread and typed reply returns only to that agent')
 ;({chat}=await open());await page.evaluate(()=>__wosNativeBack());await chat.locator('[data-chnew]').waitFor();for(let i=0;i<3;i++)await page.evaluate(()=>__wosNativeBack());assert.ok(!page.isClosed()&&page.url().startsWith(s.origin()));record('back-contract','Viewer → thread → list → shell root; repeated native Back never closes or leaves app')
}
async function composeChecks({s,context,page,record,load,reload,root,open,refresh,settle,sends}){
 const row=s.sessions.get('wizard_parity');row.hidden=false;row.messages=[{role:'user',content:'Synthetic previous question',timestamp:Date.now()/1000-3},{role:'assistant',content:'Synthetic previous answer',timestamp:Date.now()/1000-2}];await load();let{chat}=await open()
 const text=chat.locator('.ch-compose textarea');await text.fill('before after');await text.focus();await text.evaluate(e=>e.setSelectionRange(7,7));await page.evaluate(()=>window.dispatchEvent(new CustomEvent('wizard:dictation',{detail:{text:'DICTATED '}})));await until(async()=> (await text.inputValue()).includes('DICTATED'),'native dictation insertion');assert.equal(await text.inputValue(),'before DICTATED after');const caret=await text.evaluate(e=>e.selectionStart);assert.ok(caret>=15)
 await chat.locator('.ch-send').click();await until(()=>sends().some(r=>JSON.stringify(r.body.input).includes('before DICTATED after')),'dictated send');assert.equal(sends().at(-1).body.session_id,'wizard_parity');await settle();await reload();({chat}=await open());assert.ok((await chat.locator('.msg.u').allTextContents()).join(' ').includes('before DICTATED after'));record('dictation','Native dictation bridge inserts at cursor, not automatically; real Send/reload retains text, same agent/thread/model')
 // Pending echo (wizard-ux #418): reopening a thread never paints a message the transcript already shows a second time as
 // Sending, whether its outbox copy is sent or receipt-lost; a copy that never left the phone still shows, same words or not.
 {const t='before DICTATED after';const seed=(id,it)=>page.evaluate(([id,t,it])=>{const at=Date.now();WosOutbox._items.set(id,{id,kind:'reply',sessionId:'wizard_parity',text:t,durable:true,createdAt:at-60e3,updatedAt:at,...it})},[id,t,it]);const drop=()=>page.evaluate(()=>{for(const k of [...WosOutbox._items.keys()])if(k.startsWith('qa-echo-'))WosOutbox._items.delete(k)})
  await page.evaluate(()=>__wosNativeBack());await seed('qa-echo-sent',{state:'sent',attempts:1,sentAt:Date.now()-50e3,runId:'qa-echo-run'});await seed('qa-echo-lost',{state:'waiting',attempts:1,lastAttemptAt:Date.now()-50e3,nextAt:Date.now()+3600e3})
  ;await page.evaluate(()=>{window.__qaPend=0;const hit=n=>n.nodeType===1&&(n.matches('.msg.u.pending')||n.querySelector('.msg.u.pending'));window.__qaObs=new MutationObserver(ms=>{for(const m of ms){if(m.type==='attributes'?m.target.matches?.('.msg.u.pending'):[...m.addedNodes].some(hit))window.__qaPend++}});window.__qaObs.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['class']})})
  ;({chat}=await open());await sleep(2000);const frames=await page.evaluate(()=>{window.__qaObs.disconnect();return window.__qaPend+document.querySelectorAll('.msg.u.pending').length})
  assert.equal(frames,0,'a message the transcript shows painted again as pending (any DOM change, from before the reopen)');assert.equal((await chat.locator('.msg.u:not(.pending)').allTextContents()).filter(x=>x.includes(t)).length,1,'transcript shows the message once')
  await drop();await page.evaluate(()=>__wosNativeBack());await seed('qa-echo-unsent',{state:'waiting',attempts:0,nextAt:Date.now()+3600e3,createdAt:Date.now()})
  ;({chat}=await open());await chat.locator('.msg.u.pending').first().waitFor({timeout:5000});assert.ok((await chat.locator('.msg.u.pending').allTextContents()).join(' ').includes(t),'an unsent repeat of the same words still shows')
  await drop();await page.evaluate(()=>__wosNativeBack());({chat}=await open());assert.equal(await chat.locator('.msg.u.pending').count(),0)
  record('pending-echo','Reopen with a sent and a receipt-lost outbox copy of a message the transcript shows: no Sending duplicate in any frame, message shown once; an unsent copy with the same words still shows')}
 await page.evaluate(()=>{const orig=WizConfig.transcribe;WizConfig.transcribe=async(...args)=>{try{return await orig.apply(WizConfig,args)}catch(e){window.__qaVoiceError=String(e.stack||e);throw e}}});await chat.locator('[data-chmic]').click();await chat.locator('[data-chmic][aria-pressed="true"]').waitFor({timeout:15000});await sleep(1300);await chat.locator('[data-chmic]').click();await until(()=>sends().some(r=>JSON.stringify(r.body.input).includes(s.stt.text)),'voice note transcription and send',30000);assert.equal(sends().at(-1).body.session_id,'wizard_parity');await settle();await reload();({chat}=await open());assert.ok((await chat.innerText()).includes('Voice note'),'browser recording survives as a playable voice chip')
 await page.evaluate(()=>__wosNativeBack());await chat.locator('[data-chnew]').click();await chat.locator('.ch-compose textarea').fill('Synthetic offline first send');const pendingBaseline=sends().length
 // Keep static assets readable for reload while the browser network to every API is offline.
 let disconnected=true;await page.route('**/wizard/**',r=>disconnected?r.abort('internetdisconnected'):r.continue())
 await chat.locator('.ch-send').click();await until(()=>page.evaluate(()=>WosOutbox.unsent().some(x=>x.text==='Synthetic offline first send')),'durable offline custody');assert.equal(sends().length,pendingBaseline)
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.WosOutbox&&window.__wos);disconnected=false;await page.unroute('**/wizard/**');await page.evaluate(()=>window.dispatchEvent(new Event('online')));let recovery=await root();await until(async()=>sends().some(r=>JSON.stringify(r.body.input).includes('Synthetic offline first send'))||await recovery.chat.locator('[data-obretry]').count(),'offline auto delivery or safe Retry control');if(await recovery.chat.locator('[data-obretry]').count())await recovery.chat.locator('[data-obretry]').first().click()
  await until(()=>sends().some(r=>JSON.stringify(r.body.input).includes('Synthetic offline first send')),'offline reconnect delivery',30000);await sleep(800);const delivered=sends().filter(r=>JSON.stringify(r.body.input).includes('Synthetic offline first send'));assert.equal(delivered.length,1);const sid=delivered[0].body.session_id;assert.ok(sid!=='wizard_parity');await settle();await refresh();({chat}=await open(sid));assert.ok((await chat.locator('.msg.u').allTextContents()).join(' ').includes('Synthetic offline first send'));assert.equal(await chat.locator('.ch-compose textarea').inputValue(),'');assert.equal(await chat.locator('.ch-tray .fchip').count(),0)
 record('outbox-offline','Offline durable IndexedDB custody survives reload/reconnect; explicit safe Retry delivers once; original voice note remains playable and recovery-safe')
 record('pending-first-send','New empty agent thread accepts one optimistic first send; acknowledged exact thread is listed, composer and tray clear')
 // Stop on send (wizard-ux #649): Stop shows while a reply has no run yet; tapping it withdraws the reply (no admission) and puts the words back.
 {const t='Synthetic stop before run';let cut=true;const runPost=/\/wizard\/hermes\/v1\/runs(\?|$)/;await page.route(runPost,r=>cut&&r.request().method()==='POST'?r.abort('internetdisconnected'):r.continue())
  ;({chat}=await open());await chat.locator('.ch-compose textarea').fill(t);await chat.locator('.ch-send').click();await until(()=>page.evaluate(t=>WosOutbox.unsent().some(x=>x.text===t&&x.state==='waiting'),t),'reply waiting with no run')
  ;({chat}=await open());await chat.locator('[data-chstop]').waitFor({timeout:5000});await chat.locator('[data-chstop]').click();await until(()=>page.evaluate(t=>!WosOutbox.unsent().some(x=>x.text===t&&!x.cancelled),t),'pending reply withdrawn')
  cut=false;await page.unroute(runPost);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await sleep(1500)
  assert.equal(sends().filter(r=>JSON.stringify(r.body.input).includes(t)).length,0,'a stopped reply is never admitted');assert.ok((await chat.locator('.ch-compose textarea').inputValue()).includes(t),'words back in the composer');await chat.locator('.ch-compose textarea').fill('')
  record('stop-on-send','Stop shows for a reply with no run yet; tapping it withdraws the send (zero admissions after reconnect) and returns the words to the same thread composer')}
}
async function workingChecks({s,page,record,load,reload,open,refresh,settle,sends}){
 await checks['native-images'](s);const row=s.sessions.get('wizard_parity');row.hidden=false
 const plan=(i,done=false)=>{const id='todo-'+i;const todos=[{id:'inspect',content:'Inspect synthetic first milestone',status:i>1?'completed':'in_progress'},{id:'verify',content:'Verify synthetic second milestone',status:done?'completed':i>1?'in_progress':'pending'}];row.messages.push({role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name:'todo_list',arguments:JSON.stringify({todos})}}],timestamp:Date.now()/1000},{role:'tool',tool_call_id:id,tool_name:'todo_list',content:JSON.stringify({todos}),timestamp:Date.now()/1000});row.updated_at=Date.now()/1000}
 plan(1);await s.request('/api/sessions?view=list');await load();let{chat}=await open();await chat.locator('[data-chstop]').waitFor({timeout:20000});const work=chat.locator('details.steps').last();await work.locator('summary').click();await until(async()=> (await work.innerText()).includes('Inspect synthetic first milestone'),'initial Working milestone')
 plan(2);await s.request('/api/sessions?view=list');await refresh();await until(async()=> (await chat.locator('details.steps').last().innerText()).includes('Verify synthetic second milestone'),'changed milestone',20000);await until(async()=>(await chat.locator('details.steps').last().innerText()).includes('1 of 2'),'updated milestone progress')
 await chat.locator('.ch-compose textarea').fill('Synthetic live steer');await chat.locator('.ch-send').click();await until(()=>s.seen.some(r=>r.path.endsWith('/steer')&&JSON.stringify(r.body.input).includes('Synthetic live steer')),'live steer');assert.equal(s.runs.size,1,'steer must not create another runtime turn');({chat}=await open())
 await chat.locator('[data-chstop]').click();await until(()=>[...s.runs.values()][0].status==='cancelled','stop cancels only exact runtime run');await refresh();await until(async()=>await chat.locator('[data-chstop]').count()===0,'stop control settles')
 const retryBaseline=sends().length;const admission=await s.request('/v1/runs',post({session_id:'wizard_parity',input:'Synthetic retry question',model:'fixture-model'}));assert.equal(admission.status,202);await until(()=>sends().length===retryBaseline+1,'failure fixture dispatched');for(const run of s.runs.values())if(run.status==='running'){run.status='failed';run.error={message:'Traceback synthetic runtime internals must stay hidden'};run.updated_at=Date.now()/1000}
 await reload();({chat}=await open());await chat.locator('[data-chretry]').waitFor({timeout:20000});assert.ok(!(await chat.innerText()).includes('Traceback'));await chat.locator('[data-chretry]').click();await until(()=>sends().length===retryBaseline+2&&JSON.stringify(sends().at(-1).body.input).includes('Synthetic retry question'),'retry new turn');assert.equal(sends().at(-1).body.session_id,'wizard_parity');record('error-recovery','Live steer uses same run; Stop cancels exact run; failed run reload shows safe Retry, which returns to same thread without raw traceback')
 plan(3,true);row.messages.push({role:'assistant',content:'Synthetic milestones completed.',timestamp:Date.now()/1000+2});await settle('Synthetic milestones completed.');await refresh();await until(async()=> (await chat.innerText()).includes('Synthetic milestones completed.'),'settled final answer');await until(async()=>await chat.locator('[data-chstop]').count()===0,'terminal work control settles');record('working-milestones','Real projected todo_list milestones update in Working dropdown; live steer and Stop work; terminal reply settles work receipt')
}
// This disposable runtime has no connected provider, so Welcome legitimately opens; close it the way the media
// group does (after its async boot decision, with trusted Escape) before any thread action.
async function closeWelcome(page){
 await page.waitForFunction(()=>!window.WosWelcome||window.WosWelcome.log.some(x=>x.startsWith('boot:')),null,{timeout:10000})
 for(let i=0;i<2&&await page.locator('#wosWelcome.wl-overlay').isVisible();i++)await page.keyboard.press('Escape')
 await page.locator('#wosWelcome.wl-overlay').waitFor({state:'hidden',timeout:2000})
}
// Stream resume (wizard-ux issue 718), per kind through the real Service route: the synthetic runtime numbers every
// frame and replays the run on each read, like stock Hermes. A drop resumes without doubled words, an offline spell
// waits for the network, a replay that lost frames drops the partial text, and nothing is ever admitted twice.
async function resumeChecks({s,context,page,record,load,open,refresh,settle,sends}){
 const row=s.sessions.get('wizard_parity');row.hidden=false;row.messages=[{role:'user',content:'Synthetic earlier question',timestamp:Date.now()/1000-3},{role:'assistant',content:'Synthetic earlier answer',timestamp:Date.now()/1000-2}]
 let reads=0;page.on('request',r=>{if(/\/v1\/runs\/[^/?]+\/events(\?|$)/.test(new URL(r.url()).pathname+'?'))reads++})
 await load();await closeWelcome(page);let{chat}=await open();const admitted=sends().length
 await chat.locator('.ch-compose textarea').fill('Synthetic resume question');await chat.locator('.ch-send').click();await until(()=>sends().length===admitted+1,'one runtime admission')
 await until(()=>[...s.runs.values()].some(r=>r.status==='running'),'runtime run');const run=[...s.runs.values()].find(r=>r.status==='running'),script=s.eventScript(run.run_id);await until(()=>reads>=1,'shell reads the run stream')
 const live=async()=>(await chat.locator('[data-streaming] .bub').allInnerTexts()).join(' ')
 const once=async words=>{const text=await live();for(const w of words)assert.equal(text.split(w).length,2,`${w} shown exactly once in ${JSON.stringify(text)}`)}
 // A network drop between the browser and Wizard: every open connection to the real Service is cut.
 const drop=()=>s.server.closeAllConnections()
 script.push('tool.started',{tool:'terminal',tool_call_id:'call-1',preview:'ls'});script.push('message.delta',{delta:'Alpha '});script.push('tool.completed',{tool:'terminal',tool_call_id:'call-1'});script.push('message.delta',{delta:'Bravo '})
 await until(async()=>(await live()).includes('Alpha Bravo'),'live words before the drop')
 // 1. Drop: the next read replays from the first frame, and the shell skips every frame it already showed.
 let before=reads;drop();script.push('message.delta',{delta:'Charlie '})
 await until(async()=>reads>before&&(await live()).includes('Charlie'),'stream resumed after a drop');await once(['Alpha','Bravo','Charlie'])
 // 2. Offline: the shell waits for the network instead of spending its retries, then reads again at once.
 await context.setOffline(true);drop();before=reads;script.push('message.delta',{delta:'Delta '});await sleep(2500)
 assert.equal(reads,before,'no stream read while offline');assert.ok(!(await live()).includes('Delta'))
 await context.setOffline(false);await until(async()=>reads>before&&(await live()).includes('Delta'),'stream resumed once back online');await once(['Alpha','Bravo','Charlie','Delta'])
 // 3. A replay that lost frames this stream never showed (past the runtime's and the Service's 4000-frame
 // retention): the partial text goes, and the transcript brings the answer.
 await context.setOffline(true);drop();before=reads;script.push('message.delta',{delta:'Lost '});for(let i=0;i<4001;i++)script.push('tool.completed',{tool:'synthetic-filler',tool_call_id:'filler-'+i});script.push('message.delta',{delta:'Echo '});script.oldest=script.frames.length-3999
 await sleep(300);await context.setOffline(false)
 await until(async()=>reads>before&&await chat.locator('[data-streaming]').count()===0,'replay gap drops the partial text');await sleep(800);assert.equal(await chat.locator('[data-streaming]').count(),0,'no partial text after the gap')
 const final='Synthetic resumed final answer.';await settle(final);script.push('run.completed',{output:final});await refresh()
 await until(async()=>(await chat.locator('.msg.a').allInnerTexts()).some(t=>t.includes(final)),'transcript answer after the gap');await sleep(800)
 assert.equal((await chat.locator('.msg.a').allInnerTexts()).filter(t=>t.includes(final)).length,1,'final answer shown once');assert.ok(!(await chat.innerText()).includes('Echo'));assert.equal(sends().length,admitted+1,'a resumed read never admits again')
 const via=s.seen.filter(x=>x.method==='POST'&&/\/v1\/runs$|\/chat\/stream$/.test(x.path)).map(x=>x.path).at(-1)
 record('stream-resume',`Real Service stream for this kind (runtime admission ${via}, agent ${await page.evaluate(()=>WizLive.agentOf('wizard_parity')||'main')}): a drop resumed by seq with no doubled words, an offline spell made no read until online, replay.truncated dropped the partial text and the transcript answer showed once; ${reads} stream reads, one admission`)
}
// Offline start (wizard-ux issue 719), per kind: after one online visit the scoped worker opens the shell with no
// network; only main threads keep a saved copy (labelled when shown), routed threads are never stored, and no
// /wizard/* API or private media response is ever cached.
async function offlineChecks({s,context,page,record,load,open,root}){
 const row=s.sessions.get('wizard_parity');row.hidden=false;row.title='Synthetic saved thread';row.messages=[{role:'user',content:'Synthetic saved question',timestamp:Date.now()/1000-3},{role:'assistant',content:'Synthetic saved answer',timestamp:Date.now()/1000-2}]
 await load();await closeWelcome(page);let{chat}=await open();await until(async()=>(await chat.innerText()).includes('Synthetic saved answer'),'thread read online')
 await page.waitForFunction(()=>!!navigator.serviceWorker?.controller,null,{timeout:30000})
 const cached=()=>page.evaluate(async()=>{const out=[];for(const n of await caches.keys())for(const r of await (await caches.open(n)).keys())out.push({cache:n,path:new URL(r.url).pathname});return out})
 await until(async()=>{const k=(await cached()).filter(x=>x.cache==='wos-shell-v1').map(x=>x.path);return k.includes('/wizard-os-home/')&&k.some(p=>p.endsWith('/live.js'))&&k.some(p=>p.endsWith('/chats.js'))},'shell copied for an offline start',30000)
 const stored=()=>page.evaluate(()=>new Promise(res=>{const r=indexedDB.open('wos-thread-cache',1);r.onupgradeneeded=()=>r.result.createObjectStore('t',{keyPath:'id'});r.onerror=()=>res(null);r.onsuccess=()=>{try{const g=r.result.transaction('t').objectStore('t').get('wizard_parity');g.onsuccess=()=>res(g.result?{rows:Array.isArray(g.result.rows)?g.result.rows.length:0}:false);g.onerror=()=>res(null)}catch{res(false)}}}))
 const main=s.kind==='main'
 // Any record at all counts as stored (metadata or empty rows too), and every seeded word is looked for offline.
 const seeded=['Synthetic saved thread','Synthetic saved question','Synthetic saved answer']
 if(main)await until(async()=>(await stored())?.rows>0,'main thread saved on this device');else{await sleep(1500);assert.equal(await stored(),false,'a routed thread is never stored, not even as metadata')}
 const keys=await cached();assert.ok(!keys.some(x=>x.path.startsWith('/wizard/')),'no /wizard/* API or private media response is cached: '+JSON.stringify(keys.filter(x=>x.path.startsWith('/wizard/'))))
 await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'})
 await page.waitForFunction(()=>!!window.__wos&&!!window.WizLive&&!!window.WosChat,null,{timeout:30000});assert.equal(await page.evaluate(()=>navigator.onLine),false)
 assert.ok(await page.evaluate(()=>!!document.querySelector('[data-chats],#app,body')),'shell painted from the worker copy')
 let label='routed thread: no saved copy'
 if(main){({chat}=await open());await until(async()=>(await chat.innerText()).includes('Synthetic saved answer'),'saved copy painted offline');await chat.locator('.ch-saved').waitFor({timeout:10000});label=(await chat.locator('.ch-saved').innerText()).trim();assert.match(label,/Saved copy/)}
 else{await root();await sleep(1500);const body=await page.locator('body').innerText();for(const w of seeded)assert.ok(!body.includes(w),`no stored routed thread text appears offline: ${w}`);assert.equal(await stored(),false)}
 await context.setOffline(false);await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__wos?.live?.ok,null,{timeout:45000})
 record('offline-start',`Offline reload opened the shell from the scoped worker copy; ${main?'main thread showed its labelled saved copy ('+label+')':'routed thread was never stored and nothing appeared'}; no /wizard/* response cached (${keys.length} cached files)`)
}
try{for(const kind of selectedKinds){if(!selectedGroup||selectedGroup==='static')await stage(kind,'static',['inline-agent-images','archive-placement','image-thumbnail','ready-needs-you','copy-share','appearance','reading-position','thread-links','swipe-gestures','regenerate','notifications','back-contract'],staticChecks);if(!selectedGroup||selectedGroup==='compose')await stage(kind,'compose',['dictation','pending-echo','outbox-offline','pending-first-send','stop-on-send'],composeChecks);if(!selectedGroup||selectedGroup==='working')await stage(kind,'working',['working-milestones','error-recovery'],workingChecks);if(!selectedGroup||selectedGroup==='media')await stage(kind,'media',['viewer-desktop-fit-keys'],mediaChecks);if(!selectedGroup||selectedGroup==='resume')await stage(kind,'resume',['stream-resume'],resumeChecks);if(!selectedGroup||selectedGroup==='offline')await stage(kind,'offline',['offline-start'],offlineChecks)}}finally{await browser.close();persist(true)}
assert.equal(cells.length,(selectedGroup?({static:12,compose:5,working:2,media:1,resume:1,offline:1}[selectedGroup]):features.length)*selectedKinds.length);assert.equal(new Set(cells.map(c=>c.feature+'/'+c.kind)).size,cells.length)
console.log(JSON.stringify({out,summary:Object.fromEntries(['pass','fail'].map(s=>[s,cells.filter(c=>c.status===s).length])),errors}))
if(cells.some(c=>c.status==='fail')||errors.length)process.exitCode=1
