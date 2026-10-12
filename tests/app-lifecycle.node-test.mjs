import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppLifecycleRoutes, localOwnerAccess } from '../server/app-lifecycle.mjs'
async function fixture(t) {
  const p = join(mkdtempSync(join(tmpdir(),'lifecycle-')), 'apps.json')
  writeFileSync(p, JSON.stringify({ apps: [{ id: 'hello', status: 'running', view: { url: '/apps/hello/', upstream: 'http://127.0.0.1:12345/ui/' } }, {id:'evil',status:'running',view:{upstream:'http://169.254.169.254/'}}] }))
  const calls = []; let refresh = 0
  const handler = createAppLifecycleRoutes({managerUrl:'http://127.0.0.1:9876',managerToken:'internal-fixture',appsJsonPath:p,refresh:()=>refresh++,fetchImpl:async (url,opts)=>{
    calls.push({url:String(url),opts}); return new Response(String(url).includes('12345') ? '<h1>Hello</h1>' : JSON.stringify({ok:true,installed:[]}),{headers:{'content-type':String(url).includes('12345')?'text/html':'application/json'}})
  }})
  const s = createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost'))) {res.writeHead(404);res.end()}})
  await new Promise(r=>s.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>s.close(r)))
  return {base:'http://127.0.0.1:'+s.address().port,calls,refresh:()=>refresh}
}
test('owner session + same origin + CSRF are required, manager key stays server-side',async t=>{
  const {base,calls,refresh}=await fixture(t)
  const path=base+'/api/app-lifecycle/hello%3Awizardapps/install'
  const no=await fetch(path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','Idempotency-Key':'install-12345'},body:'{}'});assert.equal(no.status,403);assert.equal(calls.length,0)
  const boot=await fetch(base+'/wizard/v1/app-lifecycle/session');assert.equal(boot.status,200)
  const cookie=boot.headers.get('set-cookie').split(';')[0];assert.match(boot.headers.get('set-cookie'),/HttpOnly/)
  const {csrf}=await boot.json();assert.ok(csrf);assert.ok(!csrf.includes('internal-fixture'))
  const headers={Origin:base,Cookie:cookie,'X-Wizard-CSRF':csrf,'Idempotency-Key':'install-12345','Content-Type':'application/json'}
  assert.equal((await fetch(path,{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:'{}'})).status,403)
  assert.equal((await fetch(path,{method:'POST',headers:{...headers,'X-Wizard-CSRF':'bad'},body:'{}'})).status,403)
  const good=await fetch(path,{method:'POST',headers,body:'{}'});assert.equal(good.status,200);assert.equal(refresh(),1)
  assert.equal(calls.length,1);assert.equal(calls[0].opts.headers.Authorization,'Bearer internal-fixture');assert.equal(calls[0].opts.headers['Idempotency-Key'],'install-12345')
  assert.equal(JSON.stringify(await good.json()).includes('internal-fixture'),false)
})
test('rejects forwarded unauthenticated request, unknown lifecycle and wrong methods',async t=>{
  const {base,calls}=await fixture(t)
  assert.equal((await fetch(base+'/api/apps/installed',{headers:{'X-Forwarded-For':'8.8.8.8'}})).status,403)
  assert.equal((await fetch(base+'/api/app-lifecycle/hello%3Awizardapps/reset',{method:'POST'})).status,404)
  assert.equal((await fetch(base+'/api/app-lifecycle/hello%3Awizardapps/install')).status,405)
  assert.equal((await fetch(base+'/api/apps/installed',{method:'POST'})).status,405)
  assert.equal(calls.length,0)
})
test('app URL resolves only to running registered loopback upstream and never forwards owner credentials',async t=>{
  const {base,calls}=await fixture(t)
  const r=await fetch(base+'/apps/hello/',{headers:{Authorization:'Bearer OWNER',Cookie:'wizard_lifecycle=owner'}})
  assert.equal(r.status,200);assert.match(await r.text(),/Hello/);assert.equal(calls[0].url,'http://127.0.0.1:12345/ui/');assert.equal(calls[0].opts.headers.Authorization,undefined);assert.equal(calls[0].opts.headers.Cookie,undefined)
  assert.equal((await fetch(base+'/apps/evil/')).status,404);assert.equal((await fetch(base+'/apps/missing/')).status,404)
  assert.equal(calls.length,1)
})
test('trusts loopback or a loopback verified Tailscale principal, never raw remote headers',()=>{
  const req=(ip,h={})=>({socket:{remoteAddress:ip},headers:h})
  assert.equal(localOwnerAccess(req('127.0.0.1')),true)
  assert.equal(localOwnerAccess(req('8.8.8.8',{'tailscale-user-login':'owner'})),false)
  assert.equal(localOwnerAccess(req('127.0.0.1',{'x-forwarded-for':'100.1.2.3'})),false)
  assert.equal(localOwnerAccess(req('127.0.0.1',{'x-forwarded-for':'100.1.2.3','tailscale-user-login':'owner'})),true)
})
