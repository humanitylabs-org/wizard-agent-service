import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { DatabaseSync } from 'node:sqlite'
import { abandonedRunVerdict, hermesRunTurnHeld, readAbandonedRunOutcomeHttp } from '../server/hermes-http-readers.mjs'
import { readRunDelivered } from '../server/service.mjs'

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
async function zombieThread(options: { held: () => boolean | null, abandoned: () => { status: string } | null, active?: () => string[] }) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T00:00:00Z'))
  const launches: string[] = []
  const reconciled: string[] = []
  const queue = new DurableRunQueue({
    statePath: join(await tempDir(), 'queue.sqlite3'),
    maxActive: 8,
    pollIntervalMs: 0,
    activeSessionIds: async () => options.active?.() ?? [],
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

describe('stale-run guard: a message held behind the thread\'s active turn', () => {
  // Real shape (wizardq_530017dc…, 7 Nov 2026): the owner's message was admitted while a long reply was
  // still running. Hermes reports it `running` with no agent attached until that reply ends, then
  // delivers it. The guard declared it interrupted after ten minutes; the message was answered anyway.
  it('never calls it interrupted while another turn holds the thread, and completes it once delivered', async () => {
    let busy = false
    const abandoned = vi.fn(() => ({ status: 'completed' }))
    const t = await zombieThread({ held: () => false, abandoned, active: () => (busy ? ['wizard_thread'] : []) })
    busy = true // another turn holds the thread from here on
    for (let minute = 0; minute < 30; minute += 1) await t.advance(60)
    expect(t.queue.get(t.first)?.status).toBe('running')
    expect(abandoned).not.toHaveBeenCalled()
    expect(t.reconciled).toEqual([])
    busy = false
    await t.advance(301)
    expect(t.queue.get(t.first)?.status).toBe('running') // the five-minute clock restarts when the thread frees up
    await t.advance(301)
    expect(t.queue.get(t.first)).toMatchObject({ status: 'completed' })
  })

  it('waits when the thread\'s busy state cannot be read', async () => {
    const abandoned = vi.fn(() => ({ status: 'interrupted' }))
    let unreadable = false
    const t = await zombieThread({ held: () => false, abandoned, active: () => { if (unreadable) throw new Error('state unreadable'); return [] } })
    unreadable = true
    await t.advance(301)
    await t.advance(3600)
    expect(t.queue.get(t.first)?.status).toBe('running')
    expect(abandoned).not.toHaveBeenCalled()
  })
})

describe('stale-run guard: only an ingested message can be abandoned', () => {
  const RUN = 'run_accad41e57684983bb43349a678219ba'
  const SESSION = 'wizard_1794036340706_7a4a6d366ae1'
  async function stateDb(rows: Array<{ session: string, role: string, meta: object | null }>) {
    const path = join(await tempDir(), 'state.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, display_metadata TEXT)')
    db.prepare('INSERT INTO sessions VALUES(?, NULL)').run(SESSION)
    db.prepare('INSERT INTO sessions VALUES(?, ?)').run('child_of_thread', SESSION)
    for (const row of rows) db.prepare('INSERT INTO messages(session_id, role, display_metadata) VALUES(?, ?, ?)').run(row.session, row.role, row.meta ? JSON.stringify(row.meta) : null)
    db.close()
    return path
  }

  it('reads delivery from the submission id Hermes stamps on the ingested user row (real row 4263263)', async () => {
    const meta = { gateway_input_owner: '234e51e8-74fb-539c-90e4-c27c4eb23ef3', submission_id: RUN }
    const path = await stateDb([{ session: SESSION, role: 'user', meta: { submission_id: 'run_other' } }, { session: SESSION, role: 'assistant', meta: null }])
    expect(readRunDelivered(path, SESSION, RUN)).toBe(false)
    const delivered = await stateDb([{ session: SESSION, role: 'user', meta }])
    expect(readRunDelivered(delivered, SESSION, RUN)).toBe(true)
    const child = await stateDb([{ session: 'child_of_thread', role: 'user', meta }])
    expect(readRunDelivered(child, SESSION, RUN)).toBe(true)
    expect(() => readRunDelivered(join(delivered, 'missing'), SESSION, RUN)).toThrow(/unavailable/)
  })

  it('keeps a not-yet-ingested message waiting (however the other reply ended), then fails it as retryable', () => {
    // wizardq_530017dc…: 666 s old when the guard fired; Hermes ingested it 15 minutes after admission.
    expect(abandonedRunVerdict({ delivered: false, outcome: 'interrupted', ageSeconds: 666 })).toBeNull()
    expect(abandonedRunVerdict({ delivered: false, outcome: 'completed', ageSeconds: 1200 })).toBeNull()
    expect(abandonedRunVerdict({ delivered: false, outcome: 'interrupted', ageSeconds: 46 * 60 })).toMatchObject({ status: 'failed', safeError: expect.stringContaining('never delivered') })
    expect(abandonedRunVerdict({ delivered: true, outcome: 'interrupted', ageSeconds: 666 })).toEqual({ status: 'interrupted' })
    expect(abandonedRunVerdict({ delivered: true, outcome: 'completed', ageSeconds: 666 })).toEqual({ status: 'completed' })
  })

  it('stores the retryable failure on the queue row with its safe error', async () => {
    const t = await zombieThread({ held: () => false, abandoned: () => ({ status: 'failed', safeError: 'This message was never delivered.' } as { status: string }) })
    await t.advance(301)
    await t.advance(301)
    expect(t.queue.get(t.first)).toMatchObject({ status: 'failed', payload: expect.objectContaining({ safe_error: 'This message was never delivered.', reconciled_reason: 'no_turn_held' }) })
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
