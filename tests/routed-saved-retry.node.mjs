import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs';
import { createRoutedQueues } from '../server/routed-run-queue.mjs';
for (const kind of ['host-profile', 'container', 'restricted']) test(`${kind}: saved first request retains agent custody across restart, reload and duplicate Retry`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'routed-saved-')); const disposers = [];
  t.after(async () => { for (const f of disposers) await f(); rmSync(root, { recursive: true, force: true }); });
  const agent = { id: 'fixture-agent', runtime: { kind }, model: { model: 'original', provider: 'anthropic' } };
  const body = JSON.stringify({ session_id: 'wizard_first', input: [{ role: 'user', content: [{ type: 'text', text: 'synthetic owner words' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj' } }] }], model: 'original' });
  const q = new DurableRunQueue({ agentId: agent.id, statePath: join(root, agent.id, 'wizard-run-queue.sqlite3'), pollIntervalMs: 0, canDispatch: () => false, launch: async () => ({}), lookup: async () => ({}) });
  const source = (await q.admit({ runtime: 'direct', sessionId: 'wizard_first', idempotencyKey: 'first', requestHash: queueRequestHash('direct', body), body, agent_id: agent.id, continuation: { kind: 'watch', preserve_archived: true, agent_id: agent.id } })).record;
  q._update(source.publicRunId, { status: 'failed' }); await q.close();
  const sent = [];
  const registry = { agentsDir: root, list: () => [agent], apiKey: () => 'synthetic-fixture-key', fetchAgent: async (target, path, init = {}) => {
    assert.equal(target.id, agent.id);
    if (path === '/v1/runs' && init.method === 'POST') { sent.push(JSON.parse(init.body)); return Response.json({ run_id: 'upstream', status: 'running' }, { status: 202 }); }
    if (init.method === 'PATCH') return Response.json({ archived: true });
    if (path.startsWith('/api/sessions/')) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json({ run_id: 'upstream', status: 'running' });
  } };
  const queues = createRoutedQueues({ registry, own: f => disposers.push(f), pollIntervalMs: 0 }); await queues.ready;
  const detail = await (await queues.fetch(agent, '/api/sessions/wizard_first?view=detail')).json();
  assert.equal(detail.wizard_retry_run_id, source.publicRunId); assert.equal(detail.status, 'failed');
  const retry = session_id => queues.fetch(agent, '/v1/runs', { method: 'POST', body: JSON.stringify({ session_id, input: 'untrusted preview', wizard_retry_run_id: source.publicRunId, model: 'chosen' }) });
  assert.equal((await retry('another-thread')).status, 404);
  const responses = await Promise.all([retry('wizard_first'), retry('wizard_first')]);
  assert(responses.every(r => r.status === 202));
  const receipts = await Promise.all(responses.map(r => r.json())); assert.equal(receipts[0].run_id, receipts[1].run_id);
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].input, JSON.parse(body).input); assert.equal(sent[0].model, 'chosen');
  assert.equal(sent[0].provider, undefined); assert.equal(sent[0].wizard_retry_run_id, undefined);
});
