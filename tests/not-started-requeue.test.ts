import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
const dirs: string[] = [], queues: any[] = []
afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
const request = (id: string) => {
  const body = JSON.stringify({ session_id: id, input: 'Please carry on with the tracker' })
  return { runtime: 'direct', sessionId: id, idempotencyKey: id, body, requestHash: queueRequestHash('direct', body) }
}
async function setup({ lease = false, cancels = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wizard-notstarted-')); dirs.push(dir)
  const launches: string[] = [], cancelled: string[] = []
  const hermesStatus = new Map<string, string>()
  const state = { lease, cancels, n: 0 }
  const q = new DurableRunQueue({ statePath: join(dir, 'q.sqlite3'), maxActive: 2, reservedInteractive: 1, pollIntervalMs: 0, canDispatch: () => true, notStartedSeconds: 5,
    launch: async (r: any) => { const id = `run_${++state.n}`; launches.push(id); hermesStatus.set(id, 'queued'); return { upstreamRunId: id, status: 'running', payload: { status: 'queued', run_id: id } } },
    lookup: async (r: any) => ({ payload: { status: hermesStatus.get(r.upstreamRunId) || 'queued', run_id: r.upstreamRunId } }),
    leaseHeld: async () => state.lease,
    cancelUpstream: async (r: any) => { cancelled.push(r.upstreamRunId); if (state.cancels) hermesStatus.set(r.upstreamRunId, 'cancelled'); return state.cancels } })
  queues.push(q); await q.initialize()
  const wait = (id: string) => q.database.prepare('UPDATE wizard_run_queue SET created_at=created_at-100 WHERE session_id=?').run(id)
  const advance = async () => { for (const [k, v] of q.notStartedSince) q.notStartedSince.set(k, v - 100); await q.tick(true) }
  return { q, launches, cancelled, state, wait, advance, hermesStatus }
}
it('cancels a run Hermes accepted but never started and sends the same message again', async () => {
  const s = await setup()
  await s.q.admit(request('thread'))
  await s.q.tick(true); await s.advance()
  expect(s.cancelled).toEqual(['run_1'])
  const rows = s.q.queuedForSession('direct', 'thread')
  expect(rows.map((r: any) => r.status)).toContain('cancelled')
  const fresh = rows.find((r: any) => r.status !== 'cancelled')
  expect(fresh.retrySourceId).toBe(rows[0].publicRunId)
  expect(JSON.parse(fresh.body).input).toBe('Please carry on with the tracker')
  await s.q.tick(true)
  expect(s.launches).toEqual(['run_1', 'run_2'])
})
it('leaves a reply that is only waiting behind a live turn, and one Hermes would not cancel', async () => {
  const waiting = await setup({ lease: true })
  await waiting.q.admit(request('thread')); await waiting.q.tick(true); await waiting.advance()
  expect(waiting.cancelled).toEqual([])
  const stuck = await setup({ cancels: false })
  await stuck.q.admit(request('thread')); await stuck.q.tick(true); await stuck.advance()
  expect(stuck.launches).toEqual(['run_1'])
  expect(stuck.q.queuedForSession('direct', 'thread')).toHaveLength(1)
})
it('does not count a never-started run as a running slot', async () => {
  const s = await setup({ cancels: false })
  for (const id of ['a', 'b']) await s.q.admit(request(id))
  await s.q.tick(true)
  await s.q.admit(request('c'))
  expect(s.launches).toEqual(['run_1', 'run_2']) // both slots look taken until the runs have waited
  for (const id of ['a', 'b']) s.wait(id)
  await s.q.tick(true)
  expect(s.launches).toHaveLength(3)
  expect((await s.q.summary()).ghost_slots_released).toBe(2)
})
