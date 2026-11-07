import { heavyRoot } from './support/heavy-root'
import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeavyIntegration, heavyRequestWatermark, submittedRowIds, HEAVY_PREFIX } from '../server/heavy-integration.mjs'
import { DatabaseSync } from 'node:sqlite'
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
    session_id: 's', key: 'fixture', spec: { cwd: join(heavyRoot, 'fixture'), argv: ['true'], timeout_seconds: 10 } })
  expect(integration.queue.get(job.job_id).watermark).toEqual(mark(rows[0]))
  expect(integration.queue.get(job.job_id).route).toEqual({ model: 'origin-model', provider: 'origin-provider', require_model_lock: true })
  complete = true; await runs.tick(true); await integration.queue.tick()
  const continuation = runs.get(integration.queue.get(job.job_id).resume)
  await expect(integration.validate(continuation)).resolves.toBeUndefined()
  rows = [...rows, human(602, 'Stop; do not continue')]
  await expect(integration.validate(continuation)).rejects.toMatchObject({ status: 410 })
})

// Hermes 0.22.7 shape (live 7 Nov 2026): every /v1/runs admission, the owner's own reply included,
// is persisted as internal_notification with display_metadata.submission_id; the HTTP history omits
// display_metadata. A gateway self-injected wake has no submission_id.
function hermesState(dir: string, rows: { id: number, content: string, meta?: any, kind?: string | null }[], session = 's') {
  const path = join(dir, 'state.db'), db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT, display_metadata TEXT)`)
  db.prepare('INSERT INTO sessions VALUES (?, NULL)').run(session)
  for (const r of rows) db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(r.id, session, 'user', r.content,
    r.kind === undefined ? 'internal_notification' : r.kind, r.meta === undefined ? null : JSON.stringify(r.meta))
  db.close()
  return path
}
const submittedRow = (id: number, content: string) => ({ id, content, meta: { gateway_input_owner: 'o', submission_id: `run_${id}` } })
const httpRows = (rows: any[]) => rows.map(r => ({ id: r.id, role: 'user', content: r.content, display_kind: r.kind === undefined ? 'internal_notification' : r.kind }))

it('Hermes 0.22.7: a submitted owner turn typed internal_notification is the latest request; wakes and machine inputs are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-watermark-0227-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const owner = submittedRow(10, 'Okay, rehearse the installer on forum')
  const rows = [submittedRow(9, 'adopt'), owner,
    { id: 11, content: 'Background process finished', meta: { gateway_input_owner: 'o' } },
    { id: 12, content: 'Process watcher fired' },
    submittedRow(13, '[Wizard follow-through] helper receipt'),
    submittedRow(14, '[Wizard schedule] deferred run'),
    submittedRow(15, HEAVY_PREFIX + '\nreceipt')]
  const db = new DatabaseSync(hermesState(dir, rows), { readOnly: true })
  cleanup.push(() => db.close())
  const read = async () => envelope(httpRows(rows), 0)
  // Without the state.db lookup every row is machinery: the live 503 'human request unavailable'.
  await expect(heavyRequestWatermark(read, 's')).rejects.toMatchObject({ status: 503, message: 'human request unavailable' })
  expect([...submittedRowIds(db, 's', rows.map(r => r.id))].sort((a, b) => a - b)).toEqual([9, 10, 13, 14, 15])
  expect(submittedRowIds(db, 'other-session', rows.map(r => r.id)).size).toBe(0)
  expect(await heavyRequestWatermark(read, 's', { submitted: (ids: number[]) => submittedRowIds(db, 's', ids) })).toEqual(mark(owner))
  // Unreadable metadata or state fails closed, never grants authority.
  expect(submittedRowIds(null, 's', [10]).size).toBe(0)
})

it('Hermes 0.22.7: a submitted owner row stored in a compression descendant still counts for the root thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-watermark-lineage-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = hermesState(dir, [submittedRow(30, 'Before compaction')])
  const write = new DatabaseSync(path)
  write.prepare('INSERT INTO sessions VALUES (?, ?)').run('s-compacted', 's')
  write.prepare('INSERT INTO sessions VALUES (?, NULL)').run('unrelated')
  write.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(31, 's-compacted', 'user', 'After compaction',
    'internal_notification', JSON.stringify({ submission_id: 'run_31' }))
  write.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(32, 'unrelated', 'user', 'Other thread',
    'internal_notification', JSON.stringify({ submission_id: 'run_32' }))
  write.close()
  const db = new DatabaseSync(path, { readOnly: true })
  cleanup.push(() => db.close())
  expect([...submittedRowIds(db, 's', [30, 31, 32])].sort((a, b) => a - b)).toEqual([30, 31])
})

it('Hermes 0.22.7: heavy submit is admitted from a live owner turn whose request row is internal_notification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-submit-0227-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const owner = submittedRow(20, 'Run the forum rehearsal')
  const rows = [owner, { id: 21, content: 'Gateway wake' }]
  const statePath = hermesState(dir, rows)
  const runs = new DurableRunQueue({ statePath: join(dir, 'run.db'), pollIntervalMs: 0,
    launch: async (r: any) => ({ upstreamRunId: r.publicRunId, payload: { status: 'running' } }),
    lookup: async () => ({ payload: { status: 'running' } }) })
  cleanup.push(() => runs.close())
  const body = JSON.stringify({ session_id: 's', input: owner.content, model: 'origin-model', provider: 'origin-provider' })
  await runs.admit({ runtime: 'direct', sessionId: 's', idempotencyKey: 'origin', body, requestHash: queueRequestHash('direct', body) })
  await runs.tick(true)
  const token = 'watermark-fixture-token-000000000000000'
  const integration = createHeavyIntegration({ options: { heavyStatePath: join(dir, 'heavy.db'), heavyToken: token,
    heavyTransport: async () => new Promise(() => {}) }, queue: runs, hermesStatePath: statePath,
    request: async (path: string) => path.startsWith('/v1/runs/') ? {} : envelope(httpRows(rows), 0) }) as any
  cleanup.push(() => integration.close())
  const job = await integration.handle({ headers: { authorization: `Bearer ${token}` } }, '/wizard/internal/heavy/submit', {
    session_id: 's', key: 'forum-rehearsal', spec: { cwd: join(heavyRoot, 'fixture'), argv: ['true'], timeout_seconds: 10 } })
  expect(job.session_id).toBe('s')
  expect(integration.queue.get(job.job_id).watermark).toEqual(mark(owner))
})
