import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createBrowserAdapters, browserAdaptersHttp } from '../server/browser-adapters.mjs'
const installation = appId => ({ installationId:appId+'-install',sourceId:'synthetic:'+appId,installedCommit:'a'.repeat(40),permissionRevision:'p1',status:'running', browser_contract:{operations:appId === 'fixture-list' ? ['fixture.notifications.list'] : ['state.local'], state:{persistent_bytes:5242880}} })
function fixture() { const installs=new Map(['fixture-list','fixture-drafts'].map(id=>[id,installation(id)])); let grants=true; const api=createBrowserAdapters({resolveInstallation:id=>installs.get(id),resolveGrants:id=>({operations:grants ? installation(id.replace('-install','')).browser_contract.operations : []})}); const generation=randomUUID(); const b=api.create({appId:'fixture-list',generation}); let n=0; return {api,installs,generation,b,revoke:()=>grants=false,call:(extra={})=>api.check({handle:b.handle,generation,requestId:'wbs-'+(++n),operation:'fixture.notifications.list',args:{limit:20},...extra})} }
for (const [name,act,code] of [
 ['unknown operation',f=>f.call({operation:'owner.fetch'}),'not_allowed'],
 ['cross-app operation',f=>f.call({operation:'state.local',args:{}}),'not_allowed'],
 ['forged principal',f=>f.call({appId:'fixture-drafts'}),'bad_request'],
 ['stale generation',f=>f.call({generation:randomUUID()}),'stale_binding'],
 ['unknown binding',f=>f.call({handle:randomUUID()}),'stale_binding'],
 ['schema extra fields',f=>f.call({args:{limit:2,url:'/wizard/v1/settings'}}),'bad_request'],
 ['schema bounds',f=>f.call({args:{limit:21}}),'bad_request'],
 ['revoked grant',f=>{f.revoke();f.call()},'not_allowed'],
 ['changed source',f=>{f.installs.get('fixture-list').sourceId='other';f.call()},'revoked'],
 ['changed commit',f=>{f.installs.get('fixture-list').installedCommit='b'.repeat(40);f.call()},'revoked'],
 ['changed permission revision',f=>{f.installs.get('fixture-list').permissionRevision='p2';f.call()},'revoked'],
 ['uninstalled',f=>{f.installs.delete('fixture-list');f.call()},'not_allowed'],
 ['revoked channel',f=>{f.api.revoke(f.b.handle);f.call()},'stale_binding'],
]) test(name,()=>{const f=fixture();assert.throws(()=>act(f),e=>e.code===code)})
test('typed output + request replay denied',()=>{const f=fixture();assert.deepEqual(f.call({requestId:'wbs-9'}),{items:[{id:'synthetic-1',title:'Synthetic list item',read:false,revision:'r1'}],nextCursor:null});assert.throws(()=>f.call({requestId:'wbs-9'}),e=>e.code==='replay')})
test('manifest declaration grants nothing',()=>{const api=createBrowserAdapters({resolveInstallation:()=>installation('fixture-list')});assert.throws(()=>api.check({handle:api.create({appId:'fixture-list',generation:randomUUID()}).handle,generation:randomUUID(),requestId:'wbs-1',operation:'fixture.notifications.list',args:{limit:2}})); const f=fixture();f.revoke();assert.throws(()=>f.call(),e=>e.code==='not_allowed')})
test('HTTP default off, independent owner proof and exact routes',async()=>{
 const responses=[];const f=fixture(); const run=(override={})=>browserAdaptersHttp({method:'POST'}, {},new URL('http://fixture/wizard/v1/browser-adapters/bindings'),{enabled:true,principal:{kind:'owner'},access:true,adapters:f.api,readBody:async()=>Buffer.from(JSON.stringify({appId:'fixture-list',generation:randomUUID()})),send:(_,status,body)=>responses.push({status,body}),...override});
 await run({enabled:false});assert.equal(responses.at(-1).status,404);
 await run({principal:{kind:'service'}});assert.equal(responses.at(-1).status,403);
 await run({access:false});assert.equal(responses.at(-1).status,403);
 await run();assert.equal(responses.at(-1).status,200)
})
