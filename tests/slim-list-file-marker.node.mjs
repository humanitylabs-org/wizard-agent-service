// wizard-ux issue 2055 ask 3: the title-index list read (fields=slim) answered 502 "unsafe file marker" on every
// real-size box. A thread whose stored preview or owner message holds a cut-off attachment marker (an opening
// [WIZARD_FILES_V1] with no closer, as Hermes truncates previews) lost the marker's underscores in the one-line
// preview cleaner, so the file-marker guard no longer recognised it as a marker to drop and refused the whole list.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWizardServer,listen} from '../server/service.mjs';
import {clean} from '../server/session-list-view.mjs';
const close=s=>new Promise(r=>s.close(r));
const files=JSON.stringify([{filename:'synthetic-photo.png',mime:'image/png',path:'/synthetic/uploads/photo.png'}]);
const cutOff='Look at this photo [WIZARD_FILES_V1]\n'+files.slice(0,30);

test('a cut-off or odd file marker leaves no marker in the one-line preview', () => {
  for (const s of [cutOff, 'tail of a cut preview\n[/WIZARD_FILES_V1] and more', 'quoted [wizard-files-v1] in lower case', 'spaced [ WIZARD FILES V1 ] marker'+' x'.repeat(150)]) {
    const out=clean(s).toUpperCase().replace(/[\s_-]+/g,'');
    assert(!out.includes('[WIZARDFILESV1]') && !out.includes('[/WIZARDFILESV1]'), `${JSON.stringify(s)} -> ${JSON.stringify(clean(s))}`);
  }
  assert.equal(clean('Look at this photo [WIZARD_FILES_V1]\n'+files+'\n[/WIZARD_FILES_V1]'), 'Look at this photo 🖼 Photo');
  assert.equal(clean(cutOff), 'Look at this photo');
});

test('fields=slim answers 200 when a thread carries a cut-off file marker', {timeout:20000}, async t => {
  const root=mkdtempSync(join(tmpdir(),'slim-marker-2055-')); const servers=[];
  t.after(async()=>{for(const s of servers.reverse())await close(s);rmSync(root,{recursive:true,force:true})});
  const now=Date.now()/1000;
  const rows=Array.from({length:80},(_,i)=>({id:`wizard_synthetic_${i}`,source:'api_server',title:`Synthetic ${i}`,hidden:false,message_count:2,
    last_active:now-i*3600,started_at:now-i*3600,wizard_activity_at:now-i*3600,
    latest_message:{role:'assistant',content:`Synthetic reply ${i}`,timestamp:now-i*3600}}));
  // Thread with an attachment whose preview fields were cut inside the marker.
  rows[3]={...rows[3],latest_message:undefined,preview:cutOff,last_user_message:{role:'user',content:cutOff,timestamp:now-3*3600}};
  rows[60]={...rows[60],archived:true,latest_message:{role:'assistant',content:'[/WIZARD_FILES_V1] tail',timestamp:now-60*3600},wizard_request_preview:cutOff};
  const up=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');const url=new URL(req.url,'http://fixture');
    if(req.method!=='GET'){res.writeHead(405);res.end('{}');return}
    if(url.pathname==='/api/sessions'){const off=Number(url.searchParams.get('offset')||0);res.end(JSON.stringify({data:rows.slice(off,off+100),has_more:off+100<rows.length}));return}
    res.end('{}');
  });servers.push(up);const u=await listen(up);mkdirSync(join(root,'os'));
  const svc=createWizardServer({upstreamOrigin:`http://127.0.0.1:${u.port}`,hermesKey:'synthetic-api-key',requireAccess:false,agents:false,agentBridge:false,
    followThrough:false,joinedDelegation:'off',wizardOsHome:join(root,'os'),canonicalSessionReader:()=>rows,runQueue:false});
  servers.push(svc);const addr=await listen(svc),base=`http://127.0.0.1:${addr.port}/wizard/hermes/api/sessions`;
  const get=async suffix=>{const r=await fetch(base+suffix);return {status:r.status,text:await r.text()}};
  const q='?view=list&window=archive-50&fields=slim&limit=500&offset=0&include_children=false&overrides=%7B%7D';
  const slim=await get(q);
  assert.equal(slim.status,200,slim.text);
  const body=JSON.parse(slim.text);
  assert.equal(body.fields,'slim');
  const row=body.data.find(r=>r.id==='wizard_synthetic_3');
  assert.equal(row.preview,'Look at this photo');
  assert(!/WIZARD.?FILES/i.test(slim.text),'no attachment marker reaches the title index');
  const full=await get('?view=list&window=archive-50&limit=100&include_children=false&overrides=%7B%7D');
  assert.equal(full.status,200,full.text);
});
