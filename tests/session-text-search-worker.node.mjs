import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchHermesSessionText, createHermesTextSearcher } from '../server/session-truth.mjs'
import { searchHermesSessionTextAsync } from '../server/session-text-search-worker.mjs'
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'wizard-search-')),path=join(dir,'state.db'),db=new DatabaseSync(path)
  db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,display_kind TEXT,finish_reason TEXT); BEGIN')
  const put=db.prepare('INSERT INTO messages(session_id,role,content,display_kind,finish_reason) VALUES(?,?,?,?,?)')
  const ids=Array.from({length:210},(_,i)=>`wizard_fixture_${i}`)
  for(const id of ids) {
    put.run(id,'user','owner-visible needle',null,null)
    put.run(id,'assistant','newer needle','tool_call','tool_calls')
    put.run(id,'tool','tool needle',null,null)
  }
  put.run('other-agent','user','privateword needle',null,null)
  for(let i=0;i<1500;i++) put.run(ids[i%ids.length],'user','ordinary history '.repeat(100),null,null)
  db.exec("COMMIT; CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(content,content='messages',content_rowid='id',tokenize='trigram'); INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild')")
  db.close()
  return {path,ids,close:()=>rmSync(dir,{recursive:true,force:true})}
}
test('single indexed pass covers all approved roots past 200; visibility and cross-agent privacy',async()=>{
  const f=fixture()
  try {
    const expected=searchHermesSessionText(f.path,f.ids,'needle')
    const actual=await searchHermesSessionTextAsync(f.path,f.ids,'needle')
    assert.deepEqual([...actual],[...expected]); assert.equal(actual.size,210)
    assert(!actual.has('other-agent')); assert([...actual.values()].every(t=>t==='owner-visible needle'))
    assert.equal((await searchHermesSessionTextAsync(f.path,f.ids,'privateword')).size,0)
    assert.equal((await searchHermesSessionTextAsync(f.path,['other-agent'],'privateword')).size,1)
    assert.equal(actual.mode,'body'); assert(actual.timings.candidates>210)
  }finally{f.close()}
})
test('bounded admission and recovery across independent client scopes',async()=>{
  const f=fixture()
  try {
    const jobs=Array.from({length:17},(_,i)=>searchHermesSessionTextAsync(f.path,f.ids,`absent-${i}`,`client-${i}`))
    await assert.rejects(searchHermesSessionTextAsync(f.path,f.ids,'overflow','overflow'),e=>e.status===503)
    assert((await Promise.all(jobs)).every(h=>h.size===0))
    assert.equal((await searchHermesSessionTextAsync(f.path,f.ids,'needle')).size,210)
  }finally{f.close()}
})
test('isolated indexed search leaves HTTP event loop runnable and deduplicates reads',async()=>{
  const f=fixture()
  try {
    const first=searchHermesSessionTextAsync(f.path,f.ids,'absent-term')
    assert.equal(searchHermesSessionTextAsync(f.path,f.ids,'absent-term'),first)
    let finished=false; first.finally(()=>{finished=true})
    await new Promise(r=>setImmediate(r)); assert.equal(finished,false)
    assert.equal((await first).size,0)
  }finally{f.close()}
})
test('short/non-ASCII queries never create a worker or open SQLite',async()=>{
  for(const q of ['n','no','日本語','nostr 日本語']) {
    const hits=await searchHermesSessionTextAsync('/absent/search.db',['root'],q)
    assert.equal(hits.mode,'titles'); assert.equal(hits.timings.fts_ms,0); assert.equal(hits.size,0)
  }
})
test('latest wins drops queued predecessors only for the same client',async()=>{
  const f=fixture()
  try {
    const first=searchHermesSessionTextAsync(f.path,f.ids,'absent-one','client')
    const older=searchHermesSessionTextAsync(f.path,f.ids,'absent-two','client')
    const rejected=assert.rejects(older,e=>e.status===503&&/superseded/.test(e.message))
    const newest=searchHermesSessionTextAsync(f.path,f.ids,'needle','client')
    await rejected; await first; assert.equal((await newest).size,210)
  }finally{f.close()}
})
test('warm handle changes allowlists; snippets are bounded; next three candidates can recover visibility',()=>{
  const f=fixture(),db=new DatabaseSync(f.path)
  for(let i=0;i<3;i++) db.prepare('INSERT INTO messages(session_id,role,content,display_kind) VALUES(?,?,?,?)').run(f.ids[0],'assistant','needle hidden','hidden')
  db.exec("INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild')"); db.close()
  const reader=createHermesTextSearcher(f.path)
  try {
    assert.equal(reader.search([f.ids[0]],'needle').size,1)
    assert.equal(reader.search([f.ids[1]],'needle').has(f.ids[0]),false)
    assert([...reader.search(f.ids,'needle').values()].every(t=>t.length<=202))
  }finally{reader.close();f.close()}
})
