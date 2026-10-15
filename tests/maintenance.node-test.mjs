import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMaintenanceLease, localRuntimeActivity } from '../server/maintenance.mjs'
const token = '12345678-1234-1234-1234-123456789abc'

test('unknown runtime barrier fails closed, never uses queue-only truth', async () => {
  const lease = createMaintenanceLease({ activity: async () => [{ id: 'hermes', known: true, active: 0 }] })
  await assert.rejects(lease.acquire(token), /runtime_maintenance_barrier_unavailable/)
  assert.equal(lease.blocked(), false)
})
test('all agents including secondary busy/unknown block, scan closes new admission race', async () => {
  let finish, released = 0
  const barrier = { acquire: async () => async () => { released++ }, release: async () => { released++ } }
  const lease = createMaintenanceLease({ barrier, activity: () => new Promise(resolve => { finish = resolve }) })
  const acquisition = lease.acquire(token)
  await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => lease.enter(), /maintenance_active/)
  finish([{ id: 'hermes', known: true, active: 0 }, { id: 'private', known: true, active: 1 }])
  await assert.rejects(acquisition, /agent_busy_or_unknown/)
  assert.equal(released, 1)
  const leave = lease.enter()
  await assert.rejects(lease.acquire(token), /admission_in_flight/)
  leave()
  const unknown = createMaintenanceLease({ barrier, activity: async () => [{ id: 'private', known: false, active: 0 }] })
  await assert.rejects(unknown.acquire(token), /agent_busy_or_unknown/)
})
test('lease survives Service restart and requires exact release token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-'))
  try {
    const options = { path: join(root, 'lease.json'), activity: async () => [{ id: 'hermes', known: true, active: 0 }, { id: 'private', known: true, active: 0 }], barrier: { acquire: async () => async () => {}, release: async () => {} } }
    const lease = createMaintenanceLease(options)
    assert.deepEqual((await lease.acquire(token)).agents, ['hermes', 'private'])
    const restarted = createMaintenanceLease(options)
    assert.throws(() => restarted.enter(), /maintenance_active/)
    await assert.rejects(restarted.release('wrong'), /maintenance_token_mismatch/)
    await restarted.release(token)
    restarted.enter()()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('runtime activity reads actual all-session DB leases, not human/UI filters', () => {
  const root = mkdtempSync(join(tmpdir(), 'activity-')), path = join(root, 'state.db')
  try {
    assert.throws(() => localRuntimeActivity(path), /activity_unknown/)
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL); CREATE TABLE sessions(last_activity_description TEXT,last_activity_at REAL)')
    db.prepare('INSERT INTO session_turn_leases VALUES (?,?)').run('hidden-cron-worker', Date.now()/1000+300)
    db.close()
    assert.equal(localRuntimeActivity(path).active, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
