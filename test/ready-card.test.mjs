import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readyCard, readApps } from '../server/wizard-os-settings.mjs';
const declaration = {title:'Garden',subtitle:'Water · Feed',status:'api/status',dismiss:'api/hide'};
test('existing apps.json and owner launcher both project optional ready_card',()=>{
 const root=process.env.TMPDIR || join(process.cwd(),'.test-tmp');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'ready-card-'));
 try{const appsJsonPath=join(dir,'apps.json'),launcherPath=join(dir,'launcher.json');
 writeFileSync(appsJsonPath,JSON.stringify({apps:[{id:'garden',name:'Garden',view:'/garden/',ready_card:declaration},{id:'plain',view:'/plain/'}]}));
 writeFileSync(launcherPath,JSON.stringify({links:[{id:'water',name:'Water',url:'/water/',ready_card:declaration}]}));
 const {apps}=readApps({appsJsonPath,launcherPath});assert.deepEqual(apps.find(a=>a.id==='garden').ready_card,declaration);assert.deepEqual(apps.find(a=>a.id==='water').ready_card,declaration);assert.ok(!('ready_card' in apps.find(a=>a.id==='plain')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('reject external apps, relative escape, absolute/write-anywhere, malformed or executable declarations',()=>{
 for(const view of ['https://other/garden/','//other/garden/','/garden/?x=1','/garden'])assert.equal(readyCard(declaration,view),null);
 for(const status of ['../wizard/api/status','/wizard/api/status','//other/status','https://other/status','api/%2e%2e/status','api\\status','api/status?token=x'])assert.equal(readyCard({...declaration,status},'/garden/'),null);
 assert.equal(readyCard({...declaration,dismiss:'../hide'},'/garden/'),null);assert.equal(readyCard({...declaration,title:''},'/garden/'),null);
 assert.deepEqual(readyCard({...declaration,html:'<script>oops</script>'},'/garden/'),declaration);
 assert.deepEqual(readyCard({title:'Garden',status:'api/status'},'/garden/'),{title:'Garden',subtitle:'',status:'api/status'});
});
