import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createAgentRegistry } from '../server/agents.mjs'
import { createWizardServer, listen } from '../server/service.mjs'
import { DurableRunQueue } from '../server/run-queue.mjs'
import { truthFixture } from './fixtures/chats-truth.mjs'
import { createListWindows } from '../server/session-list-window.mjs'

test('stable window selections reuse normalization without caching across scope, input or age transitions', async () => {
  let at = Date.parse('2026-01-08T00:00:00Z'), reads = 0
  const row = { id: 'wizard_window', last_active: (at - 7 * 864e5 + 1000) / 1000,
    get title() { reads++; return 'Synthetic window' } }
  let rows = [row]
  const page = createListWindows({ now: () => at, reuseSelections: true })
  const params = new URLSearchParams('window=archive-50&limit=50&offset=0')
  const load = async () => rows
  const call = (extra = {}) => page({ params, scope: 'synthetic-account', load, ...extra })
  const first = await call(), initial = reads
  assert.equal(first.archive_total, 0)
  const second = await call()
  assert.equal(reads, initial, 'do not normalize/hash the same immutable rows on every poll')
  assert.equal(second.build, first.build)
  assert.notEqual(second.snapshot, first.snapshot, 'cursor snapshots still have independent lifetimes')
  at += 1000
  const aged = await call()
  assert.equal(aged.archive_total, 1, 'recompute at the exact age boundary, without a stale TTL')
  assert(reads > initial)
  const disposition = { [`direct:${row.id}`]: { deferred: true, updatedAt: new Date(at).toISOString() } }
  assert.equal((await call({ dispositions: disposition })).archive_total, 0)
  assert.equal((await call({ scope: 'another-account' })).archive_total, 1)
  assert.equal((await call({ params: new URLSearchParams('window=archive-50&overrides=' + encodeURIComponent(JSON.stringify({ [row.id]: { deferred: true } }))) })).archive_total, 0)
  rows = [{ ...row, title: 'Changed synthetic window', last_active: at / 1000 }]
  assert.equal((await call()).archive_total, 0, 'new projection identity invalidates the selection')
  // General mutable callers do not opt in and retain the old behavior.
  const mutable = createListWindows({ now: () => at })
  const mutableCall = () => mutable({ params, scope: 'synthetic-account', load })
  assert.equal((await mutableCall()).data[0].title, 'Changed synthetic window')
  rows[0].title = 'Edited in place'
  assert.equal((await mutableCall()).data[0].title, 'Edited in place')
})

const box = t => {
  const dir = mkdtempSync(join(tmpdir(), 'chats-poll-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('observing known authoritative pins does not stat main-agent configuration per row', t => {
  const dir = box(t)
  const registry = createAgentRegistry({ agentsDir: join(dir, 'agents'), mainOrigin: 'http://127.0.0.1:1', mainKey: 'synthetic', appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json') })
  const ids = Array.from({ length: 600 }, (_, i) => `wizard_poll_${i}`)
  registry.observeSessions('hermes', ids)
  const stat = fs.statSync
  let calls = 0
  t.mock.method(fs, 'statSync', (...args) => { calls++; return stat(...args) })
  syncBuiltinESMExports()
  try {
    registry.observeSessions('hermes', ids)
    assert(calls <= 3, `one config check per batch, not per pinned thread: ${calls}`)
    for (const id of ids) assert.equal(registry.pinnedAgent(id), 'hermes')
    // New positive sightings must still be pinned, not bypass the authority check.
    registry.observeSessions('hermes', ['wizard_poll_new'])
    assert.equal(registry.pinnedAgent('wizard_poll_new'), 'hermes')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})

test('durable send replays preserve the shared list snapshot; real admissions invalidate it', async t => {
  const dir = box(t), fixture = truthFixture(dir, 150)
  const queuePath = join(dir, 'queue.db')
  const queue = new DurableRunQueue({ statePath: queuePath, launch: async () => { throw Error('unexpected dispatch') }, lookup: async () => ({}) })
  const body = JSON.stringify({ session_id: 'wizard_truth_149', input: 'Synthetic replay probe' })
  const hash = createHash('sha256').update(`direct\0${body}`).digest('hex')
  await queue.close()
  const db = new DatabaseSync(queuePath)
  db.prepare(`INSERT INTO wizard_run_queue(public_run_id,runtime,session_id,idempotency_key,request_hash,body,status,created_at,updated_at,terminal_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('wizardq_poll_replay', 'direct', 'wizard_truth_149', 'synthetic-key', hash, body, 'completed', Date.now() / 1000, Date.now() / 1000, Date.now() / 1000, JSON.stringify({ status: 'completed', output: 'Synthetic result' }))
  db.close()
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname
    return new Response(JSON.stringify(path === '/v1/capabilities' ? { features: {} } : { data: fixture.sessions }), { headers: { 'Content-Type': 'application/json' } })
  }
  const server = createWizardServer({ requireAccess: false, upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'synthetic-test-key-not-in-message-content', fetchImpl,
    settingsPath: join(dir, 'settings.json'), agentsDir: join(dir, 'agents'), sessionSubjectsPath: join(dir, 'subjects.json'),
    canonicalSessionReader: async () => fixture.sessions, pendingFirstSendReader: () => [], archivedSessionReader: () => [], canonicalSessionListing: true, hermesStatePath: fixture.path,
    listCacheMode: 'on', listCacheTimerMs: 1e9, listCacheStaleMs: 1e9, listCacheHotSeconds: 0,
    runQueueStatePath: queuePath, activeSessionReader: () => [], dispatchHealthReader: () => false,
    joinedDelegation: 'off', followThrough: false, ownedOpenWork: false })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = await listen(server), origin = `http://127.0.0.1:${address.port}`
  const get = async path => { const r = await fetch(origin + path); assert.equal(r.status, 200); return r.json() }
  const list = '/wizard/hermes/api/sessions?view=list&window=archive-50&limit=50&offset=0'
  const before = await get(list), initial = await get('/wizard/list-cache')
  for (let i = 0; i < 5; i++) {
    const replay = await fetch(origin + '/wizard/hermes/v1/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic-key' }, body })
    assert.equal(replay.status, 202); assert.equal(replay.headers.get('Idempotency-Replayed'), 'true'); await replay.json()
    const after = await get(list)
    assert.deepEqual(after.data, before.data)
    assert.equal((await get('/wizard/list-cache')).builds, initial.builds, 'a read-only replay must not expire the snapshot')
  }
  const admission = await fetch(origin + '/wizard/hermes/v1/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic-new-key' }, body })
  assert.equal(admission.status, 202); await admission.json()
  await get(list)
  assert((await get('/wizard/list-cache')).builds > initial.builds, 'new work still invalidates the shared snapshot')
})
