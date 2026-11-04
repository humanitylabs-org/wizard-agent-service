import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs';
const failure = { status: 'completed', output: "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY.", usage: { total_tokens: 0 } };
function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), 'signin-transition-'));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const state = { ready: true, sent: [], failAgain: false };
 const options = { statePath: join(root, 'q.db'), pollIntervalMs: 0, providerSignInReady: async () => state.ready,
  launch: async r => { state.sent.push(r); return { upstreamRunId: r.publicRunId, payload: r.retrySourceId && !state.failAgain ? { status: 'completed', output: 'Synthetic original-model reply' } : failure }; },
  lookup: async () => ({ payload: failure }) };
 const q = new DurableRunQueue(options); t.after(() => q.close());
 const body = JSON.stringify({ session_id: 'same-thread', input: 'Keep all original owner words.', model: 'claude-opus-5-5', provider: 'anthropic' });
 const admit = () => q.admit({ runtime: 'direct', sessionId: 'same-thread', idempotencyKey: 'first', body, requestHash: queueRequestHash('direct', body) });
 return { state, q, options, body, admit };
}
test('healthy but divergent sign-in cannot consume the single automatic resend', async t => {
 const { q, state, admit } = fixture(t); const { record } = await admit();
 await q.tick(true); await q.tick(true); assert.equal(state.sent.length, 1);
 state.ready = false; await q.tick(true); state.ready = true; await q.tick(true); await q.tick(true);
 assert.equal(state.sent.length, 2); assert.equal(state.sent[1].retrySourceId, record.publicRunId);
 const recovered = JSON.parse(state.sent[1].body); assert.equal(recovered.require_model_lock, true);
 assert.equal(recovered.model, 'claude-opus-5-5'); assert.equal(recovered.provider, 'anthropic');
 assert.equal(recovered.input, 'Keep all original owner words.');
});
test('observed unavailable-to-ready transition survives a service restart', async t => {
 const { q, state, options, admit } = fixture(t); const { record } = await admit();
 state.ready = false; await q.tick(true); await q.close();
 state.ready = true; const reopened = new DurableRunQueue(options); t.after(() => reopened.close());
 await reopened.initialize(); await reopened.tick(true);
 const child = reopened.byIdempotencyKey('direct', 'wizard-saved-retry-' + record.publicRunId);
 assert.equal(child.status, 'completed'); assert.equal(state.sent.length, 2);
});
test('a second sign-in failure offers truthful manual Retry and never promises another automatic send', async t => {
 const { q, state, admit, body } = fixture(t); const { record } = await admit();
 state.ready = false; await q.tick(true); state.failAgain = true; state.ready = true;
 await q.tick(true); await q.tick(true);
 const child = q.byIdempotencyKey('direct', 'wizard-saved-retry-' + record.publicRunId);
 const payload = q.publicPayload(child);
 assert.equal(payload.status, 'failed'); assert.equal(payload.wizard_reconnect, undefined);
 assert.equal(payload.wizard_provider_auth, undefined); assert.match(payload.safe_error, /Sign in again, then tap Retry/);
 const projection = q.latestProjections(['same-thread'])[0]; assert.equal(projection.reconnect, undefined);
 assert.match(projection.safeError, /tap Retry/); assert.equal(q.get(record.publicRunId).body, body);
 await q.tick(true); assert.equal(state.sent.length, 2);
 state.failAgain = false; const manual = await q.retrySaved(child.publicRunId, 'same-thread');
 assert.equal(manual.record.status, 'completed'); assert.equal(state.sent.length, 3);
});
