import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableHeavyQueue } from '../server/heavy-queue.mjs'
import { DurableRunQueue, queueRequestHash, retryAfterSeconds } from '../server/run-queue.mjs'
import { createHeavyIntegration } from '../server/heavy-integration.mjs'
import { wizardInteractiveHealthy } from '../server/service.mjs'

const paths: string[] = []
const queues: any[] = []
afterEach(async () => { for (const q of queues.splice(0)) await q.close(); for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }) })
const file = () => { const p = mkdtempSync(join(tmpdir(), 'heavy-')); paths.push(p); return join(p, 'queue.db') }
const spec = { cwd: '/Volumes/ThalesMedia/qa', argv: ['/usr/bin/true'], timeout_seconds: 10 }
function heavy(options: any = {}) {
  const q = new DurableHeavyQueue({ statePath: file(), transport: async p => ({ job_id: p.job_id, state: 'queued' }), current: async () => true,
    continuation: async () => ({ publicRunId: 'resumed' }), ...options }); queues.push(q); return q
}
const submit = (q: any, key = 'build', extra = {}) => q.submit({ sessionId: 'wizard_test', origin: 'owner', key, spec, ...extra })

it('returns a durable receipt without starting or waiting on remote work; replays and rejects changed intent', async () => {
  let calls = 0
  const path = file()
  const q = heavy({ statePath: path, transport: async () => { calls++; throw new Error('offline') } })
  const job = submit(q)
  expect(calls).toBe(0)
  expect(submit(q).job_id).toBe(job.job_id)
  expect(() => submit(q, 'build', { spec: { ...spec, argv: ['different'] } })).toThrow('conflict')
  await q.tick()
  expect(q.get(job.job_id).reason).toBe('worker_unavailable')
  queues.splice(queues.indexOf(q), 1); await q.close()
  const recovered = heavy({ statePath: path })
  expect(submit(recovered).job_id).toBe(job.job_id)
  expect(recovered.summary().queued).toBe(1)
})

it('retries ambiguous remote admission with the same ID; resumes one logical receipt across restart', async () => {
  const remote = new Map(); let launches = 0; let attempts = 0; let resumeAttempts = 0
  const path = file()
  const transport = async p => {
    if (!remote.has(p.job_id)) { launches++; remote.set(p.job_id, { job_id: p.job_id, state: 'completed', receipt: { exit_code: 0 } }) }
    if (++attempts === 1) throw new Error('lost response')
    return remote.get(p.job_id)
  }
  const resumed = new Set()
  const continuation = async j => { resumed.add(j.job_id); if (++resumeAttempts === 1) throw new Error('lost admission response'); return { publicRunId: j.job_id } }
  const q = heavy({ statePath: path, transport, continuation }); const job = submit(q)
  await q.tick(); await q.tick()
  queues.splice(queues.indexOf(q), 1); await q.close()
  const recovered = heavy({ statePath: path, transport, continuation })
  await recovered.tick(); await recovered.tick()
  expect(launches).toBe(1); expect(resumed.size).toBe(1)
  expect(recovered.get(job.job_id).resume).toBe(job.job_id)
})

it('cancels before dispatch without starting a command; cancels ambiguous submission, never resumes', async () => {
  const actions: string[] = []
  const q = heavy({ transport: async p => { actions.push(p.action); return null }, continuation: async () => { throw new Error('must not resume') } })
  const job = submit(q); q.cancel(job.job_id, job.sessionId); await q.tick()
  expect(actions).toEqual(['status']); expect(q.get(job.job_id).state).toBe('cancelled')
  expect(q.get(job.job_id).resume).toBe('suppressed')
})

it('keeps cancellation responsive during a remote RPC and fences a stale completion', async () => {
  let release: any
  let resumes = 0
  const q = heavy({ transport: p => new Promise(resolve => { release = () => resolve({ job_id: p.job_id, state: 'completed' }) }),
    continuation: async () => { resumes++; return { publicRunId: 'x' } } })
  const job = submit(q); const pending = q.tick()
  q.cancel(job.job_id, job.sessionId); release(); await pending
  expect(resumes).toBe(0); expect(q.get(job.job_id).cancel_requested).toBe(true)
})

it('does not consume an interactive slot while one heavy job runs and another queues', async () => {
  const q = heavy({ transport: async p => ({ job_id: p.job_id, state: p.spec.argv[0] === 'first' ? 'running' : 'queued', reason: 'worker_busy' }) })
  submit(q, 'first', { spec: { ...spec, argv: ['first'] } }); submit(q, 'second')
  await q.tick()
  expect(q.summary()).toMatchObject({ active: 1, queued: 1 })
  const run = new DurableRunQueue({ statePath: file(), pollIntervalMs: 0, maxActive: 1,
    launch: async () => ({ upstreamRunId: 'answer', payload: { status: 'completed', output: 'A queue separates waiting work from interactive turns.' } }), lookup: async () => ({}) })
  queues.push(run)
  const body = JSON.stringify({ session_id: 'ordinary', input: 'Why use a queue?' })
  const answer = await run.admit({ runtime: 'direct', sessionId: 'ordinary', body, requestHash: queueRequestHash('direct', body), idempotencyKey: 'question' })
  expect(answer.record.payload.output).toContain('interactive turns')
  expect(q.summary()).toMatchObject({ active: 1, queued: 1 })
})

it('keeps provider retry reasons and Retry-After across restart; other routes remain eligible', async () => {
  const path = file(); let launches = 0
  const launch = async r => { launches++; if (JSON.parse(r.body).provider === 'busy') throw Object.assign(new Error('quota'), { status: 429, retryAfter: '120' }); return { upstreamRunId: 'ok', payload: { status: 'completed' } } }
  const make = () => { const q = new DurableRunQueue({ statePath: path, pollIntervalMs: 0, launch, lookup: async () => ({}) }); queues.push(q); return q }
  const admit = async (q, id, provider) => { const body = JSON.stringify({ session_id: id, provider, input: 'q' }); return q.admit({ runtime: 'direct', sessionId: id, idempotencyKey: id, requestHash: queueRequestHash('direct', body), body }) }
  const q = make(); await admit(q, 'a', 'busy'); await admit(q, 'b', 'busy')
  expect(launches).toBe(1); expect((await q.summary()).provider_waiting).toBe(2)
  queues.splice(queues.indexOf(q), 1); q.close(); const recovered = make(); await recovered.tick()
  expect(launches).toBe(1); await admit(recovered, 'c', 'other'); expect(launches).toBe(2)
  expect(retryAfterSeconds('Thu, 15 Oct 2026 12:01:00 GMT', Date.parse('2026-10-15T12:00:00Z'))).toBe(60)
})

it('gates conversational admission on memory rather than local CPU load', () => {
  expect(wizardInteractiveHealthy({ memoryText: 'MemAvailable: 1048576 kB', pressureText: 'full avg10=0.00' })).toBe(true)
  expect(wizardInteractiveHealthy({ memoryText: 'MemAvailable: 1000 kB', pressureText: 'full avg10=0.00' })).toBe(false)
  expect(wizardInteractiveHealthy({ memoryText: 'MemAvailable: 1048576 kB', pressureText: 'full avg10=30.00' })).toBe(false)
})

it('integrates origin route, generation fencing, continuation idempotency, and authenticated tools', async () => {
  let latestMessage = { id: 1, role: 'user', content: 'Build the thing' }
  const runs = new DurableRunQueue({ statePath: file(), pollIntervalMs: 0,
    launch: async r => ({ upstreamRunId: r.publicRunId, payload: { status: r.continuation ? 'completed' : 'running' } }),
    lookup: async () => ({ payload: { status: 'completed' } }) }); queues.push(runs)
  const body = JSON.stringify({ session_id: 'wizard_test', input: 'Build the thing', model: 'unchanged', provider: 'private' })
  await runs.admit({ runtime: 'direct', sessionId: 'wizard_test', idempotencyKey: 'human', body, requestHash: queueRequestHash('direct', body) })
  const token = 'fixture-heavy-token-not-secret-00000000'
  const integration = createHeavyIntegration({ options: { heavyStatePath: file(), heavyToken: token,
    heavyTransport: async p => ({ job_id: p.job_id, state: 'completed', receipt: { exit_code: 0 } }) },
    queue: runs, request: async () => ({ data: [latestMessage] }) })!
  queues.push(integration)
  const req = { headers: { authorization: `Bearer ${token}` } }
  await expect(integration.handle({ headers: {} }, '/wizard/internal/heavy/submit', { session_id: 'wizard_test', key: 'one', spec })).rejects.toMatchObject({ status: 403 })
  const receipt = await integration.handle(req, '/wizard/internal/heavy/submit', { session_id: 'wizard_test', key: 'one', spec })
  const job = integration.queue.get(receipt.job_id)
  expect(job.route).toEqual({ model: 'unchanged', provider: 'private', require_model_lock: true })
  await runs.tick(true); await integration.queue.tick()
  const continued = runs.get(integration.queue.get(receipt.job_id).resume)
  expect(continued.continuation.job_id).toBe(receipt.job_id)
  expect(JSON.parse(continued.body).provider).toBe('private')
  latestMessage = { id: 2, role: 'user', content: 'Do something different' }
  await expect(integration.validate(continued)).rejects.toMatchObject({ status: 410 })
})
