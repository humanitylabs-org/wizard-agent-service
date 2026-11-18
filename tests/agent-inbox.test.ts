// Issue 549: the agent inbox store (one record per background task), its nightly check, and the switch.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentInboxStore, INBOX_RUN_PREFIX, NO_SUMMARY, STALE_NOTE, START_FAILED, textForModel } from '../server/agent-inbox.mjs'
import { DurableRunQueue } from '../server/run-queue.mjs'
import { Scheduler } from '../server/scheduler.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r))))
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const home = () => { const d = mkdtempSync(join(tmpdir(), 'agent-inbox-')); dirs.push(d); return d }
const line = (value: any) => `Reply text\n[WIZARD_STATUS_V1]${JSON.stringify(value)}[/WIZARD_STATUS_V1]`
const clock = (start = Date.parse('2026-11-18T10:00:00Z')) => { const c = { at: start, now: () => c.at }; return c }
const store = (path = '', c = clock(), log: string[] = []) => new AgentInboxStore(path, { now: c.now, log: (m: string) => log.push(m) })
const task = (s: any, thread = 'wizard_worker_1', extra = {}) => s.capture({ thread_id: thread, title: 'Book the dentist', ask: 'Find a dentist slot this week', ...extra }).record

describe('agent inbox store', () => {
  it('capture writes a running record before any worker turn, and the same ask never makes two', () => {
    const s = store()
    const first = s.capture({ thread_id: 'wizard_worker_1', title: 'Book the dentist', ask: 'Find a dentist slot this week' })
    expect(first.created).toBe(true)
    expect(first.record).toMatchObject({ state: 'running', agent: 'hermes', thread_id: 'wizard_worker_1', kind: 'note', privacy_class: 'private', surfaced_count: 0 })
    expect(first.record.id).toMatch(/^inbox_[a-f0-9]{24}$/)
    const again = s.capture({ thread_id: 'wizard_worker_1', title: 'Book the dentist', ask: 'find a dentist slot this week' })
    expect([again.created, again.record.id]).toEqual([false, first.record.id])
    // The same mail captured into another worker thread is still the same record.
    const mail = s.capture({ thread_id: 'wizard_worker_2', source: { app: 'mail', item: 'msg-1' }, title: 'Reply to Anna', dedupe_hash: 'ab'.repeat(16) })
    expect(s.capture({ thread_id: 'wizard_worker_3', title: 'Reply to Anna', dedupe_hash: 'ab'.repeat(16) }).record.id).toBe(mail.record.id)
    expect(s.list()).toHaveLength(2)
    expect(() => s.capture({ thread_id: '../x', title: 'x' })).toThrow()
    expect(() => s.capture({ thread_id: 'wizard_ok' })).toThrow()
  })

  it('a captured task whose worker could not start waits on the owner, never lost (issue 551)', () => {
    const s = store()
    const made = task(s)
    expect(s.startFailed(made.id)).toMatchObject({ state: 'new', kind: 'needs_you', last_update: START_FAILED })
    expect(s.startFailed(made.id)).toBeNull()
    expect(s.startFailed('inbox_' + '0'.repeat(24))).toBeNull()
    expect(s.retryStart(made.id)).toMatchObject({ state: 'running', kind: 'note', last_update: made.ask })
    expect(s.retryStart(made.id)).toBeNull()
  })

  it('issue 1569: only a Service-started worker thread may be hidden, never a thread the owner started or typed in', () => {
    const s = store()
    // A thread the owner started himself has no worker record (a capture from his own thread is not a worker).
    expect(s.mayHide('hermes', 'wizard_owner_1')).toBe(false)
    s.capture({ thread_id: 'wizard_owner_1', title: 'From my chat', ask: 'Look into this later' })
    expect(s.mayHide('hermes', 'wizard_owner_1')).toBe(false)
    // The orb's worker thread may be hidden until the owner writes in it; after that, never again.
    s.capture({ thread_id: 'wizard_worker_9', title: 'Flights', ask: 'Research flights to Lisbon' }, { fields: { worker: true } })
    expect(s.mayHide('hermes', 'wizard_worker_9')).toBe(true)
    expect(s.mayHide('other', 'wizard_worker_9')).toBe(false)
    expect(s.ownerTurnPending('hermes', 'wizard_worker_9')).toBe(true)
    expect(s.ownerTurn('hermes', 'wizard_worker_9')).toHaveLength(1)
    expect(s.ownerTurnPending('hermes', 'wizard_worker_9')).toBe(false)
    expect(s.ownerTurn('hermes', 'wizard_worker_9')).toEqual([])
    expect(s.mayHide('hermes', 'wizard_worker_9')).toBe(false)
    // An orb dump record kept from before the worker marker is still a worker (its thread is already hidden).
    s.capture({ thread_id: 'wizard_worker_8', title: 'Old dump', ask: 'Plan the move', source: 'orb:dump' })
    expect(s.mayHide('hermes', 'wizard_worker_8')).toBe(true)
  })
  it('every finished worker run updates exactly one record: needs_you, done, fyi, no status line, killed', () => {
    const s = store()
    const r = task(s)
    expect(s.noteRun('hermes', 'wizard_worker_1', { id: 'run1', status: 'running', output: '' })).toBeNull()
    // Any status that is not a finished one (routed 'started', a new alias) changes nothing.
    for (const status of ['started', 'queued', 'waiting', 'something-new', '']) expect(s.noteRun('hermes', 'wizard_worker_1', { id: 'run0', status, output: '' })).toBeNull()
    s.noteRun('hermes', 'wizard_worker_1', { id: 'run1', status: 'completed', output: line({ state: 'needs_you', ask: 'Two slots free. Reply mon or tue', recommendation: 'Take Monday at 9.', options: { mon: 'Book Monday at 9.', tue: 'Book Tuesday at 4.', 'Bad Token': 'x' }, default_option: 'mon', deadline: '2026-11-20', confirm: true }) })
    expect(s.get(r.id)).toMatchObject({ state: 'new', kind: 'needs_you', ask: 'Two slots free. Reply mon or tue', last_update: 'Two slots free. Reply mon or tue', recommendation: 'Take Monday at 9.', options: { mon: 'Book Monday at 9.', tue: 'Book Tuesday at 4.' }, default_option: 'mon', deadline: '2026-11-20T00:00:00.000Z', confirm: true })
    s.noteRun('hermes', 'wizard_worker_1', { id: 'run2', status: 'completed', output: line({ state: 'check', ask: 'Booked Monday. Say if the time is right' }) })
    // A later line without options carries no stale tokens or recommendation; the task's deadline stays.
    expect(s.get(r.id)).toMatchObject({ state: 'new', kind: 'needs_you', options: {}, recommendation: '', default_option: null, confirm: false, deadline: '2026-11-20T00:00:00.000Z' })
    s.noteRun('hermes', 'wizard_worker_1', { id: 'run3', status: 'completed', output: line({ state: 'done', ask: 'Dentist booked for Monday at 9' }) })
    expect(s.get(r.id)).toMatchObject({ state: 'new', kind: 'result', last_update: 'Dentist booked for Monday at 9' })
    // fyi while more work is on its way only moves last_update; at the end of the work it is an FYI record.
    const w = task(s, 'wizard_worker_2', { title: 'Watch prices', ask: 'Watch flight prices' })
    s.noteRun('hermes', 'wizard_worker_2', { id: 'w1', status: 'completed', output: line({ state: 'fyi', ask: 'Started the watcher' }) }, { continues: true })
    expect(s.get(w.id)).toMatchObject({ state: 'running', kind: 'note', last_update: 'Started the watcher' })
    // The heavy-work guard turns a done into fyi while background work is owed: still running.
    s.noteRun('hermes', 'wizard_worker_2', { id: 'w2', status: 'completed', output: line({ state: 'done', ask: 'All done' }) }, { guard: (st: any) => ({ ...st, state: 'fyi', ask: 'Background work is still running or waiting to report back.' }) })
    expect(s.get(w.id)).toMatchObject({ state: 'running', last_update: 'Background work is still running or waiting to report back.' })
    s.noteRun('hermes', 'wizard_worker_2', { id: 'w3', status: 'completed', output: line({ state: 'fyi', ask: 'Prices are flat this week' }) })
    expect(s.get(w.id)).toMatchObject({ state: 'new', kind: 'fyi', last_update: 'Prices are flat this week' })
    // No parseable status line, and a killed worker: still a result, nothing dropped.
    const n = task(s, 'wizard_worker_3', { ask: 'Summarise the report' })
    s.noteRun('hermes', 'wizard_worker_3', { id: 'n1', status: 'completed', output: 'Here is the summary, but no status line [WIZARD_STATUS_V1]{broken' })
    expect(s.get(n.id)).toMatchObject({ state: 'new', kind: 'result', last_update: NO_SUMMARY })
    const k = task(s, 'wizard_worker_4', { ask: 'Clean the downloads folder' })
    s.noteRun('hermes', 'wizard_worker_4', { id: 'k1', status: 'failed', output: '' })
    expect(s.get(k.id)).toMatchObject({ state: 'new', kind: 'result', last_update: NO_SUMMARY })
    expect(s.list()).toHaveLength(4)
    // A thread with no record, or another agent's thread, is never written.
    expect(s.noteRun('hermes', 'wizard_other', { id: 'x', status: 'completed', output: line({ state: 'done', ask: 'x' }) })).toBeNull()
    expect(s.noteRun('research', 'wizard_worker_1', { id: 'x', status: 'completed', output: line({ state: 'done', ask: 'x' }) })).toBeNull()
  })

  it('every status line updates last_update (at most 140 chars) and the same run read twice applies once', () => {
    const s = store()
    const r = task(s)
    const long = 'Word '.repeat(60)
    s.noteStatus('hermes', 'wizard_worker_1', line({ state: 'fyi', ask: long }))
    const after = s.get(r.id)
    expect(after.last_update.length).toBeLessThanOrEqual(140)
    expect(after.state).toBe('running')
    const done = line({ state: 'done', ask: 'Finished' })
    expect(s.noteRun('hermes', 'wizard_worker_1', { id: 'r1', status: 'completed', output: done })).not.toBeNull()
    s.patch(r.id, { action: 'answer' })
    // List polls read the same finished run again: the owner's answer is not undone by it.
    expect(s.noteRun('hermes', 'wizard_worker_1', { id: 'r1', status: 'completed', output: done })).toBeNull()
    expect(s.get(r.id).state).toBe('answered')
    // A repeat of the same ask in a later run updates the same record, never a second one.
    s.noteRun('hermes', 'wizard_worker_1', { id: 'r2', status: 'completed', output: line({ state: 'needs_you', ask: 'Pick a slot' }) })
    s.noteRun('hermes', 'wizard_worker_1', { id: 'r3', status: 'completed', output: line({ state: 'needs_you', ask: 'Pick a slot' }) })
    expect(s.list()).toHaveLength(1)
    expect(s.get(r.id)).toMatchObject({ state: 'new', kind: 'needs_you', ask: 'Pick a slot' })
  })

  it('a worker killed mid-run shows as no news for 6 h at the next read (fake clock)', () => {
    const c = clock(), s = store('', c)
    const r = task(s)
    s.noteStatus('hermes', 'wizard_worker_1', line({ state: 'fyi', ask: 'Working on it' }))
    c.at += 6 * 3600_000 - 1
    expect(s.list({ state: 'stale' })).toHaveLength(0)
    c.at += 1
    const [stale] = s.list({ state: 'stale' })
    expect(stale).toMatchObject({ id: r.id, state: 'stale', last_update: STALE_NOTE })
    // News again brings it back to running.
    s.noteStatus('hermes', 'wizard_worker_1', line({ state: 'fyi', ask: 'Back on it' }))
    expect(s.get(r.id).state).toBe('running')
  })

  it('records survive a restart, in the state file the backup already covers', () => {
    const d = home(), path = join(d, 'state', 'wizard-mobile', 'agent-inbox.json')
    const s = store(path)
    const r = task(s)
    s.noteRun('hermes', 'wizard_worker_1', { id: 'r1', status: 'completed', output: line({ state: 'done', ask: 'Finished' }) })
    const again = store(path)
    expect(again.get(r.id)).toMatchObject({ state: 'new', kind: 'result', last_update: 'Finished' })
    writeFileSync(path, 'not json')
    expect(store(path).list()).toEqual([])
  })

  it('owner actions: answer needs a known option, snooze, archive, surface', () => {
    const s = store()
    const r = task(s)
    s.noteRun('hermes', 'wizard_worker_1', { id: 'r1', status: 'completed', output: line({ state: 'needs_you', ask: 'Pick', options: { yes: 'Do it.', no: 'Leave it.' } }) })
    expect(() => s.patch(r.id, { action: 'answer', option: 'maybe' })).toThrow()
    expect(s.patch(r.id, { action: 'surface' })).toMatchObject({ state: 'surfaced', surfaced_count: 1 })
    expect(s.patch(r.id, { action: 'answer', option: 'yes' })).toMatchObject({ state: 'answered', answer: 'yes' })
    expect(s.patch(r.id, { action: 'snooze' }).state).toBe('new')
    expect(s.patch(r.id, { action: 'archive' }).state).toBe('archived')
    expect(() => s.patch(r.id, { action: 'delete' })).toThrow()
    expect(s.patch('inbox_000000000000000000000000', { action: 'archive' })).toBeNull()
    // An archived record no longer takes status lines.
    expect(s.noteRun('hermes', 'wizard_worker_1', { id: 'r2', status: 'completed', output: line({ state: 'done', ask: 'x' }) })).toBeNull()
  })

  it('private-class text never reaches a non-private model', () => {
    const s = store()
    const priv = task(s), general = task(s, 'wizard_worker_2', { ask: 'General ask', privacy_class: 'general' })
    expect(textForModel(priv, { privateModel: false })).toBeNull()
    expect(textForModel(priv, { privateModel: true })).toMatchObject({ title: 'Book the dentist' })
    expect(textForModel(general)).toMatchObject({ ask: 'General ask' })
  })
})

describe('nightly check', () => {
  it('reports 0 finished worker runs without a record on 20 runs, and 1 when one record is deleted', () => {
    const d = home(), c = clock(), log: string[] = []
    const queue: any = new DurableRunQueue({ statePath: join(d, 'q.sqlite3'), launch: async () => ({}), lookup: async () => ({}), activeSessionIds: async () => [], canDispatch: async () => false } as any)
    const insert = queue.database.prepare(`INSERT INTO wizard_run_queue (public_run_id, runtime, session_id, idempotency_key, request_hash, body,
      trusted_paths_json, status, created_at, updated_at, terminal_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    const t = c.at / 1000 - 3600
    const s = store(join(d, 'agent-inbox.json'), c, log)
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      insert.run(`wizardq_${i}`, 'direct', `wizard_worker_${i}`, `${INBOX_RUN_PREFIX}${i}`, 'a'.repeat(32), '{}', '[]', 'completed', t, t, t)
      ids.push(task(s, `wizard_worker_${i}`, { ask: `Task ${i}` }).id)
    }
    // Owner chats, still-running worker runs and runs older than the window are not worker runs to check.
    insert.run('wizardq_owner', 'direct', 'wizard_owner', 'owner-send-1', 'a'.repeat(32), '{}', '[]', 'completed', t, t, t)
    insert.run('wizardq_live', 'direct', 'wizard_worker_live', `${INBOX_RUN_PREFIX}live`, 'a'.repeat(32), '{}', '[]', 'running', t, t, null)
    insert.run('wizardq_old', 'direct', 'wizard_worker_old', `${INBOX_RUN_PREFIX}old`, 'a'.repeat(32), '{}', '[]', 'completed', t - 30 * 86400, t - 30 * 86400, t - 30 * 86400)
    const runs = () => queue.finishedRunsWithKeyPrefix(INBOX_RUN_PREFIX, (c.at - 7 * 86400_000) / 1000)
    expect(runs()).toHaveLength(20)
    expect(s.nightly(c.at, runs())).toMatchObject({ missing: 0, stale: 0 })
    expect(log).toEqual([])
    // Once a day: a second call the same day does nothing.
    expect(s.nightly(c.at + 3600_000, runs())).toBeNull()
    s.remove(ids[7])
    c.at += 24 * 3600_000
    const check = s.nightly(c.at, runs())
    expect(check).toMatchObject({ missing: 1, missing_runs: ['wizardq_7'] })
    expect(log.join('\n')).toContain('1 finished worker run(s) without an inbox record')
    expect(store(join(d, 'agent-inbox.json'), c).lastCheck()).toMatchObject({ missing: 1 })
    queue.database.close()
  })

  it('the scheduler calls the nightly hook on its scheduling tick, and a failing hook never stops the tick', async () => {
    const d = home(), calls: number[] = []
    const make = (nightly: any) => new Scheduler({ statePath: join(d, `s${calls.length}-${Math.random()}.sqlite3`), deliver: async () => ({}), now: () => 1234, nightly } as any)
    const ok = make((now: number) => { calls.push(now) })
    await ok.tick(); await ok.close()
    expect(calls).toEqual([1234])
    const bad = make(() => { throw new Error('boom') })
    await expect(bad.tick()).resolves.toBeUndefined()
    await bad.close()
  })
})

describe('agent inbox HTTP and switch', () => {
  async function start(d: string, extra: any = {}) {
    const s = createWizardServer({ wizardOsHome: d, requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false,
      runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, agentInboxStatePath: join(d, 'agent-inbox.json'), ...extra })
    servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}/wizard/v1/agent-inbox`
  }
  const json = (method: string, value: any, headers = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) })

  it('switch off: every inbox route is 404 and nothing is written', async () => {
    const d = home(), u = await start(d)
    expect((await fetch(u)).status).toBe(404)
    expect((await fetch(u, json('POST', { thread_id: 'wizard_w', title: 'x' }))).status).toBe(404)
    expect((await fetch(`${u}/inbox_000000000000000000000000`)).status).toBe(404)
    // Issue 550: switch off = no card, no sweep, no Yes to all.
    expect((await fetch(`${u}/sweep`)).status).toBe(404)
    expect((await fetch(`${u}/sweep`, json('POST', {}))).status).toBe(404)
    expect((await fetch(`${u}/sweep_000000000000000000000000/yes-to-all`, json('POST', {}))).status).toBe(404)
    // Issue 552: switch off = no alert rules, no events, no feedback; Alerts exactly as now.
    expect((await fetch(`${u}/rules`)).status).toBe(404)
    expect((await fetch(`${u}/events`, json('POST', { type: 'payment_failed', title: 'x' }))).status).toBe(404)
    expect((await fetch(`${u}/alert-log`)).status).toBe(404)
    expect((await fetch(`${u}/inbox_000000000000000000000000`, json('PATCH', { action: 'not_urgent' }))).status).toBe(404)
    expect(existsSync(join(d, 'agent-inbox.json'))).toBe(false)
    expect(existsSync(join(d, 'alert-rules.json'))).toBe(false)
  })

  it('issue 550: a sweep needs the Daily channel; the card route shapes are owner-only and strict', async () => {
    const d = home(), u = await start(d, { agentInbox: true })
    expect((await (await fetch(`${u}/sweep`)).json()).card).toBeNull()
    // No Daily channel (Channels off): nowhere to post the card, nothing written.
    const refused = await fetch(`${u}/sweep`, json('POST', {}))
    expect([refused.status, (await refused.json()).error]).toEqual([409, 'daily_unavailable'])
    expect((await fetch(`${u}/sweep`, json('PATCH', {}))).status).toBe(405)
    expect((await fetch(`${u}/sweep_000000000000000000000000/yes-to-all`, json('POST', {}))).status).toBe(404)
    expect((await fetch(`${u}/sweep_000000000000000000000000/yes-to-all`)).status).toBe(405)
    expect((await fetch(`${u}/inbox_000000000000000000000000/yes-to-all`, json('POST', {}))).status).toBe(404)
    expect((await fetch(`${u}/sweep`, json('POST', {}, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
  })

  it('the owner switch in the Look file turns it on at runtime; the env/option choice wins', async () => {
    const d = home(), pages = join(d, 'Pages')
    const look = (on: boolean) => { mkdirSync(join(pages, 'wizard-look'), { recursive: true }); writeFileSync(join(pages, 'wizard-look', 'look.json'), JSON.stringify({ version: 1, tweaks: { 'wizard/agent-inbox': { on } } })) }
    look(false)
    const u = await start(d, { pagesRoot: pages, pagesGitDir: join(d, 'pages.git'), pagesWatch: false, agentInboxSwitchTtlMs: 0 })
    expect((await fetch(u)).status).toBe(404)
    look(true)
    expect((await fetch(u)).status).toBe(200)
    const forcedOff = await start(home(), { agentInbox: false, pagesRoot: pages, pagesGitDir: join(d, 'pages2.git'), pagesWatch: false, agentInboxSwitchTtlMs: 0 })
    expect((await fetch(forcedOff)).status).toBe(404)
  })

  it('switch on: capture, list by state, read, patch; owner-settings gate on writes', async () => {
    const d = home(), u = await start(d, { agentInbox: true })
    const made = await fetch(u, json('POST', { thread_id: 'wizard_w', title: 'Book the dentist', ask: 'Find a slot', link: 'javascript:alert(1)' }))
    expect(made.status).toBe(201)
    const { record } = await made.json()
    expect(record).toMatchObject({ state: 'running', agent: 'hermes', link: null })
    expect(record.run_sigs).toBeUndefined()
    expect((await fetch(u, json('POST', { thread_id: 'wizard_w', title: 'Book the dentist', ask: 'Find a slot' }))).status).toBe(200)
    expect((await (await fetch(`${u}?state=running`)).json()).records.map((r: any) => r.id)).toEqual([record.id])
    expect((await (await fetch(`${u}?state=new`)).json()).records).toEqual([])
    expect((await (await fetch(`${u}/${record.id}`)).json()).record.title).toBe('Book the dentist')
    expect((await (await fetch(`${u}/${record.id}`, json('PATCH', { action: 'archive' }))).json()).record.state).toBe('archived')
    expect((await fetch(`${u}/${record.id}`, json('PATCH', { action: 'nope' }))).status).toBe(400)
    expect((await fetch(`${u}/inbox_000000000000000000000000`)).status).toBe(404)
    expect((await fetch(u, { method: 'POST', body: 'x=1' })).status).toBe(415)
    expect((await fetch(u, json('DELETE', {}))).status).toBe(405)
    expect((await fetch(u, json('POST', { thread_id: 'wizard_w2', title: 'x' }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
    expect((await fetch(u, json('POST', { thread_id: '../etc', title: 'x' }))).status).toBe(400)
    expect(existsSync(join(d, 'agent-inbox.json'))).toBe(true)
  })
})
