import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'

const temporaryDirectories: string[] = []
const queues: DurableRunQueue[] = []

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function statePath() {
  const directory = await mkdtemp(join(tmpdir(), 'wizard-run-queue-'))
  temporaryDirectories.push(directory)
  return join(directory, 'queue.sqlite3')
}

function request(sessionId: string, key: string, text = sessionId) {
  const body = JSON.stringify({ session_id: sessionId, input: text })
  return {
    runtime: 'direct',
    sessionId,
    idempotencyKey: key,
    requestHash: queueRequestHash('direct', body),
    body,
    trustedPaths: [],
  }
}

describe('durable Wizard run queue', () => {
  it('starts at most the configured number of threads and drains queued work FIFO', async () => {
    const statuses = new Map<string, string>()
    const launches: string[] = []
    const queue = new DurableRunQueue({
      statePath: await statePath(),
      maxActive: 2,
      pollIntervalMs: 0,
      activeSessionIds: async () => [],
      canDispatch: () => true,
      launch: vi.fn(async (record) => {
        launches.push(record.sessionId)
        const upstreamRunId = `upstream-${record.sessionId}`
        const upstreamStatus = record.sessionId === 'one' ? 'queued' : 'running'
        statuses.set(upstreamRunId, upstreamStatus)
        return { upstreamRunId, status: upstreamStatus, payload: { run_id: upstreamRunId, session_id: record.sessionId, status: upstreamStatus } }
      }),
      lookup: vi.fn(async (record) => ({
        capacityStatus: statuses.get(record.upstreamRunId) ?? 'running',
        payload: { run_id: record.upstreamRunId, session_id: record.sessionId, status: statuses.get(record.upstreamRunId) ?? 'running' },
      })),
    })
    queues.push(queue)
    await queue.initialize()

    const first = await queue.admit(request('one', 'key-one'))
    const second = await queue.admit(request('two', 'key-two'))
    const third = await queue.admit(request('three', 'key-three'))

    expect(first.record.status).toBe('running')
    expect(second.record.status).toBe('running')
    expect(third.record.status).toBe('queued')
    expect(queue.publicPayload(third.record)).toMatchObject({ run_id: third.record.publicRunId, session_id: 'three', status: 'queued', queue_position: 1 })
    expect(launches).toEqual(['one', 'two'])

    statuses.set('upstream-one', 'completed')
    await queue.tick(true)
    expect(launches).toEqual(['one', 'two', 'three'])
    expect(queue.get(third.record.publicRunId)?.status).toBe('running')
  })

  it('counts already-active human threads and pauses admission under host pressure', async () => {
    let healthy = false
    let active = ['external-a']
    const launch = vi.fn(async (record) => ({
      upstreamRunId: `upstream-${record.sessionId}`,
      status: 'running',
      payload: { run_id: `upstream-${record.sessionId}`, session_id: record.sessionId, status: 'running' },
    }))
    const queue = new DurableRunQueue({
      statePath: await statePath(),
      maxActive: 2,
      pollIntervalMs: 0,
      activeSessionIds: async () => active,
      canDispatch: () => healthy,
      launch,
      lookup: async (record) => ({ capacityStatus: record.status, payload: record.payload }),
    })
    queues.push(queue)
    await queue.initialize()

    const admitted = await queue.admit(request('queued', 'key-queued'))
    expect(admitted.record.status).toBe('queued')
    expect(queue.publicPayload(admitted.record)).toMatchObject({ status: 'queued', queue_reason: 'system_busy' })

    healthy = true
    await queue.tick(true)
    expect(launch).toHaveBeenCalledTimes(1)
    active = ['external-a', 'external-b']
    const blocked = await queue.admit(request('blocked', 'key-blocked'))
    expect(blocked.record.status).toBe('queued')
    expect(queue.publicPayload(blocked.record)).toMatchObject({ status: 'queued', queue_reason: 'capacity' })
  })

  it('survives restart, preserves identity, and never dispatches an identical replay twice', async () => {
    const path = await statePath()
    const statuses = new Map([['upstream-one', 'running'], ['upstream-two', 'running']])
    const launches: string[] = []
    const options = {
      statePath: path,
      maxActive: 1,
      pollIntervalMs: 0,
      activeSessionIds: async () => [],
      canDispatch: () => true,
      launch: async (record: { sessionId: string }) => {
        launches.push(record.sessionId)
        const upstreamRunId = `upstream-${record.sessionId}`
        statuses.set(upstreamRunId, 'running')
        return { upstreamRunId, status: 'running', payload: { run_id: upstreamRunId, session_id: record.sessionId, status: 'running' } }
      },
      lookup: async (record: { upstreamRunId: string; sessionId: string }) => ({
        capacityStatus: statuses.get(record.upstreamRunId) ?? 'running',
        payload: { run_id: record.upstreamRunId, session_id: record.sessionId, status: statuses.get(record.upstreamRunId) ?? 'running' },
      }),
    }
    const firstQueue = new DurableRunQueue(options)
    await firstQueue.initialize()
    const first = await firstQueue.admit(request('one', 'key-one'))
    const second = await firstQueue.admit(request('two', 'key-two'))
    const replay = await firstQueue.admit(request('two', 'key-two'))
    expect(replay.replayed).toBe(true)
    expect(replay.record.publicRunId).toBe(second.record.publicRunId)
    expect(launches).toEqual(['one'])
    firstQueue.close()

    const restarted = new DurableRunQueue(options)
    queues.push(restarted)
    await restarted.initialize()
    expect(restarted.get(second.record.publicRunId)?.status).toBe('queued')
    expect(restarted.projections()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'one', status: 'running', publicRunId: first.record!.publicRunId, createdAt: expect.any(Number) }),
      expect.objectContaining({ sessionId: 'two', status: 'queued', publicRunId: second.record!.publicRunId, createdAt: expect.any(Number) }),
    ]))
    statuses.set(first.record.upstreamRunId, 'completed')
    await restarted.tick(true)
    expect(launches).toEqual(['one', 'two'])

    await expect(restarted.admit(request('two', 'key-two', 'conflicting payload'))).rejects.toMatchObject({ status: 409 })
  })

  it('cancels queued work without launching it', async () => {
    const queue = new DurableRunQueue({
      statePath: await statePath(),
      maxActive: 1,
      pollIntervalMs: 0,
      activeSessionIds: async () => ['busy'],
      canDispatch: () => true,
      launch: vi.fn(),
      lookup: vi.fn(),
    })
    queues.push(queue)
    await queue.initialize()
    const admitted = await queue.admit(request('later', 'key-later'))
    expect((await queue.cancel(admitted.record.publicRunId)).status).toBe('cancelled')
    await queue.tick(true)
    expect(queue.get(admitted.record.publicRunId)?.status).toBe('cancelled')
  })

  it('cancels and steers queued work before newly available capacity can dispatch it', async () => {
    let active: string[] = ['busy']
    const launches: string[] = []
    const queue = new DurableRunQueue({
      statePath: await statePath(),
      maxActive: 1,
      pollIntervalMs: 0,
      activeSessionIds: async () => active,
      canDispatch: () => true,
      launch: vi.fn(async (record) => {
        launches.push(record.sessionId)
        return { upstreamRunId: `upstream-${record.sessionId}`, status: 'running', payload: { status: 'running' } }
      }),
      lookup: vi.fn(),
    })
    queues.push(queue)
    await queue.initialize()
    const cancelled = await queue.admit(request('cancel-me', 'cancel-key'))
    const guided = await queue.admit(request('guide-me', 'guide-key'))
    active = []
    await queue.cancel(cancelled.record!.publicRunId)
    const updated = await queue.appendGuidance(guided.record!.publicRunId, 'Keep it compact.')
    expect(JSON.parse(updated!.body).input).toContain('Guidance added while queued:\nKeep it compact.')
    expect(launches).toHaveLength(0)
    await queue.tick(true)
    expect(launches).toEqual(['guide-me'])
  })

  it('fails closed when canonical liveness cannot be read', async () => {
    const launch = vi.fn()
    const queue = new DurableRunQueue({
      statePath: await statePath(),
      maxActive: 2,
      pollIntervalMs: 0,
      activeSessionIds: async () => { throw new Error('state unavailable') },
      canDispatch: () => true,
      launch,
      lookup: vi.fn(),
    })
    queues.push(queue)
    await queue.initialize()
    const admission = await queue.admit(request('session-a', 'key-a'))
    expect(admission.record).not.toBeNull()
    expect(admission.record!.status).toBe('queued')
    expect(queue.publicPayload(admission.record!)).toMatchObject({ status: 'queued', queue_reason: 'liveness_unavailable' })
    expect(launch).toHaveBeenCalledTimes(0)
  })
})
