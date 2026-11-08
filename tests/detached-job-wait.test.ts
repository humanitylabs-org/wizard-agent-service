import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detachedJobRow, createDetachedJobReader, createLedger } from '../server/detached-job-wait.mjs'
import { pendingHeavyJobs, heavyResultOwed } from '../server/heavy-wait.mjs'
import { guardHeavyStatus } from '../server/thread-status.mjs'
import { projectOpenAskSession, backgroundHelperStatus, threadBackground, liveWorker } from '../server/open-ask.mjs'

const sid = 'wizard_deploy_fixture'
const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const job = (over: Record<string, unknown> = {}) => ({ id: 'j1', requested_by_session: sid, status: 'running', created_at: iso(now - 4 * 60_000),
  timeout: 5400, verify_s: 300, what: 'Agent service update', ...over })

test('a launching or running detached deploy is a pending job for the thread that launched it', () => {
  for (const status of ['launching', 'running']) {
    const row = detachedJobRow(job({ status }), now)
    assert.equal(row?.sessionId, sid)
    assert.equal(pendingHeavyJobs([row], [sid], now).get(sid)?.pending, 1, status)
    assert.equal(heavyResultOwed(row), true)
  }
})

test('a reported, failed-to-post, session-less, future or overdue deploy no longer holds the thread', () => {
  for (const over of [{ status: 'reported' }, { status: 'post_failed' }, { requested_by_session: '', thread: '' }, { created_at: iso(now + 3_600_000) },
    { created_at: iso(now - (5400 + 300 + 700) * 1000) }, { created_at: 'garbage' }]) assert.equal(detachedJobRow(job(over), now), null, JSON.stringify(over))
})

test('the reader lists only live deploys, keeps array identity while nothing changes, and drops a job the moment it reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'detached-'))
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(job({ id: 'a' })))
    writeFileSync(join(dir, 'b.json'), JSON.stringify(job({ id: 'b', status: 'reported' })))
    writeFileSync(join(dir, 'c.json'), '{ not json')
    writeFileSync(join(dir, 'a.log'), 'ignored')
    const reader = createDetachedJobReader(dir, { ttlMs: 0 })
    const first = reader.rows(now)
    assert.deepEqual(first.map((r: any) => r.job_id), ['deploy:a'])
    assert.equal(reader.rows(now), first, 'unchanged receipts keep one snapshot')
    writeFileSync(join(dir, 'a.json'), JSON.stringify(job({ id: 'a', status: 'reported' })))
    assert.deepEqual(reader.rows(now), [])
    assert.deepEqual(createDetachedJobReader(join(dir, 'missing')).rows(now), [])
    assert.deepEqual(createDetachedJobReader('').rows(now), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the combined ledger keeps heavy rows first and one identity per unchanged pair', () => {
  const heavy = [{ job_id: 'h1', sessionId: 'x' }], deploy = [detachedJobRow(job(), now)]
  const ledger = createLedger(() => heavy, () => deploy)
  const out = ledger()
  assert.equal(out.length, 2); assert.equal(out[0].job_id, 'h1')
  assert.equal(ledger(), out)
  assert.equal(createLedger(() => heavy, () => [])(), heavy, 'no detached jobs: the heavy snapshot passes through untouched')
})

test('a done reply is held as progress while the deploy runs, and settles when it reports', () => {
  const done = { state: 'done', ask: 'Fix merged; deploy queued' }
  assert.equal(guardHeavyStatus(done, { jobs: [detachedJobRow(job(), now)], agentId: 'hermes', sessionId: sid })?.state, 'fyi')
  assert.equal(guardHeavyStatus(done, { jobs: [], agentId: 'hermes', sessionId: sid })?.state, 'done')
})

const stalled = { phase: 'stalled', pending: 0, returned: 2, since: now / 1000 - 258, resumeEligible: true, failed: false }
const replies = [{ timestamp: 200, status: { state: 'done', ask: 'Deploy started; nothing needed from you' } }]
const session = (extra = {}) => ({ id: sid, status: 'completed', wizard_helper_status: stalled, ...extra })

test('returned helpers plus a running deploy: Working on background work, not Stuck, no Resume', () => {
  const truth = { heavyPending: true, helperStatus: stalled }
  const row = projectOpenAskSession(session(), { replies, lastUserAt: 100, background: threadBackground(truth), heavyPending: true, live: liveWorker(truth) })
  assert.equal(row.status, 'running')
  assert.equal(row.wizard_waiting_on, 'helper')
  assert.equal(row.wizard_helper_status.phase, 'background')
  assert.equal(row.wizard_helper_status.resumeEligible, false)
})

test('the same thread with no running job is unchanged: a genuinely stuck chat still shows Stuck with Resume', () => {
  const truth = { helperStatus: stalled }
  const row = projectOpenAskSession(session(), { replies, lastUserAt: 100, background: threadBackground(truth), heavyPending: false, live: liveWorker(truth) })
  assert.equal(row.wizard_helper_status.phase, 'stalled')
  assert.equal(row.wizard_helper_status.resumeEligible, true)
})

test('only returned-helper phases turn into background; running, held, uncertain and failed ones are left alone', () => {
  for (const phase of ['stalled', 'waiting']) assert.deepEqual(backgroundHelperStatus({ phase, resumeEligible: true, pending: 0 }), { phase: 'background', resumeEligible: false, pending: 0 })
  for (const phase of ['running', 'integrating', 'held', 'uncertain']) { const h = { phase, pending: 1 }; assert.equal(backgroundHelperStatus(h), h) }
  assert.equal(backgroundHelperStatus(undefined), undefined)
})
