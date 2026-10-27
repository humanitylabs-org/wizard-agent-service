import test from 'node:test'
import assert from 'node:assert/strict'
import { runCheck } from '../qa/agent-parity/checks.mjs'
import { OpusDirect, routerConnection } from '../server/opus-direct.mjs'
import { fakeOpusRouter } from '../qa/opus-router-fixture.mjs'
import { refusesDirect } from '../server/thread-routes.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const kind of ['main','host-profile','container','restricted']) test(`Opus direct HTTP contract / ${kind}`, async () => {
  const result = await runCheck(kind,'opus-direct-answer-route')
  assert.equal(result.status,'pass',result.reason)
})
test('App Manager outgoing slot grant and upstream discovery', () => {
  const dir=mkdtempSync(join(tmpdir(),'route-grant-'))
  try {
    const appsJsonPath=join(dir,'apps.json'), grantsFile=join(dir,'grants.json')
    writeFileSync(appsJsonPath,JSON.stringify({slots:{'connection-router':{default:'router'}},apps:[{id:'router',view:{upstream:'http://127.0.0.1:12345/apps/router/'}}]}))
    writeFileSync(grantsFile,JSON.stringify({outgoing:{'slot:connection-router':'synthetic-grant'}}))
    assert.deepEqual(routerConnection({appsJsonPath,grantsFile}),{origin:'http://127.0.0.1:12345',token:'synthetic-grant'})
    writeFileSync(grantsFile,'{}')
    assert.equal(routerConnection({appsJsonPath,grantsFile}),null)
  } finally {rmSync(dir,{recursive:true,force:true})}
})
test('private/confidential/restricted/recovery policy refuses direct disclosure',()=>{
  for(const agent of [{privacy:'private'},{privacy:'confidential'},{runtime:{isolation:'restricted'}},{role:'recovery'},{model:{provider:'tinfoil'}}]) assert.equal(refusesDirect(agent),true)
  assert.equal(Boolean(refusesDirect({privacy:'standard',runtime:{kind:'profile'}})),false)
})
test('durable idempotency, missing provenance and router errors never replay via Hermes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'direct-durable-')), router=await fakeOpusRouter()
  const appsJsonPath=join(dir,'apps.json')
  writeFileSync(appsJsonPath,JSON.stringify({slots:{'connection-router':{default:router.app.id}},apps:[router.app]}))
  const options={appsJsonPath,routerGrant:router.token,turnsPath:join(dir,'turns.sqlite3'),routePath:join(dir,'routes.json'),fetchImpl:fetch,history:async()=>[]}
  let direct=new OpusDirect(options)
  const finish=async run=>{await Promise.all([...direct.pending]);return direct.get(run.run_id)}
  try {
    direct.routes.set('hermes','s','opus-direct')
    const body={input:'Synthetic exactly-once request'}
    const run=await direct.admit({id:'hermes'},'s',body,'once')
    assert.equal((await finish(run)).status,'completed')
    assert.equal((await direct.admit({id:'hermes'},'s',body,'once')).run_id,run.run_id)
    await assert.rejects(()=>direct.admit({id:'hermes'},'s',{input:'Changed'},'once'),{status:409})
    assert.equal(router.calls.length,1)
    await direct.close(); direct=new OpusDirect(options)
    assert.equal(direct.selected('hermes','s'),true)
    assert.equal((await direct.admit({id:'hermes'},'s',body,'once')).run_id,run.run_id)
    assert.equal(router.calls.length,1)
    for(const code of ['signed_out','expired','limit','needs_owner','unreachable','blocked','provider_error']) {
      router.state.error={code,fix_url:'/apps/fix-synthetic/'}
      const failed=await finish(await direct.admit({id:'hermes'},'s',{input:`Synthetic ${code}`}))
      assert.equal(failed.status,'failed');assert.equal(failed.error.code,code);assert.equal(failed.error.fix_url,'/apps/fix-synthetic/')
      const info=await direct.info({id:'hermes'},'s');assert.equal(info.route,'opus-direct');assert.equal(info.available,false)
    }
    router.state.error=null; router.state.malformed=true
    const incomplete=await finish(await direct.admit({id:'hermes'},'s',{input:'Synthetic incomplete stream'}))
    assert.equal(incomplete.status,'failed');assert.equal(incomplete.error.code,'provider_error')
    assert.ok(!direct.messages('hermes','s').some(m=>m.id===incomplete.run_id+':assistant'))
    direct.save({run_id:'direct:interrupted',agent_id:'hermes',session_id:'s',status:'running',output:'',created_at:1})
    await direct.close();direct=new OpusDirect(options)
    assert.equal(direct.get('direct:interrupted').status,'failed')
    assert.equal(router.calls.length,9)
  } finally {await direct.close();await router.close();rmSync(dir,{recursive:true,force:true})}
})
