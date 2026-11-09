import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as RQ from '../server/run-queue.mjs'
import { projectInFlightOwnerTurns, projectWizardMessageHistory, restoreOwnerTurns } from '../server/service.mjs'
const { DurableRunQueue, queueRequestHash, DRAINING_RESEND_DELAYS } = RQ as any

// 9 Nov 2026 (James): "The message I sent is disappearing and being lost." Hermes writes the owner's message only when
// a turn starts. A reply it never started (three resends), refused while restarting (runtime_draining) or refused
// for a thread another app owns (permission_denied) had no row, so once the phone's own copy expired the thread
// showed only "Reply not sent". And once a resent message finally landed, every resend showed as its own copy.
// A message the owner sends never leaves the thread: it shows once, marked Not sent, until Retry lands it.
const dirs: string[] = [], queues: any[] = []
afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
const SID = 'wizard_1794122381681_0056d47f6f0e'
const WORDS = 'What has this thread been doing for 10 hours? Are you stuck?'
const FILES = '[WIZARD_FILES_V1] [{"id":"drop_12dd4b21a78044589b08a67ed97cca27","filename":"Screenshot.jpg"}]'
const input = [{ role: 'user', content: [{ type: 'text', text: `${WORDS}\n\n${FILES}` }] }]
const request = (key = 'wos-native-rec-1794202826930-745017a7') => {
  const body = JSON.stringify({ session_id: SID, input, model: 'claude-sonnet-5-5', provider: 'anthropic', require_model_lock: true })
  return { runtime: 'direct', sessionId: SID, idempotencyKey: key, body, requestHash: queueRequestHash('direct', body) }
}
async function setup(dir?: string) {
  if (!dir) { dir = await mkdtemp(join(tmpdir(), 'wizard-lost-msg-')); dirs.push(dir) }
  const launches: { id: string, body: any }[] = [], hermes = new Map<string, any>()
  let n = 0
  const q: any = new (DurableRunQueue as any)({ statePath: join(dir, 'q.sqlite3'), maxActive: 2, pollIntervalMs: 0, canDispatch: () => true, notStartedSeconds: 5,
    launch: async (r: any) => { const id = `run_${launches.length + 1}_${++n}`; launches.push({ id, body: JSON.parse(r.body) }); hermes.set(id, { status: 'queued', run_id: id }); return { upstreamRunId: id, status: 'running', payload: { status: 'queued', run_id: id } } },
    lookup: async (r: any) => ({ payload: hermes.get(r.upstreamRunId) ?? { status: 'queued' } }),
    leaseHeld: async () => false,
    cancelUpstream: async (r: any) => { q.markOwnerStop(r.upstreamRunId); hermes.set(r.upstreamRunId, { status: 'cancelled' }); return true } })
  queues.push(q); await q.initialize()
  const advance = async () => {
    for (const [k, v] of q.notStartedSince) q.notStartedSince.set(k, v - 100)
    for (const [k, v] of q.stalledSince) q.stalledSince.set(k, v - 100)
    await q.tick(true); await q.tick(true)
  }
  return { q, dir, launches, hermes, advance }
}
// What every client reads for the thread (service.mjs applies these two in this order to Hermes' history).
const history = (q: any, rows: any[] = []) => {
  let out = Buffer.from(JSON.stringify({ object: 'list', data: rows, pagination: { order: 'latest', offset: 0, limit: 100, returned: rows.length } }))
  out = restoreOwnerTurns(out, q, SID)
  out = projectInFlightOwnerTurns(out, q, SID)
  return JSON.parse(out.toString()).data.filter((row: any) => row.role === 'user' && !row.display_kind)
}
const earlier = [{ id: 1, session_id: SID, role: 'user', content: 'Earlier question', timestamp: 1 }, { id: 2, session_id: SID, role: 'assistant', content: 'Earlier answer', timestamp: 2 }]

describe('a message Hermes never started stays in the thread', () => {
  it('shows once, marked Not sent, at the time it was sent, after every resend gave up', async () => {
    const s = await setup()
    await s.q.admit(request())
    await s.q.tick(true)
    const sentAt = s.q.queuedForSession('direct', SID)[0].createdAt
    for (let i = 0; i < 4; i++) await s.advance()
    const rows = s.q.queuedForSession('direct', SID)
    expect(rows.map((r: any) => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'failed'])
    const shown = history(s.q, earlier)
    expect(shown.map((r: any) => r.content)).toEqual(['Earlier question', `${WORDS}\n\n${FILES}`])
    expect(shown[1].wizard_queue).toMatchObject({ status: 'failed', reason: 'not_sent', public_run_id: rows[3].publicRunId })
    expect(shown[1].timestamp).toBe(sentAt)
    // Retry is offered on exactly this message.
    expect(s.q.savedRetry(SID)?.publicRunId).toBe(rows[3].publicRunId)
  })

  it('survives a reload: a fresh service on the same saved queue still shows it', async () => {
    const s = await setup()
    await s.q.admit(request())
    await s.q.tick(true)
    for (let i = 0; i < 4; i++) await s.advance()
    s.q.close(); queues.splice(queues.indexOf(s.q), 1)
    const again = await setup(s.dir)
    const shown = history(again.q)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ content: `${WORDS}\n\n${FILES}`, wizard_queue: { status: 'failed' } })
  })

  it('Retry resends the same words and attachments, and the message is never shown twice', async () => {
    const s = await setup()
    await s.q.admit(request())
    await s.q.tick(true)
    for (let i = 0; i < 4; i++) await s.advance()
    const failed = s.q.savedRetry(SID)
    const { record: retry } = await s.q.retrySaved(failed.publicRunId, SID)
    // A second tap (or the other device) replays the same retry: no second send.
    const again = await s.q.retrySaved(failed.publicRunId, SID).catch((e: any) => e)
    expect(again.record?.publicRunId ?? retry.publicRunId).toBe(retry.publicRunId)
    expect(s.launches.at(-1)!.body.input).toEqual(input)
    expect(s.launches.every(l => JSON.stringify(l.body.input) === JSON.stringify(input))).toBe(true)
    // While the retry runs: one bubble, no longer marked Not sent.
    let shown = history(s.q, earlier)
    expect(shown.filter((r: any) => r.content.startsWith(WORDS))).toHaveLength(1)
    expect(shown.at(-1).wizard_queue.status).not.toBe('failed')
    // Hermes starts it and writes the owner's row: one bubble, Hermes' own, with no queue copies of the resends.
    s.hermes.set(retry.upstreamRunId || s.launches.at(-1)!.id, { status: 'completed' })
    await s.q.tick(true)
    const landedAt = s.q.get(retry.publicRunId).createdAt + 2
    const landed = [...earlier, { id: 3, session_id: SID, role: 'user', display_kind: 'internal_notification', content: `${WORDS}\n\n${FILES}`, timestamp: landedAt },
      { id: 4, session_id: SID, role: 'assistant', content: 'Here is what happened.', timestamp: landedAt + 5 }]
    shown = history(s.q, landed)
    expect(shown.map((r: any) => r.id)).toEqual([1, 3])
  })
})

describe('a reply refused while Hermes restarts (runtime_draining)', () => {
  it('is sent again by itself once the restart is over, the same words and files, and stays visible meanwhile', async () => {
    const s = await setup()
    await s.q.admit(request())
    await s.q.tick(true)
    s.hermes.set(s.launches[0].id, { status: 'failed', error: 'runtime_draining', last_event: 'run.failed' })
    await s.q.tick(true)
    const rows = s.q.queuedForSession('direct', SID)
    expect(rows.map((r: any) => r.status)).toEqual(['cancelled', 'queued'])
    expect(rows[1]).toMatchObject({ retrySourceId: rows[0].publicRunId, waitingReason: 'admission_retry' })
    expect(rows[1].retryAfter).toBeGreaterThan(Date.now() / 1000 + DRAINING_RESEND_DELAYS[0] - 5)
    expect(s.launches).toHaveLength(1) // not hammered while the gateway is still draining
    expect(history(s.q).map((r: any) => r.wizard_queue?.status)).toEqual(['queued'])
    s.q._update(rows[1].publicRunId, { retryAfter: 0 })
    await s.q.tick(true)
    expect(s.launches).toHaveLength(2)
    expect(s.launches[1].body.input).toEqual(input)
  })

  it('an owner Stop is never resent', async () => {
    const s = await setup()
    await s.q.admit(request())
    await s.q.tick(true)
    s.q.markOwnerStop(s.launches[0].id)
    s.hermes.set(s.launches[0].id, { status: 'failed', error: 'runtime_draining' })
    await s.q.tick(true)
    expect(s.q.queuedForSession('direct', SID)).toHaveLength(1)
  })
})

describe('a reply into a thread another app owns (permission_denied)', () => {
  it('says why in plain words, keeps the message visible, and is not resent on its own', async () => {
    const s = await setup()
    await s.q.admit(request())
    await s.q.tick(true)
    s.hermes.set(s.launches[0].id, { status: 'failed', error: 'permission_denied', last_event: 'run.failed' })
    await s.q.tick(true)
    const [row] = s.q.queuedForSession('direct', SID)
    expect(row.status).toBe('failed')
    // The thread's Reply not sent card (the Chats list and thread read this projection).
    const [projected] = s.q.latestProjections([SID])
    expect(projected.safeError).toMatch(/started in another app, such as Telegram, so WizardOS can’t add to it\. Your message is saved\./)
    expect(history(s.q).map((r: any) => r.wizard_queue?.status)).toEqual(['failed'])
    expect(s.launches).toHaveLength(1)
  })
})

it('an unclaimed internal copy the owner cannot see does not hide the Not sent message', () => {
  const at = 1794202857
  const q = { queuedForSession: () => [{ publicRunId: 'wizardq_f', sessionId: SID, status: 'failed', createdAt: at + 900, retryOrderAt: at, retrySourceId: 'wizardq_0',
    body: JSON.stringify({ session_id: SID, input }) }] }
  const page = (rows: any[]) => Buffer.from(JSON.stringify({ object: 'list', data: rows, pagination: { order: 'latest', offset: 0, limit: 100, returned: rows.length } }))
  const hidden = [{ id: 7, role: 'user', display_kind: 'internal_notification', content: `${WORDS}\n\n${FILES}`, timestamp: at + 10 }]
  const out = JSON.parse(projectInFlightOwnerTurns(page(hidden), q, SID).toString()).data
  expect(out.filter((r: any) => r.wizard_queue?.status === 'failed')).toHaveLength(1)
  const visible = [{ ...hidden[0], display_kind: undefined }]
  expect(JSON.parse(projectInFlightOwnerTurns(page(visible), q, SID).toString()).data).toHaveLength(1)
})

it('the Not sent marker reaches the client through the history projection (it used to be dropped)', () => {
  const row = { id: 'queue-wizardq_f', session_id: SID, role: 'user', timestamp: 1, content: WORDS, secret: 'x',
    wizard_queue: { status: 'failed', reason: 'not_sent', public_run_id: 'wizardq_f', extra: '<b>' } }
  const [out] = JSON.parse(projectWizardMessageHistory(Buffer.from(JSON.stringify({ data: [row] }))).toString()).data
  expect(out.wizard_queue).toEqual({ status: 'failed', reason: 'not_sent', public_run_id: 'wizardq_f' })
  expect(out.secret).toBeUndefined()
})
