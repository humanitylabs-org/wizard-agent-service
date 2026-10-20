import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPhotoProjection, createChatPhotoReconciler } from '../server/chat-photo-projection.mjs'
const bytes=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex')
const config={ownerId:'owner',authorityId:'a'.repeat(64),ownerLabel:'Owner',agentLabel:'Agent',maxBytes:1024,verifyAuthority:async()=>{}}
const source={owner_id:'owner',authority_id:config.authorityId,role:'user',agent_id:'main',thread_id:'thread',message_id:'1',sent_at:'2026-10-15T00:00:00Z'}
function setup(t){const root=mkdtempSync(join(tmpdir(),'photo-integrity-'));t.after(()=>rmSync(root,{force:true,recursive:true}));return root}
test('existing unmanifested hash target cannot bypass storage budget',async t=>{
 const root=setup(t),p=createPhotoProjection({root,...config})
 await p.publish(bytes,'image/png',source);rmSync(p.index)
 await assert.rejects(createPhotoProjection({root,...config,maxBytes:1}).publish(bytes,'image/png',source),/storage_placement_required/)
 assert.equal(existsSync(p.index),false)
})
test('every publication error and non-transient resolver error freezes cursor',async t=>{
 const root=setup(t),statePath=join(root,'cursor.json')
 const base={...config,statePath,scanBatch:async()=>({cursor:1,ceiling:1,done:true,counts:{},evidence:[{thread_id:'thread',message_id:'1',role:'user',timestamp:10}]}),resolveMessage:async()=>({photos:[{bytes,mime:'image/png'}],unavailable:[]})}
 for(const message of ['photo directory changed','photo directory is not a plain directory','photo_changed','canonical_image_size_limit']){
  await assert.rejects(createChatPhotoReconciler({...base,projection:{publish(){throw new Error(message)}}}).step(),new RegExp(message))
  assert.equal(existsSync(statePath),false)
 }
 await assert.rejects(createChatPhotoReconciler({...base,projection:{},resolveMessage:async()=>{throw new Error('photo_changed')}}).step(),/photo_changed/)
 assert.equal(existsSync(statePath),false)
})
