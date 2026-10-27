import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scene, kinds, post } from '../qa/agent-parity/fixture.mjs'
import { guardHeavyStatus } from '../server/thread-status.mjs'

it('completion guard has no age expiry, preserves metadata and leaves owner questions alone', () => {
  const job = { agent_id: 'hermes', sessionId: 's', state: 'failed', resume: '', created_at: Date.now() - 7 * 86_400_000 }
  const status = { state: 'done', ask: '', subject: 'Tests', title: 'Tests · Results', app_id: 'wizard-quest' }
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
        expect(row.wizard_attention?.state, JSON.stringify(job)).toBe('fyi')
        expect(row.wizard_attention.ask).toContain('work')
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
