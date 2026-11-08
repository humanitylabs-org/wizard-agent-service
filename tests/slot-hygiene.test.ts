import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
const dirs: string[] = [], queues: any[] = []
afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
const request = (id: string, continuation: any = null) => {
  const body = JSON.stringify({ session_id: id, input: 'hello' })
  return { runtime: 'direct', sessionId: id, idempotencyKey: id, body, requestHash: queueRequestHash('direct', body), continuation }
}
async function setup(extra: any = {}, held: (r: any) => boolean | null = () => true) {
  const dir = await mkdtemp(join(tmpdir(), 'wizard-slots-')); dirs.push(dir)
  const launches: string[] = [], states = new Map<string, string>()
  const q = new DurableRunQueue({ statePath: join(dir, 'q.sqlite3'), maxActive: 3, reservedInteractive: 1, pollIntervalMs: 0, canDispatch: () => true,
    launch: async (r: any) => { launches.push(r.sessionId); states.set(r.sessionId, 'running'); return { upstreamRunId: 'run_' + r.sessionId, status: 'running', payload: { status: 'running' } } },
    lookup: async (r: any) => ({ payload: { status: states.get(r.sessionId) || 'running' } }),
    turnHeld: (r: any) => held(r), ghostGraceSeconds: 15, ...extra })
  queues.push(q); await q.initialize()
  const age = (session: string, seconds: number) => q.database.prepare('UPDATE wizard_run_queue SET created_at=created_at-? WHERE session_id=?').run(seconds, session)
  return { q, launches, states, age }
}
it('a new chat waits behind full slots held by live turns, then uses the people overflow', async () => {
  const s = await setup({ interactiveOverflow: 1 })
  for (const id of ['a', 'b', 'c']) await s.q.admit(request(id))
  expect(s.launches).toEqual(['a', 'b', 'c'])
  await s.q.admit(request('new-chat'))
  expect(s.launches).toContain('new-chat')
  await s.q.admit(request('fifth'))
  expect(s.launches).not.toContain('fifth')
  expect(s.q.get(s.q.latestForSession('fifth').publicRunId).waitingReason).toBe('capacity')
})
it('background work never uses the people overflow', async () => {
  const s = await setup({ interactiveOverflow: 1 })
  for (const id of ['a', 'b']) await s.q.admit(request(id))
  await s.q.admit(request('bg', { kind: 'external-heavy', job_id: 'j' }))
  expect(s.launches).toEqual(['a', 'b'])
})
it('runs Hermes holds no turn for release their slot after the grace but keep their thread fenced', async () => {
  const dead = new Set(['z1', 'z2', 'z3'])
  const s = await setup({}, (r) => !dead.has(r.sessionId))
  for (const id of ['z1', 'z2', 'z3']) await s.q.admit(request(id))
  await s.q.admit(request('person'))
  expect(s.launches).toEqual(['z1', 'z2', 'z3'])
  expect(s.q.latestForSession('person').status).toBe('queued')
  for (const id of dead) s.age(id, 60)
  await s.q.tick(true)
  expect(s.launches).toContain('person')
  expect((await s.q.summary()).ghost_slots_released).toBe(3)
  await s.q.admit(request('z1'))
  expect(s.launches.filter((id) => id === 'z1')).toHaveLength(1)
})
it('an unreadable or true turn state never frees a slot', async () => {
  for (const held of [() => null, () => true]) {
    const s = await setup({}, held as any)
    for (const id of ['a', 'b', 'c']) await s.q.admit(request(id))
    await s.q.admit(request('late'))
    for (const id of ['a', 'b', 'c']) s.age(id, 600)
    await s.q.tick(true)
    expect(s.launches).not.toContain('late')
  }
})
it('remembers an accepted reply while its run is unfinished, and forgets it once the run ends', async () => {
  const s = await setup()
  await s.q.admit(request('thread'))
  const run = s.q.latestForSession('thread')
  expect(s.q.noteAcceptedSteer(run.upstreamRunId, '  also the footer ')).toBe(true)
  expect(s.q.noteAcceptedSteer('run_unknown', 'x')).toBe(false)
  expect(s.q.acceptedSteersForSession('thread')).toEqual([expect.objectContaining({ text: 'also the footer', publicRunId: run.publicRunId })])
  s.states.set('thread', 'completed'); await s.q.tick(true)
  expect(s.q.acceptedSteersForSession('thread')).toEqual([])
})
