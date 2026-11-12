import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRestartGate, restartRequestRefusal } from '../server/restart-gate.mjs'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'

// Issue 480: a restart the product starts waits for running turns, holds new sends (saved, never refused) and the
// next process launches them, so nothing shows "Reply not sent".

const directories: string[] = []
const queues: DurableRunQueue[] = []
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function clock(start = 1_800_000_000_000) {
  let at = start
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

describe('restart gate', () => {
  it('is idle until asked, then waits for running turns, turns ready when none run, and overdue past the limit', () => {
    const time = clock()
    let running = [{ sessionId: 'wizard_a', agentId: 'hermes', since: time.now() - 30_000 }]
    const gate = createRestartGate({ activeTurns: () => running, heldSends: () => 2, now: time.now, log: () => {} })
    expect(gate.holding()).toBe(false)
    expect(gate.summary()).toEqual({ phase: 'idle', holding: false })

    const asked = gate.request({ reason: 'update', wait_s: 60 })
    expect(gate.holding()).toBe(true)
    expect(asked).toMatchObject({ phase: 'waiting', reason: 'update', active: 1, held: 2, oldest_active_s: 30 })
    expect(asked.turns).toEqual([{ session_id: 'wizard_a', agent_id: 'hermes', running_s: 30 }])
    expect(gate.summary().turns).toBeUndefined() // health never carries thread ids

    time.advance(61_000)
    expect(gate.status().phase).toBe('overdue')
    // The owner chose to wait longer: the first request time stays, the limit moves.
    const longer = gate.request({ wait_s: 120 })
    expect(longer.phase).toBe('waiting')
    expect(longer.requested_at).toBe(asked.requested_at)

    running = []
    expect(gate.status()).toMatchObject({ phase: 'ready', active: 0 })
  })

  it('never reads an unreadable queue as nothing running', () => {
    const gate = createRestartGate({ activeTurns: () => { throw new Error('closed') }, log: () => {} })
    gate.request({})
    expect(gate.status()).toMatchObject({ phase: 'waiting', active: null, active_unknown: true })
  })

  it('lets the hold lapse when the restarter stops asking, and lifts it on release', () => {
    const time = clock()
    const gate = createRestartGate({ activeTurns: () => [], now: time.now, leaseMs: 10_000, log: () => {} })
    gate.request({ reason: 'channels' })
    time.advance(9_000); gate.status() // a poll renews the lease
    time.advance(9_000); expect(gate.holding()).toBe(true)
    time.advance(2_000); expect(gate.holding()).toBe(false)
    gate.request({})
    expect(gate.release()).toMatchObject({ phase: 'idle', released: true })
    expect(gate.holding()).toBe(false)
  })

  it('refuses a nonsense wait and caps a huge one', () => {
    const time = clock()
    const gate = createRestartGate({ activeTurns: () => [{ sessionId: 'x', since: time.now() }], now: time.now, maxWaitMs: 60_000, log: () => {} })
    expect(() => gate.request({ wait_s: -1 })).toThrow(/wait_s/)
    expect(() => gate.request({ wait_s: 'soon' })).toThrow(/wait_s/)
    const capped = gate.request({ wait_s: 99_999, reason: 'Not A Reason!' })
    expect(Date.parse(capped.wait_until) - time.now()).toBe(60_000)
    expect(capped.reason).toBe('restart')
  })
})

describe('restart route refusal', () => {
  const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers: { host: '127.0.0.1:8080', ...headers } })
  const json = { 'content-type': 'application/json' }

  it('refuses a POST that is not JSON, so a page cannot send it without a preflight', () => {
    expect(restartRequestRefusal(req('POST'))).toBe(415)
    expect(restartRequestRefusal(req('POST', { 'content-type': 'text/plain' }))).toBe(415)
    expect(restartRequestRefusal(req('POST', json))).toBe(0)
    expect(restartRequestRefusal(req('POST', { 'content-type': 'application/json; charset=utf-8' }))).toBe(0)
  })

  it('refuses same-site, cross-site and foreign origins on every method, so a sibling page cannot renew the lease', () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const body = method === 'POST' ? json : {}
      expect(restartRequestRefusal(req(method, { ...body, 'sec-fetch-site': 'same-site' }))).toBe(403)
      expect(restartRequestRefusal(req(method, { ...body, 'sec-fetch-site': 'cross-site' }))).toBe(403)
      expect(restartRequestRefusal(req(method, { ...body, origin: 'http://127.0.0.1:9866' }))).toBe(403)
      expect(restartRequestRefusal(req(method, { ...body, origin: 'not a url' }))).toBe(403)
      expect(restartRequestRefusal(req(method, { ...body, 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8080' }))).toBe(0)
      expect(restartRequestRefusal(req(method, body))).toBe(0)
    }
    expect(restartRequestRefusal(req('GET', { origin: 'https://box.example.ts.net', 'x-forwarded-host': 'box.example.ts.net' }))).toBe(0)
    expect(restartRequestRefusal(req('GET', { origin: 'https://box.example.ts.net', 'x-forwarded-host': 'box.example.ts.net' }), { publicHost: '127.0.0.1:8080' })).toBe(403)
  })
})

describe('run queue under a restart hold', () => {
  async function statePath() {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-restart-gate-'))
    directories.push(directory)
    return join(directory, 'queue.sqlite3')
  }
  const request = (sessionId: string, key: string) => {
    const body = JSON.stringify({ session_id: sessionId, input: `hello ${sessionId}` })
    return { runtime: 'direct', sessionId, idempotencyKey: key, requestHash: queueRequestHash('direct', body), body, trustedPaths: [] }
  }

  it('saves a send made during the wait, launches nothing new, and the next process sends it', async () => {
    const path = await statePath()
    const launched: string[] = []
    const status = new Map<string, string>()
    let hold = false
    const transport = {
      launch: async (record: { sessionId: string }) => { launched.push(record.sessionId); status.set(record.sessionId, 'running'); return { upstreamRunId: `run_${record.sessionId}`, capacityStatus: 'running', payload: { status: 'running' } } },
      lookup: async (record: { sessionId: string }) => ({ payload: { status: status.get(record.sessionId) ?? 'running' } }),
    }
    const first = new DurableRunQueue({ statePath: path, pollIntervalMs: 0, launchHold: () => hold, ...transport } as never)
    queues.push(first)
    await first.initialize()
    await first.admit(request('wizard_long', 'long-1'))
    expect(launched).toEqual(['wizard_long'])

    hold = true
    const gate = createRestartGate({ activeTurns: () => first.activeTurns(), heldSends: () => first.heldSends(), log: () => {} })
    gate.request({ reason: 'update' })
    const held = await first.admit(request('wizard_mid', 'mid-1'))
    expect(held.record.status).toBe('queued')
    expect(first.get(held.record.publicRunId)?.waitingReason).toBe('restart_pending')
    expect(launched).toEqual(['wizard_long']) // held, not refused and not sent
    expect(gate.status()).toMatchObject({ phase: 'waiting', active: 1, held: 1 })

    // The long turn finishes: the gate reports ready, still without sending the held message.
    status.set('wizard_long', 'completed')
    await first.tick(true)
    expect(gate.status()).toMatchObject({ phase: 'ready', active: 0, held: 1 })
    expect(launched).toEqual(['wizard_long'])

    // Restart: the old process closes, the new one starts without a hold and sends the saved message once.
    await first.close(); queues.splice(queues.indexOf(first), 1)
    const next = new DurableRunQueue({ statePath: path, pollIntervalMs: 0, ...transport } as never)
    queues.push(next)
    await next.initialize()
    expect(launched).toEqual(['wizard_long', 'wizard_mid'])
    expect(next.get(held.record.publicRunId)?.status).toBe('running')
  })

  it('a hold raised while a tick awaits dispatch health still stops that tick from launching', async () => {
    const launched: string[] = []
    let hold = false, armed = false
    const queue = new DurableRunQueue({ statePath: await statePath(), pollIntervalMs: 0, launchHold: () => hold,
      // The restart request lands while the tick waits on this health read (after the tick's first hold check).
      canDispatch: async () => { if (armed) hold = true; return true },
      launch: async (record: { sessionId: string }) => { launched.push(record.sessionId); return { upstreamRunId: 'r', capacityStatus: 'running', payload: { status: 'running' } } },
      lookup: async () => ({ payload: { status: 'running' } }) } as never)
    queues.push(queue)
    await queue.initialize()
    armed = true
    const admitted = await queue.admit(request('wizard_race', 'race-1'))
    expect(launched).toEqual([])
    expect(queue.get(admitted.record!.publicRunId)).toMatchObject({ status: 'queued', waitingReason: 'restart_pending' })
  })

  it('without a hold (switch off) launches at once as before', async () => {
    const launched: string[] = []
    const queue = new DurableRunQueue({ statePath: await statePath(), pollIntervalMs: 0,
      launch: async (record: { sessionId: string }) => { launched.push(record.sessionId); return { upstreamRunId: 'r', capacityStatus: 'running', payload: { status: 'running' } } },
      lookup: async () => ({ payload: { status: 'running' } }) } as never)
    queues.push(queue)
    await queue.initialize()
    await queue.admit(request('wizard_plain', 'plain-1'))
    expect(launched).toEqual(['wizard_plain'])
    expect(queue.heldSends()).toBe(0)
  })
})
