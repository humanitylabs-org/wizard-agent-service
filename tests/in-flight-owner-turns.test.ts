import { describe, expect, it } from 'vitest'
import { projectInFlightOwnerTurns, queuedOwnerHistory } from '../server/service.mjs'
const SID = 'wizard_1_abc'
const row = (publicRunId: string, text: string, status: string, createdAt: number, extra: any = {}) => ({
  publicRunId, sessionId: SID, status, createdAt, waitingReason: extra.waitingReason ?? '', retrySourceId: extra.retrySourceId ?? '',
  continuation: extra.continuation ?? null, body: JSON.stringify({ session_id: SID, input: [{ role: 'user', content: [{ type: 'text', text }] }] }),
})
const queue = (rows: any[]) => ({ queuedForSession: () => rows })
const page = (data: any[], pagination: any = { order: 'oldest', offset: 0, limit: 500, returned: data.length }) => Buffer.from(JSON.stringify({ object: 'list', data, pagination }))
const run = (payload: Buffer, rows: any[]) => JSON.parse(projectInFlightOwnerTurns(payload, queue(rows), SID).toString())
describe('projectInFlightOwnerTurns', () => {
  it('shows a waiting first message in an empty thread, marked Queued with its reason', () => {
    const out = run(page([]), [row('wizardq_1', 'Build me a tracker', 'queued', 100, { waitingReason: 'capacity' })])
    expect(out.data).toHaveLength(1)
    expect(out.data[0]).toMatchObject({ role: 'user', content: 'Build me a tracker', timestamp: 100, wizard_queue: { status: 'queued', reason: 'capacity' } })
    expect(out.pagination.returned).toBe(1)
  })
  it('shows an accepted-but-not-started turn after the earlier history, in time order', () => {
    const history = [{ id: 1, role: 'user', content: 'first', timestamp: 10 }, { id: 2, role: 'assistant', content: 'ok', timestamp: 20 }]
    const out = run(page(history), [row('wizardq_2', 'reply from phone', 'running', 300)])
    expect(out.data.map((r: any) => r.content)).toEqual(['first', 'ok', 'reply from phone'])
    expect(out.data[2].wizard_queue.status).toBe('running')
  })
  it('does not duplicate a turn Hermes already shows (even with an appended notice)', () => {
    const history = [{ id: 1, role: 'user', content: 'Build me a tracker\n\n[System: note]', timestamp: 101 }]
    const out = run(page(history), [row('wizardq_1', 'Build me a tracker', 'running', 100)])
    expect(out.data).toHaveLength(1)
  })
  it('skips finished, retried-away, background and machine turns', () => {
    const rows = [row('a', 'done one', 'completed', 1), row('b', 'was retried', 'failed', 2), row('c', 'retry of b', 'queued', 3, { retrySourceId: 'b' }),
      row('d', 'background', 'queued', 4, { continuation: { kind: 'external-heavy' } })]
    const out = run(page([]), rows)
    expect(out.data.map((r: any) => r.content)).toEqual(['retry of b'])
  })
  it('leaves older pages alone and never throws on a bad queue', () => {
    const older = page([{ id: 1, role: 'user', content: 'x', timestamp: 1 }], { order: 'latest', offset: 100, limit: 100, returned: 1 })
    expect(projectInFlightOwnerTurns(older, queue([row('q', 'waiting', 'queued', 5)]), SID)).toBe(older)
    const empty = page([])
    expect(projectInFlightOwnerTurns(empty, { queuedForSession: () => { throw new Error('boom') } }, SID)).toBe(empty)
    expect(projectInFlightOwnerTurns(empty, null, SID)).toBe(empty)
  })
  it('the 404 history for a queued new thread carries the same Queued marker', () => {
    const out = JSON.parse(queuedOwnerHistory(queue([row('wizardq_9', 'hello', 'queued', 5, { waitingReason: 'interactive_reserve' })]), SID)!.toString())
    expect(out.data[0].wizard_queue).toMatchObject({ status: 'queued', reason: 'interactive_reserve' })
  })
})
describe('replies sent into a running turn', () => {
  const withSteers = (rows: any[], steers: any[]) => ({ queuedForSession: () => rows, acceptedSteersForSession: () => steers })
  it('shows an accepted reply on every client until Hermes shows it, once', () => {
    const q = withSteers([row('wizardq_1', 'start', 'running', 100)], [{ publicRunId: 'wizardq_1', text: 'also check the footer', at: 200, status: 'running' }])
    const history = [{ id: 1, role: 'user', content: 'start', timestamp: 101 }]
    const out = JSON.parse(projectInFlightOwnerTurns(page(history), q, SID).toString())
    expect(out.data.map((r: any) => r.content)).toEqual(['start', 'also check the footer'])
    expect(out.data[1].wizard_queue.status).toBe('steered')
    const landed = [...history, { id: 2, role: 'user', content: 'also check the footer', timestamp: 205 }]
    expect(JSON.parse(projectInFlightOwnerTurns(page(landed), q, SID).toString()).data).toHaveLength(2)
  })
})
