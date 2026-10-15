import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPhotoProjection, createChatPhotoReconciler, atomicPhotoJson } from '../server/chat-photo-projection.mjs'
import { photoAuthorityId, createPhotoRuntimeVerifier } from '../server/chat-photo-authority.mjs'
const PNG = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex')
function setup(t) {
 const root = mkdtempSync(join(tmpdir(),'photo-review-')); t.after(()=>rmSync(root,{recursive:true,force:true}))
 const registryPath = join(root,'registry'); mkdirSync(registryPath)
 const database = join(root,'state.db'), db = new DatabaseSync(database)
 db.exec(`CREATE TABLE sessions(id TEXT,source TEXT,user_id TEXT,chat_id TEXT,chat_type TEXT,profile_name TEXT,hidden INTEGER,parent_session_id TEXT,title TEXT,model_config TEXT,origin_json TEXT,created_source TEXT,transport_profile TEXT); INSERT INTO sessions VALUES('wizard_123_abc','api_server',NULL,NULL,NULL,'default',0,NULL,'Human chat','{}',NULL,'unknown',NULL);`)
 db.close()
 const config = { database, runtimeHome: root, registryPath, upstreamOrigin:'http://127.0.0.1:1', hermesKey:'fixture-key', ownerId:'123', singleOwner:true }
 const authorityId = photoAuthorityId(config)
 const options = {...config, authorityId, ownerLabel:'Owner', agentLabel:'Agent', maxBytes:1024*1024}
 const provenance = {role:'user',agent_id:'main',owner_id:'123',authority_id:authorityId,thread_id:'wizard_123_abc',message_id:'1',sent_at:'2026-10-15T00:00:00.000Z'}
 return {root,config,options,provenance}
}
test('actual registry path and owner are sealed; runtime verifies authenticated canonical ID',async t=>{
 const {root,config}=setup(t), other=join(root,'other');mkdirSync(other)
 assert.notEqual(photoAuthorityId(config),photoAuthorityId({...config,registryPath:other}))
 assert.notEqual(photoAuthorityId(config),photoAuthorityId({...config,ownerId:'other'}))
 const registry={pinnedAgent:()=>''}
 let requests=0
 const good=createPhotoRuntimeVerifier({...config,registry,fetchImpl:async(url,init)=>{requests++;assert.equal(init.headers.Authorization,'Bearer fixture-key');assert.match(url,/wizard_123_abc$/);return new Response(JSON.stringify({id:'wizard_123_abc'}))}})
 await good();await good();assert.equal(requests,1)
 await assert.rejects(createPhotoRuntimeVerifier({...config,registry,fetchImpl:async()=>new Response('{}',{status:401})})(),/authentication/)
 await assert.rejects(createPhotoRuntimeVerifier({...config,registry,fetchImpl:async()=>new Response('{"id":"wrong"}')})(),/identity/)
})
test('private permissions and accounting survive publication before checkpoint',async t=>{
 const {root,options,provenance}=setup(t), p=createPhotoProjection({root:join(root,'media'),...options})
 const file=await p.publish(PNG,'image/png',provenance)
 assert.equal(statSync(join(root,'media',file.path)).mode&0o077,0)
 assert.equal(statSync(join(root,'media','.wizard')).mode&0o077,0)
 assert.equal(statSync(join(root,'media','Photos','Chats')).mode&0o077,0)
 const statePath=join(root,'cursor.json'),message={thread_id:provenance.thread_id,message_id:'1',role:'user',timestamp:1792022400}
 const r=createChatPhotoReconciler({...options,statePath,projection:p,verifyAuthority:async()=>{},scanBatch:async()=>({evidence:[message],counts:{},cursor:1,ceiling:1,done:true}),resolveMessage:async()=>({photos:[{bytes:PNG,mime:'image/png'}],unavailable:[]})})
 await r.step();assert.equal(JSON.parse(readFileSync(statePath)).counts.resolved,1)
 await r.step();assert.equal(JSON.parse(readFileSync(statePath)).counts.resolved,1)
 chmodSync(join(root,'media','Photos','Chats'),0o755)
 await assert.rejects(p.publish(PNG,'image/png',provenance),/permissions/)
})
test('transients remain durably pending beyond six attempts; authentication failure leaves no cursor',async t=>{
 const {root,options}=setup(t),statePath=join(root,'retry.json'), p=createPhotoProjection({root:join(root,'media'),...options})
 const message={thread_id:'wizard_123_abc',message_id:'1',role:'user',timestamp:10,refs:[{}]}
 const config={...options,statePath,projection:p,verifyAuthority:async()=>{},scanBatch:async s=>({evidence:s.cursor?[]:[message],counts:{},cursor:1,ceiling:1,done:true}),resolveMessage:async()=>{throw Object.assign(new Error('outage'),{code:'ECONNRESET'})}}
 const r=createChatPhotoReconciler(config)
 for(let i=0;i<8;i++){await r.step();const state=JSON.parse(readFileSync(statePath));assert.equal(state.pending.length,1);state.pending[0].after=0;atomicPhotoJson(statePath,state)}
 const state=JSON.parse(readFileSync(statePath));assert.equal(state.pending[0].attempts,8);assert.equal(state.counts.unavailable,undefined)
 await assert.rejects(createChatPhotoReconciler({...config,verifyAuthority:async()=>{throw new Error('auth denied')}}).step(),/auth denied/)
 assert.deepEqual(JSON.parse(readFileSync(statePath)),state)
})
