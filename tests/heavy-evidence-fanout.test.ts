import { it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scene } from '../qa/agent-parity/fixture.mjs'
import * as owned from '../server/owned-open-work-follow-through.mjs'

// Count the real SQLite-backed reader, not an invented fast replacement.
vi.mock('../server/owned-open-work-follow-through.mjs', { spy: true })

it('live list projection bounds transcript reads by relevant threads, not historical heavy jobs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-fanout-'))
  const statePath = join(root, 'heavy.db'), now = Date.now(), id = 'wizard_fanout'
  const s = await scene('main', { heavyStatePath: statePath, heavyToken: 'synthetic-heavy-fanout-token-000000000',
    heavyPollIntervalMs: 3_600_000, ownedOpenWorkIntervalMs: 3_600_000,
    followThrough: true, ownedOpenWork: true, listCacheMode: 'off',
    heavyTransport: async () => { throw Error('no worker traffic allowed') } })
  const db = new DatabaseSync(statePath), canonical = new DatabaseSync(join(s.root, 'hermes-state.db'))
  canonical.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT; ALTER TABLE messages ADD COLUMN tool_call_id TEXT; CREATE INDEX messages_session ON messages(session_id)')
  const attention = { state: 'check', ask: 'Check the finished synthetic repair', subject: 'Speed fixture' }
  // A body-heavy real transcript makes accidental per-job reads meaningful.
  s.sessions.set(id, { id, source: 'wizard-mobile', title: 'Synthetic heavy fanout', created_at: now / 1000 - 3600,
    messages: [...Array.from({ length: 80 }, (_, i) => ({ role: 'user', content: `Synthetic request ${i} ${'x'.repeat(4096)}`, timestamp: now / 1000 - 100 + i })),
      { role: 'assistant', timestamp: now / 1000 - 1,
        content: `Finished\n[WIZARD_STATUS_V1]${JSON.stringify(attention)}[/WIZARD_STATUS_V1]` }] })
  const save = (count: number, over: any = {}) => {
    db.exec('DELETE FROM heavy_jobs; BEGIN')
    const put = db.prepare('INSERT INTO heavy_jobs(id,session,origin,key,hash,data,agent_id) VALUES(?,?,?,?,?,?,?)')
    for (let i = 0; i < count; i++) {
      const job = { job_id: `synthetic_${i}`, sessionId: id, agent_id: 'hermes', state: 'completed',
        created_at: now, resume: 'delivered', completion_delivered_at: now, ...over }
      put.run(job.job_id, id, 'synthetic', String(i), 'synthetic', JSON.stringify(job), job.agent_id)
    }
    db.exec('COMMIT')
  }
  const list = async () => {
    vi.mocked(owned.readNonHoldingFollowUps).mockClear()
    const started = performance.now()
    const response = await s.request('/api/sessions?limit=100&view=list')
    expect(response.status).toBe(200)
    const row = (await response.json()).data.find((r: any) => r.id === id)
    expect(row).toBeDefined()
    return { row, reads: vi.mocked(owned.readNonHoldingFollowUps).mock.calls.length, ms: performance.now() - started }
  }
  try {
    const empty = await list()
    expect(empty.row.attention).toEqual(attention)
    save(600)
    const delivered = await list()
    expect(delivered.row.attention).toEqual(attention)
    expect(delivered.row.status).not.toBe('running')
    expect(delivered.reads).toBe(empty.reads)
    save(1, { state: 'running', resume: '', completion_delivered_at: undefined })
    const one = await list()
    expect(one.row.status).toBe('running')
    expect(one.row.attention.state).toBe('fyi')
    save(600, { state: 'running', resume: '', completion_delivered_at: undefined })
    const many = await list()
    expect(many.row).toEqual(one.row)
    expect(many.reads).toBe(one.reads)
    expect(many.reads).toBeLessThanOrEqual(empty.reads + 2)
    save(600, { agent_id: 'foreign-agent', state: 'running', resume: '', completion_delivered_at: undefined })
    const foreign = await list()
    expect(foreign.row.attention).toEqual(attention)
    expect(foreign.row.status).not.toBe('running')
    expect(foreign.reads).toBe(empty.reads)
    console.log('HEAVY_EVIDENCE_FANOUT ' + JSON.stringify(Object.fromEntries(Object.entries({ empty, delivered, one, many, foreign }).map(([k, v]) => [k, { reads: v.reads, ms: v.ms }]))))
    expect(s.seen.filter((r: any) => r.method !== 'GET')).toEqual([])
  } finally { canonical.close(); db.close(); await s.close(); rmSync(root, { recursive: true, force: true }) }
}, 30_000)
