import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as RQ from '../server/run-queue.mjs'
const { DurableRunQueue, queueRequestHash, NOT_STARTED_SAFE_ERROR } = RQ as any

// 8 Nov 2026: Hermes accepted replies (202) and never started them. Wizard cancelled and resent the reply three
// times, then left it on "running" for good. The last resend that also never starts must fail visibly, with the
// message saved and Retry, and health must say replies are not starting.
const dirs: string[] = [], queues: any[] = []
afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
const request = (id: string) => {
  const body = JSON.stringify({ session_id: id, input: 'Please carry on with the tracker' })
  return { runtime: 'direct', sessionId: id, idempotencyKey: id, body, requestHash: queueRequestHash('direct', body) }
}
async function setup({ cancels = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wizard-gaveup-')); dirs.push(dir)
  const launches: string[] = [], gaveUp: any[] = []
  const hermesStatus = new Map<string, string>()
  let n = 0
  const q: any = new (DurableRunQueue as any)({ statePath: join(dir, "q.sqlite3"), maxActive: 2, reservedInteractive: 1, pollIntervalMs: 0, canDispatch: () => true, notStartedSeconds: 5,
    launch: async () => { const id = `run_${++n}`; launches.push(id); hermesStatus.set(id, 'queued'); return { upstreamRunId: id, status: 'running', payload: { status: 'queued', run_id: id } } },
    lookup: async (r: any) => ({ payload: { status: hermesStatus.get(r.upstreamRunId) || 'queued', run_id: r.upstreamRunId } }),
    leaseHeld: async () => false,
    cancelUpstream: async (r: any) => { if (cancels) hermesStatus.set(r.upstreamRunId, 'cancelled'); return cancels },
    onNotStartedGaveUp: (r: any, cancelled: boolean) => gaveUp.push({ id: r.publicRunId, cancelled }) })
  queues.push(q); await q.initialize()
  const age = (seconds: number) => {
    for (const [k, v] of q.notStartedSince) q.notStartedSince.set(k, v - seconds)
    for (const [k, v] of q.stalledSince) q.stalledSince.set(k, v - seconds)
  }
  const advance = async () => { age(100); await q.tick(true); await q.tick(true) }
  return { q, launches, gaveUp, advance, age }
}

it('fails the last never-started resend visibly with the message saved and Retry, instead of a fake "running"', async () => {
  const s = await setup()
  await s.q.admit(request('thread'))
  await s.q.tick(true)
  for (let i = 0; i < 4; i++) await s.advance()
  expect(s.launches).toEqual(['run_1', 'run_2', 'run_3', 'run_4'])
  const rows = s.q.queuedForSession('direct', 'thread')
  const last = rows[rows.length - 1]
  expect(last.status).toBe('failed')
  expect(last.payload.safe_error).toBe(NOT_STARTED_SAFE_ERROR)
  expect(rows.filter((r: any) => !['cancelled', 'failed'].includes(r.status))).toEqual([])
  expect(s.gaveUp).toEqual([{ id: last.publicRunId, cancelled: true }])
  // Retry is offered on exactly this saved message, and resends the owner's own words.
  expect(s.q.savedRetry('thread')?.publicRunId).toBe(last.publicRunId)
  expect(JSON.parse(last.body).input).toBe('Please carry on with the tracker')
  const summary = await s.q.summary()
  expect(summary.replies_given_up_15m).toBe(1)
  expect(summary.replies_not_started).toBe(0)
})

it('health reports a reply that has not started for longer than a minute, across resends', async () => {
  const s = await setup()
  await s.q.admit(request('thread'))
  await s.q.tick(true)
  expect((await s.q.summary()).replies_not_started).toBe(0) // just accepted: not a stall yet
  await s.advance() // confirmed stalled, cancelled and resent
  const summary = await s.q.summary()
  expect(summary.replies_not_started).toBe(1)
  expect(summary.replies_not_started_s).toBeGreaterThanOrEqual(100)
})

it('a reply Hermes will not cancel still stops waiting after the same bounded time', async () => {
  const s = await setup({ cancels: false })
  await s.q.admit(request('thread'))
  await s.q.tick(true)
  s.age(6); await s.q.tick(true)
  expect(s.q.queuedForSession('direct', 'thread')[0].status).toBe('running') // first refusal: keep waiting
  s.age(30); await s.q.tick(true)
  const [only] = s.q.queuedForSession('direct', 'thread')
  expect(only.status).toBe('failed')
  expect(s.gaveUp).toEqual([{ id: only.publicRunId, cancelled: false }])
  expect(s.launches).toEqual(['run_1'])
})

it('reads status rows without loading saved bodies until a body is needed', async () => {
  const s = await setup()
  await s.q.admit(request('thread'))
  const [row] = s.q._rows('1=1')
  expect(Object.getOwnPropertyDescriptor(row, 'body')?.get).toBeTypeOf('function')
  expect(JSON.parse(row.body).input).toBe('Please carry on with the tracker')
  expect({ ...row }.body).toBe(row.body) // spreads keep the body
  row.body = 'replaced'
  expect(row.body).toBe('replaced')
})
