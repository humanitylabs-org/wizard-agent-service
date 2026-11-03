import assert from 'node:assert/strict'
import { post } from './fixture.mjs'
async function exercise(s, restart=false, model=false) {
  const first = await s.request('/v1/runs', post({session_id:'wizard_parity',input:'First held synthetic turn',model:'fixture-model',provider:'anthropic'}))
  assert.equal(first.status,202); const a = await first.json()
  const secondInit=post({session_id:'wizard_parity',input:'Second queued synthetic turn',model:'fixture-other',provider:'anthropic'})
  const second=await s.request('/v1/runs',secondInit);assert.equal(second.status,202);const b=await second.json()
  assert.equal(b.status,'queued'); assert.notEqual(a.run_id,b.run_id)
  assert.equal(s.runs.size,1,'second turn must not be sent to a busy runtime')
  if(model) {
    const change=await s.request('/api/sessions/wizard_parity/model',post({model:'fixture-model',provider:'anthropic'}));assert.equal(change.status,200)
    const steer=await s.request(`/v1/runs/${b.run_id}/steer`,post({input:'Synthetic queued guidance'}));assert.ok([200,202].includes(steer.status))
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
  const sent=s.seen.filter(r=>r.method==='POST'&&r.path.endsWith('/v1/runs')).at(-1).body
  assert.equal(sent.model,'fixture-other');if(s.kind==='main')assert.equal(sent.provider,'anthropic');else assert.equal(sent.provider,undefined,'routed runtime keeps its configured provider, never the registry account id')
  assert.ok(JSON.stringify(sent.input).includes('Second queued synthetic turn'))
  if(model)assert.ok(JSON.stringify(sent.input).includes('Synthetic queued guidance'))
  await s.restart()
  const after=await s.request(`/v1/runs/${b.run_id}`);assert.equal(after.status,200);assert.equal(s.runs.size,2,'a second restart must not duplicate dispatch')
  assert.equal((await after.json()).agent_id,s.id)
}
async function lockedSelectorBoundary(s) {
 try {
  const selector = model => s.request('/api/sessions/wizard_parity/model', post({ model, provider: 'anthropic' }))
  const sonnet = 'claude-sonnet-5-5', opus = 'claude-opus-5-5'
  assert.equal((await selector(opus)).status, 200)
  const first = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Synthetic held turn', model: sonnet, provider: 'anthropic', require_model_lock: true }))
  assert.equal(first.status, 202)
  const queuedInit = post({ session_id: 'wizard_parity', input: 'Synthetic immutable Opus admission', model: opus, provider: 'anthropic', require_model_lock: true })
  const queued = await s.request('/v1/runs', queuedInit)
  assert.equal(queued.status, 202)
  const receipt = await queued.json()
  assert.equal(receipt.status, 'queued')
  assert.equal(s.runs.size, 1)
  const change = await selector(sonnet)
  assert.equal(change.status, 200, `${s.kind}: switch between this agent's declared allowed models`)
  Object.assign([...s.runs.values()][0], { status: 'completed', output: 'Synthetic first result' })
  const until = Date.now() + 5_000
  while (s.runs.size < 2 && Date.now() < until) {
    await s.request(`/v1/runs/${receipt.run_id}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(s.runs.size, 2, `${s.kind}: queued work must dispatch`)
  const sends = () => s.seen.filter(row => row.method === 'POST' && /\/(?:v1\/runs|chat\/stream)$/.test(row.path))
  assert.equal(sends().at(-1).body.model, opus, `${s.kind}: a later selector cannot rewrite an admitted exact lock`)
  assert.equal(sends().at(-1).body.require_model_lock, true)
  Object.assign([...s.runs.values()][1], { status: 'completed', output: 'Synthetic locked result' })
  await s.request(`/v1/runs/${receipt.run_id}`)
  await s.restart()
  const replay = await s.request('/v1/runs', queuedInit)
  assert.equal(replay.status, 202)
  assert.equal((await replay.json()).run_id, receipt.run_id)
  assert.equal(s.runs.size, 2, `${s.kind}: restart/replay cannot duplicate the admitted send`)
  assert.equal((await selector(sonnet)).status, 200, `${s.kind}: an idle selector change remains available`)
  const fresh = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Synthetic unlocked legacy composer', model: opus, provider: 'anthropic' }))
  assert.equal(fresh.status, 202)
  assert.equal(sends().at(-1).body.model, s.kind === 'main' ? sonnet : opus,
    `${s.kind}: only the main legacy hint inherits the host selector; routed agents retain their own explicit route`)
  // The opt-in native stream fixture is intentionally held. End it before close.
  for (const run of s.runs.values()) Object.assign(run, { status: 'completed', output: 'Synthetic cleanup' })
  await s.request(`/v1/runs/${(await fresh.json()).run_id}`)
 } finally {
   // Also drain native fixture streams when an assertion fails.
   for (const run of s.runs.values()) Object.assign(run, { status: 'completed', output: 'Synthetic cleanup' })
 }
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
  const sent=s.seen.filter(r=>r.method==='POST'&&r.path.endsWith('/v1/runs')).at(-1)
  assert.equal(sent.body.session_id,'wizard_parity'); assert.equal(sent.body.model,'fixture-other')
  assert.ok(JSON.stringify(sent.body.input).includes(steer))
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
 'locked-selector-boundary': lockedSelectorBoundary,
}
