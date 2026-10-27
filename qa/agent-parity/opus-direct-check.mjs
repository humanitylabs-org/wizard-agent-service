import assert from 'node:assert/strict'
import { post } from './fixture.mjs'

export async function checkOpusDirect(s) {
  await s.request('/api/sessions/wizard_parity', {...post({hidden:false}),method:'PATCH'})
  const routePath = `/wizard/v1/threads/wizard_parity/route?agent_id=${s.id}`
  const route = value => s.raw(routePath, value ? {...post({route:value}),method:'PUT'} : {})
  const countHermes = () => s.seen.filter(r => r.method === 'POST' && /\/(v1\/runs|chat\/stream)$/.test(r.path)).length
  if (s.kind === 'restricted') {
    for (const value of [undefined,'opus-direct','hermes']) {
      const r = await route(value); assert.equal(r.status,409); assert.equal((await r.json()).error.code,'thread_route.private_agent')
    }
    assert.equal(s.opusRouter.calls.length,0)
    assert.equal(countHermes(),0)
    return
  }
  assert.equal((await (await route()).json()).route,'hermes')
  const invalid = await route('nonsense'); assert.equal(invalid.status,400)
  const selected = await route('opus-direct'); assert.equal(selected.status,200)
  const info = await selected.json(); assert.equal(info.available,true); assert.equal(info.route,'opus-direct')
  await s.restart()
  assert.equal((await (await route()).json()).route,'opus-direct')
  const before = countHermes()
  const admission = await s.request('/v1/runs',post({session_id:'wizard_parity',input:'Synthetic direct owner request'}))
  assert.equal(admission.status,202,await admission.clone().text())
  const run = await admission.json(); assert.match(run.run_id,/^direct:/)
  const stream = await (await s.request(`/v1/runs/${run.run_id}/events`)).text()
  assert.ok(stream.includes('message.delta'),stream); assert.ok(stream.includes('run.completed'),stream)
  assert.ok(stream.includes('"kind":"opus-direct"'),stream)
  assert.equal(countHermes(),before,'no Hermes inference admission for a direct turn')
  assert.equal(s.opusRouter.calls.length,1)
  const body = s.opusRouter.calls[0].body
  assert.equal(body.model,undefined); assert.equal(body.tools,undefined)
  assert.ok(body.messages.some(m=>m.content.includes('Synthetic direct owner request')))
  const history = await (await s.request('/api/sessions/wizard_parity/messages?order=latest&view=wizard')).json()
  const direct = (history.data || history.messages).filter(m=>String(m.id).startsWith('direct:'))
  assert.equal(direct.length,2); assert.equal(direct[1].route.model,'claude-opus-5-5')
  const firstPage = await (await s.request('/api/sessions/wizard_parity/messages?order=latest&limit=1&offset=0&view=wizard')).json()
  const secondPage = await (await s.request('/api/sessions/wizard_parity/messages?order=latest&limit=1&offset=1&view=wizard')).json()
  assert.equal(firstPage.data.length,1); assert.equal(secondPage.data.length,1)
  assert.notEqual(firstPage.data[0].id,secondPage.data[0].id)
  assert.equal(firstPage.has_more,true); assert.equal(secondPage.has_more,false)
  const detail = await (await s.request('/api/sessions/wizard_parity?view=detail')).json()
  assert.equal((detail.session||detail).answer_route,'opus-direct')
  const list = await (await s.request('/api/sessions?view=list')).json()
  assert.equal(list.data.find(r=>r.id==='wizard_parity').answer_route,'opus-direct')
  await s.restart()
  const restored = await (await s.request(`/v1/runs/${run.run_id}`)).json(); assert.equal(restored.status,'completed')
  assert.equal(restored.route.provider,'claude-connection')
  const switched = await route('hermes'); assert.equal(switched.status,200)
  const next = await s.request('/v1/runs',post({session_id:'wizard_parity',input:'Back to Hermes'})); assert.equal(next.status,202)
  assert.equal(countHermes(),before+1)
  const sent = s.seen.filter(r=>r.method==='POST' && /\/(v1\/runs|chat\/stream)$/.test(r.path)).at(-1).body
  assert.ok(sent.instructions.includes('[Wizard direct-answer context]'),JSON.stringify(sent))
  assert.ok(sent.instructions.includes('Synthetic Opus direct reply.'))
  // Router errors remain visible and cannot enter Hermes.
  await route('opus-direct')
  s.opusRouter.state.error = {code:'signed_out',fix_url:'/apps/claude-connection/'}
  const failedAdmission = await s.request('/v1/runs',post({session_id:'wizard_parity',input:'Synthetic router failure'}))
  assert.equal(failedAdmission.status,202)
  const failedRun = await failedAdmission.json()
  const errorStream = await (await s.request(`/v1/runs/${failedRun.run_id}/events`)).text()
  assert.ok(errorStream.includes('run.failed')); assert.ok(errorStream.includes('signed_out')); assert.ok(errorStream.includes('/apps/claude-connection/'))
  assert.equal(countHermes(),before+1)
  const failedList = await (await s.request('/api/sessions?view=list')).json()
  const failedRow = failedList.data.find(row=>row.id==='wizard_parity')
  assert.equal(failedRow.lastRunStatus || failedRow.wizard_last_run_status,'failed')
  assert.ok(failedRow.safeError?.includes('connection') || failedRow.wizard_safe_error?.includes('connection'))
  await s.request('/api/sessions',post({id:'wizard_untouched',source:'wizard-mobile'}))
  const untouched = await s.request('/v1/runs',post({session_id:'wizard_untouched',input:'Ordinary Hermes request'}))
  assert.equal(untouched.status,202); assert.equal(countHermes(),before+2)
  assert.equal(s.opusRouter.calls.length,2)
  const ordinary = s.seen.filter(r=>r.method==='POST' && /\/(v1\/runs|chat\/stream)$/.test(r.path)).at(-1).body
  assert.ok(!ordinary.instructions.includes('[Wizard direct-answer context]'))
  // Sealing an already-selected route is checked again before sending any history.
  if (s.kind !== 'main') {
    s.setSupervisorSeal('private',false)
    const denied = await route('opus-direct'); assert.equal(denied.status,409); assert.equal((await denied.json()).error.code,'thread_route.private_agent')
    const blocked = await s.request('/v1/runs',post({session_id:'wizard_parity',input:'PRIVATE_DO_NOT_SEND'})); assert.equal(blocked.status,409)
    assert.equal(s.opusRouter.calls.length,2)
  }
  const unknown = await s.raw('/wizard/v1/threads/does-not-exist/route'); assert.equal(unknown.status,404)
}
