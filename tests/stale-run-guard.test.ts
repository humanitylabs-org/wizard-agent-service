import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { readAbandonedRunOutcome, readSessionTurnHeld } from '../server/service.mjs'

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

describe('stale-run guard Hermes readers', () => {
  async function stateDb() {
    const path = join(await tempDir(), 'state.db')
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT);
      CREATE TABLE session_turn_leases (conversation_id TEXT PRIMARY KEY, holder TEXT, acquired_at REAL, expires_at REAL);
      CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp REAL);
      INSERT INTO sessions VALUES ('root', NULL), ('child', 'root'), ('other', NULL);
    `)
    return { path, db }
  }

  it('sees a live lease anywhere in the compression chain and ignores expired ones', async () => {
    const { path, db } = await stateDb()
    const now = Date.now() / 1000
    expect(readSessionTurnHeld(path, 'child')).toBe(false)
    db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run('root', 'h', now, now + 120)
    expect(readSessionTurnHeld(path, 'child')).toBe(true)
    expect(readSessionTurnHeld(path, 'root')).toBe(true)
    expect(readSessionTurnHeld(path, 'other')).toBe(false)
    db.prepare('UPDATE session_turn_leases SET expires_at = ?').run(now - 1)
    expect(readSessionTurnHeld(path, 'child')).toBe(false)
    db.close()
  })

  it('calls an abandoned run completed only when its answer reached the thread', async () => {
    const { path, db } = await stateDb()
    const add = db.prepare('INSERT INTO messages VALUES (?,?,?,?)')
    add.run('root', 'user', 'question', 10)
    expect(readAbandonedRunOutcome(path, 'root', 10)).toBe('interrupted')
    add.run('root', 'assistant', '', 11)
    add.run('root', 'tool', '{}', 12)
    expect(readAbandonedRunOutcome(path, 'root', 10)).toBe('interrupted')
    add.run('root', 'assistant', 'Here is the answer.', 13)
    add.run('root', 'assistant', '', 14)
    add.run('root', 'tool', '{"fact_id": 1}', 15)
    expect(readAbandonedRunOutcome(path, 'root', 10)).toBe('completed')
    db.close()
  })
})
