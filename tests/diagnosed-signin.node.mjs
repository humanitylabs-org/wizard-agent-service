import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { normalizeProviderPreflightFailure, projectProviderSignInHistory } from '../server/run-provider-failure.mjs'
import { annotateProviderSignOut } from '../server/provider-reconnect.mjs'
const failure = {status:'completed',output:"⚠️ Provider authentication failed: No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY.",usage:{input_tokens:0,output_tokens:0}}
const codex = '⚠️ Provider authentication failed: No Codex credentials stored. Run `hermes auth add openai-codex --type oauth` to authenticate.'
test('a diagnosed sign-in failure shows Sign in, not Retry', () => {
  const p = annotateProviderSignOut(normalizeProviderPreflightFailure(failure))
  assert.equal(p.status, 'failed'); assert.equal(p.wizard_reconnect.provider, 'claude')
  assert.doesNotMatch(JSON.stringify(p), /tap Retry|Fix it/)
  const history = JSON.parse(projectProviderSignInHistory(Buffer.from(JSON.stringify({data:[{role:'user',content:'hello'},{role:'assistant',content:failure.output}]})), {payload:p}))
  assert.deepEqual(history.data, [{role:'user',content:'hello'}])
})
for (const provider of ['claude','chatgpt']) for (const failAgain of [false,true]) test(`the held message sends once after sign-in on the same model (${provider}, second failure=${failAgain})`, async t => {
  const root = mkdtempSync(join(tmpdir(),'diagnosed-')); t.after(()=>rmSync(root,{recursive:true,force:true}))
  let signedIn=false; const sent=[]
  const expired=provider==='claude'?failure:{...failure,output:codex}
  const options={statePath:join(root,'runs.db'),pollIntervalMs:0,providerSignInReady:async p=>p===provider&&signedIn,
    launch:async r=>{sent.push(r);return{upstreamRunId:r.publicRunId,payload:r.retrySourceId&&!failAgain?{status:'completed',output:'same-model reply'}:expired}},lookup:async()=>{throw Error('unexpected lookup')}}
  const q=new DurableRunQueue(options); t.after(()=>q.close())
  const body=JSON.stringify({session_id:'held',input:'original words',provider:provider==='claude'?'claude-subscription-directsdk-experimental':'openai-codex',model:provider==='claude'?'claude-opus-4-8':'gpt-6.1-sol',require_model_lock:true})
  const {record}=await q.admit({runtime:'direct',sessionId:'held',idempotencyKey:'first',requestHash:queueRequestHash('direct',body),body})
  assert.equal(q.get(record.publicRunId).status,'failed')
  assert.equal(q.latestProjections(['held'])[0].reconnect.provider, provider)
  await q.tick(true);assert.equal(sent.length,1)
  signedIn=true;await q.tick(true);await q.tick(true);await q.tick(true)
  assert.equal(sent.length,2);assert.equal(sent[1].body,body);assert.equal(sent[1].providerRecoveryAttempted,true)
  assert.equal(q.latestForSession('held').status,failAgain?'failed':'completed')
  await q.close();const reopened=new DurableRunQueue(options);t.after(()=>reopened.close());await reopened.tick(true);assert.equal(sent.length,2)
})
test('a newer owner request prevents automatic resend of an old diagnosed failure', async t=>{
  const root=mkdtempSync(join(tmpdir(),'diagnosed-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let ready=false;const sent=[]
  const q=new DurableRunQueue({statePath:join(root,'q.db'),pollIntervalMs:0,providerSignInReady:async()=>ready,launch:async r=>{sent.push(r);return{upstreamRunId:r.publicRunId,payload:failure}},lookup:async()=>({payload:failure})});t.after(()=>q.close())
  for(const input of ['old','new']) {const body=JSON.stringify({input,model:'claude-opus-4-8',provider:'claude'});await q.admit({runtime:'direct',sessionId:'same',idempotencyKey:input,requestHash:queueRequestHash('direct',body),body})}
  await q.tick(true); // observe the newest diagnosed sign-in as unavailable before its recovery
  ready=true;await q.tick(true);await q.tick(true);assert.equal(sent.length,3);assert.equal(JSON.parse(sent[2].body).input,'new')
})

for (const agentId of ['hermes', 'host-profile', 'container', 'restricted']) test(`sign-in polling excludes expired saved bodies before hydration (${agentId})`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'diagnosed-range-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const now = 2_000_000_000
  t.mock.method(Date, 'now', () => now * 1000)
  const probes = []
  const q = new DurableRunQueue({ statePath: join(root, 'queue.db'), agentId, pollIntervalMs: 0,
    providerAccessWindowSeconds: 60, providerSignInReady: async provider => { probes.push(provider); return false },
    launch: async () => { throw new Error('no dispatch expected') }, lookup: async () => { throw new Error('no lookup expected') } })
  t.after(() => q.close())
  const body = JSON.stringify({ input: 'Synthetic saved request', provider: 'claude', attachment: 'A'.repeat(128 * 1024) })
  const insert = q.database.prepare(`INSERT INTO wizard_run_queue
    (public_run_id,runtime,session_id,idempotency_key,request_hash,body,status,created_at,updated_at,agent_id,payload_json,provider_recovery_attempted)
    VALUES (?,'direct',?,?,?,?, 'failed',?,?,?,?,?)`)
  const payload = JSON.stringify(normalizeProviderPreflightFailure(failure))
  for (let n = 0; n < 64; n++) insert.run(`expired-${n}`, `old-${n}`, `old-${n}`, queueRequestHash('direct', body), body, now - 3600, now, agentId, payload, 0)
  insert.run('boundary', 'boundary', 'boundary', queueRequestHash('direct', body), body, now - 60, now, agentId, payload, 0)
  insert.run('recent', 'recent', 'recent', queueRequestHash('direct', body), body, now - 59, now, agentId, payload, 0)
  insert.run('attempted', 'attempted', 'attempted', queueRequestHash('direct', body), body, now - 1, now, agentId, payload, 1)
  insert.run('operator', 'operator', 'operator', queueRequestHash('direct', body), body, now - 1, now, agentId, payload, 0)
  q.database.prepare("UPDATE wizard_run_queue SET runtime='operator' WHERE public_run_id='operator'").run()
  const hydrated = [], selects = []
  const record = q._record.bind(q), rows = q._rows.bind(q)
  q._record = row => { if (row) hydrated.push(row.public_run_id); return record(row) }
  q._rows = (where, ...params) => { selects.push({ where, params }); return rows(where, ...params) }
  await q._resumeDiagnosedSignIns()
  assert.equal(hydrated.filter(id => id.startsWith('expired-') || id === 'boundary').length, 0,
    'expired failure hydration must be zero')
  assert.deepEqual(probes, ['claude'])
  assert.ok(hydrated.includes('recent'))
  assert.ok(!hydrated.includes('attempted'))
  assert.ok(!hydrated.includes('operator'))
  const { where, params } = selects[0]
  const plan = q.database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM wizard_run_queue WHERE ${where}`).all(...params)
  assert.match(plan.map(row => row.detail).join('\n'), /USING COVERING INDEX wizard_run_queue_fifo \(status=\? AND created_at>\?\)/)
  // No cross-poll cache: an external canonical edit is visible on the very next poll.
  const other = new DatabaseSync(q.statePath)
  try { other.prepare("UPDATE wizard_run_queue SET created_at=? WHERE public_run_id='expired-0'").run(now - 1) }
  finally { other.close() }
  hydrated.length = 0; probes.length = 0
  await q._resumeDiagnosedSignIns()
  assert.ok(hydrated.includes('expired-0'))
  assert.equal(hydrated.filter(id => id.startsWith('expired-') && id !== 'expired-0').length, 0)
  assert.deepEqual(probes, ['claude', 'claude'])
})
