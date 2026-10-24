import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler, notificationFromOutput, importHermesSchedules, isSilentResult, isScheduleInput, resolveWindow, SCHEDULE_INPUT, scheduledRunEvents } from '../server/scheduler.mjs'
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
  function source(jobs: any[], config?: string) {
    mkdirSync(join(process.env.HERMES_HOME!, 'cron'), { recursive: true })
    writeFileSync(join(process.env.HERMES_HOME!, 'cron', 'jobs.json'), JSON.stringify({ jobs }))
    if (config !== undefined) writeFileSync(join(process.env.HERMES_HOME!, 'config.yaml'), config)
  }
  const weekly = (extra: any = {}) => ({ id: 'weekly', name: 'Weekly', schedule: { kind: 'cron', expr: '0 1 * * 1' }, prompt: 'Analyse the collected context.', ...extra })

  it.each([undefined, 'timezone: null\n', 'timezone: "UTC" # source clock\n', 'clock:\n  timezone: Asia/Bangkok\n'])('defaults to source UTC, never the owner clock (%s)', config => {
    clock = Date.parse('2026-10-24T00:00:00Z')
    source([weekly()], config)
    const s = scheduler(undefined, { timezone: 'Asia/Bangkok' })
    const r = importHermesSchedules(s).results[0]
    expect(r).toMatchObject({ status: 'would import (paused)', timezone: 'UTC', nextRun: '2026-10-26T01:00:00.000Z', thread: null })
    expect(r.promptLength).toBe(r.schedule.prompt.length)
    expect(r.schedule.enabled).toBe(false)
    expect(s.list()).toEqual([])
    expect(s.db.prepare('SELECT count(*) AS n FROM schedule_imports').get().n).toBe(0)
  })

  it('uses top-level YAML timezone, with row timezone taking precedence', () => {
    source([weekly(), weekly({ id: 'override', timezone: 'UTC' })], '"timezone": "America/New_York" # source\n')
    const results = importHermesSchedules(scheduler()).results
    expect(results[0]).toMatchObject({ timezone: 'America/New_York', nextRun: '2026-10-26T05:00:00.000Z' })
    expect(results[1]).toMatchObject({ timezone: 'UTC', nextRun: '2026-10-26T01:00:00.000Z' })
  })

  it.each(['timezone: [invalid\n', 'timezone: Not/AZone\n'])('does not silently import in the wrong timezone on invalid source configuration', config => {
    source([weekly()], config)
    const s = scheduler()
    expect(() => importHermesSchedules(s, { dryRun: false })).toThrow('Hermes config unavailable or invalid')
    expect(s.list()).toEqual([])
  })

  it.each(['context.py', 'context.sh', 'context.bash', "nested/context's data.py"])('prefixes a quoted absolute pre-run command and appends delivery override (%s)', script => {
    source([weekly({ script, no_agent: false, prompt: 'Publish through a chat posting tool, then reply exactly [SILENT].' })], 'cron:\n  script_timeout_seconds: 120\n')
    const s = scheduler()
    const r = importHermesSchedules(s).results[0]
    expect(r.status).toBe('would import (paused)')
    expect(r.schedule.prompt).toMatch(/^Before following the task below, run this exact command first in the terminal/)
    expect(r.schedule.prompt).toContain(join(process.env.HERMES_HOME!, 'scripts'))
    expect(r.schedule.prompt).toContain(/\.(sh|bash)$/.test(script) ? 'bash ' : 'python3 ')
    expect(r.schedule.prompt).toContain('120 seconds')
    expect(r.schedule.prompt).toContain('full stdout')
    expect(r.schedule.prompt).toContain('This run happens inside its Wizard chat')
    expect(r.schedule.prompt).toContain('do not publish through that script or tool')
    expect(r.schedule.prompt).toContain('Reply [SILENT] only when there is genuinely nothing to report.')
    expect(r.promptLength).toBe(r.schedule.prompt.length)
    if (script.includes("'")) expect(r.schedule.prompt).toContain("'\"'\"'")
  })

  it('keeps configured interpreter and workdir in the pre-run command; pure scripts remain refused with preview fields', () => {
    const workdir = join(root, 'work'); mkdirSync(workdir)
    source([weekly({ script: 'context.py', interpreter: join(root, 'venv', 'bin', 'python3'), workdir }), weekly({ id: 'system', no_agent: true, script: 'health.sh' })])
    const results = importHermesSchedules(scheduler()).results
    expect(results[0].schedule.prompt).toContain(`cd '${workdir}' && '${join(root, 'venv', 'bin', 'python3')}'`)
    expect(results[0].schedule.prompt).toContain('3600 seconds')
    expect(results[0].schedule.prompt).toContain('For the rest of this agent turn')
    expect(results[0].schedule.prompt).toContain('resolve every relative path against it')
    expect(results[0].schedule.prompt).toContain('AGENTS.md')
    expect(results[1]).toEqual({ id: 'system', name: 'Weekly', status: 'not imported: script-only system job (no agent turn) — move to a host timer or Supervisor health check', timezone: 'UTC', nextRun: null, thread: null, promptLength: null })
  })

  it.each(['../escape.py', '/outside/scripts/context.py', 'bad\u0000.py'])('refuses scripts outside the source scripts directory (%s)', script => {
    source([weekly({ script })])
    expect(importHermesSchedules(scheduler()).results[0].status).toBe('not imported: unsupported or invalid job')
  })

  it('refuses symlink escapes even through a parent of a missing script, and refuses non-Python interpreter overrides', () => {
    const scripts = join(process.env.HERMES_HOME!, 'scripts'); mkdirSync(scripts)
    symlinkSync(root, join(scripts, 'outside'))
    source([weekly({ script: 'outside/missing.py' }), weekly({ id: 'bad-python', script: 'context.py', interpreter: '/bin/bash' })])
    expect(importHermesSchedules(scheduler()).results.map((r: any) => r.status)).toEqual(['not imported: unsupported or invalid job', 'not imported: unsupported or invalid job'])
  })

  it('validates the resolved target of an existing Python interpreter symlink', () => {
    const venv = join(root, 'venv', 'bin'); mkdirSync(venv, { recursive: true })
    const other = join(root, 'not-python'); writeFileSync(other, 'synthetic executable')
    const interpreter = join(venv, 'python3'); symlinkSync(other, interpreter)
    source([weekly({ script: 'context.py', interpreter })])
    expect(importHermesSchedules(scheduler()).results[0].status).toBe('not imported: unsupported or invalid job')
  })

  it('includes nullable preview fields for invalid rows without turning empty jobs into delivery-note-only jobs', () => {
    source([null, weekly({ id: 'bad/id' }), weekly({ id: 'empty', prompt: '' }), weekly({ id: 'invalid-zone', timezone: 'Not/AZone' })])
    const s = scheduler()
    const results = importHermesSchedules(s, { dryRun: false }).results
    expect(results.map((r: any) => r.status)).toEqual(['not imported: invalid job', 'not imported: invalid id', 'not imported: unsupported or invalid job', 'not imported: unsupported or invalid job'])
    for (const r of results) expect(r).toMatchObject({ nextRun: null, promptLength: null, thread: null })
    expect(results[0].timezone).toBeNull()
    expect(s.list()).toEqual([])
  })

  it('maps validated source ids to existing threads, persists paused copies and previews saved jobs idempotently', async () => {
    source([weekly(), weekly({ id: 'unbound' })])
    let s = scheduler()
    const threads = { weekly: 'existing.chat:reports-1' }
    expect(importHermesSchedules(s, { threads }).results[0].thread).toBe(threads.weekly)
    const result = importHermesSchedules(s, { dryRun: false, threads }).results
    const job = s.get(result[0].scheduleId)
    expect(job).toMatchObject({ enabled: false, thread: threads.weekly, timezone: 'UTC' })
    expect(job.createThread).toBeUndefined()
    expect(result[1].thread).toBeNull()
    const saved = s.list()
    await s.close(); schedulers.splice(schedulers.indexOf(s), 1)
    s = scheduler()
    const again = importHermesSchedules(s, { dryRun: false, threads: { weekly: 'other-thread' } }).results[0]
    expect(again).toMatchObject({ status: 'already imported', thread: threads.weekly, promptLength: job.prompt.length, nextRun: '2026-10-26T01:00:00.000Z' })
    expect(s.list()).toEqual(saved)
    s.delete(job.id)
    expect(importHermesSchedules(s).results[0]).toMatchObject({ status: 'already imported', nextRun: null, promptLength: null })
    expect(s.list()).toHaveLength(1)
  })

  it.each([null, [], 'bad', { 'bad/id': 'thread' }, { weekly: '' }, { weekly: 'bad/id' }, { weekly: null }, { weekly: 42 }])('rejects invalid thread mappings before any writes (%j)', threads => {
    source([weekly()])
    const s = scheduler()
    expect(() => importHermesSchedules(s, { dryRun: false, threads })).toThrow('invalid threads')
    expect(s.list()).toEqual([])
  })

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
    expect(importHermesSchedules(s, { dryRun: true }).results.map((r: any) => r.status)).toEqual(['would import (paused)', 'would import (paused)', 'would import (paused)', 'would import (paused)', 'not imported: script-only system job (no agent turn) — move to a host timer or Supervisor health check'])
    expect(s.list()).toEqual([])
    const result = importHermesSchedules(s, { dryRun: false })
    expect(result.results.filter((r: any) => r.status === 'imported (paused)')).toHaveLength(4)
    expect(s.list().every((j: any) => !j.enabled)).toBe(true)
    expect(s.list().every((j: any) => j.prompt.endsWith('Reply [SILENT] only when there is genuinely nothing to report.'))).toBe(true)
    expect(s.list().find((j: any) => j.name === 'Daily').model).toBe('fixture-model')
    expect(s.list().find((j: any) => j.name === 'Every')).toMatchObject({ skill: 'one', prompt: expect.stringContaining('Also load and follow the skill "two".') })
    expect(importHermesSchedules(s, { dryRun: false }).results[0].status).toBe('already imported')
    expect(s.list()).toHaveLength(4)
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
      const patched = path.match(/^\/api\/sessions\/([^/]+)$/)
      if (patched && req.method === 'PATCH') { const id = decodeURIComponent(patched[1]); sessions.set(id, { ...sessions.get(id), ...body }); send(200, sessions.get(id)); return }
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

  it('deliver: notification reads the unscrubbed answer through the real run route and keeps the thread and owner views silent', async () => {
    const f = await fixture({ fixtureOutput: '**Disk almost full**\nThales is at 93%.\n[SILENT]' })
    const sent: any[] = []
    f.server.scheduler.notifier = { available: () => true, send: async (n: any) => { sent.push(n); return { app: 'notifications' } } }
    const created = await (await api(f.origin, '', 'POST', job({ enabled: false, deliver: 'notification' }))).json()
    const receipt = await (await api(f.origin, `/${created.id}/run`, 'POST')).json()
    await f.server.scheduler.tick(false); await f.server.scheduler.refreshRuns()
    expect(f.bodies[0].input).toContain("the owner's Notifications, not this chat")
    expect(sent).toEqual([{ title: 'Disk almost full', message: 'Thales is at 93%.', key: receipt.key }])
    expect(f.server.scheduler.project(f.server.scheduler.get(created.id)).lastRun.outcome).toBe('notified')
    expect(f.sessions.get(receipt.thread)).toMatchObject({ hidden: true })
    const row = f.server.scheduler.db.prepare('SELECT receipt FROM schedule_occurrences WHERE key=?').get(receipt.key)
    const runId = JSON.parse(row.receipt).run_id
    // The raw view is internal-only: an owner asking for it still gets the scrubbed run.
    const headers = { 'X-Wizard-Owner-Proof': 'fixture-owner-proof-with-32-characters', 'X-Wizard-Schedule-Raw': '1' }
    const run = await (await fetch(`${f.origin}/wizard/hermes/v1/runs/${runId}`, { headers })).json()
    expect(run.output).toBe('')
    const history = await (await fetch(`${f.origin}/wizard/hermes/api/sessions/${receipt.thread}/messages?view=wizard`, { headers })).json()
    expect(history.messages).toEqual([])
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
    expect((await api(f.origin, '/import-hermes', 'POST', { dryRun: false, threads: { importable: 'bad/id' } })).status).toBe(400)
    expect(f.server.scheduler.list()).toHaveLength(0)
    const imported = await api(f.origin, '/import-hermes', 'POST', { dryRun: false, threads: { importable: 'existing-report-thread' } })
    expect(imported.status).toBe(200)
    expect((await imported.json()).results[0]).toMatchObject({ thread: 'existing-report-thread', timezone: 'UTC', nextRun: expect.any(String), promptLength: expect.any(Number) })
    expect(f.server.scheduler.list()).toHaveLength(1)
    expect(f.server.scheduler.list()[0].enabled).toBe(false)
    expect(readFileSync(join(path, 'jobs.json'), 'utf8')).toBe(raw)
    expect(f.bodies).toHaveLength(0)
  })

  it('defaults new jobs to the owner clock but imports to the source clock without changing existing jobs', async () => {
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
    expect(imported.results[0].schedule.timezone).toBe('UTC')
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


describe('windows, reminders and trickled agent work', () => {
  const BKK = 'Asia/Bangkok'
  it('resolves morning to the next 08:30 and overnight to the next 03:30 (+ jitter) in the owner timezone', () => {
    // 2026-10-22 01:00 Bangkok: still the owner's evening; "tomorrow morning" is today 08:30.
    const lateNight = Date.parse('2026-10-21T18:00:00Z')
    expect(new Date(resolveWindow('morning', BKK, lateNight, () => 0)).toISOString()).toBe('2026-10-22T01:30:00.000Z')
    expect(new Date(resolveWindow('overnight', BKK, lateNight, () => 0)).toISOString()).toBe('2026-10-21T20:30:00.000Z')
    // 14:00 Bangkok -> next calendar day's windows; jitter stays inside 20 minutes.
    const afternoon = Date.parse('2026-10-22T07:00:00Z')
    expect(new Date(resolveWindow('morning', BKK, afternoon, () => 0.99)).toISOString()).toBe('2026-10-23T01:30:00.000Z')
    expect(new Date(resolveWindow('overnight', BKK, afternoon, () => 0.99)).toISOString()).toBe('2026-10-22T20:49:00.000Z')
    expect(() => resolveWindow('lunch', BKK, afternoon)).toThrow(/unknown window/)
  })

  it('stores a window as a labelled one-shot and builds reminder vs deferred-work input', () => {
    const s = scheduler(undefined, { timezone: BKK, random: () => 0 })
    const remind = s.create({ name: 'Play Store', kind: 'remind', when: { at: 'morning' }, prompt: 'Create the Play Store account', thread: 'wizard_t1' })
    expect(remind).toMatchObject({ kind: 'remind', window: 'morning', when: { once: '2026-10-21T01:30:00.000Z' } })
    const work = s.create({ name: 'Overnight merge', when: { at: 'overnight' }, prompt: 'Merge the PR', thread: 'wizard_t2' })
    const r = s.transaction(() => s.reserve(remind, clock)), w = s.transaction(() => s.reserve(work, clock))
    expect(r.body.input).toContain('reminded'); expect(r.body.input).not.toContain('[SILENT]')
    expect(w.body.input).toContain('Do the work now'); expect(w.body.input).not.toContain('[SILENT]')
    expect(isScheduleInput(r.body.input) && isScheduleInput(w.body.input)).toBe(true)
    expect(r.body.session_id).toBe('wizard_t1')
    expect(() => s.create({ name: 'x', kind: 'remind', when: { at: 'morning' }, skill: 'k' })).toThrow(/reminder needs/)
    expect(() => s.create({ name: 'x', kind: 'email', when: { at: 'morning' }, prompt: 'p' })).toThrow(/kind/)
  })

  it('trickles due agent work (one per trickle, capped in flight) while reminders go straight through', async () => {
    const admitted: string[] = []
    const status: Record<string, string> = {}
    const s = scheduler(async (o: any) => { admitted.push(o.jobId); status[o.jobId] = 'running'; return { run_id: o.jobId } },
      { trickleMs: 60_000, maxInflight: 3, lookup: async (o: any) => ({ status: status[o.jobId] }) })
    const jobs = Array.from({ length: 6 }, (_, i) => s.create({ name: `Work ${i}`, when: { once: '2026-10-20T23:00:00Z' }, prompt: 'go', thread: `wizard_w${i}` }))
    const reminders = Array.from({ length: 2 }, (_, i) => s.create({ name: `R ${i}`, kind: 'remind', when: { once: '2026-10-20T23:00:00Z' }, prompt: 'note', thread: `wizard_r${i}` }))
    await s.tick()
    expect(admitted.filter(id => reminders.some(r => r.id === id))).toHaveLength(2)
    expect(admitted.filter(id => jobs.some(j => j.id === id))).toHaveLength(1)
    for (let i = 0; i < 6; i++) { clock += 60_000; await s.tick() }
    // Cap 3 holds the rest while nothing finishes, even though the trickle allows more.
    expect(admitted.filter(id => jobs.some(j => j.id === id))).toHaveLength(3)
    for (const id of admitted) status[id] = 'completed'
    await s.refreshRuns()
    for (let i = 0; i < 4; i++) { clock += 60_000; await s.tick() }
    expect(admitted.filter(id => jobs.some(j => j.id === id))).toHaveLength(6)
    expect(new Set(admitted).size).toBe(8)
  })

  it('lets the main agent schedule, list and cancel in its own thread over the loopback token only', async () => {
    const token = 'fixture-heavy-token-with-more-than-32-chars'
    const server: any = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'fixture-key', ownerProof: 'fixture-owner-proof-with-32-characters', requireAccess: false,
      requireJoinedDelegationCapability: false, followThrough: false, wizardOsHome: process.env.WIZARD_OS_HOME, heavyToken: token,
      schedulerStatePath: join(root, 'agent-schedules.sqlite3'), schedulerNow: () => clock, schedulerTimezone: BKK })
    servers.push(server)
    const origin = `http://127.0.0.1:${(await listen(server)).port}`
    const call = (action: string, body: any, auth = token) => fetch(`${origin}/wizard/internal/schedules/${action}`, { method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await call('create', { session_id: 'wizard_a', name: 'x', when: { at: 'morning' }, text: 'hi' }, 'wrong-token-wrong-token-wrong-token-xx')).status).toBe(403)
    const made = await (await call('create', { session_id: 'wizard_a', name: 'Reminder · Loomis', kind: 'remind', when: { at: 'morning' }, text: 'Email Loomis' })).json()
    expect(made).toMatchObject({ thread: 'wizard_a', kind: 'remind', window: 'morning', nextRun: '2026-10-21T01:30:00.000Z' })
    await call('create', { session_id: 'wizard_b', name: 'Other', when: { at: 'overnight' }, text: 'Run it' })
    expect((await (await call('list', { session_id: 'wizard_a' })).json()).schedules.map((j: any) => j.id)).toEqual([made.id])
    expect((await (await call('list', { session_id: 'wizard_a', all: true })).json()).schedules).toHaveLength(2)
    expect((await call('create', { session_id: 'wizard_a', name: 'bad', when: { at: 'lunch' }, text: 'x' })).status).toBe(400)
    const other = (await (await call('list', { session_id: 'wizard_b' })).json()).schedules[0]
    expect((await call('cancel', { session_id: 'wizard_a', schedule_id: other.id })).status).toBe(409)
    expect((await call('cancel', { session_id: 'wizard_a', schedule_id: made.id })).status).toBe(200)
    expect((await (await call('list', { session_id: 'wizard_a' })).json()).schedules).toHaveLength(0)
  })
})

describe('Boomerang returns (kind return)', () => {
  it('validates a return as a once-only, prompt-free hand-back of a thread or message', () => {
    const s = scheduler()
    const thread = s.create({ name: 'Boomerang · Loomis', kind: 'return', when: { once: '2026-10-21T02:00:00Z' }, thread: 'wizard_t1', prompt: '  Reply to Loomis  ' })
    expect(thread).toMatchObject({ kind: 'return', thread: 'wizard_t1', prompt: 'Reply to Loomis', skill: '', target: { message: null, excerpt: '' } })
    const message = s.create({ name: 'Boomerang · msg', kind: 'return', when: { once: '2026-10-21T02:00:00Z' }, thread: 'wizard_t1', target: { message: 1792700000.5, excerpt: 'the   price\nquote' } })
    expect(message.target).toEqual({ message: 1792700000.5, excerpt: 'the price quote' })
    expect(() => s.create({ name: 'x', kind: 'return', when: { every: 5 }, thread: 'wizard_t1' })).toThrow(/once/)
    expect(() => s.create({ name: 'x', kind: 'return', when: { once: '2026-10-21T02:00:00Z' } })).toThrow(/thread/)
    expect(() => s.create({ name: 'x', kind: 'return', when: { once: '2026-10-21T02:00:00Z' }, thread: 'wizard_t1', skill: 'k' })).toThrow(/runs nothing/)
    expect(() => s.create({ name: 'x', kind: 'return', when: { once: '2026-10-21T02:00:00Z' }, thread: 'wizard_t1', target: { message: '<b>' } })).toThrow(/target/)
    expect(() => s.create({ name: 'x', when: { once: '2026-10-21T02:00:00Z' }, prompt: 'p', target: { message: 1 } })).toThrow(/only for kind return/)
    const r = s.transaction(() => s.reserve(message, clock))
    expect(r.body).toBeUndefined()
    expect(r).toMatchObject({ kind: 'return', thread: 'wizard_t1', target: { message: 1792700000.5 } })
  })

  it('returns on time without a run, skips the trickle, and serves its watch id only once returned', async () => {
    const delivered: any[] = []
    const s = scheduler(async (o: any) => { delivered.push(o); return { returned: true } }, { trickleMs: 60_000, maxInflight: 1,
      lookup: async () => ({ status: 'running' }) })
    const work = s.create({ name: 'Busy', when: { once: '2026-10-20T23:00:00Z' }, prompt: 'go', thread: 'wizard_w' })
    const back = s.create({ name: 'Boomerang · Thread', kind: 'return', when: { once: '2026-10-21T00:02:00Z' }, thread: 'wizard_b', prompt: 'Check the quote' })
    expect(s.returnRun(`wzb_${back.id}`)).toMatchObject({ status: 'queued', session_id: 'wizard_b', output: '' })
    expect(s.returnRun(`wzb_${work.id}`)).toBeNull()
    expect(s.returnRun('wzb_missing')).toBeNull()
    await s.tick()
    expect(delivered.map(o => o.jobId)).toEqual([work.id])
    clock += 120_000; await s.tick()
    // The trickle and the in-flight cap (work still running) never hold a Boomerang.
    expect(delivered.map(o => o.jobId)).toEqual([work.id, back.id])
    expect(delivered[1].body).toBeUndefined()
    expect(s.project(s.get(back.id))).toMatchObject({ nextRun: null, lastRun: { outcome: 'returned' } })
    expect(s.returnRun(`wzb_${back.id}`)).toMatchObject({ status: 'completed', session_id: 'wizard_b', output: '🪃 Back: Check the quote' })
    clock += 120_000; await s.tick(); await s.refreshRuns()
    expect(delivered).toHaveLength(2)
    expect(s.project(s.get(back.id)).lastRun.outcome).toBe('returned')
    // Again: a new time re-arms it, and the earlier return never reads as this one.
    s.update(back.id, { when: { once: '2026-10-21T01:00:00Z' }, enabled: true })
    expect(s.project(s.get(back.id)).nextRun).toBe('2026-10-21T01:00:00.000Z')
    expect(s.returnRun(`wzb_${back.id}`)).toMatchObject({ status: 'queued', output: '' })
    clock = Date.parse('2026-10-21T01:00:30Z'); await s.tick()
    expect(delivered.map(o => o.jobId)).toEqual([work.id, back.id, back.id])
    expect(s.returnRun(`wzb_${back.id}`)).toMatchObject({ status: 'completed' })
    s.delete(back.id)
    expect(s.returnRun(`wzb_${back.id}`)).toBeNull()
  })
})

describe('deliver: notification (alerts go to the notifications slot, not Chats)', () => {
  const notifier = (up = true, fail = false) => {
    const sent: any[] = []
    return { sent, available: () => up, send: async (n: any) => { if (fail) throw Error('down'); sent.push(n); return { app: 'notifications' } } }
  }
  it('freezes a silent notification instruction into the run and sends the answer to the slot once', async () => {
    const n = notifier(); let bodies: any[] = []
    const s = scheduler(async (o: any) => { bodies.push(o); return { run_id: 'r1' } }, { notifier: n,
      lookup: async () => ({ status: 'completed', output: '**Disk almost full**\nThales is at 93%. Free space or approve cleanup.\n[SILENT]' }) })
    const j = s.create(job({ deliver: 'notification' }))
    expect(j.deliver).toBe('notification')
    clock += 5 * 60_000; await s.tick()
    expect(bodies[0].deliver).toBe('notification')
    expect(bodies[0].body.input).toContain("the owner's Notifications, not this chat")
    expect(isSilentResult('**Disk almost full**\nThales is at 93%.\n[SILENT]')).toBe(true)
    await s.refreshRuns(); await s.refreshRuns()
    expect(n.sent).toEqual([{ title: 'Disk almost full', message: 'Thales is at 93%. Free space or approve cleanup.', key: expect.stringMatching(/^schedule:/) }])
    expect(s.project(s.get(j.id)).lastRun).toMatchObject({ outcome: 'notified', error: null })
  })
  it('sends nothing for a [SILENT]-only answer', async () => {
    const n = notifier()
    const s = scheduler(undefined, { notifier: n, lookup: async () => ({ status: 'completed', output: '[SILENT]' }) })
    const j = s.create(job({ deliver: 'notification' })); clock += 5 * 60_000; await s.tick()
    expect(n.sent).toEqual([]); expect(s.project(s.get(j.id)).lastRun.outcome).toBe('silent')
  })
  it('falls back to the thread when the slot is empty or stopped, and retries a failed send', async () => {
    let bodies: any[] = []
    const s1 = scheduler(async (o: any) => { bodies.push(o); return { run_id: 'r' } }, { notifier: notifier(false) })
    s1.create(job({ deliver: 'notification' })); clock += 5 * 60_000; await s1.tick()
    expect(bodies[0].deliver).toBeUndefined()
    expect(bodies[0].body.input).not.toContain('Notifications')
    await s1.close(); schedulers.splice(schedulers.indexOf(s1), 1); rmSync(join(root, 'scheduler.sqlite3'), { force: true })
    let fail = true; const sent: any[] = []
    const flaky = { available: () => true, send: async (x: any) => { if (fail) throw Error('down'); sent.push(x) } }
    const s2 = scheduler(undefined, { notifier: flaky, lookup: async () => ({ status: 'completed', output: 'Backup failed\nRestore check could not reach R2.\n[SILENT]' }) })
    const j = s2.create(job({ deliver: 'notification' })); clock += 5 * 60_000; await s2.tick()
    expect(s2.project(s2.get(j.id)).lastRun).toMatchObject({ outcome: 'failed', error: 'Notification not delivered; will retry', finishedAt: null })
    fail = false; await s2.refreshRuns()
    expect(sent).toHaveLength(1); expect(s2.project(s2.get(j.id)).lastRun).toMatchObject({ outcome: 'notified', error: null })
  })
  it('observes a notification occurrence past the 6 h run window', async () => {
    let state: any = { status: 'running' }; const n = notifier()
    const s = scheduler(undefined, { notifier: n, lookup: async () => state })
    const j = s.create(job({ deliver: 'notification' })); clock += 5 * 60_000; await s.tick()
    clock += 8 * 3600_000; state = { status: 'completed', output: 'Render done\nAll 3 clips exported.\n[SILENT]' }
    await s.refreshRuns()
    expect(n.sent).toHaveLength(1); expect(s.project(s.get(j.id)).lastRun.outcome).toBe('notified')
  })
  it('validates deliver and keeps returns as threads', () => {
    const s = scheduler()
    expect(s.create(job()).deliver).toBe('thread')
    expect(() => s.create(job({ deliver: 'email' }))).toThrow(/deliver must be/)
    expect(() => s.create({ name: 'R', kind: 'return', when: { once: '2026-10-22T00:00:00Z' }, thread: 'wizard_1_abc', deliver: 'notification' })).toThrow(/return always/)
  })
  it('extracts title and message from an answer', () => {
    expect(notificationFromOutput('# Job done\nAll 3 renders finished.\n[SILENT]')).toEqual({ title: 'Job done', message: 'All 3 renders finished.' })
    expect(notificationFromOutput('One line only [SILENT]')).toEqual({ title: '', message: 'One line only' })
    expect(notificationFromOutput('[SILENT]')).toBeNull()
  })
})
