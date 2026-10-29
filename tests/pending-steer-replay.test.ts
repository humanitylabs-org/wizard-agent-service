import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableRunQueue, PENDING_STEER_REPLAY_PREFIX, queueRequestHash } from '../server/run-queue.mjs'
import { readSteerResentHttp } from '../server/hermes-http-readers.mjs'

// 24 Oct 2026: the owner sent a voice note while a run was writing its final answer. Hermes accepted the
// steer (200), but the run had no further tool result to carry it, so it ended `completed` with the text
// in `pending_steer` "for replay". The phone showed "Delivered · Wizard sees it next step" and nothing ever
// read it. A steer the run did not consume must become the next ordinary turn in the same thread, once.

const directories: string[] = []
const queues: DurableRunQueue[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const queue of queues.splice(0)) queue.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

type Run = { status: string, output?: string | null, pending_steer?: string }
type Upstream = Map<string, Run>

function serviceProcess(statePath: string, upstream: Upstream, launched: Array<{ key: string, body: string }>, options: {
  delivered?: (record: { sessionId: string }, text: string) => boolean | Promise<boolean>,
  decisions?: Array<{ state: string, reason: string, replayRunId: string }>,
} = {}) {
  const queue = new DurableRunQueue({
    statePath,
    maxActive: 8,
    pollIntervalMs: 0,
    activeSessionIds: async () => [],
    canDispatch: () => true,
    launch: async (record) => {
      const id = `run_${launched.length + 1}`
      launched.push({ key: record.idempotencyKey, body: record.body })
      upstream.set(id, { status: 'running' })
      return { upstreamRunId: id, status: 'running', payload: { status: 'running', run_id: id } }
    },
    lookup: async (record) => {
      const run = upstream.get(record.upstreamRunId)!
      return { capacityStatus: run.status, payload: { status: run.status, run_id: record.upstreamRunId, output: run.output ?? null,
        ...(run.pending_steer ? { pending_steer: run.pending_steer } : {}) } }
    },
    steerDelivered: options.delivered ? async (record, text) => options.delivered!(record, text) : null,
    onPendingSteerReplay: (_record, decision) => { options.decisions?.push(decision) },
  })
  queues.push(queue)
  return queue
}

function send(sessionId: string, key: string, input: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ session_id: sessionId, input, model: 'claude-opus-5-5', provider: 'claude-subscription', require_model_lock: true, ...extra })
  return { runtime: 'direct', sessionId, idempotencyKey: key, requestHash: queueRequestHash('direct', body), body, trustedPaths: [] }
}

const VOICE = 'Please try to SSH via Tailscale.\n\n[WIZARD_FILES_V1]\n[{"id":"wf_1","filename":"voice.webm","mime":"audio/webm","trusted_path":"/media/Inbox/voice.webm","userVisible":true}]\n[/WIZARD_FILES_V1]'

async function steeredRunFinishes(opts: Parameters<typeof serviceProcess>[3] = {}, pending = VOICE) {
  const directory = await mkdtemp(join(tmpdir(), 'wizard-pending-steer-'))
  directories.push(directory)
  const statePath = join(directory, 'queue.sqlite3')
  const upstream: Upstream = new Map()
  const launched: Array<{ key: string, body: string }> = []
  const queue = serviceProcess(statePath, upstream, launched, opts)
  await queue.initialize()
  const { record } = await queue.admit(send('wizard_thread', 'wos-1', 'Check the mail server', { instructions: 'Wizard client view context: Chats' }))
  // The steer is accepted while the model writes its final answer; the run ends with it unread.
  Object.assign(upstream.get('run_1')!, { status: 'completed', output: 'Mail server is fine.', pending_steer: pending })
  await queue.tick(true)
  return { queue, upstream, launched, original: record.publicRunId, statePath }
}

describe('a steer the run never consumed', () => {
  it('becomes one same-thread turn with the same model lock, under a stable key', async () => {
    const decisions: Array<{ state: string, reason: string, replayRunId: string }> = []
    const t = await steeredRunFinishes({ delivered: () => false, decisions })
    const key = PENDING_STEER_REPLAY_PREFIX + t.original
    expect(t.launched.map((entry) => entry.key)).toEqual(['wos-1', key])
    const replay = t.queue.byIdempotencyKey('direct', key)!
    expect(replay.sessionId).toBe('wizard_thread')
    const body = JSON.parse(replay.body)
    expect(body).toMatchObject({ session_id: 'wizard_thread', model: 'claude-opus-5-5', provider: 'claude-subscription',
      require_model_lock: true, instructions: 'Wizard client view context: Chats' })
    // The owner's message itself, exactly as Hermes held it (file block included), not a paraphrase.
    expect(body.input).toBe(VOICE)
    expect(t.queue.pendingSteerReplay(t.original)).toMatchObject({ state: 'admitted', replay_run_id: replay.publicRunId })
    expect(decisions).toEqual([{ state: 'admitted', reason: '', replayRunId: replay.publicRunId }])
    // The original run keeps its own answer; the replay is answered as a normal turn.
    expect(t.queue.get(t.original)).toMatchObject({ status: 'completed', payload: expect.objectContaining({ output: 'Mail server is fine.' }) })
    t.upstream.get('run_2')!.status = 'completed'
    t.upstream.get('run_2')!.output = 'Connected to OscarLocal over Tailscale.'
    await t.queue.tick(true)
    expect(t.queue.get(replay.publicRunId)).toMatchObject({ status: 'completed', payload: expect.objectContaining({ output: 'Connected to OscarLocal over Tailscale.' }) })
  })

  it('is replayed at most once across ticks and restarts', async () => {
    const t = await steeredRunFinishes({ delivered: () => false })
    await t.queue.tick(true)
    t.queue.close()
    const again = serviceProcess(t.statePath, t.upstream, t.launched, { delivered: () => false })
    await again.initialize()
    await again.tick(true)
    expect(t.launched).toHaveLength(2)
    // Even if Hermes reports the same pending steer again, the stable key admits nothing new.
    expect(again.byIdempotencyKey('direct', PENDING_STEER_REPLAY_PREFIX + t.original)).toBeTruthy()
  })

  it('a replay that itself ends with a pending steer is replayed under its own key, never the first one', async () => {
    const t = await steeredRunFinishes({ delivered: () => false })
    const first = t.queue.byIdempotencyKey('direct', PENDING_STEER_REPLAY_PREFIX + t.original)!
    Object.assign(t.upstream.get('run_2')!, { status: 'completed', output: 'ok', pending_steer: 'and also check the disk' })
    await t.queue.tick(true)
    expect(t.launched.map((entry) => entry.key)).toEqual(['wos-1', PENDING_STEER_REPLAY_PREFIX + t.original, PENDING_STEER_REPLAY_PREFIX + first.publicRunId])
    expect(JSON.parse(t.launched[2].body).input).toBe('and also check the disk')
  })

  it('is not replayed when the owner already resent it in the thread', async () => {
    const decisions: Array<{ state: string, reason: string, replayRunId: string }> = []
    const t = await steeredRunFinishes({ delivered: () => true, decisions })
    expect(t.launched).toHaveLength(1)
    expect(t.queue.pendingSteerReplay(t.original)).toMatchObject({ state: 'skipped', reason: 'already_in_thread' })
  })

  it('is not replayed when a newer queued turn in the thread already carries the text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-pending-steer-'))
    directories.push(directory)
    const upstream: Upstream = new Map()
    const launched: Array<{ key: string, body: string }> = []
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const queue = serviceProcess(join(directory, 'q.sqlite3'), upstream, launched, { delivered: () => false })
    await queue.initialize()
    const { record } = await queue.admit(send('wizard_thread', 'wos-1', 'first'))
    now += 1 // Make "newer" deterministic even when both admissions take under one millisecond.
    await queue.admit(send('wizard_thread', 'wos-2', 'Please try to SSH via Tailscale.'))
    Object.assign(upstream.get('run_1')!, { status: 'completed', output: 'done', pending_steer: VOICE })
    await queue.tick(true)
    expect(queue.pendingSteerReplay(record.publicRunId)).toMatchObject({ state: 'skipped', reason: 'already_resent' })
    expect(launched.map((entry) => entry.key)).toEqual(['wos-1', 'wos-2'])
  })

  it('waits while the thread history cannot be read, then replays', async () => {
    let readable = false
    const t = await steeredRunFinishes({ delivered: () => { if (!readable) throw new Error('503'); return false } })
    expect(t.launched).toHaveLength(1)
    expect(t.queue.pendingSteerReplay(t.original)).toMatchObject({ state: 'pending' })
    readable = true
    await t.queue.tick(true)
    expect(t.launched.map((entry) => entry.key)).toEqual(['wos-1', PENDING_STEER_REPLAY_PREFIX + t.original])
  })

  it('never replays a steer on a run the owner stopped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-pending-steer-'))
    directories.push(directory)
    const upstream: Upstream = new Map()
    const launched: Array<{ key: string, body: string }> = []
    const queue = serviceProcess(join(directory, 'q.sqlite3'), upstream, launched, { delivered: () => false })
    await queue.initialize()
    const { record } = await queue.admit(send('wizard_stop', 'k-stop', 'long task'))
    queue.markOwnerStop('run_1')
    Object.assign(upstream.get('run_1')!, { status: 'cancelled', pending_steer: 'never mind' })
    await queue.tick(true)
    expect(launched).toHaveLength(1)
    expect(queue.pendingSteerReplay(record.publicRunId)).toMatchObject({ state: 'skipped', reason: 'owner_stopped' })
  })

  it('a short steer is not mistaken for a newer turn that merely contains it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-pending-steer-'))
    directories.push(directory)
    const upstream: Upstream = new Map()
    const launched: Array<{ key: string, body: string }> = []
    const queue = serviceProcess(join(directory, 'q.sqlite3'), upstream, launched, { delivered: () => false })
    await queue.initialize()
    const { record } = await queue.admit(send('wizard_thread', 'wos-1', 'first'))
    await queue.admit(send('wizard_thread', 'wos-2', "yesterday's report"))
    Object.assign(upstream.get('run_1')!, { status: 'completed', output: 'done', pending_steer: 'yes' })
    await queue.tick(true)
    expect(queue.pendingSteerReplay(record!.publicRunId)).toMatchObject({ state: 'admitted' })
  })

  it('captures a pending steer on a run that is already terminal when admission answers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-pending-steer-'))
    directories.push(directory)
    const launched: string[] = []
    const queue = new DurableRunQueue({
      statePath: join(directory, 'q.sqlite3'), maxActive: 8, pollIntervalMs: 0,
      activeSessionIds: async () => [], canDispatch: () => true, steerDelivered: async () => false,
      // A lost admission receipt retried with the same key: Hermes answers with the finished run.
      launch: async (record) => {
        launched.push(record.idempotencyKey)
        return launched.length === 1
          ? { upstreamRunId: 'run_1', status: 'completed', payload: { status: 'completed', run_id: 'run_1', output: 'done', pending_steer: 'and the disk' } }
          : { upstreamRunId: 'run_2', status: 'running', payload: { status: 'running', run_id: 'run_2' } }
      },
      lookup: async (record) => ({ capacityStatus: 'running', payload: { status: 'running', run_id: record.upstreamRunId } }),
    })
    queues.push(queue)
    await queue.initialize()
    const { record } = await queue.admit(send('wizard_thread', 'wos-1', 'first'))
    await queue.tick(true)
    expect(launched).toEqual(['wos-1', PENDING_STEER_REPLAY_PREFIX + record!.publicRunId])
  })

  it('does nothing for a run that ends without a pending steer', async () => {
    const t = await steeredRunFinishes({ delivered: () => false }, '')
    expect(t.launched).toHaveLength(1)
    expect(t.queue.pendingSteerReplay(t.original)).toBeNull()
  })

  it('leaves runs that finished before this existed alone (no replay on upgrade)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-pending-steer-'))
    directories.push(directory)
    const statePath = join(directory, 'q.sqlite3')
    const upstream: Upstream = new Map()
    const launched: Array<{ key: string, body: string }> = []
    const queue = serviceProcess(statePath, upstream, launched)
    await queue.initialize()
    const { record } = await queue.admit(send('wizard_old', 'k-old', 'old'))
    Object.assign(upstream.get('run_1')!, { status: 'completed', output: 'done' })
    await queue.tick(true)
    // A terminal row is never re-read, so a later pending_steer (or one stored by an older build) stays put.
    upstream.get('run_1')!.pending_steer = 'old steer'
    await queue.tick(true)
    expect(launched).toHaveLength(1)
    expect(queue.pendingSteerReplay(record.publicRunId)).toBeNull()
  })
})

describe('readSteerResentHttp', () => {
  const rows = (...messages: Array<{ role: string, content: unknown, timestamp: number }>) => async () => ({ data: messages.slice().reverse() })

  it('finds a resent user turn after the run started, ignoring the file block', async () => {
    const request = rows(
      { role: 'user', content: 'Check the mail server', timestamp: 100 },
      { role: 'assistant', content: 'Mail server is fine.', timestamp: 110 },
      { role: 'user', content: 'Please try to SSH via Tailscale.\n\n[WIZARD_FILES_V1]\n[]\n[/WIZARD_FILES_V1]', timestamp: 120 },
    )
    expect(await readSteerResentHttp(request, 'wizard_thread', 99, VOICE, 'Check the mail server')).toBe(true)
  })

  it('never matches a turn that only contains the steer\'s words', async () => {
    const request = rows({ role: 'user', content: "yesterday's report", timestamp: 120 })
    expect(await readSteerResentHttp(request, 'wizard_thread', 99, 'yes', 'first')).toBe(false)
  })

  it('does not count the steered run\'s own request, older turns or tool rows', async () => {
    const request = rows(
      { role: 'user', content: 'Please try to SSH via Tailscale.', timestamp: 50 },
      { role: 'user', content: 'Check the mail server', timestamp: 100 },
      { role: 'tool', content: 'Please try to SSH via Tailscale.', timestamp: 105 },
      { role: 'assistant', content: 'Mail server is fine.', timestamp: 110 },
    )
    expect(await readSteerResentHttp(request, 'wizard_thread', 99, VOICE, 'Check the mail server')).toBe(false)
  })
})
