import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  ready=true;await q.tick(true);await q.tick(true);assert.equal(sent.length,3);assert.equal(JSON.parse(sent[2].body).input,'new')
})
