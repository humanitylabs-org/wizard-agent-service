// Finished helpers must wake their thread (James, 7 Nov 2026: threads fell into Ready as "stopped").
// Hermes 0.22.7 persists every canonical /v1/runs admission — the owner's own replies included — as an
// internal_notification row stamped with the admission's submission_id. Treating every such row as
// machinery hid the owner's "adopt", so an older needs_you looked current and the watcher held the
// completion forever. Separately, a retry after a failed/interrupted attempt reused that attempt's
// idempotency key with a new body and died on "idempotency key conflict".
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { findPendingFollowThroughs, startDelegationFollowThrough, resolveHelperAttempt, helperAttemptKey } from '../server/delegation-follow-through.mjs'
import { ownerGate, ownerMovedOn, isHumanRequest } from '../server/delegation-receipts.mjs'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { fixture, withServer, sid } from './fixtures/helper-backend.mjs'

const now = Date.now()
const sec = now / 1000
const status = (state: string) => `Done.\n[WIZARD_STATUS_V1]{"state":"${state}","ask":"Reply adopt"}[/WIZARD_STATUS_V1]`
const submitted = JSON.stringify({ gateway_input_owner: 'owner-1', submission_id: 'run_abc' })

// The real 7 Nov thread shape: needs_you → owner "adopt" (0.22.7 row) → fyi + helpers → completion.
function thread({ ownerMeta = submitted, afterFyi = '' } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'wz-ft0227-')), 'state.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1,
    tool_calls TEXT, display_kind TEXT, display_metadata TEXT, finish_reason TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
    CREATE TABLE async_delegations(delegation_id TEXT, origin_session_id TEXT, parent_session_id TEXT, state TEXT, delivery_state TEXT, result_json TEXT, dispatched_at REAL, completed_at REAL);`)
  const add = db.prepare('INSERT INTO messages(session_id,role,content,timestamp,display_kind,display_metadata,finish_reason) VALUES(?,?,?,?,?,?,?)')
  add.run('wizard_t', 'user', 'Should I adopt the installer?', sec - 900, 'internal_notification', submitted, null)
  add.run('wizard_t', 'assistant', status('needs_you'), sec - 890, null, null, 'stop')
  add.run('wizard_t', 'user', 'adopt', sec - 800, 'internal_notification', ownerMeta, null)
  add.run('wizard_t', 'assistant', 'Two helpers are rehearsing.\n[WIZARD_STATUS_V1]{"state":"fyi","ask":"Rehearsing"}[/WIZARD_STATUS_V1]', sec - 780, null, null, 'stop')
  if (afterFyi) add.run('wizard_t', 'assistant', afterFyi, sec - 700, null, null, 'stop')
  add.run('wizard_t', 'user', '[ASYNC DELEGATION BATCH COMPLETE — deleg_t] 2 subagents finished.', sec - 60, 'async_delegation_complete', '{"delegation_id":"deleg_t"}', null)
  db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?)').run('deleg_t', 'wizard_t', 'wizard_t', 'completed', 'delivered',
    JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'Rehearsal passed' }] }), sec - 780, sec - 60)
  db.close()
  return path
}

test('an owner reply persisted by Hermes 0.22.7 clears the older needs_you gate, so the completion is pending', () => {
  const path = thread()
  const db = new DatabaseSync(path, { readOnly: true })
  try { assert.equal(ownerGate(db, 'wizard_t'), null) } finally { db.close() }
  const pending = findPendingFollowThroughs(path, { now })
  assert.deepEqual(pending.map((p: any) => [p.sessionId, p.delegationId, p.key]), [['wizard_t', 'deleg_t', 'wizard-helper-receipt-deleg_t']])
})

test('a gateway self-injected wake (internal_notification without submission_id) is still machinery, so the gate holds', () => {
  const path = thread({ ownerMeta: JSON.stringify({ gateway_input_owner: 'owner-1' }) })
  assert.deepEqual(findPendingFollowThroughs(path, { now }), [])
  assert.equal(isHumanRequest({ role: 'user', content: 'Process finished', display_kind: 'internal_notification' }), false)
  assert.equal(isHumanRequest({ role: 'user', content: '[Wizard follow-through] x', display_kind: 'internal_notification', display_metadata: submitted }), false)
})

test('a needs_you written after the owner reply still holds the completion (owner gate kept)', () => {
  assert.deepEqual(findPendingFollowThroughs(thread({ afterFyi: status('needs_you') }), { now }), [])
})

test('an owner reply after the completion means the owner moved on', () => {
  const path = thread()
  const db = new DatabaseSync(path)
  db.prepare('INSERT INTO messages(session_id,role,content,timestamp,display_kind,display_metadata) VALUES(?,?,?,?,?,?)')
    .run('wizard_t', 'user', 'Actually stop', sec - 30, 'internal_notification', submitted)
  try { assert.equal(ownerMovedOn(db, 'wizard_t', sec - 60), true) } finally { db.close() }
})

test('a completion that arrived just before an Agent Service restart is followed through once by the restarted watcher', async () => {
  const path = thread()
  const admitted: string[] = []
  const admit = async (id: string, _input: string, key: string) => { admitted.push(`${id}|${key}`) }
  // Old process: died before its first tick saw the row.
  const before = startDelegationFollowThrough({ sessionDbPath: path, find: () => findPendingFollowThroughs(path, { now }), intervalMs: 60_000, enabled: async () => true, admit })
  await before.stop()
  const after = startDelegationFollowThrough({ sessionDbPath: path, find: () => findPendingFollowThroughs(path, { now }), intervalMs: 60_000, enabled: async () => true, admit })
  try { await after.tick(); await after.tick() } finally { await after.stop() }
  assert.deepEqual(admitted, ['wizard_t|wizard-helper-receipt-deleg_t'])
})

test('attempt resolution: failed earlier attempt gets a fresh key; live, finished or cancelled attempts stand', async () => {
  const records: Record<string, { status: string, upstreamRunId?: string }> = {}
  const lookup = (k: string) => records[k] ?? null
  assert.deepEqual(await resolveHelperAttempt('k', { lookup }), { key: 'k', attempt: 1 })
  records.k = { status: 'failed' }
  assert.deepEqual(await resolveHelperAttempt('k', { lookup }), { key: helperAttemptKey('k', 2), attempt: 2 })
  records.k = { status: 'interrupted', upstreamRunId: 'run_1' }
  const live = await resolveHelperAttempt('k', { lookup, upstreamLive: async () => true })
  assert.equal(live.record, records.k) // already running upstream: no second turn
  const unknown = await resolveHelperAttempt('k', { lookup, upstreamLive: async () => { throw new Error('down') } })
  assert.equal(unknown.record, records.k)
  for (const s of ['queued', 'running', 'completed', 'cancelled']) {
    records.k = { status: s }
    assert.equal((await resolveHelperAttempt('k', { lookup })).record, records.k)
  }
  records.k = { status: 'failed' }; records[helperAttemptKey('k', 2)] = { status: 'interrupted' }; records[helperAttemptKey('k', 3)] = { status: 'failed' }
  assert.deepEqual(await resolveHelperAttempt('k', { lookup }), { exhausted: true })
})

async function seedQueue(dir: string, status: string, upstreamRunId = '') {
  const queue = new DurableRunQueue({ statePath: dir + '/queue.db', pollIntervalMs: 0, canDispatch: () => false, launch: async () => ({}), lookup: async () => ({}) } as any)
  const body = JSON.stringify({ session_id: sid, input: 'an older attempt body' })
  const { record }: any = queue._admitRow({ runtime: 'direct', sessionId: sid, idempotencyKey: 'wizard-helper-receipt-deleg_review', requestHash: queueRequestHash('direct', body), body })
  queue._update(record.publicRunId, { status, ...(upstreamRunId ? { upstreamRunId } : {}) })
  queue.close()
}
const queueRows = (dir: string) => {
  const q = new DatabaseSync(dir + '/queue.db', { readOnly: true })
  try { return q.prepare('SELECT idempotency_key AS key, status FROM wizard_run_queue ORDER BY created_at').all() as Array<{ key: string, status: string }> } finally { q.close() }
}

test('idempotency conflict with a previous failed attempt still wakes the thread under a fresh attempt key', () => fixture(async (c: any) => {
  await seedQueue(c.dir, 'failed')
  await withServer(c.path, async (server: any) => {
    const response = await server.post()
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()))
    const rows = queueRows(c.dir)
    assert.deepEqual(rows.map(r => r.key), ['wizard-helper-receipt-deleg_review', 'wizard-helper-receipt-deleg_review~attempt-2'])
    assert.equal(rows[0].status, 'failed')
  }, { runQueueStatePath: c.dir + '/queue.db', runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => false })
}))

test('no double wake: an interrupted attempt whose upstream run is still live is "already running", not re-admitted', () => fixture(async (c: any) => {
  await seedQueue(c.dir, 'interrupted', 'run_still_live')
  await withServer(c.path, async (server: any) => {
    const response = await server.post()
    assert.equal(response.status, 202)
    assert.deepEqual(queueRows(c.dir).map(r => r.key), ['wizard-helper-receipt-deleg_review'])
    assert.equal(server.launches, 0)
  }, { runQueueStatePath: c.dir + '/queue.db', runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => false,
    upstreamRunStatus: (url: string) => url.includes('run_still_live') ? 'running' : 'completed' })
}))
