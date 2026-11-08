import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'

const dirs: string[] = [], queues: any[] = []
afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
const request = (id: string) => {
  const body = JSON.stringify({ session_id: id, input: 'hello' })
  return { runtime: 'direct', sessionId: id, idempotencyKey: id, body, requestHash: queueRequestHash('direct', body) }
}
async function setup(): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'wizard-terminal-read-')); dirs.push(dir)
  let n = 0
  const q = new DurableRunQueue({ statePath: join(dir, 'q.sqlite3'), maxActive: 4, reservedInteractive: 1, pollIntervalMs: 0, canDispatch: () => true,
    launch: async () => ({ upstreamRunId: `run_${++n}`, status: 'running', payload: { status: 'running' } }),
    lookup: async (r: any) => ({ payload: { status: 'completed', run_id: r.upstreamRunId } }) })
  queues.push(q); await q.initialize()
  return q
}

it('re-reading finished runs shares one forced tick instead of one per read', async () => {
  const q = await setup()
  const ids: string[] = []
  for (const id of ['a', 'b', 'c']) ids.push((await q.admit(request(id))).record.publicRunId)
  await q.tick(true); await q.tick(true)
  for (const id of ids) expect(q.get(id).status).toBe('completed')
  let ticks = 0
  const original = q.tick.bind(q)
  q.tick = (force?: boolean) => { ticks++; return original(force) }
  for (let round = 0; round < 5; round++) for (const id of ids) expect((await q.refreshRun(id)).status).toBe('completed')
  expect(ticks).toBe(1)
  q.terminalReadTickAt -= 6_000
  await q.refreshRun(ids[0])
  expect(ticks).toBe(2)
})

it('keeps the diagnosed-sign-in scan on the failed-run id list, not a walk of every direct row', async () => {
  const q = await setup()
  const plan = q.database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM wizard_run_queue WHERE public_run_id IN (
      SELECT public_run_id FROM wizard_run_queue INDEXED BY wizard_run_queue_fifo WHERE status='failed' AND created_at>?
    ) AND +runtime='direct' AND +provider_recovery_attempted=0`).all(0).map((row: any) => row.detail).join('\n')
  expect(plan).not.toMatch(/INDEX sqlite_autoindex_wizard_run_queue_2 \(runtime=\?\)/)
  expect(plan).toMatch(/autoindex_wizard_run_queue_1 \(public_run_id=\?\)/)
})
