// Reconciler pacing: failure backoff, idle relaxation after a complete scan, event coalescing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatPhotoReconciler, CHAT_PHOTO_PACING } from '../server/chat-photo-projection.mjs'

const config = { ownerId: 'owner', authorityId: 'a'.repeat(64), database: '', projection: {}, resolveMessage: async () => ({ photos: [], unavailable: [] }) }
const settle = () => new Promise(r => setTimeout(r, 250)) // runStep spawns the python lock helper
function harness(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'photo-pacing-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const clock = { t: 1_000_000, root }, logs = [], calls = { verify: 0, scan: 0 }
  const reconciler = createChatPhotoReconciler({
    ...config, pacing: extra.pacing, statePath: join(root, 'state.json'), now: () => clock.t, log: line => logs.push(line),
    verifyAuthority: async () => { calls.verify++; if (extra.verifyFails) throw new Error('no canonical owner session to authenticate') },
    scanBatch: async () => { calls.scan++; return { evidence: [], counts: {}, cursor: 1, ceiling: 1, done: extra.scanDone ?? true } },
  })
  t.after(() => reconciler.stop())
  return { reconciler, clock, logs, calls }
}

test('persistent authority failure backs off exponentially, logs once per window and spawns no scan', async t => {
  const { reconciler, clock, logs, calls } = harness(t, { verifyFails: true })
  reconciler.kick('startup'); await settle()
  assert.equal(calls.verify, 1); assert.equal(logs.length, 1); assert.match(logs[0], /no canonical owner session.*retry in 3s/)
  // Every 3 s timer tick and every event inside the window is a no-op.
  for (let i = 0; i < 20; i++) { clock.t += 100; reconciler.kick('repair'); reconciler.kick('accepted_user') }
  await settle(); assert.equal(calls.verify, 1); assert.equal(logs.length, 1); assert.equal(calls.scan, 0)
  // Windows double: 3, 6, 12 … capped at 5 min.
  const seen = [3]
  for (let n = 0; n < 12; n++) {
    clock.t += 301_000; reconciler.kick('repair'); await settle()
    seen.push(Number(/retry in (\d+)s/.exec(logs.at(-1))[1]))
  }
  assert.deepEqual(seen.slice(0, 6), [3, 6, 12, 24, 48, 96]); assert.equal(Math.max(...seen), CHAT_PHOTO_PACING.backoffMaxMs / 1000)
  assert.equal(calls.scan, 0)
})

test('a successful run resets the backoff', async t => {
  const root = mkdtempSync(join(tmpdir(), 'photo-pacing-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const clock = { t: 5_000_000 }, logs = []; let failing = true, verifies = 0
  const r = createChatPhotoReconciler({ ...config, statePath: join(root, 's.json'), now: () => clock.t, log: l => logs.push(l),
    verifyAuthority: async () => { verifies++; if (failing) throw new Error('boom') },
    scanBatch: async () => ({ evidence: [], counts: {}, cursor: 1, ceiling: 1, done: false }) })
  t.after(() => r.stop())
  r.kick('repair'); await settle(); clock.t += 3001; r.kick('repair'); await settle()
  assert.deepEqual(logs.map(l => /retry in (\d+)s/.exec(l)[1]), ['3', '6'])
  failing = false; clock.t += 6001; r.kick('repair'); await settle(); assert.equal(verifies, 3)
  failing = true; clock.t += 3001; r.kick('repair'); await settle()
  assert.match(logs.at(-1), /retry in 3s/) // back to the first window, not 12 s
})

test('complete scan relaxes repair to the idle interval and coalesces event kicks', async t => {
  const { reconciler, clock, calls } = harness(t, { pacing: { eventMinMs: 50 } })
  reconciler.kick('startup'); await settle(); assert.equal(calls.scan, 1)
  // Periodic repair every 3 s does nothing for a minute.
  for (let i = 0; i < 19; i++) { clock.t += 3000; reconciler.kick('repair') }
  await settle(); assert.equal(calls.scan, 1)
  clock.t += 3000; reconciler.kick('repair'); await settle(); assert.equal(calls.scan, 2) // 60 s elapsed
  // A burst of events is held back, then served by exactly one trailing scan.
  clock.t += 10
  for (let i = 0; i < 50; i++) reconciler.kick('accepted_user')
  await settle(); assert.equal(calls.scan, 2)
  clock.t += 1000
  await new Promise(r => setTimeout(r, 120)); await settle()
  assert.equal(calls.scan, 3)
  await new Promise(r => setTimeout(r, 120)); assert.equal(calls.scan, 3)
  const state = JSON.parse(readFileSync(join(clock.root, 'state.json')))
  assert.equal(state.event_counts.accepted_user, 50); assert.ok(state.event_counts.repair <= 3)
})

test('an incomplete scan keeps the fast 3 s cadence', async t => {
  const { reconciler, clock, calls } = harness(t, { scanDone: false })
  for (let i = 0; i < 4; i++) { reconciler.kick('repair'); await settle(); clock.t += 3000 }
  assert.equal(calls.scan, 4)
})
