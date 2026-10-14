import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { normalizeProviderPreflightFailure } from '../server/run-provider-failure.mjs'

const dirs: string[] = [], queues: DurableRunQueue[] = []
afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
const failure = () => ({ status: 'completed', completed: true, last_event: 'run.completed', output: '⚠️ Provider authentication failed: Anthropic credentials are rate-limited for claude-opus-5-5; other Claude models remain available.', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } })
const request = () => {
  const body = JSON.stringify({ session_id: 'wizard_saved', input: 'Please do the original task.', model: 'claude-opus-5-5', provider: 'anthropic', require_model_lock: true })
  return { runtime: 'direct', sessionId: 'wizard_saved', idempotencyKey: 'original-send', requestHash: queueRequestHash('direct', body), body }
}
async function make(launch: any, lookup: any) {
  const dir = await mkdtemp(join(tmpdir(), 'wizard-provider-fail-')); dirs.push(dir)
  const q = new DurableRunQueue({ statePath: join(dir, 'q.sqlite3'), pollIntervalMs: 0, canDispatch: () => true, activeSessionIds: async () => [], launch, lookup }); queues.push(q); return q
}

it('converts only exact zero-token provider preflight failures', () => {
  const result = normalizeProviderPreflightFailure(failure())
  expect(result).toMatchObject({ status: 'failed', completed: false, last_event: 'run.failed', error: { type: 'provider_preflight_failed' } })
  expect(result.safe_error).toContain('Your message is saved')
  for (const value of [null, { ...failure(), output: 'A normal answer' }, { ...failure(), status: 'running' }, { ...failure(), usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } }, { ...failure(), usage: undefined }]) expect(normalizeProviderPreflightFailure(value)).toBe(value)
})
it('admission failure is durable, projects failed, and does not relaunch a duplicate', async () => {
  let calls = 0
  const q = await make(async () => { calls++; return { upstreamRunId: 'run_a', capacityStatus: 'completed', payload: failure() } }, async () => { throw new Error('terminal lookup') })
  const first = await q.admit(request())
  expect(first.record!.status).toBe('failed')
  expect(q.publicPayload(first.record)).toMatchObject({ status: 'failed', completed: false })
  expect(q.latestProjections(['wizard_saved'])[0].status).toBe('failed')
  expect(first.record!.body).toBe(request().body)
  await q.admit(request()); expect(calls).toBe(1)
})
it('polling failure releases capacity while preserving selected route and saved body', async () => {
  const q = await make(async () => ({ upstreamRunId: 'run_b', payload: { status: 'running' } }), async () => ({ capacityStatus: 'completed', payload: failure() }))
  const first = await q.admit(request()); await q.tick(true)
  expect(q.get(first.record!.publicRunId)).toMatchObject({ status: 'failed', body: request().body })
  expect((await q.summary()).active).toBe(0)
})
it('startup repairs historical receipts once without replaying or changing their times', async () => {
  let launches = 0
  const q = await make(async () => { launches++; return { upstreamRunId: 'run_old', payload: { status: 'completed', output: 'ok' } } }, async () => { throw new Error('no lookup') })
  const first = await q.admit(request())
  q._update(first.record!.publicRunId, { status: 'completed', payload: failure(), updatedAt: 123 })
  await q.initialize(); await q.initialize()
  expect(q.get(first.record!.publicRunId)).toMatchObject({ status: 'failed', updatedAt: 123, body: request().body })
  expect(q.publicPayload(first.record!.publicRunId).status).toBe('failed')
  expect(q.latestProjections(['wizard_saved'])[0].status).toBe('failed')
  expect(launches).toBe(1)
})
