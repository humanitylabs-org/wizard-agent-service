import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { DismissedFailureStore } from '../server/thread-seen.mjs'
import { createWizardServer, listen } from '../server/service.mjs'
import { createRoutedQueues } from '../server/routed-run-queue.mjs'

const failure = { status: 'completed', output: '⚠️ Provider authentication failed: synthetic expired sign-in', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
const success = { status: 'completed', output: 'Synthetic answer' }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'provider-dismiss-startup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const statePath = join(root, 'queue.sqlite3')
  const sent = []
  let recovered = false
  const options = { statePath, pollIntervalMs: 0, providerAccessRecovery: true,
    launch: async record => { sent.push(record); return { upstreamRunId: record.publicRunId, payload: recovered ? success : failure } },
    lookup: async () => ({ payload: recovered ? success : failure }) }
  const open = (extra = {}) => { const q = new DurableRunQueue({ ...options, ...extra }); t.after(() => q.close()); return q }
  const admit = async (q, sessionId, input = 'saved owner words', continuation = null) => {
    const body = JSON.stringify({ session_id: sessionId, input, provider: 'synthetic', model: 'original' })
    return (await q.admit({ runtime: 'direct', sessionId, idempotencyKey: crypto.randomUUID(), requestHash: queueRequestHash('direct', body), body, continuation })).record
  }
  return { root, statePath, sent, open, admit, recover: () => { recovered = true } }
}

// Both assertions belong to the normal npm test graph, not an ad-hoc acceptance script.
test('A dismissed error never sends itself later', async t => {
  await t.test('Dismiss releases every waiting row immediately, including queued failures without run references', async t => {
    const f = fixture(t)
    const q = f.open()
    const helper = await f.admit(q, 'wizard_dismissed', 'helper delivery', { kind: 'helper' })
    const owner = await f.admit(q, 'wizard_dismissed')
    const other = await f.admit(q, 'wizard_other')
    await q.close()
    const dismissPath = join(f.root, 'dismissed-failures.json')
    const os = join(f.root, 'os'); mkdirSync(os)
    const server = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:19876',
      fetchImpl: async () => Response.json({}), hermesKey: 'synthetic-key', requireAccess: false,
      agents: false, agentBridge: false, followThrough: false, joinedDelegation: 'off', wizardOsHome: os,
      runQueueStatePath: f.statePath, runQueuePollIntervalMs: 0, providerAccessRecovery: true,
      dismissedFailureStatePath: dismissPath, activeSessionReader: async () => [], dispatchHealthReader: () => true })
    t.after(() => new Promise(resolve => server.close(resolve)))
    const address = await listen(server)
    const response = await fetch(`http://127.0.0.1:${address.port}/wizard/session-failure/wizard_dismissed/dismiss`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 200, await response.text())
    const db = new DatabaseSync(f.statePath, { readOnly: true }); t.after(() => db.close())
    for (const source of [helper, owner]) {
      const row = db.prepare('SELECT status,waiting_reason FROM wizard_run_queue WHERE public_run_id=?').get(source.publicRunId)
      assert.equal(row.status, 'cancelled', 'Dismiss must release waiting requests before responding')
      assert.equal(row.waiting_reason, '')
    }
    assert.equal(db.prepare('SELECT waiting_reason FROM wizard_run_queue WHERE public_run_id=?').get(other.publicRunId).waiting_reason, 'provider_access')
    assert(new DismissedFailureStore(dismissPath).isDismissed('wizard_dismissed', owner.publicRunId), 'queued failure identity is durable')
  })

  await t.test('A persisted dismissal fences startup recovery even if the process died before releasing rows', async t => {
    const f = fixture(t)
    const q = f.open()
    const source = await f.admit(q, 'wizard_crash_after_dismiss')
    await q.close()
    const dismissPath = join(f.root, 'dismissed-failures.json')
    // A newer external run reference can be the display key: session intent still wins.
    new DismissedFailureStore(dismissPath).dismiss(source.sessionId, 'synthetic-external-reference')
    const os = join(f.root, 'os'); mkdirSync(os)
    const calls = []
    const server = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:19876',
      fetchImpl: async (url, init = {}) => {
        if (new URL(url).pathname.endsWith('/chat/stream') && init.method === 'POST') calls.push(JSON.parse(String(init.body)))
        return Response.json({})
      }, hermesKey: 'synthetic-key', requireAccess: false, agents: false, agentBridge: false,
      followThrough: false, joinedDelegation: 'off', wizardOsHome: os, runQueueStatePath: f.statePath,
      runQueuePollIntervalMs: 0, providerAccessRecovery: true, dismissedFailureStatePath: dismissPath,
      activeSessionReader: async () => [], dispatchHealthReader: () => true })
    t.after(() => new Promise(resolve => server.close(resolve)))
    const address = await listen(server)
    await fetch(`http://127.0.0.1:${address.port}/wizard/hermes/v1/runs/${source.publicRunId}`).then(r => r.arrayBuffer())
    const db = new DatabaseSync(f.statePath, { readOnly: true }); t.after(() => db.close())
    assert.equal(db.prepare('SELECT status FROM wizard_run_queue WHERE public_run_id=?').get(source.publicRunId).status, 'cancelled')
    assert.equal(calls.length, 0)
  })

  await t.test('Dismiss wins even after automatic recovery admission while dispatch is blocked', async t => {
    const f = fixture(t)
    let canDispatch = true, dismissed = false
    let source
    const q = f.open({ canDispatch: () => canDispatch,
      providerFailureDismissed: record => dismissed && record.publicRunId === source.publicRunId })
    source = await f.admit(q, 'wizard_admitted_retry')
    f.recover()
    await f.admit(q, 'wizard_health')
    canDispatch = false
    await q.tick(true)
    const child = q.byIdempotencyKey('direct', 'wizard-saved-retry-' + source.publicRunId)
    assert(child)
    assert.equal(child.status, 'queued')
    dismissed = true
    // A restart/crash can skip eager release. The dispatch fence must stand alone.
    canDispatch = true
    await q.tick(true)
    assert.equal(q.get(child.publicRunId).status, 'cancelled')
    assert(!f.sent.some(row => row.retrySourceId === source.publicRunId))
  })

  await t.test('Dismissal timestamps are scoped to the admitted request and agent, not all future requests', t => {
    const f = fixture(t)
    const store = new DismissedFailureStore(join(f.root, 'dismissed-failures.json'))
    store.dismiss('wizard_same', 'external-reference')
    const reopened = new DismissedFailureStore(store.statePath)
    assert(reopened.isDismissedAfter('wizard_same', 0))
    assert(!reopened.isDismissedAfter('wizard_same', Date.now() + 1000))
    assert(!reopened.isDismissedAfter('wizard_other', 0))
    assert(!reopened.isDismissedAfter('wizard_same', 0, 'another-agent'))
  })

  for (const kind of ['host-profile', 'container', 'restricted']) await t.test(`${kind}: dismissed waiting sends stay fenced after provider recovery`, async t => {
    const f = fixture(t)
    const disposers = []
    t.after(async () => { for (const dispose of disposers) await dispose() })
    let dismissed = false, recovered = false
    const sent = []
    const agent = { id: 'fixture-agent', runtime: { kind }, model: { model: 'original' } }
    const registry = { agentsDir: f.root, list: () => [], apiKey: () => 'synthetic-key',
      fetchAgent: async (_agent, path, init = {}) => {
        if (path === '/v1/runs' && init.method === 'POST') {
          const body = JSON.parse(init.body); sent.push(body)
          return Response.json({ run_id: 'synthetic-' + sent.length, ...(recovered ? success : failure) })
        }
        return Response.json({})
      } }
    const queues = createRoutedQueues({ registry, own: dispose => disposers.push(dispose), pollIntervalMs: 0,
      providerAccessRecovery: true, providerFailureDismissed: record => record.sessionId === 'wizard_dismissed' && dismissed })
    const send = (session_id) => queues.fetch(agent, '/v1/runs', { method: 'POST', body: JSON.stringify({ session_id, input: 'saved words', model: 'original' }) })
    const source = await (await send('wizard_dismissed')).json()
    dismissed = true; recovered = true
    await send('wizard_health')
    await queues.fetch(agent, '/v1/runs/' + source.run_id)
    assert.equal(sent.filter(body => body.session_id === 'wizard_dismissed').length, 1)
  })

  await t.test('Dismissal is checked at failure and resume, but never fences a new owner request', async t => {
    const f = fixture(t)
    const dismissed = new Set()
    const q = f.open({ providerFailureDismissed: record => dismissed.has(record.publicRunId) })
    const source = await f.admit(q, 'wizard_guard')
    dismissed.add(source.publicRunId)
    // Simulate a late failure refresh of a dismissed receipt.
    const failed = q._update(source.publicRunId, { status: 'failed', waitingReason: '' })
    assert.equal(q._waitForProvider(failed).status, 'failed')
    q._update(source.publicRunId, { status: 'queued', waitingReason: 'provider_access' })
    f.recover()
    await f.admit(q, 'wizard_health')
    await q.tick(true)
    assert.equal(q.get(source.publicRunId).status, 'cancelled')
    assert(!f.sent.some(row => row.retrySourceId === source.publicRunId))
    const fresh = await f.admit(q, 'wizard_guard', 'a new owner request')
    assert.equal(fresh.status, 'completed')
  })
})

test('Turning auto-resend on never resends old failures', async t => {
  const f = fixture(t)
  const disabled = f.open({ providerAccessRecovery: false })
  const old = await f.admit(disabled, 'wizard_old_failure')
  assert.equal(old.status, 'failed')
  assert.equal(old.providerWaitDeadline, 0)
  await disabled.close()
  const enabled = f.open()
  await enabled.initialize()
  assert.equal(enabled.get(old.publicRunId).status, 'failed', 'Enabling the feature is not permission to resend old failures')
  assert.equal(enabled.get(old.publicRunId).providerWaitDeadline, 0)
  const waiting = await f.admit(enabled, 'wizard_opted_in')
  assert.equal(waiting.waitingReason, 'provider_access')
  await enabled.close()
  const restarted = f.open()
  await restarted.initialize()
  assert.equal(restarted.get(waiting.publicRunId).waitingReason, 'provider_access', 'Already-authorized waits survive restart')
  f.recover()
  await f.admit(restarted, 'wizard_health')
  await restarted.tick(true)
  await restarted.tick(true)
  assert(!f.sent.some(row => row.retrySourceId === old.publicRunId))
  assert.equal(f.sent.filter(row => row.retrySourceId === waiting.publicRunId).length, 1)
  assert.equal(restarted.get(old.publicRunId).status, 'failed')
})
