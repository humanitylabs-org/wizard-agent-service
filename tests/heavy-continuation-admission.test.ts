import { heavyRoot } from './support/heavy-root'
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { createHeavyIntegration } from '../server/heavy-integration.mjs'

const cleanup: (() => any)[] = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0 })
const token = randomBytes(32).toString('hex')
const req = { headers: { authorization: `Bearer ${token}` } }
const spec = { cwd: heavyRoot, argv: ['uname', '-a'], timeout_seconds: 10, lane: 'light' }
const path = '/wizard/internal/heavy/submit'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'heavy-followup-'))
  let integration: any
  const statuses = new Map<string, string>()
  const workerStates = new Map<string, string>()
  const history = [{ id: 1, role: 'user', content: 'Check the authorized build' }]
  let duringHistory = async () => {}, duringRuntime = async () => {}
  let runs: any
  const open = () => {
    runs = new DurableRunQueue({ statePath: join(root, 'runs.db'), pollIntervalMs: 0,
      launch: async (r: any) => {
        if (r.continuation?.kind === 'external-heavy') await integration.validate(r)
        statuses.set(r.publicRunId, 'running')
        return { upstreamRunId: r.publicRunId, payload: { status: 'running' } }
      }, lookup: async (r: any) => ({ payload: { status: statuses.get(r.publicRunId) || 'running' } }) })
    integration = createHeavyIntegration({ options: { heavyStatePath: join(root, 'heavy.db'), heavyToken: token,
      heavyTransport: async (p: any) => ({ job_id: p.job_id, state: workerStates.get(p.job_id) || 'completed', receipt: { exit_code: workerStates.get(p.job_id) === 'failed' ? 1 : 0 } }) },
      queue: runs, request: async (p: string) => {
        if (p.startsWith('/v1/runs/')) { await duringRuntime(); return { runtime: { model: 'original', provider: 'original-provider' } } }
        await duringHistory(); return { data: history }
      } })!
  }
  open()
  cleanup.push(async () => { await integration.close(); runs.close(); rmSync(root, { recursive: true, force: true }) })
  const admit = async (key: string, continuation: any = null, sessionId = 's') => {
    const body = JSON.stringify({ session_id: sessionId, input: key, model: 'original', provider: 'original-provider' })
    return (await runs.admit({ runtime: 'direct', sessionId, idempotencyKey: key, body,
      requestHash: queueRequestHash('direct', body), continuation })).record
  }
  const jobOrder = new Map<string, number>()
  const submit = async (key: string, session_id = 's', command = spec) => {
    const result = await integration.handle(req, path, { session_id, key, spec: command })
    // Synchronous fixture submissions can share Date.now(); make their intended
    // completion order explicit instead of relying on UUID/index tie ordering.
    if (!jobOrder.has(result.job_id)) jobOrder.set(result.job_id, jobOrder.size + 1)
    integration.queue.save({ ...integration.queue.get(result.job_id), created_at: jobOrder.get(result.job_id) })
    return result
  }
  const finish = async (id: string) => { statuses.set(id, 'completed'); await runs.tick(true) }
  const origin = await admit('human')
  return { get runs() { return runs }, get integration() { return integration }, submit, finish, admit, origin, history,
    workerStates,
    restart: async () => { await integration.close(); runs.close(); open() },
    setHistoryHook: (fn: () => Promise<void>) => { duringHistory = fn },
    setRuntimeHook: (fn: () => Promise<void>) => { duringRuntime = fn } }
}

it.each([false, true])('two heavy jobs from one turn both report back; restart=%s', async restart => {
  const f = await fixture()
  const first = await f.submit('first'), second = await f.submit('second')
  f.workerStates.set(first.job_id, 'failed'); f.workerStates.set(second.job_id, 'running')
  await f.finish(f.origin.publicRunId); await f.integration.queue.tick()
  const one = f.integration.queue.get(first.job_id)
  expect(f.runs.get(one.resume).status).toBe('running')
  f.history.push({ id: 2, role: 'user', content: JSON.parse(f.runs.get(one.resume).body).input })
  if (restart) await f.restart()
  f.workerStates.set(second.job_id, 'failed')
  await f.integration.queue.tick()
  const two = f.integration.queue.get(second.job_id)
  expect(two.resume).toMatch(/^wizardq_/)
  expect(f.runs.get(two.resume).status).toBe('queued')
  await f.finish(one.resume)
  expect(f.runs.get(two.resume).status).toBe('running')
  expect(JSON.parse(f.runs.get(two.resume).body).input).toContain('"exit_code":1')
  await f.integration.queue.tick()
  expect(f.integration.queue.get(second.job_id).resume).toBe(two.resume)
})

it('two heavy jobs from one turn both report back after an automatic provider recovery', async () => {
  const f = await fixture()
  const first = await f.submit('first'), second = await f.submit('second')
  f.workerStates.set(second.job_id, 'running')
  await f.finish(f.origin.publicRunId); await f.integration.queue.tick()
  const one = f.integration.queue.get(first.job_id)
  await f.finish(one.resume)
  f.runs._update(one.resume, { status: 'failed', waitingReason: 'provider_access' })
  const retried = f.runs._retrySavedRow(one.resume, 's', {}, true).record
  expect(retried.providerRecoveryAttempted).toBe(true)
  f.workerStates.set(second.job_id, 'failed')
  await f.integration.queue.tick()
  expect(f.integration.queue.get(second.job_id).resume).toMatch(/^wizardq_/)
  await expect(f.integration.validate(f.runs.get(retried.publicRunId))).resolves.toBeUndefined()
  await f.runs.tick()
  expect(f.runs.get(retried.publicRunId).status).toBe('running')
})

it('superseded terminal results leave a durable short notice for the next turn', async () => {
  const f = await fixture(), first = await f.submit('first')
  await f.admit('new-owner-request')
  await f.integration.queue.tick()
  expect(f.integration.queue.get(first.job_id).resume).toBe('superseded')
  await f.restart()
  const note = f.integration.queue.noticeContext('hermes', 's')
  expect(note).toContain(first.job_id)
  expect(note).toContain('completed')
  expect(f.integration.queue.noticeContext('other-agent', 's')).toBe('')
  expect(f.integration.queue.noticeContext('hermes', 'other-session')).toBe('')
  f.integration.queue.acknowledgeNotices('hermes', 's', { instructions: 'not sent' })
  expect(f.integration.queue.noticeContext('hermes', 's')).toBe(note)
  f.integration.queue.acknowledgeNotices('hermes', 's', { instructions: note })
  expect(f.integration.queue.noticeContext('hermes', 's')).toBe('')
})

it.each([false, true])('admits a follow-up from the running continuation behind a newer sibling; restart=%s', async restart => {
  const f = await fixture()
  const first = await f.submit('first'), second = await f.submit('second')
  await f.finish(f.origin.publicRunId)
  await f.integration.queue.tick()
  const one = f.integration.queue.get(first.job_id), two = f.integration.queue.get(second.job_id)
  expect(f.runs.get(one.resume).status).toBe('running')
  expect(f.runs.get(two.resume).status).toBe('queued')
  // The newest receipt is NOT the mutation owner. This was the live 409.
  expect(f.runs.latestForSession('s').publicRunId).toBe(two.resume)
  if (restart) await f.restart()
  const followup = await f.submit('repair-authorized-check')
  expect(f.integration.queue.get(followup.job_id).origin).toBe(one.resume)
  expect((await f.submit('repair-authorized-check')).job_id).toBe(followup.job_id)
  await expect(f.submit('repair-authorized-check', 's', { ...spec, argv: ['false'] })).rejects.toMatchObject({ status: 409 })
  await f.integration.queue.tick()
  const next = f.runs.get(f.integration.queue.get(followup.job_id).resume)
  expect(next.status).toBe('queued') // cannot release the current owner early
  await f.finish(one.resume)
  await f.integration.validate(next)
  await f.integration.validate(f.runs.get(two.resume))
  expect(JSON.parse(next.body)).toMatchObject({ model: 'original', provider: 'original-provider', require_model_lock: true })
  expect(JSON.parse(next.body).input).toContain('original authorization')
})

it.each(['human', 'helper'])('keeps a newer %s request outside the heavy generation as a hard fence', async kind => {
  const f = await fixture()
  const first = await f.submit('first')
  await f.admit('new-scope', kind === 'helper' ? { kind: 'helper', sessionId: 's' } : null)
  await expect(f.submit('must-not-admit')).rejects.toMatchObject({ status: 409 })
  await f.integration.queue.tick()
  expect(f.integration.queue.get(first.job_id).resume).toBe('superseded')
})

it.each(['stop', 'steer', 'owner-finished'])('fails closed when %s races the history lookup', async action => {
  const f = await fixture()
  f.setHistoryHook(async () => {
    if (action === 'owner-finished') await f.finish(f.origin.publicRunId)
    else if (action === 'steer') f.integration.supersede('s')
    else f.integration.stopSession('s')
  })
  await expect(f.submit('must-not-admit')).rejects.toMatchObject({ status: 409 })
  expect(f.integration.queue.rows()).toEqual([])
})

it('rejects a helper child with no native owner and a completed origin', async () => {
  const f = await fixture()
  await expect(f.submit('child', 'child-session')).rejects.toMatchObject({ status: 409 })
  await f.finish(f.origin.publicRunId)
  await expect(f.submit('idle')).rejects.toMatchObject({ status: 409 })
})

it('replays an ambiguous pre-upgrade continuation with its exact admitted bytes', async () => {
  const f = await fixture()
  const first = await f.submit('first')
  const body = JSON.stringify({ session_id: 's', input: 'old receipt guidance', model: 'original', provider: 'original-provider', require_model_lock: true })
  const key = `wizard-heavy-${first.job_id}`
  const { record } = f.runs._admitRow({ runtime: 'direct', sessionId: 's', idempotencyKey: key,
    requestHash: queueRequestHash('direct', body), body,
    continuation: { kind: 'external-heavy', job_id: first.job_id, sessionId: 's' } })
  await f.integration.queue.tick()
  const saved = f.integration.queue.get(first.job_id)
  expect(saved.resume).toBe(record.publicRunId)
  expect(saved.continuation_body).toBe(body)
  expect(f.runs.byIdempotencyKey('direct', key).body).toBe(body)
  await f.integration.queue.tick()
  expect(f.integration.queue.get(first.job_id).resume).toBe(record.publicRunId)
})

it('fails closed if two native mutation owners exist', async () => {
  const f = await fixture()
  const other = await f.admit('sibling')
  f.runs.database.prepare("UPDATE wizard_run_queue SET status='running' WHERE public_run_id=?").run(other.publicRunId)
  await expect(f.submit('ambiguous')).rejects.toMatchObject({ status: 409 })
})

it('does not let a cancelled queued sibling revoke the running sibling authorization', async () => {
  const f = await fixture()
  const first = await f.submit('first'), second = await f.submit('second')
  await f.finish(f.origin.publicRunId); await f.integration.queue.tick()
  const two = f.integration.queue.get(second.job_id)
  await f.integration.handle(req, '/wizard/internal/heavy/cancel', { session_id: 's', job_id: second.job_id })
  await f.runs.cancel(two.resume)
  const repair = await f.submit('authorized-repair')
  expect(f.integration.queue.get(repair.job_id).origin).toBe(f.integration.queue.get(first.job_id).resume)
})

it.each(['human', 'helper'])('re-fences a route await against %s without wedging the new owner', async kind => {
  const f = await fixture()
  const first = await f.submit('first'), second = await f.submit('second')
  f.integration.queue.save({ ...f.integration.queue.get(second.job_id), route: null })
  await f.finish(f.origin.publicRunId)
  let injected = false, newScope: any
  f.setRuntimeHook(async () => {
    if (injected) return
    injected = true
    // Human path matches service.mjs; helpers are fenced by queue generation.
    if (kind === 'human') f.integration.supersede('s')
    newScope = await f.admit('new-scope', kind === 'helper' ? { kind: 'helper', sessionId: 's' } : null)
  })
  await f.integration.queue.tick()
  expect(injected).toBe(true)
  expect(['suppressed', 'superseded']).toContain(f.integration.queue.get(second.job_id).resume)
  expect(f.runs.byIdempotencyKey('direct', `wizard-heavy-${second.job_id}`)).toBeNull()
  await expect(f.submit('must-not-run')).rejects.toMatchObject({ status: 409 })
  await f.finish(f.integration.queue.get(first.job_id).resume)
  expect(f.runs.get(newScope.publicRunId).status).toBe('running')
  const newJob = await f.submit('new-authorized-check')
  expect(f.integration.queue.get(newJob.job_id).origin).toBe(newScope.publicRunId)
})

it('keeps already-authorized multi-step follow-ups in one generation without relaxing the model lock', async () => {
  const f = await fixture()
  const first = await f.submit('first')
  await f.finish(f.origin.publicRunId); await f.integration.queue.tick()
  let owner = f.integration.queue.get(first.job_id).resume
  for (let n = 0; n < 4; n++) {
    const repair = await f.submit(`distinct-authorized-check-${n}`)
    await f.finish(owner); await f.integration.queue.tick()
    owner = f.integration.queue.get(repair.job_id).resume
    const next = f.runs.get(owner)
    expect(next.status).toBe('running')
    expect(JSON.parse(next.body)).toMatchObject({ model: 'original', provider: 'original-provider', require_model_lock: true })
    await f.integration.validate(next)
  }
})

it('keeps stop/steer fencing effective across a follow-up generation', async () => {
  const f = await fixture()
  const first = await f.submit('first'), second = await f.submit('second')
  await f.finish(f.origin.publicRunId); await f.integration.queue.tick()
  const owner = f.integration.queue.get(first.job_id).resume
  const followup = await f.submit('repair')
  await f.integration.queue.tick()
  const next = f.runs.get(f.integration.queue.get(followup.job_id).resume)
  f.integration.stopSession('s')
  await f.finish(owner)
  await expect(f.integration.validate(next)).rejects.toMatchObject({ status: 410 })
  await expect(f.integration.validate(f.runs.get(f.integration.queue.get(second.job_id).resume))).rejects.toMatchObject({ status: 410 })
})
