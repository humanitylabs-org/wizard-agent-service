import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeavyIntegration, heavyRequestWatermark, HEAVY_PREFIX } from '../server/heavy-integration.mjs'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'

const human = (id: number, content = 'Run the authorized check') => ({ id, role: 'user', content })
const machine = (id: number) => ({ id, role: 'assistant', content: 'Working' })
const mark = (row: any) => ({ id: row.id, hash: createHash('sha256').update(row.content).digest('hex') })
const envelope = (data: any[], offset: number) => ({ data, pagination: { limit: 500, offset, order: 'latest', returned: data.length } })
function history(getRows: () => any[], paths: string[] = []) {
  return async (path: string) => {
    paths.push(path)
    const url = new URL(path, 'http://fixture.invalid')
    expect(url.searchParams.get('include_compacted')).toBe('true')
    expect(url.searchParams.has('include_inactive')).toBe(false)
    expect(url.searchParams.get('order')).toBe('latest')
    expect(url.searchParams.get('limit')).toBe('500')
    const offset = Number(url.searchParams.get('offset'))
    const rows = getRows()
    return envelope(rows.slice(Math.max(0, rows.length - offset - 500), rows.length - offset), offset)
  }
}

it('reads compacted canonical history rather than the active-only summary; newest human wins', async () => {
  const old = human(1), latest = human(2, 'Use my correction')
  const rows = [old, latest,
    { ...human(3), content: '[CONTEXT SUMMARY] summary' },
    { ...human(4), display_kind: 'internal_notification' },
    { ...human(5), content: HEAVY_PREFIX + '\nreceipt' },
    { ...human(6), content: '[ASYNC DELEGATION BATCH COMPLETE] receipt' }]
  const paths: string[] = []
  expect(await heavyRequestWatermark(history(() => rows, paths), 'session/with space')).toEqual(mark(latest))
  expect(paths[0]).toContain('session%2Fwith%20space/messages?')
})

it('finds a human beyond the capped first page and rechecks the head', async () => {
  const rows = [human(1), ...Array.from({ length: 1100 }, (_, i) => machine(i + 2))]
  const paths: string[] = []
  expect(await heavyRequestWatermark(history(() => rows, paths), 's')).toEqual(mark(rows[0]))
  expect(paths.map(path => new URL(path, 'http://fixture.invalid').searchParams.get('offset'))).toEqual(['0', '500', '1000', '0'])
})

it('fails closed if a newer human appears while older pages are being read', async () => {
  const rows = [human(1), ...Array.from({ length: 500 }, (_, i) => machine(i + 2))]
  const read = history(() => rows)
  await expect(heavyRequestWatermark(async (path: string) => {
    const result = await read(path)
    if (path.endsWith('offset=500')) rows.push(human(502, 'Stop now'))
    return result
  }, 's')).rejects.toMatchObject({ status: 503 })
})

it.each([
  ['missing rows', {}],
  ['invalid identity', { data: [{ role: 'user', content: 'No identity' }] }],
  ['wrong offset', { ...envelope([human(1)], 1) }],
  ['wrong count', { data: [human(1)], pagination: { limit: 500, offset: 0, order: 'latest', returned: 0 } }],
  ['empty history', envelope([], 0)],
  ['only machine messages', envelope([{ ...human(1), display_kind: 'system' }], 0)],
])('fails closed for %s', async (_label, payload) => {
  await expect(heavyRequestWatermark(async () => payload, 's')).rejects.toMatchObject({ status: 503 })
})

it('fails closed on missing pagination acknowledgement or repeated rows', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => machine(i + 1))
  await expect(heavyRequestWatermark(async () => ({ data: rows }), 's')).rejects.toMatchObject({ status: 503 })
  await expect(heavyRequestWatermark(async (path: string) => envelope(rows, Number(new URL(path, 'http://fixture.invalid').searchParams.get('offset'))), 's')).rejects.toMatchObject({ status: 503 })
})

it('bounds history scanning and propagates upstream failure without guessing authority', async () => {
  let calls = 0
  await expect(heavyRequestWatermark(async () => {
    const offset = calls++ * 500
    return envelope(Array.from({ length: 500 }, (_, i) => machine(offset + i + 1)), offset)
  }, 's')).rejects.toMatchObject({ status: 503 })
  expect(calls).toBe(32)
  await expect(heavyRequestWatermark(async () => { throw new Error('upstream unavailable') }, 's')).rejects.toThrow('upstream unavailable')
})

const cleanup: (() => any)[] = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0 })
it('uses the compacted watermark at admission and rejects a newer correction at continuation dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-watermark-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let rows = [human(1), ...Array.from({ length: 600 }, (_, i) => machine(i + 2))]
  let complete = false, integration: any
  const runs = new DurableRunQueue({ statePath: join(dir, 'run.db'), pollIntervalMs: 0,
    canDispatch: () => !complete,
    launch: async (r: any) => ({ upstreamRunId: r.publicRunId, payload: { status: 'running' } }),
    lookup: async () => ({ payload: { status: complete ? 'completed' : 'running' } }) })
  cleanup.push(() => runs.close())
  const body = JSON.stringify({ session_id: 's', input: 'Run the authorized check', model: 'origin-model', provider: 'origin-provider' })
  await runs.admit({ runtime: 'direct', sessionId: 's', idempotencyKey: 'origin', body, requestHash: queueRequestHash('direct', body) })
  const token = 'watermark-fixture-token-000000000000000'
  const read = history(() => rows)
  integration = createHeavyIntegration({ options: { heavyStatePath: join(dir, 'heavy.db'), heavyToken: token,
    heavyTransport: async (p: any) => ({ job_id: p.job_id, state: 'completed', receipt: { exit_code: 0 } }) }, queue: runs,
    request: (path: string) => path.startsWith('/v1/runs/') ? Promise.resolve({}) : read(path) })
  cleanup.push(() => integration.close())
  const job = await integration.handle({ headers: { authorization: `Bearer ${token}` } }, '/wizard/internal/heavy/submit', {
    session_id: 's', key: 'fixture', spec: { cwd: '/Volumes/ThalesMedia/qa', argv: ['true'], timeout_seconds: 10 } })
  expect(integration.queue.get(job.job_id).watermark).toEqual(mark(rows[0]))
  expect(integration.queue.get(job.job_id).route).toEqual({ model: 'origin-model', provider: 'origin-provider', require_model_lock: true })
  complete = true; await runs.tick(true); await integration.queue.tick()
  const continuation = runs.get(integration.queue.get(job.job_id).resume)
  await expect(integration.validate(continuation)).resolves.toBeUndefined()
  rows = [...rows, human(602, 'Stop; do not continue')]
  await expect(integration.validate(continuation)).rejects.toMatchObject({ status: 410 })
})
