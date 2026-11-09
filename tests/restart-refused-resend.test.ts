import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'

// 8-9 Nov 2026: each gateway restart drained for up to 30 min and Hermes failed every accepted-but-unstarted
// reply with `runtime_draining`. The owner saw "Reply not sent" and had to tap Retry once Hermes was back.
const dirs: string[] = [], queues: any[] = []
afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
const request = (session: string, key: string, input = 'Please carry on with the tracker') => {
  const body = JSON.stringify({ session_id: session, input })
  return { runtime: 'direct', sessionId: session, idempotencyKey: key, body, requestHash: queueRequestHash('direct', body) }
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'wizard-restart-refused-')); dirs.push(dir)
  const launches: string[] = []
  const hermes = new Map<string, any>()
  const state = { draining: false, n: 0 }
  const q = new DurableRunQueue({ statePath: join(dir, 'q.sqlite3'), maxActive: 4, reservedInteractive: 1, pollIntervalMs: 0, retryDelayMs: 50, canDispatch: () => true,
    launch: async (r: any) => {
      if (state.draining) throw Object.assign(new Error('draining'), { status: 503 })
      const id = `run_${++state.n}`; launches.push(JSON.parse(r.body).input); hermes.set(id, { status: 'queued', run_id: id })
      return { upstreamRunId: id, status: 'running', payload: { status: 'queued', run_id: id } }
    },
    lookup: async (r: any) => ({ payload: hermes.get(r.upstreamRunId) }) })
  queues.push(q); await q.initialize()
  // The gateway begins its drain: Hermes fails every queued, never-started run.
  const drain = () => { state.draining = true; for (const [id, run] of hermes) if (run.status === 'queued') hermes.set(id, { ...run, status: 'failed', error: 'runtime_draining', shutdown_requested_at: 1 }) }
  return { q, launches, state, drain, hermes }
}
const live = (q: any, session: string) => q.queuedForSession('direct', session).filter((r: any) => !['cancelled'].includes(r.status))

it('sends a reply the restarting gateway refused again by itself, once Hermes accepts work again', async () => {
  const s = await setup()
  const first = await s.q.admit(request('thread', 'wos-1'))
  await s.q.tick(true)
  s.drain()
  await s.q.tick(true)
  const rows = s.q.queuedForSession('direct', 'thread')
  const original = rows.find((r: any) => r.publicRunId === (first.record ?? first).publicRunId)
  expect(original.status).toBe('cancelled')
  expect(original.payload.reconciled_reason).toBe('gateway_restart')
  const resend = live(s.q, 'thread')
  expect(resend).toHaveLength(1)
  expect(resend[0].idempotencyKey).toMatch(/^wizard-not-started-requeue-1-/)
  expect(resend[0].retryOrderAt).toBe(original.createdAt) // keeps the first send time
  expect(['queued', 'launching']).toContain(resend[0].status) // waits out the drain, no failure shown
  s.state.draining = false
  await new Promise((done) => setTimeout(done, 80))
  await s.q.tick(true)
  expect(s.launches).toEqual(['Please carry on with the tracker', 'Please carry on with the tracker'])
  expect(live(s.q, 'thread')[0].status).toBe('running')
})

it('keeps the failure visible when a later message already went through, a Retry exists, or it failed for another reason', async () => {
  const s = await setup()
  await s.q.admit(request('thread', 'wos-1', 'first'))
  await s.q.tick(true)
  await s.q.admit(request('thread', 'wos-2', 'second'))
  s.q.database.prepare("UPDATE wizard_run_queue SET status='completed', created_at=created_at+5 WHERE idempotency_key='wos-2'").run()
  s.drain()
  await s.q.tick(true)
  const first = s.q.queuedForSession('direct', 'thread').filter((r: any) => JSON.parse(r.body).input === 'first')
  expect(first.map((r: any) => r.status)).toEqual(['failed'])

  const retried = await setup()
  const admitted = await retried.q.admit(request('t1', 'wos-1'))
  await retried.q.tick(true)
  const originalId = (admitted.record ?? admitted).publicRunId
  await retried.q.admit(request('t1', 'wizard-saved-retry-x'))
  retried.q.database.prepare("UPDATE wizard_run_queue SET retry_source_id=? WHERE idempotency_key='wizard-saved-retry-x'").run(originalId)
  retried.drain()
  await retried.q.tick(true)
  expect(retried.q.queuedForSession('direct', 't1').filter((r: any) => r.idempotencyKey.startsWith('wizard-not-started-requeue-'))).toHaveLength(0)

  const other = await setup()
  await other.q.admit(request('t2', 'wos-3'))
  await other.q.tick(true)
  for (const [id, run] of other.hermes) other.hermes.set(id, { ...run, status: 'failed', error: 'permission_denied' })
  await other.q.tick(true)
  expect(other.q.queuedForSession('direct', 't2').map((r: any) => r.status)).toEqual(['failed'])
})

it('stops resending after the shared not-started cap', async () => {
  const s = await setup()
  await s.q.admit(request('thread', 'wos-1'))
  for (let round = 0; round < 5; round++) {
    s.state.draining = false
    await new Promise((done) => setTimeout(done, 60))
    await s.q.tick(true)
    s.drain()
    await s.q.tick(true)
  }
  const rows = s.q.queuedForSession('direct', 'thread')
  expect(rows.filter((r: any) => r.status === 'failed')).toHaveLength(1)
  expect(rows.filter((r: any) => r.status === 'failed')[0].idempotencyKey).toMatch(/^wizard-not-started-requeue-3-/)
})
