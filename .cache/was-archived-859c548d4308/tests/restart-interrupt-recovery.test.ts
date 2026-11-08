import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableRunQueue, INTERRUPT_RECOVERY_PREFIX, INTERRUPTED_SAFE_ERROR, queueRequestHash } from '../server/run-queue.mjs'
import { readInterruptedRunOutcomeHttp } from '../server/hermes-http-readers.mjs'

// 19 Oct 2026: every Agent Service restart dropped the SSE streams of live runs; Hermes interrupted them,
// the queue copied `cancelled` with empty output, and four threads ended as a blank "Worked for Ns"
// receipt with no reply and no Retry. A restart mid-run must end in the resumed answer or a visible Retry.

const directories: string[] = []
const queues: DurableRunQueue[] = []

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

type Upstream = Map<string, { status: string, output?: string | null }>

// One "process" of the Agent Service: a queue over the shared state file and the shared Hermes runs.
function serviceProcess(statePath: string, upstream: Upstream, launched: string[], options: {
  outcome?: (record: { sessionId: string }) => string | null | Promise<string | null>,
  decisions?: Array<{ state: string, reason: string, recoveryRunId: string }>,
} = {}) {
  const queue = new DurableRunQueue({
    statePath,
    maxActive: 8,
    pollIntervalMs: 0,
    activeSessionIds: async () => [],
    canDispatch: () => true,
    launch: async (record) => {
      const id = `run_${launched.length + 1}`
      launched.push(record.idempotencyKey)
      upstream.set(id, { status: 'running' })
      return { upstreamRunId: id, status: 'running', payload: { status: 'running', run_id: id } }
    },
    lookup: async (record) => {
      const run = upstream.get(record.upstreamRunId)!
      return { capacityStatus: run.status, payload: { status: run.status, run_id: record.upstreamRunId, output: run.output ?? null } }
    },
    interruptOutcome: options.outcome ? async (record) => options.outcome!(record) : null,
    onInterruptRecovery: (_record, decision) => { options.decisions?.push(decision) },
  })
  queues.push(queue)
  return queue
}

function send(sessionId: string, key: string, input: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ session_id: sessionId, input, model: 'claude-opus-5-5', provider: 'anthropic', require_model_lock: true, ...extra })
  return { runtime: 'direct', sessionId, idempotencyKey: key, requestHash: queueRequestHash('direct', body), body, trustedPaths: [] }
}

async function liveRunThenRestart(opts: Parameters<typeof serviceProcess>[3] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wizard-restart-interrupt-'))
  directories.push(directory)
  const statePath = join(directory, 'queue.sqlite3')
  const upstream: Upstream = new Map()
  const launched: string[] = []
  const before = serviceProcess(statePath, upstream, launched)
  await before.initialize()
  const { record } = await before.admit(send('wizard_wisdom', 'wos-native-rec-1', 'On Wisdom, I am unable to select this large Chinese character'))
  expect(before.get(record.publicRunId)?.status).toBe('running')
  // systemctl --user restart wizard-mobile: the process dies, Hermes interrupts the run.
  before.close()
  upstream.get('run_1')!.status = 'cancelled'
  const after = serviceProcess(statePath, upstream, launched, opts)
  await after.initialize()
  await after.tick(true)
  return { after, upstream, launched, original: record.publicRunId, statePath }
}

describe('restart during a live run', () => {
  it('resumes once when the transcript ends with a persisted interruption diagnostic', async () => {
    const t = await liveRunThenRestart({ outcome: () => readInterruptedRunOutcomeHttp(async () => ({ data: [
      { role: 'assistant', content: 'Operation interrupted: waiting for model response (70.2s elapsed).', timestamp: Date.now() / 1000 + 1 },
    ] }), 'wizard_wisdom', 0) })
    expect(t.after.get(t.original)?.status).toBe('interrupted')
    expect(t.after.interruptRecovery(t.original)?.state).toBe('admitted')
    expect(t.launched).toEqual(['wos-native-rec-1', INTERRUPT_RECOVERY_PREFIX + t.original])
    await t.after.tick(true)
    expect(t.launched).toHaveLength(2)
  })

  it('marks the cut run interrupted (Needs retry) and resumes it once under a stable recovery key', async () => {
    const decisions: Array<{ state: string, reason: string, recoveryRunId: string }> = []
    const t = await liveRunThenRestart({ outcome: () => 'interrupted', decisions })
    expect(t.after.get(t.original)).toMatchObject({
      status: 'interrupted',
      payload: expect.objectContaining({ safe_error: INTERRUPTED_SAFE_ERROR, interrupted_reason: 'transport_lost' }),
    })
    const recoveryKey = INTERRUPT_RECOVERY_PREFIX + t.original
    expect(t.launched).toEqual(['wos-native-rec-1', recoveryKey])
    const recovery = t.after.byIdempotencyKey('direct', recoveryKey)!
    expect(recovery.status).toBe('running')
    const body = JSON.parse(recovery.body)
    expect(body).toMatchObject({ session_id: 'wizard_wisdom', model: 'claude-opus-5-5', provider: 'anthropic', require_model_lock: true })
    expect(body.input).toMatch(/^\[Wizard follow-through\] Wizard restarted/u)
    expect(body.input).toContain('On Wisdom, I am unable to select this large Chinese character')
    expect(decisions).toEqual([{ state: 'admitted', reason: '', recoveryRunId: recovery.publicRunId }])

    // More ticks and another restart never admit a second recovery.
    await t.after.tick(true)
    t.after.close()
    const again = serviceProcess(t.statePath, t.upstream, t.launched)
    await again.initialize()
    await again.tick(true)
    expect(t.launched).toHaveLength(2)

    // The resumed run answers: the thread ends with a reply.
    t.upstream.get('run_2')!.status = 'completed'
    t.upstream.get('run_2')!.output = 'Fixed: the drop cap is now selectable.'
    await again.tick(true)
    expect(again.get(recovery.publicRunId)).toMatchObject({ status: 'completed', payload: expect.objectContaining({ output: 'Fixed: the drop cap is now selectable.' }) })
  })

  it('leaves a visible Retry when the resumed run is cut too (no loop)', async () => {
    const t = await liveRunThenRestart({ outcome: () => 'interrupted' })
    const recovery = t.after.byIdempotencyKey('direct', INTERRUPT_RECOVERY_PREFIX + t.original)!
    t.upstream.get('run_2')!.status = 'cancelled'
    await t.after.tick(true)
    await t.after.tick(true)
    expect(t.after.get(recovery.publicRunId)).toMatchObject({ status: 'interrupted', payload: expect.objectContaining({ safe_error: INTERRUPTED_SAFE_ERROR }) })
    expect(t.after.interruptRecovery(recovery.publicRunId)).toMatchObject({ state: 'skipped', reason: 'recovery_already_interrupted' })
    expect(t.launched).toHaveLength(2)
  })

  it("never resumes a run James stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-restart-interrupt-'))
    directories.push(directory)
    const upstream: Upstream = new Map()
    const launched: string[] = []
    const queue = serviceProcess(join(directory, 'q.sqlite3'), upstream, launched, { outcome: () => 'interrupted' })
    await queue.initialize()
    const { record } = await queue.admit(send('wizard_stop', 'k-stop', 'long task'))
    queue.markOwnerStop('run_1')                       // the Stop button proxies /v1/runs/<upstream>/stop
    upstream.get('run_1')!.status = 'cancelled'
    await queue.tick(true)
    expect(queue.get(record.publicRunId)?.status).toBe('cancelled')
    expect(queue.interruptRecovery(record.publicRunId)).toBeNull()
    expect(launched).toEqual(['k-stop'])

    const second = await queue.admit(send('wizard_stop2', 'k-stop2', 'other task'))
    queue.markOwnerStop(second.record.publicRunId)     // Stop by public run id
    upstream.get('run_2')!.status = 'cancelled'
    await queue.tick(true)
    expect(queue.get(second.record.publicRunId)?.status).toBe('cancelled')
  })

  it('does not resume when James already sent something newer or the answer landed before the cut', async () => {
    const t = await liveRunThenRestart({ outcome: () => 'completed' })
    expect(t.after.get(t.original)?.status).toBe('completed')
    expect(t.launched).toHaveLength(1)

    const directory = await mkdtemp(join(tmpdir(), 'wizard-restart-interrupt-'))
    directories.push(directory)
    const upstream: Upstream = new Map()
    const launched: string[] = []
    const queue = serviceProcess(join(directory, 'q.sqlite3'), upstream, launched, { outcome: () => 'interrupted' })
    await queue.initialize()
    const first = await queue.admit(send('wizard_x', 'k1', 'first'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await queue.admit(send('wizard_x', 'k2', 'newer message')) // waits behind the live run
    upstream.get('run_1')!.status = 'cancelled'
    await queue.tick(true)
    expect(queue.get(first.record.publicRunId)?.status).toBe('interrupted')
    expect(queue.interruptRecovery(first.record.publicRunId)).toMatchObject({ state: 'skipped', reason: 'newer_request' })
    expect(launched).toEqual(['k1', 'k2'])
  })

  it('treats only a tool-free assistant text after the run start as an answer', async () => {
    // Hermes returns order=latest pages oldest-first; fixtures below are listed newest-first for reading.
    const rows = (list: object[]) => async () => ({ data: list.slice().reverse() })
    const at = 1_000
    // The real 19 Oct shape: tool calls, a cancelled tool, then an empty assistant row.
    expect(await readInterruptedRunOutcomeHttp(rows([
      { role: 'assistant', content: '', timestamp: at + 9 },
      { role: 'tool', content: '[Tool execution cancelled — terminal was skipped.', timestamp: at + 8 },
      { role: 'assistant', content: 'Checking the file.', tool_calls: [{ id: 'x' }], timestamp: at + 5 },
      { role: 'user', content: 'On Wisdom…', timestamp: at + 1 },
    ]), 'wizard_wisdom', at)).toBe('interrupted')
    expect(await readInterruptedRunOutcomeHttp(rows([
      { role: 'assistant', content: 'Done: fixed and verified.', timestamp: at + 9 },
      { role: 'user', content: 'On Wisdom…', timestamp: at + 1 },
    ]), 'wizard_wisdom', at)).toBe('completed')
  })
})

// End to end through the real Agent Service HTTP surface: two service processes share the queue
// state (= systemctl restart wizard-mobile), the Hermes run is interrupted by the dropped stream.
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'

describe('Agent Service restart during a live run (HTTP)', () => {
  const servers: ReturnType<typeof createServer>[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })))
  })

  async function harness() {
    const sessions = ['wizard_cut', 'wizard_stopped'].map((id) => ({ id, source: 'api_server', title: id, message_count: 1, hidden: false, archived: false, updated_at: new Date().toISOString() }))
    const runs = new Map<string, { sessionId: string, status: string, input: string, output?: string }>()
    const transcript = new Map<string, object[]>()
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const id = `actual_${runs.size + 1}`
        runs.set(id, { sessionId: value.session_id, status: 'running', input: value.input })
        json(202, { run_id: id, session_id: value.session_id, status: 'running' }); return
      }
      const stop = url.pathname.match(/^\/v1\/runs\/([^/]+)\/stop$/)
      if (req.method === 'POST' && stop) { runs.get(stop[1])!.status = 'cancelled'; json(200, { run_id: stop[1], status: 'cancelled' }); return }
      const detail = url.pathname.match(/^\/v1\/runs\/([^/]+)$/)
      if (req.method === 'GET' && detail) {
        const run = runs.get(detail[1])
        if (!run) { json(404, {}); return }
        json(200, { object: 'run', run_id: detail[1], session_id: run.sessionId, status: run.status, ...(run.output ? { output: run.output } : {}) }); return
      }
      const messages = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
      if (req.method === 'GET' && messages) { json(200, { object: 'list', data: transcript.get(messages[1]) ?? [] }); return }
      if (req.method === 'GET' && url.pathname === '/api/sessions') { json(200, { object: 'list', data: sessions }); return }
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') { json(200, {}); return }
      res.writeHead(404); res.end()
    })
    servers.push(upstream)
    const upstreamPort = (await listen(upstream)).port
    const directory = await mkdtemp(join(tmpdir(), 'wizard-restart-http-'))
    directories.push(directory)
    const statePath = join(directory, 'state.db')
    const state = new DatabaseSync(statePath)
    state.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
      INSERT INTO sessions VALUES ('wizard_cut', 1), ('wizard_stopped', 2);
    `)
    state.close()
    const boot = async (interruptOutcomeReader?: () => Promise<string>) => {
      const wizard = createWizardServer({
        requireJoinedDelegationCapability: false,
        upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
        hermesKey: 'fixture-key',
        requireAccess: false,
        hermesStatePath: statePath,
        canonicalSessionReader: () => sessions,
        runQueueStatePath: join(directory, 'queue.sqlite3'),
        runQueueMaxActive: 4,
        runQueuePollIntervalMs: 0,
        activeSessionReader: async () => [],
        dispatchHealthReader: () => true,
        ...(interruptOutcomeReader ? { interruptOutcomeReader } : {}),
      })
      servers.push(wizard)
      const origin = `http://127.0.0.1:${(await listen(wizard)).port}`
      return { wizard, origin }
    }
    const call = async (origin: string, path: string, init: RequestInit = {}) => {
      const response = await fetch(`${origin}${path}`, init)
      const text = await response.text()
      return text ? JSON.parse(text) : null
    }
    const admit = (origin: string, sessionId: string, key: string, input: string) => call(origin, '/wizard/hermes/v1/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ session_id: sessionId, input }),
    })
    const list = async (origin: string) => (await call(origin, '/wizard/hermes/api/sessions?limit=20&offset=0&include_children=false')).data
    const settle = async (origin: string, runId: string, done: (status: string) => boolean) => {
      let status = ''
      for (let attempt = 0; attempt < 20 && !done(status); attempt += 1) {
        status = (await call(origin, `/wizard/hermes/v1/runs/${encodeURIComponent(runId)}`)).status
        if (!done(status)) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return status
    }
    return { runs, transcript, statePath, boot, admit, list, call, settle }
  }

  it('ends with the resumed answer, and a James Stop stays stopped', async () => {
    const h = await harness()
    const first = await h.boot()
    const cut = await h.admit(first.origin, 'wizard_cut', 'wos-native-rec-cut', 'Make the drop cap selectable')
    const stopped = await h.admit(first.origin, 'wizard_stopped', 'wos-native-rec-stop', 'Long job James will stop')
    expect(cut.status).toBe('running')
    await h.call(first.origin, `/wizard/hermes/v1/runs/${encodeURIComponent(stopped.run_id)}/stop`, { method: 'POST' })

    // Restart: the old process goes away and Hermes interrupts the run whose stream dropped.
    await new Promise<void>((resolve) => { first.wizard.closeAllConnections?.(); first.wizard.close(() => resolve()) })
    h.runs.get('actual_1')!.status = 'cancelled'
    const second = await h.boot(async () => 'interrupted')
    expect(await h.settle(second.origin, cut.run_id, (s) => s === 'interrupted')).toBe('interrupted')
    expect(await h.settle(second.origin, stopped.run_id, (s) => s === 'cancelled')).toBe('cancelled')

    // Exactly one resume, through normal admission, in the same thread, carrying the original request.
    for (let attempt = 0; attempt < 20 && h.runs.size < 3; attempt += 1) {
      await h.list(second.origin)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect([...h.runs.keys()]).toEqual(['actual_1', 'actual_2', 'actual_3'])
    expect(h.runs.get('actual_3')).toMatchObject({ sessionId: 'wizard_cut', status: 'running' })
    expect(h.runs.get('actual_3')!.input).toContain('Make the drop cap selectable')
    let rows = await h.list(second.origin)
    expect(rows.find((row: { id: string }) => row.id === 'wizard_cut')).toMatchObject({ status: 'running' })
    expect(rows.find((row: { id: string }) => row.id === 'wizard_stopped')?.status).toBeUndefined()

    // The resumed run answers: the thread ends with the reply, not a blank receipt.
    h.runs.get('actual_3')!.status = 'completed'
    const db = new DatabaseSync(h.statePath)
    db.prepare("INSERT INTO messages VALUES ('wizard_cut', 'assistant', 'stop', 'Fixed: the drop cap is selectable.', 'final', ?, 1)").run(Date.now() / 1000 + 5)
    db.close()
    rows = await h.list(second.origin)
    for (let attempt = 0; attempt < 20 && rows.find((row: { id: string }) => row.id === 'wizard_cut')?.status; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      rows = await h.list(second.origin)
    }
    expect(rows.find((row: { id: string }) => row.id === 'wizard_cut')?.status).toBeUndefined()
    expect(h.runs.size).toBe(3)
  })

  it('ends with a visible Retry when the resume is cut too', async () => {
    const h = await harness()
    const first = await h.boot()
    const cut = await h.admit(first.origin, 'wizard_cut', 'wos-native-rec-cut2', 'Make the drop cap selectable')
    await new Promise<void>((resolve) => { first.wizard.closeAllConnections?.(); first.wizard.close(() => resolve()) })
    h.runs.get('actual_1')!.status = 'cancelled'
    const second = await h.boot(async () => 'interrupted')
    await h.settle(second.origin, cut.run_id, (s) => s === 'interrupted')
    for (let attempt = 0; attempt < 20 && h.runs.size < 2; attempt += 1) { await h.list(second.origin); await new Promise((resolve) => setTimeout(resolve, 25)) }
    expect(h.runs.size).toBe(2)
    // Second restart while the resumed run is live.
    await new Promise<void>((resolve) => { second.wizard.closeAllConnections?.(); second.wizard.close(() => resolve()) })
    h.runs.get('actual_2')!.status = 'cancelled'
    const third = await h.boot(async () => 'interrupted')
    let row: { status?: string, wizard_safe_error?: string } | undefined
    for (let attempt = 0; attempt < 20 && row?.status !== 'interrupted'; attempt += 1) {
      row = (await h.list(third.origin)).find((item: { id: string }) => item.id === 'wizard_cut')
      if (row?.status !== 'interrupted') await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(row).toMatchObject({ status: 'interrupted', wizard_safe_error: INTERRUPTED_SAFE_ERROR })
    expect(h.runs.size).toBe(2)
  })

  it('uses the real Hermes transcript: resumes a cut turn, leaves an answered one alone', async () => {
    const h = await harness()
    const first = await h.boot()
    const now = Date.now() / 1000
    const cut = await h.admit(first.origin, 'wizard_cut', 'k-cut', 'Make the drop cap selectable')
    const answered = await h.admit(first.origin, 'wizard_stopped', 'k-answered', 'Quick question')
    // Oldest-first page, as Hermes returns order=latest: tool call, cancelled tool, empty assistant.
    h.transcript.set('wizard_cut', [
      { role: 'user', content: 'Make the drop cap selectable', timestamp: now + 1 },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }], timestamp: now + 2 },
      { role: 'tool', content: '[Tool execution cancelled — terminal was skipped.', timestamp: now + 3 },
      { role: 'assistant', content: '', timestamp: now + 4 },
    ])
    h.transcript.set('wizard_stopped', [
      { role: 'user', content: 'Quick question', timestamp: now + 1 },
      { role: 'assistant', content: 'Here is the answer.', timestamp: now + 2 },
    ])
    await new Promise<void>((resolve) => { first.wizard.closeAllConnections?.(); first.wizard.close(() => resolve()) })
    h.runs.get('actual_1')!.status = 'cancelled'
    h.runs.get('actual_2')!.status = 'cancelled'
    const second = await h.boot()   // default reader, no injection
    await h.settle(second.origin, cut.run_id, (s) => s === 'interrupted')
    expect(await h.settle(second.origin, answered.run_id, (s) => s === 'completed')).toBe('completed')
    for (let attempt = 0; attempt < 20 && h.runs.size < 3; attempt += 1) { await h.list(second.origin); await new Promise((resolve) => setTimeout(resolve, 25)) }
    expect(h.runs.size).toBe(3)
    expect(h.runs.get('actual_3')).toMatchObject({ sessionId: 'wizard_cut' })
  })
})
