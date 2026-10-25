import { test } from 'vitest'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pendingHeavyJobs, withoutOwnerGates, HEAVY_WAIT_CAP_SECONDS } from '../server/heavy-wait.mjs'

const sid = 'wizard_heavy_fixture'
const now = Date.now()
const job = (over: Record<string, unknown> = {}) => ({ job_id: 'heavy_one', sessionId: sid, agent_id: 'hermes', state: 'queued', resume: '',
  cancel_requested: false, continuation_invalidated: false, created_at: now - 60_000, ...over })
const status = (state: string) => ` [WIZARD_STATUS_V1]{"state":"${state}","ask":"x","subject":"Wizard OS","title":"T · X"}[/WIZARD_STATUS_V1]`

function stateDb(fn: (db: DatabaseSync, path: string) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-wait-')), path = join(dir, 'state.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INT DEFAULT 1,display_kind TEXT)')
  return Promise.resolve(fn(db, path)).finally(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
}
const say = (db: DatabaseSync, role: string, content: string, at: number) =>
  db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run(sid, role, content, at)

test('a queued or running job, or a finished one whose result is not yet delivered, keeps its thread waiting', () => {
  for (const state of ['queued', 'running', 'completed', 'failed']) assert.equal(pendingHeavyJobs([job({ state })], [sid], now).get(sid)?.pending, 1, state)
})

test('admitted, superseded, suppressed, cancelled, invalidated, foreign, unlisted and stale jobs do not', () => {
  const none = [
    job({ state: 'completed', resume: 'wizardq_0123' }), job({ resume: 'superseded' }), job({ resume: 'suppressed' }),
    job({ state: 'cancelled' }), job({ cancel_requested: true }), job({ continuation_invalidated: true }),
    job({ agent_id: 'private-agent' }), job({ sessionId: 'other' }), job({ created_at: now - (HEAVY_WAIT_CAP_SECONDS + 60) * 1000 }),
  ]
  assert.equal(pendingHeavyJobs(none, [sid], now).size, 0)
})

test('an open owner question since the latest request keeps the thread in Ready; a progress handoff does not', () => stateDb((db, path) => {
  const t = now / 1000
  say(db, 'user', 'Build it and test it on Thales', t - 600)
  say(db, 'assistant', 'Tests are queued on Thales; the result comes back here.', t - 300)
  assert.equal(withoutOwnerGates(path, pendingHeavyJobs([job()], [sid], now)).size, 1)
  say(db, 'assistant', 'Pick layout A or B before I continue.' + status('needs_you'), t - 200)
  assert.equal(withoutOwnerGates(path, pendingHeavyJobs([job()], [sid], now)).size, 0)
  // A newer genuine request releases the old question; machine follow-through turns do not.
  say(db, 'user', '[Wizard follow-through] Recovered helper receipt deleg_x\nfindings', t - 150)
  assert.equal(withoutOwnerGates(path, pendingHeavyJobs([job()], [sid], now)).size, 0)
  say(db, 'user', 'A. Go ahead.', t - 100)
  assert.equal(withoutOwnerGates(path, pendingHeavyJobs([job()], [sid], now)).size, 1)
}))

test('session-list projection keeps a thread with an owed heavy job in Working through the real API code', () => stateDb(async (db, path) => {
  const { createWizardServer, listen } = await import('../server/service.mjs')
  db.exec('ALTER TABLE messages ADD COLUMN finish_reason TEXT DEFAULT "stop"; CREATE TABLE sessions(id TEXT PRIMARY KEY,started_at REAL,model TEXT,model_config TEXT); CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL); CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY,origin_session_id TEXT,parent_session_id TEXT,origin_ui_session_id TEXT,state TEXT,dispatched_at REAL,completed_at REAL,task_json TEXT,delivery_state TEXT,result_json TEXT)')
  const t = now / 1000
  db.prepare('INSERT INTO sessions(id,started_at) VALUES(?,?)').run(sid, t - 900)
  say(db, 'user', 'Build it and test it on Thales', t - 600)
  say(db, 'assistant', 'Tests are queued on Thales; the result comes back here.', t - 300)
  const heavyPath = join(path, '..', 'heavy.sqlite3')
  const s = createWizardServer({ archivedSessionReader: () => [], requireAccess: false, hermesKey: 'fixture-only', hermesStatePath: path, sessionDbPath: path,
    followThrough: false, runQueueStatePath: join(path, '..', 'queue.sqlite3'), heavyStatePath: heavyPath, heavyToken: 'f'.repeat(40), heavyTransport: async (p: any) => ({ job_id: p.job_id, state: 'queued' }),
    fetchImpl: async (url: string) => new Response(JSON.stringify(String(url).includes('/api/sessions?') ? { data: [{ id: sid, source: 'api_server', title: 'Heavy example' }] } : { data: [] }), { headers: { 'content-type': 'application/json' } }) })
  await listen(s)
  const list = async () => (await (await fetch(`http://127.0.0.1:${(s.address() as any).port}/wizard/hermes/api/sessions?limit=10`)).json()).data[0]
  try {
    const before = await list()
    assert.notEqual(before.status, 'running')
    const heavy = new DatabaseSync(heavyPath)
    heavy.prepare('INSERT INTO heavy_jobs(id,session,origin,key,hash,data,agent_id) VALUES(?,?,?,?,?,?,?)')
      .run('heavy_one', sid, 'wizardq_origin', 'k', 'h', JSON.stringify(job()), 'hermes')
    heavy.close()
    await new Promise(r => setTimeout(r, 1100))
    const during = await list()
    assert.equal(during.status, 'running')
    assert.equal(during.wizard_waiting_on, 'helper')
  } finally { s.closeAllConnections?.(); await new Promise(r => s.close(r)) }
}), 20_000)
