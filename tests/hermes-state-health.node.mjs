// Issue 430: a single-file bind mount of state.db-wal/-shm keeps the old inode after Hermes recreates
// them, so the archive read fails ("database disk image is malformed") or freezes. The service must say
// so in /wizard/health and in its log instead of swallowing it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHermesStateHealth, staleHermesStateFiles } from '../server/hermes-state-health.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const unlinkedWal = (path) => {
  const real = statSync(path)
  return path.endsWith('-wal') ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { nlink: 0 }) : real
}

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-state-health-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const sessionsDb = (path) => {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL, ended_at REAL, end_reason TEXT,
    message_count INTEGER, parent_session_id TEXT, last_activity_at REAL, pinned INTEGER, archived INTEGER, hidden INTEGER)`)
  db.close()
}

test('a mounted file the host replaced (zero links) is named; live files and missing ones are not', (t) => {
  const dir = scratch(t), db = join(dir, 'state.db')
  sessionsDb(db)
  writeFileSync(`${db}-wal`, '')
  assert.deepEqual(staleHermesStateFiles(db), [])
  assert.deepEqual(staleHermesStateFiles(db, { stat: unlinkedWal }), ['state.db-wal'])
  assert.deepEqual(staleHermesStateFiles(''), [])
})

test('a failing read is logged once with its SQLite code, re-thrown, and clears on the next good read', (t) => {
  const lines = []
  let clock = 1_000
  const health = createHermesStateHealth({ dbPath: join(scratch(t), 'state.db'), log: (l) => lines.push(l), now: () => clock })
  const malformed = Object.assign(new Error('database disk image is malformed'), { errcode: 11 })
  for (let i = 0; i < 3; i++) assert.throws(() => health.read('archive', () => { throw malformed }), /malformed/)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /archive read .* failed \(11: database disk image is malformed\)/)
  const report = health.report()
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'read_failed')
  assert.equal(report.last_error.code, '11')
  clock += 6 * 60_000
  assert.throws(() => health.read('archive', () => { throw malformed }))
  assert.equal(lines.length, 2, 'the same failure is logged again after five minutes')
  assert.deepEqual(health.read('archive', () => [1]), [1])
  assert.deepEqual(health.report(), { ok: true })
})

test('one reader recovering does not hide another reader that still fails', (t) => {
  const health = createHermesStateHealth({ dbPath: join(scratch(t), 'state.db'), log: () => {} })
  const malformed = Object.assign(new Error('database disk image is malformed'), { errcode: 11 })
  assert.throws(() => health.read('archive', () => { throw malformed }))
  assert.deepEqual(health.read('list', () => []), [])
  const report = health.report()
  assert.equal(report.ok, false)
  assert.deepEqual(report.failing, ['archive'])
  assert.deepEqual(health.read('archive', () => []), [])
  assert.deepEqual(health.report(), { ok: true })
})

test('alternating health polls and failing reads still log each kind once per five minutes', (t) => {
  const dir = scratch(t), db = join(dir, 'state.db'), lines = []
  sessionsDb(db)
  writeFileSync(`${db}-wal`, '')
  const health = createHermesStateHealth({ dbPath: db, stat: unlinkedWal, log: (l) => lines.push(l), now: () => 1_000 })
  const malformed = Object.assign(new Error('database disk image is malformed'), { errcode: 11 })
  for (let i = 0; i < 5; i++) {
    health.report()
    assert.throws(() => health.read('archive', () => { throw malformed }))
  }
  assert.equal(lines.length, 2)
})

test('/wizard/health reports hermes_state: ok on a live database, stale_mount after Hermes replaced its -wal', async (t) => {
  const dir = scratch(t), db = join(dir, 'state.db')
  sessionsDb(db)
  writeFileSync(`${db}-wal`, '')
  let stat = statSync
  const logged = []
  const fetchImpl = async (url) => {
    const u = new URL(url)
    if (u.pathname === '/v1/capabilities') return Response.json({ features: {} })
    if (u.pathname === '/api/sessions') return Response.json({ data: [], has_more: false })
    return Response.json({})
  }
  const server = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'synthetic-health-key', fetchImpl, requireAccess: false,
    hermesStatePath: db, hermesStateStat: (p) => stat(p), hermesStateLog: (l) => logged.push(l),
    agents: false, agentBridge: false, followThrough: false, joinedDelegation: 'off', ownedOpenWork: false, respellStoredTitles: false,
    wizardOsHome: join(dir, 'os'), appsJsonPath: join(dir, 'apps.json'), runQueueStatePath: '' })
  const address = await listen(server)
  t.after(() => new Promise((done) => server.close(done)))
  const health = async () => (await fetch(`http://127.0.0.1:${address.port}/wizard/health`)).json()

  const fresh = await health()
  assert.equal(fresh.status, 'ok')
  assert.deepEqual(fresh.hermes_state, { ok: true })

  stat = unlinkedWal
  const stale = await health()
  assert.equal(stale.status, 'ok', 'the service itself still answers')
  assert.equal(stale.hermes_state.ok, false)
  assert.equal(stale.hermes_state.reason, 'stale_mount')
  assert.deepEqual(stale.hermes_state.stale, ['state.db-wal'])
  assert.match(stale.hermes_state.hint, /restart the Agent Service/)
  assert(logged.some((l) => l.includes('stale mount: state.db-wal')))
})

test('/wizard/health has no hermes_state when no Hermes state database is configured', async (t) => {
  const dir = scratch(t)
  const server = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'synthetic-health-key', requireAccess: false,
    fetchImpl: async () => Response.json({}), hermesStatePath: '', agents: false, agentBridge: false, followThrough: false, joinedDelegation: 'off',
    wizardOsHome: join(dir, 'os'), appsJsonPath: join(dir, 'apps.json'), runQueueStatePath: '' })
  const address = await listen(server)
  t.after(() => new Promise((done) => server.close(done)))
  const body = await (await fetch(`http://127.0.0.1:${address.port}/wizard/health`)).json()
  assert.equal(body.status, 'ok')
  assert.equal('hermes_state' in body, false)
})
