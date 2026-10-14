import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { hermesRunTurnHeld, readAbandonedRunOutcomeHttp } from '../server/hermes-http-readers.mjs'

const directories: string[] = []
const queues: DurableRunQueue[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const queue of queues.splice(0)) queue.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function tempDir() {
  const directory = await mkdtemp(join(tmpdir(), 'wizard-stale-run-'))
  directories.push(directory)
  return directory
}

function request(sessionId: string, key: string) {
  const body = JSON.stringify({ session_id: sessionId, input: key })
  return { runtime: 'direct', sessionId, idempotencyKey: key, requestHash: queueRequestHash('direct', body), body, trustedPaths: [] }
}

// One thread whose Hermes run stays `running` forever (the zombie shape), plus a follow-up.
async function zombieThread(options: { held: () => boolean | null, abandoned: () => { status: string } | null }) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T00:00:00Z'))
  const launches: string[] = []
  const reconciled: string[] = []
  const queue = new DurableRunQueue({
    statePath: join(await tempDir(), 'queue.sqlite3'),
    maxActive: 8,
    pollIntervalMs: 0,
    activeSessionIds: async () => [],
    canDispatch: () => true,
    launch: async (record) => {
      launches.push(record.idempotencyKey)
      return { upstreamRunId: `run-${record.idempotencyKey}`, status: 'running', payload: { status: 'running' } }
    },
    lookup: async () => ({ capacityStatus: 'running', payload: { status: 'running' } }),
    turnHeld: async () => options.held(),
    confirmAbandoned: async () => options.abandoned(),
    onReconciled: (record) => { reconciled.push(record.idempotencyKey) },
    staleAfterSeconds: 300,
  })
  queues.push(queue)
  await queue.initialize()
  const first = await queue.admit(request('wizard_thread', 'first'))
  await queue.tick(true)
  const followUp = await queue.admit(request('wizard_thread', 'follow-up'))
  await queue.tick(true)
  const advance = async (seconds: number) => {
    vi.setSystemTime(new Date(Date.now() + seconds * 1000))
    await queue.tick(true)
  }
  return { queue, first: first.record.publicRunId, followUp: followUp.record.publicRunId, launches, reconciled, advance }
}

describe('stale-run guard', () => {
  it('releases a run with no turn held for five minutes so the held follow-up starts', async () => {
    const t = await zombieThread({ held: () => false, abandoned: () => ({ status: 'completed' }) })
    expect(t.queue.get(t.followUp)?.status).toBe('queued')
    await t.advance(301) // run is old enough; lease-less clock starts now
    expect(t.queue.get(t.first)?.status).toBe('running')
    await t.advance(301)
    expect(t.queue.get(t.first)).toMatchObject({ status: 'completed', payload: expect.objectContaining({ last_event: 'run.reconciled' }) })
    await t.queue.tick(true)
    expect(t.launches).toEqual(['first', 'follow-up'])
    expect(t.reconciled).toEqual(['first'])
  })

  it('never releases a run while Hermes holds the turn, however long it runs', async () => {
    const abandoned = vi.fn(() => ({ status: 'completed' }))
    const t = await zombieThread({ held: () => true, abandoned })
    for (let hour = 0; hour < 12; hour += 1) await t.advance(3600)
    expect(t.queue.get(t.first)?.status).toBe('running')
    expect(t.queue.get(t.followUp)?.status).toBe('queued')
    expect(abandoned).not.toHaveBeenCalled()
  })

  it('restarts the five-minute clock when the turn is held again, and waits when the lease cannot be read', async () => {
    let held: boolean | null = false
    const t = await zombieThread({ held: () => held, abandoned: () => ({ status: 'completed' }) })
    await t.advance(301)
    await t.advance(200)
    held = true
    await t.advance(10)
    held = null
    await t.advance(400)
    held = false
    await t.advance(200)
    expect(t.queue.get(t.first)?.status).toBe('running')
    await t.advance(301)
    expect(t.queue.get(t.first)?.status).toBe('completed')
  })

  it('keeps the run when its Hermes process still has an agent attached', async () => {
    const t = await zombieThread({ held: () => false, abandoned: () => null })
    await t.advance(301)
    await t.advance(3600)
    expect(t.queue.get(t.first)?.status).toBe('running')
    expect(t.reconciled).toEqual([])
  })
})

describe('stale-run guard Hermes readers (HTTP, stock Hermes)', () => {
  // Fake Hermes: GET /v1/runs/<id> answers from `runs`; an empty steer is refused 400 when an agent is
  // attached, 409 when none is, 404 when the run is unknown (stock api_server_runs.py behaviour).
  function hermes(runs: Record<string, { status: string, agent?: boolean }>) {
    const calls: string[] = []
    const fetchImpl = async (url: string, init: { method?: string } = {}) => {
      const path = new URL(url).pathname
      calls.push(`${init.method ?? 'GET'} ${path}`)
      const id = decodeURIComponent(path.split('/')[3] ?? '')
      const run = runs[id]
      if (!run) return new Response('{"error":"run_not_found"}', { status: 404 })
      if (path.endsWith('/steer')) return new Response('{}', { status: run.status === 'running' && run.agent ? 400 : 409 })
      return Response.json({ object: 'hermes.run', run_id: id, status: run.status })
    }
    return { fetchImpl, calls }
  }

  it('holds the turn while Hermes still owns the run and releases it when the run is gone or finished', async () => {
    const { fetchImpl, calls } = hermes({
      live: { status: 'running', agent: true }, zombie: { status: 'running', agent: false },
      approval: { status: 'waiting_for_approval' }, done: { status: 'completed' }, cut: { status: 'interrupted' },
    })
    const held = (id: string) => hermesRunTurnHeld(fetchImpl as typeof fetch, 'http://hermes', 'k', id)
    expect(await held('live')).toBe(true)
    expect(await held('zombie')).toBe(false)
    expect(await held('approval')).toBe(true)
    expect(await held('done')).toBe(false)
    expect(await held('cut')).toBe(false)
    expect(await held('unknown')).toBe(false)
    // Only `running` costs a steer probe; settled runs are answered from status alone.
    expect(calls.filter((c) => c.endsWith('/steer'))).toEqual(['POST /v1/runs/live/steer', 'POST /v1/runs/zombie/steer'])
  })

  it('treats an unreadable answer as unknown so the guard leaves the run alone', async () => {
    const fetchImpl = async () => new Response('busy', { status: 503 })
    await expect(hermesRunTurnHeld(fetchImpl as unknown as typeof fetch, 'http://hermes', 'k', 'r')).rejects.toThrow(/unknown/)
  })

  it('calls an abandoned run completed only when its answer reached the thread', async () => {
    const rows: Array<Record<string, unknown>> = []
    const add = (role: string, content: string, timestamp: number, extra: Record<string, unknown> = {}) => rows.push({ id: rows.length + 1, role, content, timestamp, ...extra })
    const seen: string[] = []
    // GET /api/sessions/<id>/messages?order=latest returns the newest page in chronological order.
    const request = async (path: string) => { seen.push(path); return { object: 'list', data: rows.slice(-50) } }
    add('user', 'old question', 5)
    add('assistant', 'old answer', 6)
    add('user', 'question', 10)
    expect(await readAbandonedRunOutcomeHttp(request, 'root', 10)).toBe('interrupted')
    add('assistant', '', 11)
    add('tool', '{}', 12)
    expect(await readAbandonedRunOutcomeHttp(request, 'root', 10)).toBe('interrupted')
    add('assistant', 'Here is the answer.', 13)
    add('assistant', '', 14)
    add('tool', '{"fact_id": 1}', 15)
    add('user', '', 16, { display_kind: 'hidden' })
    expect(await readAbandonedRunOutcomeHttp(request, 'root', 10)).toBe('completed')
    expect(seen[0]).toBe('/api/sessions/root/messages?order=latest&limit=50')
  })
})
