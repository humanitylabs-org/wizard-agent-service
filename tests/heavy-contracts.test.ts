import { heavyRoot } from './support/heavy-root'
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableHeavyQueue, heavyRpcTransport } from '../server/heavy-queue.mjs'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { createHeavyIntegration } from '../server/heavy-integration.mjs'
import { createHeavyRpcServer } from '../server/heavy-rpc-server.mjs'

const cleanup: (() => any)[] = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0 })
const file = () => { const root = mkdtempSync(join(tmpdir(), 'heavy-contract-')); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return join(root, 'queue.db') }
const spec = { cwd: join(heavyRoot, 'fixture'), argv: ['true'], timeout_seconds: 10 }
const token = 'test-heavy-contract-token-00000000000'

it('authenticates the loopback SSH bridge and refuses browser/cross-origin transport', async () => {
  let calls = 0
  const server = createHeavyRpcServer({ token, transport: async (p: any) => { calls++; return { job_id: p.job_id, state: 'completed' } } })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) }))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const payload = { action: 'status', job_id: 'heavy_' + 'a'.repeat(32) }
  expect((await heavyRpcTransport({ origin, token })(payload)).state).toBe('completed')
  expect(calls).toBe(1)
  expect((await fetch(origin + '/rpc', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://foreign.invalid' }, body: JSON.stringify(payload) })).status).toBe(403)
  expect((await fetch(origin + '/rpc', { method: 'POST', body: JSON.stringify(payload) })).status).toBe(403)
  expect(calls).toBe(1)
  expect(() => heavyRpcTransport({ origin: 'https://foreign.invalid', token })).toThrow('loopback')
})

it('never recreates an acknowledged job when remote state disappears', async () => {
  const actions: string[] = []
  const q = new DurableHeavyQueue({ statePath: file(), current: async () => true, continuation: async () => ({ publicRunId: 'x' }),
    transport: async (p: any) => { actions.push(p.action); return p.action === 'submit' ? { job_id: p.job_id, state: 'queued' } : null } })
  cleanup.push(() => q.close())
  const job = q.submit({ sessionId: 's', origin: 'r', key: 'k', spec })
  await q.tick(); await q.tick(); await q.tick()
  expect(actions).toEqual(['submit', 'status', 'status'])
  expect(q.get(job.job_id).reason).toBe('worker_unavailable')
})

it('waits for exact origin runtime metadata and serializes two sibling completions without changing route', async () => {
  let integration: any
  let human = { id: 1, role: 'user', content: 'Run both checks' }
  let complete = false
  const runs = new DurableRunQueue({ statePath: file(), pollIntervalMs: 0, maxActive: 2,
    launch: async (r: any) => {
      if (r.continuation) await integration.validate(r)
      return { upstreamRunId: r.publicRunId, payload: { status: 'running' } }
    }, lookup: async () => ({ payload: { status: complete ? 'completed' : 'running', runtime: complete ? { model: 'origin-model', provider: 'private-origin' } : undefined } }) })
  cleanup.push(() => runs.close())
  const body = JSON.stringify({ session_id: 'wizard_s', input: human.content })
  await runs.admit({ runtime: 'direct', sessionId: 'wizard_s', idempotencyKey: 'origin', body, requestHash: queueRequestHash('direct', body) })
  integration = createHeavyIntegration({ options: { heavyStatePath: file(), heavyToken: token,
    heavyTransport: async (p: any) => ({ job_id: p.job_id, state: 'completed', receipt: { exit_code: 0 } }) }, queue: runs,
    request: async (path: string) => path.startsWith('/v1/runs/') ? { runtime: complete ? { model: 'origin-model', provider: 'private-origin' } : undefined } : { data: [human] } })
  cleanup.push(() => integration.close())
  const req = { headers: { authorization: `Bearer ${token}` } }
  const one = await integration.handle(req, '/wizard/internal/heavy/submit', { session_id: 'wizard_s', key: 'a', spec })
  const two = await integration.handle(req, '/wizard/internal/heavy/submit', { session_id: 'wizard_s', key: 'b', spec })
  await integration.queue.tick()
  expect(integration.queue.get(one.job_id).resume).toBe('')
  expect(integration.queue.get(one.job_id).route).toBe(null)
  complete = true; await runs.tick(true); await integration.queue.tick()
  for (const job of [one, two]) {
    const saved = integration.queue.get(job.job_id)
    expect(saved.route).toEqual({ model: 'origin-model', provider: 'private-origin', require_model_lock: true })
    expect(saved.resume).toMatch(/^wizardq_/)
  }
  // A genuine newer instruction wins, including when an auto-resume is already queued.
  human = { id: 2, role: 'user', content: 'Stop; do not continue' }
  await expect(integration.validate(runs.get(integration.queue.get(two.job_id).resume))).rejects.toMatchObject({ status: 410 })
})
