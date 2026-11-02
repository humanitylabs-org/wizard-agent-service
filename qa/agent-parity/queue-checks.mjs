import assert from 'node:assert/strict'
import { post, pick, runWrites, runInput } from './fixture.mjs'
async function exercise(s, restart=false, model=false) {
  const first = await s.request('/v1/runs', post({session_id:'wizard_parity',input:'First held synthetic turn',model:'fixture-model',provider:'anthropic'}))
  assert.equal(first.status,202); const a = await first.json()
  const revision = await pick(s, 'fixture-other', 1)
  const secondInit=post({session_id:'wizard_parity',input:'Second queued synthetic turn',model:'fixture-other',provider:'anthropic',...(revision === undefined ? {} : {selection_version:revision})})
  const second=await s.request('/v1/runs',secondInit);assert.equal(second.status,202);const b=await second.json()
  assert.equal(b.status,'queued'); assert.notEqual(a.run_id,b.run_id)
  assert.equal(s.runs.size,1,'second turn must not be sent to a busy runtime')
  if(model) {
    await pick(s, 'fixture-model', revision)
    const steer=await s.request(`/v1/runs/${b.run_id}/steer`,post({input:'Synthetic queued guidance',model:'fixture-other',provider:'anthropic',...(revision === undefined ? {} : {selection_version:revision})}));assert.ok([200,202].includes(steer.status))
  }
  if(restart) {
    Object.assign([...s.runs.values()][0],{status:'completed',output:'First synthetic completed',updated_at:Date.now()/1000})
    await s.restart()
    for(let i=0;i<30&&s.runs.size!==2;i++)await new Promise(r=>setTimeout(r,20))
    assert.equal(s.runs.size,2,'restart must resume a queued turn without opening Chats or polling that agent')
  }
  assert.equal((await s.request(`/v1/runs/${b.run_id}`)).status,200)
  const replay=await s.request('/v1/runs',secondInit);assert.equal(replay.status,202);assert.equal((await replay.json()).run_id,b.run_id)
  assert.equal(s.runs.size,restart?2:1)
  const upstreamFirst=[...s.runs.values()][0];upstreamFirst.status='completed';upstreamFirst.output='First synthetic completed';upstreamFirst.updated_at=Date.now()/1000
  let current
  for(let i=0;i<30;i++) { current=await (await s.request(`/v1/runs/${b.run_id}`)).json();if(s.runs.size===2)break;await new Promise(r=>setTimeout(r,20)) }
  assert.equal(s.runs.size,2,'completion must dispatch queued turn once')
  const wire=runWrites(s).at(-1), sent=wire.body
  assert.equal(sent.model,'fixture-other')
  if (process.env.RR_EXPECT_PUBLIC_SELECTED === '1') assert.ok(wire.path.endsWith('/chat/stream'),'selected public queue dispatch must use native SSE')
  if (wire.path.endsWith('/chat/stream')) {
    assert.equal(sent.provider,'anthropic','selected native transport exactly matches configured provider');assert.equal(sent.require_model_lock,true)
    assert.ok(wire.path.endsWith('/api/sessions/wizard_parity/chat/stream'))
  } else {
    assert.ok(wire.path.endsWith('/v1/runs'));assert.equal(sent.provider,s.kind==='main'?'anthropic':undefined,'legacy transport never receives a display account override')
  }
  assert.ok(JSON.stringify(runInput(wire)).includes('Second queued synthetic turn'))
  if(model)assert.ok(JSON.stringify(runInput(wire)).includes('Synthetic queued guidance'))
  await s.restart()
  const after=await s.request(`/v1/runs/${b.run_id}`);assert.equal(after.status,200);assert.equal(s.runs.size,2,'a second restart must not duplicate dispatch')
  assert.equal((await after.json()).agent_id,s.id)
}
// A steer the run accepted but never consumed (Hermes ends the run with it in `pending_steer`)
// becomes exactly one ordinary turn in the same thread on the same model, and survives a restart.
async function pendingSteer(s) {
  const first = await s.request('/v1/runs', post({session_id:'wizard_parity',input:'Synthetic steered turn',model:'fixture-other',provider:'anthropic'}))
  assert.equal(first.status,202); const a = await first.json()
  assert.equal(s.runs.size,1)
  const steer = 'Synthetic late steer the run never read'
  Object.assign([...s.runs.values()][0],{status:'completed',output:'Synthetic answer',pending_steer:steer,updated_at:Date.now()/1000})
  for(let i=0;i<30&&s.runs.size!==2;i++) { await s.request(`/v1/runs/${a.run_id}`); await new Promise(r=>setTimeout(r,20)) }
  assert.equal(s.runs.size,2,'an unconsumed steer must be admitted as the next turn')
  const sent=runWrites(s).at(-1)
  assert.equal(sent.body.session_id,'wizard_parity'); assert.equal(sent.body.model,'fixture-other')
  assert.ok(JSON.stringify(runInput(sent)).includes(steer))
  assert.match(String(sent.headers['idempotency-key']),/^wizard-pending-steer-/)
  const replay=[...s.runs.values()][1]; Object.assign(replay,{status:'completed',output:'Synthetic steer answered',updated_at:Date.now()/1000})
  await s.restart()
  for(let i=0;i<10;i++) { await s.request(`/v1/runs/${a.run_id}`); await new Promise(r=>setTimeout(r,20)) }
  assert.equal(s.runs.size,2,'a restart must never replay the steer twice')
}
export const queueChecks = {
 'pending-steer-replay': pendingSteer,
 'queue-busy': s=>exercise(s),
 'queue-restart': s=>exercise(s,true),
 'model-lock': s=>exercise(s,true,true),
}
