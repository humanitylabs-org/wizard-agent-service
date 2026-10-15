import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { upstreamError, retryDelaySeconds, validateRecoveryIdentity } from '../server/hermes-compat.mjs'
import { hermesRunTurnHeld } from '../server/hermes-http-readers.mjs'
const dirs: string[] = [], queues: any[] = []
afterEach(async () => { queues.forEach(q => q.close()); queues.length = 0; await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
async function make(options: any = {}, path?: string) {
  if (!path) { const d = await mkdtemp(join(tmpdir(), 'compat-')); dirs.push(d); path = join(d, 'q.db') }
  const q = new DurableRunQueue({ statePath: path, pollIntervalMs: 0, maxActive: 1, activeSessionIds: () => [], canDispatch: () => true, launch: async r => ({ upstreamRunId: 'up-' + r.idempotencyKey, payload: { status: 'running' } }), lookup: async () => ({ payload: { status: 'running' } }), ...options }); queues.push(q); await q.initialize(); return q
}
function request(sessionId: string, key: string) { const body = JSON.stringify({ session_id: sessionId, input: 'hello' }); return { runtime: 'direct', sessionId, idempotencyKey: key, requestHash: queueRequestHash('direct', body), body, trustedPaths: [] } }
it('unknown fences only its session across restart; never replays it; releases followers once', async () => {
  let state = 'unknown'; const launched: string[] = []
  const options = { launch: async r => { launched.push(r.idempotencyKey); return { upstreamRunId: 'up-' + r.idempotencyKey, payload: { status: r.idempotencyKey === 'head' ? state : 'completed' } } }, lookup: async () => ({ payload: { status: state } }) }
  let q = await make(options); const head = await q.admit(request('one', 'head')); const follower = await q.admit(request('one', 'follower')); await q.admit(request('other', 'other'))
  expect(launched).toEqual(['head', 'other']); expect(q.get(head.record.publicRunId).status).toBe('unknown'); expect((await q.summary()).active).toBe(0)
  expect(q.latestProjections(['one'])[0].status).toBe('unknown')
  const path = q.statePath; q.close(); q = await make(options, path); expect(launched).toEqual(['head', 'other']); expect(q.get(follower.record.publicRunId).status).toBe('queued')
  state = 'interrupted'; await q.tick(true); await q.tick(true); expect(launched).toEqual(['head', 'other', 'follower'])
})
it.each(['permission_denied', 'idempotency_key_conflict', 'admission_conflict'])('permanent admission %s stops retrying and keeps a safe explanation', async code => {
  let attempts = 0; const options = { launch: async () => { attempts++; throw upstreamError(409, JSON.stringify({ error: { code, message: 'refused' } })) } }; let q = await make(options)
  const { record } = await q.admit(request('one', code)); await q.tick(true); expect(attempts).toBe(1); expect(q.get(record.publicRunId).status).toBe('failed'); expect(q.publicPayload(record.publicRunId).safe_error).toBeTruthy()
  const path = q.statePath; q.close(); q = await make(options, path); expect(attempts).toBe(1); expect(q.latestProjections()[0].safeError).toBeTruthy()
})
it.each([429, 503])('Retry-After %s survives queue restart and cannot be steered', async status => {
  let attempts = 0; const options = { launch: async () => { attempts++; throw upstreamError(status, '{}', '120') } }
  let q = await make(options); const { record } = await q.admit(request('one', 'retry')); expect(q.get(record.publicRunId).retryAfter).toBeGreaterThan(Date.now()/1000 + 115)
  await expect(q.appendGuidance(record.publicRunId, 'changed')).rejects.toMatchObject({ status: 409 })
  const path = q.statePath; q.close(); q = await make(options, path); expect(attempts).toBe(1)
})
it('ambiguous launch retry keeps key and wire bytes, while never-attempted work remains editable', async () => {
  let enabled = false; const sent: any[] = []; let q: any
  const options = { canDispatch: () => enabled, launch: async (r: any) => { sent.push([r.idempotencyKey, q.freezeDispatchBody(r.publicRunId, r.body)]); throw new TypeError('lost response') } }; q = await make(options)
  const { record } = await q.admit(request('one', 'same-key')); await q.appendGuidance(record.publicRunId, 'before first send'); enabled = true; await q.tick(true)
  await expect(q.appendGuidance(record.publicRunId, 'after send')).rejects.toMatchObject({ status: 409 })
  const path = q.statePath; q.close(); q = await make(options, path)
  await expect(q.appendGuidance(record.publicRunId, 'after restart')).rejects.toMatchObject({ status: 409 })
  expect(q.freezeDispatchBody(record.publicRunId, 'wrong bytes')).toBe(sent[0][1]); q.database.prepare('UPDATE wizard_run_queue SET retry_after=0').run(); await q.tick(true); expect(sent[1]).toEqual(sent[0])
})
it('canonical liveness never probes empty steer', async () => {
  let calls = 0; expect(await hermesRunTurnHeld(async () => { calls++; return new Response(JSON.stringify({ status: 'running', admission_id: 'adm', execution_generation: 1 })) }, 'http://unused', 'test', 'r')).toBe(true); expect(calls).toBe(1)
})
it('legacy migration freezes old rows without changing keys or payloads', async () => {
  let q = await make({ canDispatch: () => false }); const admitted = await q.admit(request('old', 'old-key')); const id = admitted.record!.publicRunId, path = q.statePath, before = q.get(id)!
  q.close(); const db = new DatabaseSync(path); db.exec('ALTER TABLE wizard_run_queue DROP COLUMN dispatch_attempted; ALTER TABLE wizard_run_queue DROP COLUMN dispatch_body'); db.close()
  q = await make({ canDispatch: () => false }, path); expect(q.get(id)).toMatchObject({ body: before.body, idempotencyKey: before.idempotencyKey, requestHash: before.requestHash, dispatchAttempted: true })
  await expect(q.appendGuidance(id, 'mutate')).rejects.toMatchObject({ status: 409 }); const fresh = await q.admit(request('new', 'new-key')); await expect(q.appendGuidance(fresh.record!.publicRunId, 'safe edit')).resolves.toBeTruthy()
})
it('many unknown and unsupported states fence sessions, not global worker capacity', async () => {
  const launched: string[] = []; const q = await make({ launch: async (r: any) => { launched.push(r.sessionId); return { upstreamRunId: 'up-'+r.idempotencyKey, payload: { status: r.sessionId === 'healthy' ? 'running' : 'future_unknown_state' } } }, lookup: async () => ({ payload: { status: 'unknown' } }) })
  for (const id of ['a','b','c']) { await q.admit(request(id, id)); await q.admit(request(id, id+'-follower')) }
  await q.admit(request('healthy','healthy')); expect(launched).toEqual(['a','b','c','healthy']); expect((await q.summary()).active).toBe(1)
})
it('legacy transient conflict retries with the same identity', async () => {
  const seen: string[] = []; const q = await make({ launch: async (r: any) => { seen.push(r.idempotencyKey); if (seen.length === 1) throw upstreamError(409, '{}'); return { upstreamRunId: 'old-run', payload: { status: 'running' } } } })
  const item = await q.admit(request('old','stable')); expect(item.record!.status).toBe('queued'); q.database.prepare('UPDATE wizard_run_queue SET retry_after=0').run(); await q.tick(true); expect(seen).toEqual(['stable','stable']); expect(q.get(item.record!.publicRunId)!.status).toBe('running')
})
it('recovery exact identity validates repeats, rejecting stale and extra fields', () => {
  const current = { admission_id: 'adm', execution_generation: 3, status: 'interrupted' }; expect(() => validateRecoveryIdentity({ admission_id: 'adm', execution_generation: 3 }, current)).not.toThrow(); expect(() => validateRecoveryIdentity({ admission_id: 'adm', execution_generation: 2 }, current)).toThrow('stale_generation'); expect(() => validateRecoveryIdentity(current, current)).toThrow('invalid_params')
  expect(retryDelaySeconds('Thu, 01 Jan 1970 00:02:00 GMT', 1, 0)).toBe(120)
})
