import { heavyRoot } from './support/heavy-root'
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableHeavyQueue } from '../server/heavy-queue.mjs'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { createHeavyIntegration } from '../server/heavy-integration.mjs'

const cleanup: (() => any)[] = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0 })
const file = () => { const root = mkdtempSync(join(tmpdir(), 'heavy-fence-')); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return join(root, 'queue.db') }
const spec = { cwd: join(heavyRoot, 'fixture'), argv: ['true'], timeout_seconds: 10 }
const token = 'test-heavy-fence-token-00000000000000'

it.each(['stop', 'steer'].flatMap(action => [false, true].map(restart => ({ action, restart }))))(
  'fences both already-admitted completed siblings after $action, restart=$restart', async ({ action, restart }) => {
    const runPath = file(), heavyPath = file()
    let integration: any, runs: any
    let canDispatch = true, originDone = false
    const launched: string[] = []
    const make = () => {
      runs = new DurableRunQueue({ statePath: runPath, pollIntervalMs: 0,
        canDispatch: () => canDispatch,
        launch: async (r: any) => {
          if (r.continuation) { await integration.validate(r); launched.push(r.continuation.job_id) }
          return { upstreamRunId: r.publicRunId, payload: { status: r.continuation ? 'completed' : 'running' } }
        }, lookup: async () => ({ payload: { status: originDone ? 'completed' : 'running' } }) })
      integration = createHeavyIntegration({ options: { heavyStatePath: heavyPath, heavyToken: token,
        heavyTransport: async (p: any) => ({ job_id: p.job_id, state: 'completed', receipt: { exit_code: 0 } }) }, queue: runs,
        request: async () => ({ data: [{ id: 1, role: 'user', content: 'run two checks' }] }) })
    }
    make()
    cleanup.push(async () => { await integration.close(); runs.close() })
    const body = JSON.stringify({ session_id: 'wizard_s', input: 'run two checks', model: 'same-model', provider: 'same-provider' })
    await runs.admit({ runtime: 'direct', sessionId: 'wizard_s', idempotencyKey: 'origin', body, requestHash: queueRequestHash('direct', body) })
    const req = { headers: { authorization: `Bearer ${token}` } }
    const jobs = []
    for (const key of ['first', 'second']) jobs.push(await integration.handle(req, '/wizard/internal/heavy/submit', { session_id: 'wizard_s', key, spec }))
    canDispatch = false; originDone = true
    await runs.tick(true); await integration.queue.tick()
    const ids = jobs.map(job => integration.queue.get(job.job_id).resume)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(runs.get(id).status).toBe('queued')
    // Positive control: both are dispatchable before the stop/steer fence.
    for (const id of ids) await expect(integration.validate(runs.get(id))).resolves.toBeUndefined()
    const latest = runs.latestForSession('wizard_s')
    expect(ids).toContain(latest.publicRunId)
    if (action === 'stop') {
      integration.stopSession('wizard_s')
      await runs.cancel(latest.publicRunId) // actual stop cancels ONLY the latest run
    } else {
      integration.supersede('wizard_s')
      await runs.appendGuidance(latest.publicRunId, 'Use my newer direction instead')
    }
    if (restart) { await integration.close(); runs.close(); make() }
    // Human history deliberately stays unchanged: a watermark alone is not a stop fence.
    canDispatch = true
    await runs.tick(true); await runs.tick(true); await integration.queue.tick()
    expect(launched).toEqual([])
    for (let n = 0; n < jobs.length; n++) {
      const saved = integration.queue.get(jobs[n].job_id)
      expect(saved.state).toBe('completed')
      expect(saved.resume).toBe(ids[n]) // retain admitted receipt ID for diagnosis
      expect(saved.continuation_invalidated).toBe(true)
      await expect(integration.validate(runs.get(ids[n]))).rejects.toMatchObject({ status: 410 })
    }
    for (const id of ids) expect(['cancelled', 'failed']).toContain(runs.get(id).status)
  })

it('retains an admission receipt when stop races an in-flight admission, but never revives permission', async () => {
  let release: any, admitted: any
  const entered = new Promise<void>(resolve => { admitted = resolve })
  const q = new DurableHeavyQueue({ statePath: file(), current: async () => true,
    transport: async (p: any) => ({ job_id: p.job_id, state: 'completed' }),
    continuation: async () => { admitted(); return new Promise(resolve => { release = resolve }) } })
  cleanup.push(() => q.close())
  const job = q.submit({ sessionId: 's', origin: 'origin', key: 'one', spec, watermark: {} })
  const pending = q.tick(); await entered
  q.supersede('s')
  release({ publicRunId: 'admitted-receipt' }); await pending
  expect(q.get(job.job_id)).toMatchObject({ resume: 'admitted-receipt', continuation_invalidated: true })
})
