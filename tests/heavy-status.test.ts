import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scene, kinds, post } from '../qa/agent-parity/fixture.mjs'
import { guardHeavyStatus } from '../server/thread-status.mjs'
import { DurableHeavyQueue } from '../server/heavy-queue.mjs'
import { heavyResultOwed } from '../server/heavy-wait.mjs'

it('old finished heavy jobs never pull threads back into Working', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-legacy-')), statePath = join(root, 'heavy.db')
  // Seed the pre-delivery schema directly: constructing today's queue would
  // already mark a new database migrated, hiding a repeated-on-open backfill.
  const db = new DatabaseSync(statePath)
  db.exec(`CREATE TABLE heavy_jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL,
    origin TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL,
    UNIQUE(session,origin,key))`)
  const created_at = 1_700_000_000_000, finished_at = 1_700_000_100
  const legacy = ['completed', 'failed', 'cancelled', 'interrupted'].map((state, i) => ({
    job_id: `old_${state}`, sessionId: 'legacy', state, created_at,
    resume: i ? 'superseded' : 'delivered-before-stamps', continuation_invalidated: i > 0,
    ...(i % 2 ? {} : { receipt: { finished_at } }),
  }))
  const active = ['queued', 'running'].map(state => ({ job_id: `active_${state}`, sessionId: state, state, created_at, resume: '' }))
  const partial = { ...legacy[1], job_id: 'partial', completion_delivered_at: 123 }
  const delivered = { ...legacy[2], job_id: 'delivered', completion_delivered_at: 456, notice_delivered_at: 789 }
  // Already tracked but not yet reported when the upgrade lands: must stay owed.
  const trackedNotice = { job_id: 'tracked_notice', sessionId: 'tracked', state: 'failed', created_at, receipt: { finished_at },
    resume: 'superseded', continuation_invalidated: true, completion_notice: { job_id: 'tracked_notice', state: 'failed' } }
  const awaiting = { job_id: 'awaiting_continuation', sessionId: 'awaiting', state: 'completed', created_at, receipt: { finished_at }, resume: '' }
  for (const job of [...legacy, ...active, partial, delivered, trackedNotice, awaiting]) db.prepare('INSERT INTO heavy_jobs VALUES(?,?,?,?,?,?)')
    .run(job.job_id, job.sessionId, 'origin', job.job_id, 'hash', JSON.stringify(job))
  db.close()
  let queue: any
  const open = () => new DurableHeavyQueue({ statePath, transport: async (p: any) => ({ job_id: p.job_id, state: 'completed', receipt: { finished_at: finished_at + 100 } }),
    current: async () => true, continuation: async () => ({ publicRunId: 'fresh-continuation' }) })
  const status = { state: 'done', ask: 'Finished', subject: 'Synthetic legacy work' }
  try {
    queue = open()
    for (const job of legacy) {
      const saved = queue.get(job.job_id), stamp = job.receipt?.finished_at ?? job.created_at
      expect(saved).toMatchObject({ ...job, agent_id: 'hermes', completion_delivered_at: stamp,
        notice_delivered_at: stamp, delivery_backfill: 'legacy-migration' })
      expect(heavyResultOwed(saved)).toBe(false)
    }
    expect(guardHeavyStatus(status, { sessionId: 'legacy', jobs: queue.rows() })).toBe(status)
    expect(queue.pendingNotices('hermes', 'legacy')).toEqual([])
    expect(queue.noticeContext('hermes', 'legacy')).toBe('')
    expect(queue.get('partial')).toMatchObject({ completion_delivered_at: 123, notice_delivered_at: created_at, delivery_backfill: 'legacy-migration' })
    expect(queue.get('delivered')).toMatchObject(delivered)
    expect(queue.get('delivered').delivery_backfill).toBeUndefined()
    for (const id of ['tracked_notice', 'awaiting_continuation']) {
      const kept = queue.get(id)
      expect(kept.delivery_backfill).toBeUndefined()
      expect(kept.completion_delivered_at).toBeUndefined()
      expect(heavyResultOwed(kept)).toBe(true)
    }
    expect(queue.pendingNotices('hermes', 'tracked').map((job: any) => job.job_id)).toEqual(['tracked_notice'])
    for (const job of active) expect(queue.get(job.job_id)).toEqual({ ...job, agent_id: 'hermes', session_id: job.sessionId })
    const migrated = queue.rows().filter((job: any) => job.sessionId === 'legacy')
    await queue.tick() // Work still active at migration finishes afterward.
    expect(heavyResultOwed(queue.get('active_queued'))).toBe(true)
    // Also retain a post-migration dropped result across both reopens.
    queue.save({ ...queue.get('active_running'), continuation_invalidated: true, resume: 'superseded' })
    for (let reopen = 0; reopen < 2; reopen++) {
      await queue.close(); queue = open()
      expect(queue.db.prepare('PRAGMA user_version').get().user_version).toBe(1)
      expect(queue.rows().filter((job: any) => job.sessionId === 'legacy')).toEqual(migrated)
      expect(queue.noticeContext('hermes', 'legacy')).toBe('')
      for (const id of ['active_queued', 'active_running']) {
        const job = queue.get(id)
        expect(job.state).toBe('completed')
        expect(job.completion_delivered_at).toBeUndefined()
        expect(job.notice_delivered_at).toBeUndefined()
        expect(job.delivery_backfill).toBeUndefined()
        expect(heavyResultOwed(job)).toBe(true)
        expect(guardHeavyStatus(status, { sessionId: job.sessionId, jobs: queue.rows() }).state).toBe('fyi')
      }
      expect(queue.pendingNotices('hermes', 'running').map((job: any) => job.job_id)).toEqual(['active_running'])
    }
    queue.delivered('active_queued')
    queue.delivered('awaiting_continuation')
    queue.acknowledgeNotices('hermes', 'tracked', { instructions: queue.noticeContext('hermes', 'tracked') })
    queue.acknowledgeNotices('hermes', 'running', { instructions: queue.noticeContext('hermes', 'running') })
    for (const job of queue.rows()) expect(heavyResultOwed(job)).toBe(false)
  } finally { await queue?.close(); rmSync(root, { recursive: true, force: true }) }
})

it.each(kinds)('legacy heavy delivery migration preserves finished thread status and omits stale notices: %s', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-upgrade-')), heavyStatePath = join(root, 'heavy.db')
  const id = 'wizard_parity', agent_id = kind === 'main' ? 'hermes' : 'parity-agent'
  const db = new DatabaseSync(heavyStatePath)
  db.exec(`CREATE TABLE heavy_jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL, origin TEXT NOT NULL,
    key TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, agent_id TEXT NOT NULL,
    UNIQUE(agent_id,session,origin,key))`)
  const job = { job_id: 'heavy_legacy', sessionId: id, agent_id, state: 'failed',
    created_at: 1_700_000_000_000, receipt: { finished_at: 1_700_000_100 },
    resume: 'superseded', continuation_invalidated: true }
  db.prepare('INSERT INTO heavy_jobs VALUES(?,?,?,?,?,?,?)').run(job.job_id, id, 'origin', 'legacy', 'hash', JSON.stringify(job), agent_id)
  db.close()
  let s: any
  try {
    s = await scene(kind, { heavyStatePath, heavyToken: 'synthetic-heavy-status-token-000000000', heavyPollIntervalMs: 3_600_000,
      heavyTransport: async () => { throw Error('fixture must not contact a worker') } })
    s.sessions.set(id, { id, source: 'wizard-mobile', title: 'Finished legacy work', created_at: Date.now() / 1000 - 60, messages: [] })
    for (const state of ['done', 'check']) {
      s.sessions.get(id).messages = [{ role: 'assistant', timestamp: Date.now() / 1000,
        content: `Finished\n[WIZARD_STATUS_V1]{"state":"${state}","ask":"Legacy work finished"}[/WIZARD_STATUS_V1]` }]
      const response = await s.request('/api/sessions?limit=100')
      expect(response.status).toBe(200)
      const row = (await response.json()).data.find((row: any) => row.id === id)
      expect(row.wizard_attention.state).toBe(state)
      expect(row.status).not.toBe('running')
    }
    const response = await s.request('/v1/runs', post({ session_id: id, input: 'A new synthetic owner request' }))
    expect(response.status).toBe(202)
    const sent = s.seen.filter((r: any) => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1)
    expect(sent).toBeDefined()
    expect(sent.body.instructions || '').not.toContain('[Wizard heavy-work notice]')
    expect(sent.body.instructions || '').not.toContain('heavy_legacy')
  } finally { await s?.close(); rmSync(root, { recursive: true, force: true }) }
}, 30_000)

it('completion guard has no age expiry, preserves metadata and leaves owner questions alone', () => {
  const job = { agent_id: 'hermes', sessionId: 's', state: 'failed', resume: '', created_at: Date.now() - 7 * 86_400_000 }
  const status = { state: 'check', ask: '', subject: 'Tests', title: 'Tests · Results', app_id: 'wizard-quest' }
  expect(guardHeavyStatus(status, { sessionId: 's', jobs: [job] })).toEqual({ ...status, state: 'fyi', ask: 'Background work is still running or waiting to report back.' })
  const question = { ...status, state: 'needs_you', ask: 'Choose the next step' }
  expect(guardHeavyStatus(question, { sessionId: 's', jobs: [job] })).toBe(question)
  expect(guardHeavyStatus(status, { sessionId: 's', jobs: [{ ...job, resume: 'superseded', notice_delivered_at: Date.now() }] })).toBe(status)
  expect(guardHeavyStatus(status, { sessionId: 's', jobs: [{ ...job, completion_delivered_at: Date.now(), continuation_invalidated: true }] })).toBe(status)
})

it.each(kinds)('thread is not marked done while its heavy jobs are unfinished: %s', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-status-')), heavyStatePath = join(root, 'heavy.db')
  const s = await scene(kind, { heavyStatePath, heavyToken: 'synthetic-heavy-status-token-000000000', heavyPollIntervalMs: 3_600_000,
    heavyTransport: async () => { throw Error('fixture must not contact a worker') } })
  const db = new DatabaseSync(heavyStatePath)
  const id = 'wizard_parity'
  s.sessions.set(id, { id, source: 'wizard-mobile', title: 'Synthetic checks', created_at: Date.now() / 1000 - 60, messages: [] })
  const list = async () => {
    const r = await s.request('/api/sessions?limit=100')
    expect(r.status).toBe(200)
    return (await r.json()).data.find((r: any) => r.id === id)
  }
  const save = (over: any) => {
    const job = { job_id: 'heavy_status', sessionId: id, agent_id: s.id, origin: 'origin', state: 'queued', resume: '', created_at: Date.now(), ...over }
    db.prepare('INSERT OR REPLACE INTO heavy_jobs(id,session,origin,key,hash,data,agent_id) VALUES(?,?,?,?,?,?,?)')
      .run(job.job_id, id, 'origin', 'key', 'hash', JSON.stringify(job), job.agent_id)
  }
  try {
    for (const status of ['done', 'check']) {
      s.sessions.get(id).messages = [{ role: 'assistant', timestamp: Date.now() / 1000, content: `Outcome\n[WIZARD_STATUS_V1]{"state":"${status}","ask":"Everything finished","subject":"Parity QA"}[/WIZARD_STATUS_V1]` }]
      for (const job of [{ state: 'queued' }, { state: 'running' }, { state: 'failed' }, { state: 'completed', resume: 'wizardq_not_launched' },
        { state: 'failed', resume: 'superseded' }, { state: 'running', cancel_requested: true }, { state: 'failed', resume: 'suppressed', continuation_invalidated: true }]) {
        save(job)
        const row = await list()
        expect(row.wizard_attention?.state, JSON.stringify(job)).toBe(status === 'check' ? 'fyi' : 'done')
        if (status === 'check') expect(row.wizard_attention.ask).toContain('work')
        expect(row.status).toBe('running')
      }
      save({ state: 'completed', resume: 'sent', completion_delivered_at: Date.now() })
      expect((await list()).wizard_attention?.state).toBe(status)
      save({ agent_id: 'other-agent' })
      expect((await list()).wizard_attention?.state).toBe(status)
    }
    // A suppressed result becomes context, never permission to run cancelled work again.
    save({ state: 'failed', resume: 'superseded' })
    const admitted = await s.request('/v1/runs', post({ session_id: id, input: 'New owner request' }))
    expect(admitted.status).toBe(202)
    const sent = s.seen.filter((r: any) => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1)
    expect(sent.body.instructions).toContain('heavy_status')
    expect(sent.body.instructions).toContain('failed')
    const saved = JSON.parse(db.prepare('SELECT data FROM heavy_jobs WHERE id=?').get('heavy_status').data as string)
    expect(saved.notice_delivered_at).toBeGreaterThan(0)
    // A later terminal result must not be acknowledged by mere queue admission.
    save({ state: 'failed', resume: 'superseded' })
    const queuedResponse = await s.request('/v1/runs', post({ session_id: id, input: 'Another owner request' }))
    const queued = await queuedResponse.json()
    expect(queued.status).toBe('queued')
    expect(JSON.parse(db.prepare('SELECT data FROM heavy_jobs WHERE id=?').get('heavy_status').data as string).notice_delivered_at).toBeUndefined()
    for (const run of s.runs.values()) { run.status = 'completed'; run.output = 'Finished' }
    await s.request('/v1/runs/' + queued.run_id)
    expect(JSON.parse(db.prepare('SELECT data FROM heavy_jobs WHERE id=?').get('heavy_status').data as string).notice_delivered_at).toBeGreaterThan(0)
  } finally { db.close(); await s.close(); rmSync(root, { recursive: true, force: true }) }
}, 30_000)
