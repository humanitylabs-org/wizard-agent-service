import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {proxyToAgent} from '../server/agents-http.mjs';import {isAllowedProxyRequest,listen} from '../server/service.mjs';import {createPrincipalResolver} from '../server/principals.mjs';
test('routed-agent window/search/detail stay in chosen synthetic runtime and guard secrets',async t=>{
 const calls=[],pins=[],now=Date.now()/1000;
 const all=Array.from({length:75},(_,i)=>({id:`wizard_private_${i}`,source:'wizard-mobile',title:`Private synthetic ${i}`,archived:true,last_active:now-i,started_at:now-i,preview:'Visible preview'}));
 const full='Never truncate this input '+ 'more words '.repeat(200)+' FULL-END';
 let unsafe=false;
 const ctx={isAllowedProxyRequest,mainSecrets:['synthetic-main-secret'],isThreadVisible:s=>!s.hidden,
  registry:{apiKey:()=> 'synthetic-private-key',upstream:agent=>`http://${agent.id}.invalid`,threadAgent:a=>({id:a.id,privacy:'private'}),read:id=>({id,privacy:'private'}),pin:(id,agent)=>pins.push({id,agent}),agentsDir:new URL('./fixtures/absent-agent-homes/',import.meta.url).pathname,fetchAgent:(agent,path,init)=>ctx.fetchImpl(`http://${agent.id}.invalid${path}`,init)},
  sendJson:(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))},
  fetchImpl:async (url,opts)=>{
    const u=new URL(url);calls.push({host:u.hostname,path:u.pathname,query:u.search});assert.equal(opts.headers.get('Authorization'),'Bearer synthetic-private-key');
    assert(!u.searchParams.has('view')&&!u.searchParams.has('q')&&!u.searchParams.has('window')&&!u.searchParams.has('cursor'));
    let value;
    if(u.pathname.endsWith('/messages'))value={data:[{role:'user',content:u.pathname.includes('private_74')?'historic-private-body-needle':full,timestamp:now}],has_more:false};
    else if(u.pathname==='/api/sessions'){const off=Number(u.searchParams.get('offset')||0);value={data:all.slice(off,off+100),has_more:false};}
    else value=all.find(s=>u.pathname.endsWith('/'+s.id));
    return new Response(JSON.stringify(unsafe?{data:[{id:'wizard_bad',title:'synthetic-private-key'}]}:value),{headers:{'Content-Type':'application/json'}});
  }};
 const owner=createPrincipalResolver(); // box-only owner: the private agent's search is owner-only
 const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://fixture');try{if(req.headers['x-fixture-anonymous']!=='1')await owner.attach(req);await proxyToAgent(ctx,{agent:{id:'private'},method:'GET',upstreamPath:u.pathname,searchParams:u.searchParams,request:req,response:res})}catch(e){ctx.sendJson(res,e.status||502,{error:e.code||'failed'})}
 });const address=await listen(server);t.after(()=>new Promise(r=>server.close(r)));
 const get=async path=>{const r=await fetch(`http://127.0.0.1:${address.port}${path}`);return {status:r.status,body:await r.json()}};
 const w=await get('/api/sessions?view=list&window=archive-50');assert.equal(w.status,200);assert.equal(w.body.archive_total,75);assert.equal(w.body.data.length,50);assert(w.body.data.every(s=>s.agent==='private'));assert(w.body.archive_cursor);
 const search=await get('/api/sessions?view=list&q=historic-private-body-needle');assert.equal(search.status,200);assert.equal(search.body.search_total,1);assert.equal(search.body.data[0].id,'wizard_private_74');assert.match(search.body.data[0].searchSnippet,/historic-private-body-needle/);
 const anon=await fetch(`http://127.0.0.1:${address.port}/api/sessions?view=list&q=historic-private-body-needle`,{headers:{'x-fixture-anonymous':'1'}});assert.equal(anon.status,403);
 const oldDetail=await get('/api/sessions/wizard_private_0');assert.equal(oldDetail.body.wizard_retry_input,undefined);
 const detail=await get('/api/sessions/wizard_private_0?view=detail');assert.equal(detail.status,200);assert.equal(detail.body.wizard_retry_input,full);
 assert(calls.every(c=>c.host==='private.invalid'));assert(pins.every(p=>p.agent==='private'));
 unsafe=true;const secret=await get('/api/sessions?view=list');assert.equal(secret.status,502);assert(!JSON.stringify(secret).includes('synthetic-private-key'));
});
