import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'

// 7 Nov 2026: Hermes took up to 20 minutes to accept one new run. The queue tick awaited that one
// POST /v1/runs, so /wizard/health hung (the guardian then restarted the service four times) and
// every other queued message waited behind it.

const directories: string[] = []
const queues: DurableRunQueue[] = []
const releases: Array<() => void> = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(queues.splice(0).map((queue) => queue.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function statePath() {
  const directory = await mkdtemp(join(tmpdir(), 'wizard-slow-launch-'))
  directories.push(directory)
  return join(directory, 'queue.sqlite3')
}

function request(sessionId: string, key: string) {
  const body = JSON.stringify({ session_id: sessionId, input: sessionId })
  return { runtime: 'direct', sessionId, idempotencyKey: key, requestHash: queueRequestHash('direct', body), body, trustedPaths: [] }
}

// A transport whose launch for `hangSession` never answers until released; every other launch is instant.
function transport(hangSession: string) {
  const launched: string[] = []
  const lookups: string[] = []
  let release = () => {}
  const hanging = new Promise<void>((done) => { release = done })
  releases.push(() => release())
  return {
    launched, lookups, release: () => release(),
    launch: async (record: { sessionId: string, publicRunId: string }) => {
      launched.push(record.sessionId)
      if (record.sessionId === hangSession) await hanging
      return { upstreamRunId: `run_${record.sessionId}`, capacityStatus: 'running', payload: { status: 'running' } }
    },
    lookup: async (record: { sessionId: string }) => {
      lookups.push(record.sessionId)
      return { payload: { status: 'running' }, capacityStatus: 'running' }
    },
  }
}

const within = async <T>(ms: number, work: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`still waiting after ${ms} ms`)), ms) })])
  } finally { clearTimeout(timer) }
}

describe('a slow Hermes admission', () => {
  it('health answers while a Hermes launch is hanging and says Hermes is slow to accept', async () => {
    const io = transport('slow')
    const queue = new DurableRunQueue({ statePath: await statePath(), pollIntervalMs: 0, launchWaitMs: 50, summaryWaitMs: 50, slowLaunchSeconds: 1,
      activeSessionIds: async () => [], canDispatch: () => true, launch: io.launch, lookup: io.lookup })
    queues.push(queue)
    const { record } = await within(2_000, queue.admit(request('slow', 'key-slow')))
    expect(record.status).toBe('launching')
    // Make the launch look old, as the guardian would see it after minutes of waiting.
    queue.launches.get(record.publicRunId)!.startedAt -= 90_000
    const started = performance.now()
    const summary = await within(2_000, queue.summary())
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(summary).toMatchObject({ max_active: 8, active: 1, queued: 0, dispatch_paused: false, launching: 1, hermes_slow_to_accept: true })
    expect(summary.launch_waiting_s).toBeGreaterThanOrEqual(90)
    io.release()
    await within(2_000, (async () => { while (queue.launches.size) await new Promise((done) => setTimeout(done, 5)) })())
    const after = await queue.summary()
    expect(after).toMatchObject({ launching: 0, launch_waiting_s: 0, hermes_slow_to_accept: false })
    expect(queue.get(record.publicRunId)!.status).toBe('running')
  })

  it('health still answers while a tick is stuck on Hermes, and marks the summary stale', async () => {
    let releaseLookup = () => {}
    const stuck = new Promise<void>((done) => { releaseLookup = done })
    releases.push(() => releaseLookup())
    const queue = new DurableRunQueue({ statePath: await statePath(), pollIntervalMs: 0, summaryWaitMs: 50,
      activeSessionIds: async () => [], canDispatch: () => true,
      launch: async (record) => ({ upstreamRunId: `run_${record.sessionId}`, capacityStatus: 'running', payload: { status: 'running' } }),
      lookup: async () => { await stuck; return { payload: { status: 'running' }, capacityStatus: 'running' } } })
    queues.push(queue)
    await queue.admit(request('one', 'key-one'))
    void queue.tick(true)
    const summary = await within(1_000, queue.summary())
    expect(summary).toMatchObject({ active: 1, queue_stale: true })
  })

  it('a hanging launch does not stop other queue refreshes or other messages from sending', async () => {
    const io = transport('slow')
    const queue = new DurableRunQueue({ statePath: await statePath(), pollIntervalMs: 0, launchWaitMs: 50,
      activeSessionIds: async () => [], canDispatch: () => true, launch: io.launch, lookup: io.lookup })
    queues.push(queue)
    const running = await queue.admit(request('running', 'key-running'))
    expect(running.record.status).toBe('running')
    const slow = await within(2_000, queue.admit(request('slow', 'key-slow')))
    expect(slow.record.status).toBe('launching')
    const other = await within(2_000, queue.admit(request('other', 'key-other')))
    expect(other.record.status).toBe('running')
    io.lookups.length = 0
    await within(2_000, queue.tick(true))
    // The running thread's status is still refreshed while the slow launch waits.
    expect(io.lookups).toContain('running')
    // The slow message was sent to Hermes exactly once: later ticks never send it again.
    await within(2_000, queue.tick(true))
    expect(io.launched.filter((session) => session === 'slow')).toHaveLength(1)
    io.release()
    await within(2_000, (async () => { while (queue.get(slow.record.publicRunId)!.status !== 'running') await new Promise((done) => setTimeout(done, 5)) })())
    expect(queue.get(slow.record.publicRunId)!.upstreamRunId).toBe('run_slow')
    expect(io.launched.filter((session) => session === 'slow')).toHaveLength(1)
  })

  it('a second message in the same thread waits behind the slow launch instead of overtaking it', async () => {
    const io = transport('slow')
    const queue = new DurableRunQueue({ statePath: await statePath(), pollIntervalMs: 0, launchWaitMs: 50,
      activeSessionIds: async () => [], canDispatch: () => true, launch: io.launch, lookup: io.lookup })
    queues.push(queue)
    await within(2_000, queue.admit(request('slow', 'key-first')))
    const second = await within(2_000, queue.admit(request('slow', 'key-second')))
    expect(second.record.status).toBe('queued')
    expect(io.launched).toEqual(['slow'])
  })
})
