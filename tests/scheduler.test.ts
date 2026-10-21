import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler, importHermesSchedules, isSilentResult, SCHEDULE_INPUT, scheduledRunEvents } from '../server/scheduler.mjs'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { createWizardServer, listen, latestVisibleSessionMessages, projectWizardMessageHistory } from '../server/service.mjs'
import { projectStatusMarkers } from '../server/thread-status.mjs'
import { readHermesSessionTruth, visibleAssistantReply, visibleUserRequest } from '../server/session-truth.mjs'

let root: string
let clock: number
const schedulers: any[] = []
const queues: any[] = []
const servers: any[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wizard-scheduler-case-'))
  for (const key of ['HOME', 'HERMES_HOME', 'WIZARD_OS_HOME', 'TMPDIR']) {
    const path = join(root, key.toLowerCase()); mkdirSync(path); vi.stubEnv(key, path)
  }
  vi.stubEnv('WIZARD_SCHEDULER', '0')
  clock = Date.parse('2026-10-21T00:00:00Z')
})
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await server.drained
  }
  for (const scheduler of schedulers.splice(0)) await scheduler.close()
  for (const queue of queues.splice(0)) queue.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
const job = (extra: any = {}) => ({ name: 'Project · Feature', when: { every: 5 }, prompt: 'Report material changes.', ...extra })
function scheduler(deliver: any = async () => ({ run_id: 'fixture' }), extra: any = {}) {
  const instance = new Scheduler({ statePath: join(root, 'scheduler.sqlite3'), hermesHome: process.env.HERMES_HOME, now: () => clock, deliver, ...extra })
  schedulers.push(instance); return instance
}
function queue() {
  const instance = new DurableRunQueue({ statePath: join(root, 'queue.sqlite3'), maxActive: 1, pollIntervalMs: 0,
    activeSessionIds: async () => [], canDispatch: () => true,
    launch: async () => ({ status: 'completed', upstreamRunId: 'canonical_fixture' }), lookup: async () => ({ status: 'completed' }) })
  queues.push(instance); return instance
}
async function api(origin: string, path = '', method = 'GET', body?: any, auth = true) {
  return fetch(`${origin}/wizard/v1/schedules${path}`, { method,
    headers: { ...(auth ? { 'X-Wizard-Owner-Proof': 'fixture-owner-proof-with-32-characters' } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

describe('durable Wizard scheduler', () => {
  it('survives an ambiguous admission crash/restart without a second canonical run, even after queue retention', async () => {
    let q = queue(); await q.initialize()
    let count = 0
    const admit = async (occurrence: any) => {
      const body = JSON.stringify(occurrence.body)
      const result = await q.admit({ runtime: 'direct', sessionId: occurrence.thread, idempotencyKey: occurrence.key, requestHash: queueRequestHash('direct', body), body })
      if (!result.replayed) count++
      return { run_id: result.record!.publicRunId }
    }
    let s = scheduler(async (o: any) => { await admit(o); throw new Error('crash after admission before ack') })
    const created = s.create(job())
    clock += 5 * 60_000
    await s.tick()
    const thread = s.get(created.id).thread
    expect(count).toBe(1)
    await s.close(); schedulers.splice(schedulers.indexOf(s), 1)
    // Make more than the ordinary 128-row retention floor, then age every row.
    for (let n = 0; n < 140; n++) {
      const body = JSON.stringify({ session_id: `ordinary_${n}`, input: 'fixture' })
      await q.admit({ runtime: 'direct', sessionId: `ordinary_${n}`, idempotencyKey: `ordinary-${n}`, requestHash: queueRequestHash('direct', body), body })
    }
    q.database.prepare('UPDATE wizard_run_queue SET terminal_at=1, status=\'completed\'').run()
    q._pruneTerminal(true)
    expect(q.database.prepare("SELECT COUNT(*) AS n FROM wizard_run_queue WHERE idempotency_key LIKE 'schedule:%'").get()!.n).toBe(1)
    q.close(); queues.splice(queues.indexOf(q), 1)
    q = queue(); await q.initialize()
    s = scheduler(admit)
    clock += 3 * 24 * 60 * 60_000
    await s.tick(); await s.tick()
    expect(count).toBe(1)
    expect(s.get(created.id).thread).toBe(thread)
    expect(s.db.prepare('SELECT admitted FROM schedule_occurrences').get()!.admitted).toBe(1)
  })

  it('coalesces concurrent ticks, clock rollback and duplicate ticks with a stable key', async () => {
    const keys: string[] = []
    const s = scheduler(async (o: any) => { keys.push(o.key); await Promise.resolve() })
    const created = s.create(job())
    clock += 5 * 60_000
    await Promise.all([s.tick(), s.tick(), s.tick()]); await s.tick()
    expect(keys).toEqual([`schedule:${created.id}:2026-10-21T00:05:00.000Z`])
    clock -= 10 * 60_000; await s.tick()
    clock += 10 * 60_000; await s.tick()
    expect(keys).toHaveLength(1)
  })

  it('admits only the latest missed occurrence after downtime, not every window', async () => {
    const calls: any[] = []
    let s = scheduler(async (o: any) => calls.push(o))
    const created = s.create(job())
    await s.close(); schedulers.splice(schedulers.indexOf(s), 1)
    clock += 31 * 60_000
    s = scheduler(async (o: any) => calls.push(o))
    await s.tick(); await s.tick()
    expect(calls.map(o => o.scheduledAt)).toEqual(['2026-10-21T00:30:00.000Z'])
    expect(s.get(created.id).nextAt).toBe(Date.parse('2026-10-21T00:35:00Z'))
    clock += 4 * 60_000; await s.tick()
    expect(calls).toHaveLength(2)
    expect(calls[1].thread).toBe(calls[0].thread)
  })

  it('fires a once job once across restarts, manual resume and backward time', async () => {
    const calls: any[] = []
    let s = scheduler(async (o: any) => calls.push(o))
    const created = s.create(job({ when: { once: '2026-10-21T00:01:00Z' } }))
    clock += 60_000; await s.tick(); await s.tick()
    expect(s.get(created.id).enabled).toBe(false)
    await s.close(); schedulers.splice(schedulers.indexOf(s), 1)
    s = scheduler(async (o: any) => calls.push(o))
    s.update(created.id, { enabled: true })
    clock -= 30_000; await s.tick()
    clock += 120_000; await s.tick()
    expect(calls).toHaveLength(1)
  })

  it('honors the owner timezone, cron catch-up and DST with absolute occurrence keys', async () => {
    const calls: any[] = []
    const s = scheduler(async (o: any) => calls.push(o))
    s.create(job({ when: { cron: '0 9 * * *' } }))
    clock = Date.parse('2026-10-25T02:10:00Z'); await s.tick()
    expect(calls[0].scheduledAt).toBe('2026-10-25T02:00:00.000Z')
    const dst = s.create(job({ when: { cron: '30 1 * * *' }, timezone: 'America/New_York' }))
    clock = Date.parse('2026-11-01T07:00:00Z'); await s.tick()
    expect(s.get(dst.id).nextAt).toBeGreaterThan(clock)
    const count = calls.length
    clock -= 60 * 60_000; await s.tick()
    expect(calls).toHaveLength(count)
  })

  it('drains new manual receipts and a scheduled tick arriving during an in-flight manual admission', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: any[] = []
    const s = scheduler(async (o: any) => { calls.push(o); if (calls.length === 1) await gate })
    const created = s.create(job())
    s.runNow(created.id)
    clock += 1000
    s.runNow(created.id)
    clock += 5 * 60_000
    const drain = s.tick()
    release(); await drain
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map(o => o.key)).size).toBe(2)
    expect(s.get(created.id).nextAt).toBe(Date.parse('2026-10-21T00:10:00Z'))
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM schedule_occurrences WHERE admitted=0').get()!.n).toBe(0)
  })

  it('supports pause, edits, explicit-thread manual runs and validation', async () => {
    const calls: any[] = []
    const s = scheduler(async (o: any) => calls.push(o))
    const created = s.create(job({ enabled: false, thread: 'existing_thread', model: 'fixture/model', skill: 'fixture-skill' }))
    clock += 60 * 60_000; await s.tick(); expect(calls).toHaveLength(0)
    s.runNow(created.id); await s.tick(false)
    expect(calls[0]).toMatchObject({ thread: 'existing_thread', createThread: false, body: { model: 'fixture/model' } })
    expect(calls[0].body.input).toContain('fixture-skill')
    expect(s.get(created.id).enabled).toBe(false)
    s.update(created.id, { enabled: true, when: { every: 10 } })
    clock += 10 * 60_000; await s.tick(); expect(calls).toHaveLength(2)
    expect(() => s.create(job({ when: { every: 0 } }))).toThrow()
    expect(() => s.create(job({ when: { cron: 'invalid' } }))).toThrow()
    expect(() => s.create(job({ timezone: 'not/a-zone' }))).toThrow()
    expect(() => s.create(job({ when: { once: '2026-10-21T01:00:00' } }))).toThrow()
    expect(() => s.update(created.id, { agent: 'other' })).toThrow()
    s.delete(created.id); expect(s.list()).toEqual([])
  })
})

describe('schedule last/next run projections', () => {
  it.each([
    [{ cron: '0 9 * * *' }, '2026-10-21T02:00:00.000Z'],
    [{ every: 5 }, '2026-10-21T00:05:00.000Z'],
    [{ once: '2026-10-22T00:00:00Z' }, '2026-10-22T00:00:00.000Z'],
  ])('projects the durable next cursor for %j; paused schedules have no next run', (when, expected) => {
    const s = scheduler(), created = s.create(job({ when }))
    expect(s.project(created)).toMatchObject({ lastRun: null, nextRun: expected })
    expect(s.project(s.update(created.id, { enabled: false })).nextRun).toBeNull()
    expect(s.project(s.update(created.id, { enabled: true })).nextRun).toBe(expected)
  })

  it.each([
    ['completed', 'Report', 'posted', null],
    ['completed', 'Nothing changed [SILENT]', 'silent', null],
    ['completed', '', 'silent', null],
    ['failed', '', 'failed', 'Run failed'],
    ['cancelled', '', 'failed', 'Run cancelled'],
    ['interrupted', '', 'failed', 'Run interrupted'],
    ['running', '', 'running', null],
    ['queued', '', 'running', null],
  ])('persists %s/%s as %s across restart without storing raw error/output', async (status, output, outcome, error) => {
    let s = scheduler(undefined, { lookup: async () => ({ status, output, error: 'credential-fixture-do-not-persist', started_at: '2026-10-21T00:05:01Z', finished_at: '2026-10-21T00:05:09Z' }) })
    const created = s.create(job())
    clock += 5 * 60_000; await s.tick()
    const result = s.project(s.get(created.id))
    expect(result).toMatchObject({ nextRun: '2026-10-21T00:10:00.000Z', lastRun: {
      scheduledFor: '2026-10-21T00:05:00.000Z', startedAt: '2026-10-21T00:05:01.000Z', outcome, error,
      finishedAt: outcome === 'running' ? null : '2026-10-21T00:05:09.000Z',
    } })
    expect(JSON.stringify(s.db.prepare('SELECT * FROM schedule_occurrences').all())).not.toContain('credential-fixture')
    await s.close(); schedulers.splice(schedulers.indexOf(s), 1)
    s = scheduler(); expect(s.project(s.get(created.id))).toEqual(result)
  })

  it('does not infer success from admission, edits, lookup outages or unrelated thread activity', async () => {
    let state: any = { status: 'queued' }
    const s = scheduler(undefined, { lookup: async () => { if (!state) throw Error('credential-fixture'); return state } })
    const j = s.create(job({ when: { once: '2026-10-21T00:01:00Z' } }))
    clock += 60_000; await s.tick()
    expect(s.project(s.get(j.id))).toMatchObject({ nextRun: null, lastRun: { outcome: 'running', startedAt: null, finishedAt: null } })
    state = { status: 'running' }; clock += 1000; await s.refreshRuns()
    expect(s.project(s.get(j.id)).lastRun.startedAt).toBe('2026-10-21T00:01:01.000Z')
    state = null; await s.refreshRuns()
    expect(s.project(s.update(j.id, { name: 'Edited', enabled: true }))).toMatchObject({ nextRun: null, lastRun: { outcome: 'running', finishedAt: null } })
    state = { status: 'completed', output: 'Update' }; clock += 1000; await s.refreshRuns()
    expect(s.project(s.get(j.id)).lastRun).toMatchObject({ outcome: 'posted', finishedAt: '2026-10-21T00:01:02.000Z' })
    state = { status: 'failed' }; await s.refreshRuns()
    expect(s.project(s.get(j.id)).lastRun.outcome).toBe('posted')
  })

  it('migrates a legacy occurrence ledger additively and enriches its exact receipt', async () => {
    let s = scheduler(); const j = s.create(job()); clock += 5 * 60_000; await s.tick()
    await s.close(); schedulers.splice(schedulers.indexOf(s), 1)
    const db = new DatabaseSync(join(root, 'scheduler.sqlite3'))
    for (const column of ['started_at', 'finished_at', 'outcome']) db.exec(`ALTER TABLE schedule_occurrences DROP COLUMN ${column}`)
    const before = db.prepare('SELECT key, data, receipt FROM schedule_occurrences').all(); db.close()
    s = scheduler(undefined, { lookup: async (occurrence: any, receipt: any) => {
      expect(occurrence.jobId).toBe(j.id); expect(receipt.run_id).toBe('fixture')
      return { status: 'completed', output: 'Recovered report' }
    } })
    expect(s.db.prepare('SELECT key, data, receipt FROM schedule_occurrences').all()).toEqual(before)
    expect(s.project(s.get(j.id)).lastRun.outcome).toBe('running')
    await s.refreshRuns(); expect(s.project(s.get(j.id)).lastRun.outcome).toBe('posted')
  })

  it('drains an in-flight outcome lookup before closing the durable store', async () => {
    let release!: () => void, entered!: () => void
    const began = new Promise<void>(r => { entered = r }), gate = new Promise<void>(r => { release = r })
    const s = scheduler(); const j = s.create(job()); clock += 5 * 60_000; await s.tick()
    s.lookup = async () => { entered(); await gate; return { status: 'completed', output: 'Report' } }
    const refresh = s.refreshRuns(); await began
    let closed = false; const closing = s.close().then(() => { closed = true })
    await new Promise(r => setImmediate(r)); expect(closed).toBe(false)
    release(); await Promise.all([refresh, closing]); expect(closed).toBe(true)
    schedulers.splice(schedulers.indexOf(s), 1)
    const reopened = scheduler(); expect(reopened.project(reopened.get(j.id)).lastRun.outcome).toBe('posted')
  })

  it('reports safe admission failures then clears them on exact-key retry, and chooses latest manual occurrence', async () => {
    let reject = true
    const s = scheduler(async () => { if (reject) throw Error('credential-fixture'); return { run_id: 'fixture' } })
    const j = s.create(job()); clock += 5 * 60_000; await s.tick()
    expect(s.project(s.get(j.id)).lastRun).toMatchObject({ outcome: 'failed', error: 'Admission failed; will retry', finishedAt: null })
    reject = false; await s.tick()
    expect(s.project(s.get(j.id)).lastRun).toMatchObject({ outcome: 'running', error: null })
    clock += 1000; s.runNow(j.id); await s.tick(false)
    expect(s.project(s.get(j.id)).lastRun.scheduledFor).toBe('2026-10-21T00:05:01.000Z')
    expect(s.project(s.get(j.id)).nextRun).toBe('2026-10-21T00:10:00.000Z')
  })
})

describe('paused read-only Hermes import', () => {
  it('imports native cron/interval/once/skill/model fields paused; dry-run and retries do not mutate or duplicate anything', () => {
    const path = join(process.env.HERMES_HOME!, 'cron', 'jobs.json'); mkdirSync(join(process.env.HERMES_HOME!, 'cron'))
    const raw = JSON.stringify({ jobs: [
      { id: 'cron', name: 'Daily', schedule: { kind: 'cron', expr: '0 9 * * *' }, prompt: 'brief', model: 'fixture-model' },
      { id: 'interval', name: 'Every', schedule: { kind: 'interval', minutes: 30 }, skill: 'one', skills: ['one', 'two'] },
      { id: 'once', name: 'Once', schedule: { kind: 'once', run_at: '2026-10-22T01:00:00+07:00' }, prompt: 'do it' },
      { id: 'script', script: 'anything.sh', schedule: { kind: 'interval', minutes: 1 }, prompt: 'not converted' },
      { id: 'noagent', no_agent: true },
    ] }, null, 2)
    writeFileSync(path, raw, { mode: 0o400 })
    const s = scheduler()
    expect(importHermesSchedules(s, { dryRun: true }).results.map((r: any) => r.status)).toEqual(['would import (paused)', 'would import (paused)', 'would import (paused)', 'not imported: script job', 'not imported: script job'])
    expect(s.list()).toEqual([])
    const result = importHermesSchedules(s, { dryRun: false })
    expect(result.results.filter((r: any) => r.status === 'imported (paused)')).toHaveLength(3)
    expect(s.list().every((j: any) => !j.enabled)).toBe(true)
    expect(s.list().find((j: any) => j.name === 'Daily').model).toBe('fixture-model')
    expect(s.list().find((j: any) => j.name === 'Every')).toMatchObject({ skill: 'one', prompt: 'Also load and follow the skill "two".' })
    expect(importHermesSchedules(s, { dryRun: false }).results[0].status).toBe('already imported')
    expect(s.list()).toHaveLength(3)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })
})

describe('[SILENT] projection, preview and unread truth', () => {
  it.each(['[SILENT]', '[SILENT] no changes', 'nothing to report [SILENT]', '[SILENT]\n[WIZARD_STATUS_V1]{"state":"done"}[/WIZARD_STATUS_V1]'])('hides %s without advancing the last visible reply/unread clock', silent => {
    const rows = [
      { role: 'user', content: 'original question', timestamp: 1, finish_reason: 'stop' },
      { role: 'assistant', content: 'original answer', timestamp: 2, finish_reason: 'stop', display_kind: 'final' },
      { role: 'user', content: `${SCHEDULE_INPUT}\nbackground prompt`, timestamp: 3, finish_reason: 'stop' },
      { role: 'assistant', content: silent, timestamp: 4, finish_reason: 'stop', display_kind: 'final' },
    ]
    expect(isSilentResult(silent)).toBe(true)
    expect(visibleAssistantReply(silent, 'final', 'stop')).toBe(false)
    expect(visibleUserRequest(rows[2].content, '')).toBe(false)
    const projected = JSON.parse(projectWizardMessageHistory(projectStatusMarkers(Buffer.from(JSON.stringify({ messages: rows }))), Buffer.from(JSON.stringify({ messages: rows }))).toString())
    expect(projected.messages.filter((m: any) => m.role !== 'system').map((m: any) => m.content)).toEqual(['original question', 'original answer'])
    expect(latestVisibleSessionMessages({ messages: rows }).latestAssistantAt).toBe(2)
    const path = join(root, 'truth.sqlite3'), db = new DatabaseSync(path)
    db.exec('CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL); CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL); CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, timestamp REAL, finish_reason TEXT, display_kind TEXT, active INTEGER DEFAULT 1); INSERT INTO sessions VALUES(\'existing_thread\',0)')
    for (const row of rows) db.prepare('INSERT INTO messages(session_id,role,content,timestamp,finish_reason,display_kind) VALUES(?,?,?,?,?,?)').run('existing_thread', row.role, row.content, row.timestamp, row.finish_reason, row.display_kind ?? '')
    db.close()
    const truth = readHermesSessionTruth(path, ['existing_thread']).get('existing_thread')
    expect(truth).toMatchObject({ lastAssistantAt: 2, lastUserAt: 1, activityAt: 2 })
    expect(truth.lastAssistantAt > 2).toBe(false) // a thread seen at 2 remains read
    expect(isSilentResult('quoted [SILENT] in the middle')).toBe(false)
  })
})

describe('scheduled event projection', () => {
  it.each(['[SILENT]', 'nothing changed [SILENT]', '[SILENT] no update'])('does not leak fragmented %s through SSE', async output => {
    const stream = scheduledRunEvents(), chunks: string[] = []
    stream.on('data', chunk => chunks.push(chunk.toString()))
    const wire = `event: message.delta\r\ndata: ${JSON.stringify({ delta: output.slice(0, 4) })}\r\n\r\nevent: message.delta\ndata: ${JSON.stringify({ delta: output.slice(4) })}\n\nevent: run.completed\ndata: ${JSON.stringify({ status: 'completed', output })}\n\n`
    const bytes = Buffer.from(wire)
    await pipeline(Readable.from([...bytes].map(byte => Buffer.from([byte]))), stream)
    expect(chunks.join('')).not.toContain('message.delta')
    expect(chunks.join('')).not.toContain('[SILENT]')
    expect(chunks.join('')).toContain('run.completed')
  })
  it('releases a normal unicode report only at completion and drops unterminated text', async () => {
    const stream = scheduledRunEvents(), chunks: string[] = []
    stream.on('data', chunk => chunks.push(chunk.toString()))
    stream.write('event: message.delta\ndata: {"delta":"Report · update"}\n\n')
    expect(chunks).toEqual([])
    stream.end('event: run.completed\ndata: {"status":"completed"}\n\n')
    await new Promise(resolve => stream.on('end', resolve))
    expect(chunks.join('')).toContain('Report · update')
    const interrupted = scheduledRunEvents(), lost: string[] = []
    interrupted.on('data', chunk => lost.push(chunk.toString()))
    await pipeline(Readable.from(['event: message.delta\ndata: {"delta":"partial [SIL"}\n\n']), interrupted)
    expect(lost).toEqual([])
  })
})

describe('authenticated schedule routes and ordinary thread delivery', () => {
  async function fixture(extra: any = {}) {
    const admitted = new Map<string, any>(), sessions = new Map<string, any>(), bodies: any[] = [], keys: string[] = []
    const upstream = createServer(async (req, res) => {
      const path = new URL(req.url!, 'http://fixture.invalid').pathname
      const chunks = []; for await (const c of req) chunks.push(c)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      const send = (status: number, value: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (path === '/api/sessions' && req.method === 'POST') {
        if (sessions.has(body.id)) { send(409, { error: 'exists' }); return }
        sessions.set(body.id, body); send(201, body); return
      }
      if (path === '/v1/runs' && req.method === 'POST') {
        const key = String(req.headers['idempotency-key'])
        if (!admitted.has(key)) { bodies.push(body); keys.push(key); admitted.set(key, { run_id: `fixture_${admitted.size}`, session_id: body.session_id, status: extra.fixtureStatus ?? 'completed', output: extra.fixtureOutput ?? 'fixture report', error: 'credential-fixture-do-not-expose' }) }
        send(202, admitted.get(key)); return
      }
      if (path.startsWith('/v1/runs/') && path.endsWith('/events')) {
        const record = [...admitted.values()].find(r => path === `/v1/runs/${r.run_id}/events`)
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`event: message.delta\ndata: ${JSON.stringify({ delta: record.output.slice(0, 4) })}\n\n`)
        res.end(`event: message.delta\ndata: ${JSON.stringify({ delta: record.output.slice(4) })}\n\nevent: run.completed\ndata: ${JSON.stringify(record)}\n\n`)
        return
      }
      if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) {
        const sessionId = path.split('/')[3]
        send(200, { messages: [...admitted.values()].filter(r => r.session_id === sessionId).map((r, i) => ({ id: i, role: 'assistant', content: r.output, timestamp: i + 1, display_kind: 'final', finish_reason: 'stop' })) }); return
      }
      if (path.startsWith('/v1/runs/')) { send(200, [...admitted.values()].find(r => path.endsWith(r.run_id)) ?? {}); return }
      if (path === '/v1/capabilities') { send(200, {}); return }
      if (path === '/api/sessions') { send(200, { data: [...sessions.values()] }); return }
      send(404, {})
    })
    servers.push(upstream)
    const up = await listen(upstream)
    const server: any = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${up.port}`, hermesKey: 'fixture-key', ownerProof: 'fixture-owner-proof-with-32-characters', requireAccess: false,
      requireJoinedDelegationCapability: false, followThrough: false, wizardOsHome: process.env.WIZARD_OS_HOME,
      runQueueStatePath: join(root, 'http-queue.sqlite3'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
      schedulerStatePath: join(root, 'http-schedules.sqlite3'), schedulerNow: () => clock, schedulerHermesHome: process.env.HERMES_HOME, ...extra })
    servers.push(server)
    const address = await listen(server)
    return { server, origin: `http://127.0.0.1:${address.port}`, bodies, keys, sessions }
  }

  it('requires owner auth for CRUD/run/import and sends through the ordinary queue into one durable named thread', async () => {
    const f = await fixture()
    for (const [path, method, body] of [['', 'GET'], ['', 'POST', job()], ['/missing', 'PATCH', { enabled: false }], ['/missing', 'DELETE'], ['/missing/run', 'POST'], ['/import-hermes', 'POST', { dryRun: true }]] as any[]) {
      expect((await api(f.origin, path, method, body, false)).status).toBe(403)
    }
    const response = await api(f.origin, '', 'POST', job())
    expect(response.status).toBe(201)
    const created = await response.json()
    expect((await (await api(f.origin)).json()).schedules).toHaveLength(1)
    expect((await api(f.origin, `/${created.id}`, 'PATCH', { enabled: false })).status).toBe(200)
    expect((await api(f.origin, `/${created.id}/run`, 'POST')).status).toBe(202)
    await f.server.scheduler.tick(false)
    expect(f.bodies).toHaveLength(1)
    expect(f.keys[0]).toBe(`schedule:${created.id}:2026-10-21T00:00:00.000Z`)
    expect([...f.sessions.values()][0].title).toBe('Project · Feature')
    const thread = f.bodies[0].session_id
    expect((await (await api(f.origin)).json()).schedules[0].thread).toBe(thread)
    // Another tick cannot append a result; the result itself belongs to the ordinary run.
    await f.server.scheduler.tick(false); expect(f.bodies).toHaveLength(1)
    clock += 1000
    expect((await api(f.origin, `/${created.id}/run`, 'POST')).status).toBe(202)
    await f.server.scheduler.tick(false)
    expect(f.bodies).toHaveLength(2); expect(f.bodies[1].session_id).toBe(thread)
    expect(f.sessions.size).toBe(1)
    expect((await api(f.origin, '', 'POST', { bad: true })).status).toBe(400)
    expect((await api(f.origin, `/${created.id}`, 'DELETE')).status).toBe(200)
    expect((await (await api(f.origin)).json()).schedules).toHaveLength(0)
    expect((await api(f.origin, `/${created.id}/run`, 'POST')).status).toBe(404)
  })

  it.each(['fixture report', 'nothing changed [SILENT]'])('projects scheduled output through real history and SSE routes: %s', async fixtureOutput => {
    const f = await fixture({ fixtureOutput })
    const created = await (await api(f.origin, '', 'POST', job({ enabled: false }))).json()
    const receipt = await (await api(f.origin, `/${created.id}/run`, 'POST')).json()
    await f.server.scheduler.tick(false)
    const row = f.server.scheduler.db.prepare('SELECT receipt FROM schedule_occurrences WHERE key=?').get(receipt.key)
    const runId = JSON.parse(row.receipt).run_id
    const headers = { 'X-Wizard-Owner-Proof': 'fixture-owner-proof-with-32-characters' }
    const history = await (await fetch(`${f.origin}/wizard/hermes/api/sessions/${receipt.thread}/messages?view=wizard`, { headers })).json()
    const events = await (await fetch(`${f.origin}/wizard/hermes/v1/runs/${runId}/events`, { headers })).text()
    if (isSilentResult(fixtureOutput)) {
      expect(history.messages).toEqual([])
      expect(events).not.toContain('[SILENT]')
      expect(events).not.toContain('message.delta')
    } else {
      expect(history.messages.map((m: any) => m.content)).toEqual(['fixture report'])
      expect(events).toContain('fixture report')
    }
    expect(events).toContain('run.completed')
    await f.server.scheduler.tick(false)
    expect(f.bodies).toHaveLength(1)
  })

  it.each([
    ['completed', 'Report', 'posted'], ['completed', '[SILENT]', 'silent'],
    ['failed', '', 'failed'], ['running', '', 'running'],
  ])('GET and PATCH expose last/next run through the ordinary run lookup: %s/%s', async (fixtureStatus, fixtureOutput, outcome) => {
    const f = await fixture({ fixtureStatus, fixtureOutput })
    const created = await (await api(f.origin, '', 'POST', job())).json()
    expect(created).toMatchObject({ lastRun: null, nextRun: '2026-10-21T00:05:00.000Z' })
    clock += 5 * 60_000; await f.server.scheduler.tick()
    const read = (await (await api(f.origin)).json()).schedules[0]
    expect(read).toMatchObject({ nextRun: '2026-10-21T00:10:00.000Z', lastRun: { scheduledFor: '2026-10-21T00:05:00.000Z', outcome } })
    const edited = await (await api(f.origin, `/${created.id}`, 'PATCH', { name: 'Renamed' })).json()
    expect(edited.lastRun).toEqual(read.lastRun); expect(edited.nextRun).toBe(read.nextRun)
    expect(JSON.stringify(edited)).not.toContain('credential-fixture')
  })

  it('exposes dry-run import without writing to the source or enabling jobs', async () => {
    const path = join(process.env.HERMES_HOME!, 'cron'); mkdirSync(path)
    const raw = JSON.stringify({ jobs: [{ id: 'importable', name: 'Imported', prompt: 'report', schedule: { kind: 'interval', minutes: 10 } }] })
    writeFileSync(join(path, 'jobs.json'), raw)
    const f = await fixture()
    expect((await api(f.origin, '/import-hermes', 'POST', { dryRun: true })).status).toBe(200)
    expect(f.server.scheduler.list()).toHaveLength(0)
    expect((await api(f.origin, '/import-hermes', 'POST', { dryRun: false })).status).toBe(200)
    expect(f.server.scheduler.list()).toHaveLength(1)
    expect(f.server.scheduler.list()[0].enabled).toBe(false)
    expect(readFileSync(join(path, 'jobs.json'), 'utf8')).toBe(raw)
    expect(f.bodies).toHaveLength(0)
  })

  it('defaults new jobs and paused imports to the current owner timezone without changing existing jobs', async () => {
    const settingsPath = join(root, 'owner-settings.json')
    writeFileSync(settingsPath, JSON.stringify({ schema: 1, clock: { timezone: 'America/New_York' } }))
    const f = await fixture({ settingsPath })
    const first = await (await api(f.origin, '', 'POST', job())).json()
    expect(first.timezone).toBe('America/New_York')
    writeFileSync(settingsPath, JSON.stringify({ schema: 1, clock: { timezone: 'Europe/London' } }))
    const second = await (await api(f.origin, '', 'POST', job())).json()
    expect(second.timezone).toBe('Europe/London')
    expect(f.server.scheduler.get(first.id).timezone).toBe('America/New_York')
    const path = join(process.env.HERMES_HOME!, 'cron'); mkdirSync(path)
    writeFileSync(join(path, 'jobs.json'), JSON.stringify({ jobs: [{ id: 'tz-import', name: 'Imported', prompt: 'report', schedule: { kind: 'cron', expr: '0 9 * * *' } }] }))
    const imported = await (await api(f.origin, '/import-hermes', 'POST', { dryRun: false })).json()
    expect(imported.results[0].schedule.timezone).toBe('Europe/London')
  })

  it('never starts its timer by default, even if the option alone is true', async () => {
    const f = await fixture({ schedulerEnabled: true })
    expect(f.server.scheduler.timer).toBeUndefined()
    f.server.scheduler.create(job({ when: { once: '2026-10-20T00:00:00Z' } }))
    expect(f.bodies).toHaveLength(0)
  })

  it('starts only when WIZARD_SCHEDULER=1 and stops on service drain', async () => {
    vi.stubEnv('WIZARD_SCHEDULER', '1')
    const f = await fixture({ schedulerEnabled: true, schedulerIntervalMs: 50 })
    expect(f.server.scheduler.timer).toBeTruthy()
    await new Promise<void>(resolve => f.server.close(() => resolve())); await f.server.drained
    servers.splice(servers.indexOf(f.server), 1)
    expect(f.server.scheduler.timer).toBeNull()
  })
})
