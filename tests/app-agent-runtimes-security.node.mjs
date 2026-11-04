import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRegistry } from '../server/agents.mjs';
import { appAgentRuntimes } from '../server/app-agent-runtimes.mjs';

function fixture(t) {
 const dir = mkdtempSync(join(tmpdir(), 'app-security-')); t.after(() => rmSync(dir, {recursive:true, force:true}));
 const apps = join(dir,'apps.json'), grants=join(dir,'grants.json'), agentsDir=join(dir,'agents');
 const app = {id:'agent-example',type:'agent',agent_runtime:{id:'example',label:'Example',harness:'another-harness',port:18659,host_port:28659,model:{provider:'wizard-router',model:'reply'}}};
 const publish = rows => writeFileSync(apps,JSON.stringify({apps:rows}));
 const credentials = () => writeFileSync(grants,JSON.stringify({outgoing:{'agent-example':'a'.repeat(64)},provider_endpoints:{'agent-example':'http://agent-example:18659'}}));
 publish([app]); credentials();
 const registry=createAgentRegistry({agentsDir,appsJsonPath:apps,appRuntimeGrantsPath:grants});
 return {dir,apps,grants,agentsDir,app,publish,credentials,registry};
}
test('arbitrary harness app selection rejects before sync and never partially writes grants', async t => {
 const f=fixture(t),r=f.registry; r.list();
 const seen=readFileSync(join(f.agentsDir,'.apps-seen.json'),'utf8');
 f.publish([f.app,{id:'new-app',name:'New',view:'/app/'}]);
 await assert.rejects(r.setAppAgents('new-app',{agents:['hermes','example']}), e=>e.error==='agent_not_found');
 assert.equal(readFileSync(join(f.agentsDir,'.apps-seen.json'),'utf8'),seen);
 assert.equal(existsSync(join(f.agentsDir,'.main-agent.json')),false);
 assert.equal(r.appAgents('new-app').agents.some(a=>a.id==='example'),false);
});
test('app endpoint is network-only independent of existing container upstream mode', t=>{
 const f=fixture(t),a=f.registry.read('example');
 assert.equal(f.registry.upstream(a),'http://agent-example:18659');
 assert.equal(a.permissions.files,'none');
});
test('valid JSON scalars and malformed rows fail closed',t=>{
 const f=fixture(t);
 for(const value of [null,[], 'x',42]) {
  writeFileSync(f.apps,JSON.stringify(value)); assert.deepEqual(appAgentRuntimes(f.apps,f.grants),[]);
  f.publish([f.app]); writeFileSync(f.grants,JSON.stringify(value)); assert.deepEqual(appAgentRuntimes(f.apps,f.grants),[]); f.credentials();
 }
 f.publish([null,{}, {id:'agent-example',agent_runtime:null}]); assert.deepEqual(appAgentRuntimes(f.apps,f.grants),[]);
});
test('runtime identity belongs to its app and any leftover agent folder blocks adoption',t=>{
 const f=fixture(t); f.app.id='other-app'; f.publish([f.app]);
 writeFileSync(f.grants,JSON.stringify({outgoing:{'other-app':'a'.repeat(64)},provider_endpoints:{'other-app':'http://other-app:18659'}}));
 assert.equal(f.registry.read('example'),null);
 f.app.id='agent-example'; f.publish([f.app]); f.credentials();
 mkdirSync(join(f.agentsDir,'example'),{recursive:true}); writeFileSync(join(f.agentsDir,'example','gateway.key'),'stale');
 assert.equal(f.registry.read('example'),null); assert.equal(f.registry.agentForGatewayToken('stale'),'');
});
