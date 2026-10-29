import test from 'node:test';
import assert from 'node:assert/strict';
import {selectWindow,archiveCandidate,createListWindows,slimRow} from '../server/session-list-window.mjs';
import {normalizeFull} from '../server/session-list-view.mjs';
const now=1800000000000, old=now/1000-20*86400;
const rows=Array.from({length:130},(_,i)=>({id:`s${i}`,title:`Synthetic ${i}`,source:'wizard-mobile',last_active:old-i,archived:i%2===0,wizard_request_preview:'original '.repeat(50)+(i===129?'needle-beyond-window':''),latest_message:{role:'assistant',content:'reply '.repeat(50),timestamp:old-i}}));
test('newest 50 actual Archive candidates, both explicit and aged',()=>{
 const r=selectWindow(rows,{now}); assert.equal(r.rows.length,50);assert.equal(r.archive_total,130);assert.equal(r.archive_returned,50);assert.equal(r.archive_cursor.after,'s49'); assert.deepEqual(r.rows.map(s=>s.id),rows.slice(0,50).map(s=>s.id));
});
test('all lifecycle exceptions survive even when old or archived',()=>{
 const exceptions=['running','queued','submitting','stopping','waiting_for_approval','unknown','failed','interrupted'].map((status,i)=>({...rows[100+i],status}));
 const r=selectWindow(rows.concat(exceptions.map((s,i)=>({...s,id:`exception${i}`}))),{now});
 assert.equal(r.rows.length,58); for(const e of r.rows.filter(s=>s.id.startsWith('exception')))assert.equal(archiveCandidate(normalizeFull(e),now),false);
});
test('shared deferred/restored and client override membership matches groupWork priority',()=>{
 const r=selectWindow(rows,{now,dispositions:{'direct:s129':{deferred:true},'direct:s127':{deferred:false,updatedAt:new Date(now).toISOString()}},overrides:{s125:{restoredAt:new Date(now).toISOString()},s123:{archived:false,deferred:true}}});
 for(const id of ['s129','s127','s125','s123'])assert(r.rows.some(s=>s.id===id),id);
 assert.equal(r.rows.length,54);assert.equal(r.archive_total,126);
});
test('search covers original request past 140 and outside initial window',()=>{
 const r=selectWindow(rows,{now,q:'needle-beyond-window'});assert.equal(r.search_total,1);assert.equal(r.rows[0].id,'s129');
});
test('window snapshots bind query/scope, expire, and provide a usable archive cursor',async()=>{
 let clock=now;const page=createListWindows({now:()=>clock,ttl:50});let loads=0;
 const params=new URLSearchParams({window:'archive-50',limit:'25',view:'list'});
 const load=async()=>{loads++;return rows};
 const first=await page({params,scope:'main',load});assert.equal(first.data.length,25);assert(first.has_more);assert(first.archive_cursor);
 const next=new URLSearchParams(params);next.set('offset','25');next.set('snapshot',first.snapshot);
 const second=await page({params:next,scope:'main',load});assert.equal(second.data[0].id,'s25');assert.equal(loads,1);
 const cursor=new URLSearchParams(params);cursor.set('cursor',first.archive_cursor);
 const older=await page({params:cursor,scope:'main',load});assert.equal(older.data.length,50);assert.equal(older.data[0].id,'s50');assert.equal(loads,1);
 await assert.rejects(page({params:next,scope:'other-agent',load}),e=>e.status===409);
 next.set('q','different');await assert.rejects(page({params:next,scope:'main',load}),e=>e.status===409);next.delete('q');
 clock+=51;await assert.rejects(page({params:next,scope:'main',load}),e=>e.status===409);
});
test('fresh full window catches unchanged-time renames, deletion and restore',async()=>{
 const page=createListWindows({now:()=>now}),params=new URLSearchParams({window:'archive-50',view:'list'});
 const first=await page({params,scope:'main',load:async()=>rows});
 const changed=rows.filter(s=>s.id!=='s0').map(s=>s.id==='s100'?{...s,archived:false,status:'failed',title:'renamed old exception'}:s);
 const next=await page({params,scope:'main',load:async()=>changed});
 assert(!next.data.some(s=>s.id==='s0'));assert(next.data.some(s=>s.id==='s100'&&s.title==='renamed old exception'));assert.notEqual(next.snapshot,first.snapshot);
});

test('archive and restore outside page 1 change the next complete membership without timestamp bumps',()=>{
 const recent=Array.from({length:120},(_,i)=>({...rows[0],id:`recent${i}`,archived:false,last_active:now/1000-i,latest_message:{role:'assistant',content:'recent',timestamp:now/1000-i}}));
 const initial=selectWindow([...recent,...rows],{now});
 const changed=recent.map(s=>s.id==='recent110'?{...s,archived:true}:s);
 const next=selectWindow([...changed,...rows],{now,dispositions:{'direct:s129':{deferred:false,updatedAt:new Date(now).toISOString()}}});
 assert(next.rows.some(s=>s.id==='recent110'&&s.archived));
 assert(next.rows.some(s=>s.id==='s129'));
 assert.equal(next.archive_total,initial.archive_total);
 assert(!initial.rows.some(s=>s.id==='s129'));
});

test('slim rows keep the routed agent id instead of relabelling them as the main agent', () => {
  assert.equal(slimRow({ id: 'p1', agent: 'philosopher', title: 'x', last_active: '2026-10-25T00:00:00Z' }).agent, 'philosopher');
  assert.equal(slimRow({ id: 'm1', title: 'y', last_active: '2026-10-25T00:00:00Z' }).agent, 'hermes');
});
test('the owner\'s Auto-archive choice decides which aged threads leave the list (Never keeps every unfinished one)',async()=>{
 // 20-day-old threads: half explicitly archived (Done), half only aged.
 const never=selectWindow(rows,{now,archiveDays:0});
 assert.equal(never.archive_total,65); assert.equal(never.rows.length,65+50); // all 65 aged-only threads stay in the list
 assert(never.rows.some(s=>s.id==='s129')); // even the oldest aged one, which a one-week window dropped
 assert.equal(selectWindow(rows,{now,archiveDays:30}).archive_total,65);
 assert.equal(selectWindow(rows,{now,archiveDays:14}).archive_total,130);
 assert.equal(selectWindow(rows,{now,archiveDays:'junk'}).archive_total,130); // invalid -> one week default
 let days=7; const page=createListWindows({now:()=>now,archiveDays:()=>days}),params=new URLSearchParams({window:'archive-50',view:'list',limit:'100'});
 assert.equal((await page({params,scope:'main',load:async()=>rows})).archive_total,130);
 days=0; assert.equal((await page({params,scope:'main',load:async()=>rows})).archive_total,65);
});
