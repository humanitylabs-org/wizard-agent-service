import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownedOpenItems, countDispatchHandles, dispatchHandles, nonHoldingFollowUpIds, guardOwnedOpenWork, projectOwnedOpenWork } from '../server/owned-open-work.mjs'
import { createOwnedWorkFollowThrough, readOwnedOpenWork, findOwnedOpenWork, requireOwnedWorkContinuation, OWNED_WORK_PREFIX } from '../server/owned-open-work-follow-through.mjs'
import { createWizardServer, listen, WIZARD_RUN_INSTRUCTIONS } from '../server/service.mjs'
import { OWNED_OPEN_WORK_INSTRUCTIONS, guardHeavyStatus, parseStatus } from '../server/thread-status.mjs'
import { readHermesSessionTruth } from '../server/session-truth.mjs'
import { readHelperStatuses } from '../server/helper-status.mjs'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const status = (state = 'done') => ({ state, ask: 'The fix is finished.', subject: 'Tests' })
const reply = (item = 'Archimedes: run the next checks', state = 'done') => `**The fix works.**\n\n**Still open:**\n- ${item}\n[WIZARD_STATUS_V1]${JSON.stringify(status(state))}[/WIZARD_STATUS_V1]`
const evidence = (text = reply(), over = {}) => ({ agentId: 'hermes', sessionId: 'wizard_owned', runId: '1', messageId: '2', userId: 1,
  at: Date.now()/1000, fingerprint: 'synthetic', items: ownedOpenItems(text), ownedCount: ownedOpenItems(text).length, handleCount: 0, status: status(), continuation: false, ...over })
function directory() { const path = mkdtempSync(join(tmpdir(), 'owned-open-')); cleanup.push(() => rmSync(path, { recursive: true, force: true })); return path }
function transcript() {
  const root = directory(), path = join(root, 'state.db'), db = new DatabaseSync(path)
  cleanup.push(() => db.close())
  db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INT DEFAULT 1,display_kind TEXT,tool_calls TEXT,tool_call_id TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,title_source TEXT,started_at REAL,source TEXT,model TEXT,ended_at REAL,end_reason TEXT,message_count INTEGER DEFAULT 0,parent_session_id TEXT,last_activity_at REAL,pinned INTEGER DEFAULT 0,archived INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0);`)
  const add = (role: string, content: string, extra: any = {}) => db.prepare('INSERT INTO messages(session_id,role,content,timestamp,display_kind,tool_calls,tool_call_id) VALUES(?,?,?,?,?,?,?)')
    .run('wizard_owned', role, content, Date.now()/1000, extra.display_kind ?? null, extra.tool_calls ? JSON.stringify(extra.tool_calls) : null, extra.tool_call_id ?? null)
  return { root, path, db, add }
}
function controller(get: () => any) {
  const admit = vi.fn(async (..._args: any[]) => ({})), statePath = join(directory(), 'claims.db')
  const options = { statePath, sessionDbPath: '', read: () => get(), find: async () => [get()], validate: () => {}, admit }
  const worker = createOwnedWorkFollowThrough(options); cleanup.push(() => worker.close())
  return { worker, admit, options }
}
const call = (name: string, args: any = {}, id = 't1') => ({ id, function: { name, arguments: JSON.stringify(args) } })
const events = (name: string, args: any = {}, result: any = { id: 'live_1', status: 'queued' }) => [
  { role: 'assistant', tool_calls: JSON.stringify([call(name, args)]) }, { role: 'tool', tool_call_id: 't1', content: JSON.stringify(result) },
]

describe('owner corrections', () => {
  it('clear question about follow-up is accepted', () => {
    for (const item of ['Archimedes: Want me to start the soak? Reply yes', 'Should I run a follow-up check?', 'Shall I start the next pass?']) {
      expect(ownedOpenItems(reply(item))).toEqual([])
    }
    for (const item of ['Archimedes: mine to finish', 'Archimedes: say the word', 'Archimedes: if you want']) expect(ownedOpenItems(reply(item))).toHaveLength(1)
  })
  it('owner-labelled item is not owned', () => {
    for (const label of ['You', 'James', 'Owner']) expect(ownedOpenItems(reply(`${label}: the check covers Archimedes only for now. Whether other agents get it is your call.`))).toEqual([])
  })
  it('schedule via tool_call wrapper is credited', () => {
    const result = { id: '3cd71960-44b0-4f83-a6ce-a4e17746f307', name: 'Owned work check', nextRun: '2026-10-27T22:00:00+07:00' }
    for (const name of ['mcp__tool_call', 'tool_call', 'functions.tool_call']) expect(countDispatchHandles(events(name, { calls: [{ name: 'wizard_schedule', arguments: { when: '22:00' } }] }, result))).toBe(1)
    expect(countDispatchHandles(events('mcp__wizard_schedule', {}, result))).toBe(1)
    expect(countDispatchHandles(events('mcp__wizard_schedule_cancel', {}, result))).toBe(0)
    expect(countDispatchHandles(events('mcp__tool_call', { calls: [{ name: 'wizard_schedule' }, { name: 'wizard_schedule' }] }, result))).toBe(0)
    expect(countDispatchHandles(events('mcp__tool_call', { calls: [{ name: 'wizard_schedule' }] }, { ...result, error: 'no' }))).toBe(0)
  })
  it('earlier-run schedule handle is credited', () => {
    const f = transcript(); f.add('user', 'Schedule the follow-up')
    f.add('assistant', '', { tool_calls: [call('mcp__tool_call', { calls: [{ name: 'wizard_schedule', arguments: { when: '22:00' } }] })] })
    f.add('tool', JSON.stringify({ id: 'schedule_actual', name: 'Owner check', nextRun: '22:00' }), { tool_call_id: 't1' })
    f.add('assistant', 'Scheduled'); f.add('user', 'Anything else?')
    f.add('assistant', reply('Archimedes: started the follow-up schedule_actual, scheduled for 22:00'))
    f.db.exec('UPDATE messages SET active=0 WHERE id<=3') // compaction cannot erase real handle credit
    const e = readOwnedOpenWork(f.path, 'wizard_owned')!
    expect(e.ownedCount).toBe(1); expect(e.handleCount).toBe(1)
    expect(guardOwnedOpenWork(e.status, e)).toBe(e.status)
  })
  it('follow-through reply is never re-nudged', async () => {
    const f = transcript(); f.add('user', 'Fix it'); f.add('assistant', reply())
    const admit = vi.fn(async () => ({})), statePath = join(f.root, 'claims.db')
    const options: any = { sessionDbPath: f.path, statePath, admit, validate: () => {}, find: async () => [readOwnedOpenWork(f.path, 'wizard_owned')] }
    const worker = createOwnedWorkFollowThrough(options); cleanup.push(() => worker.close())
    await worker.tick(); expect(admit).toHaveBeenCalledTimes(1)
    f.add('user', OWNED_WORK_PREFIX); f.add('assistant', reply())
    // These were the live boundary changes: reporter rewrite then scheduled wakeup.
    f.add('user', '[reporter] Rewrite'); f.add('assistant', reply())
    f.add('user', '[Wizard schedule] Follow up'); f.add('assistant', reply())
    f.db.exec("UPDATE messages SET active=0 WHERE content LIKE '[Wizard follow-through]%'")
    expect(readOwnedOpenWork(f.path, 'wizard_owned')!.continuation).toBe(true)
    const restarted = createOwnedWorkFollowThrough(options); cleanup.push(() => restarted.close())
    await restarted.tick(); expect(admit).toHaveBeenCalledTimes(1)
    expect(restarted.evidenceFor('wizard_owned')!.continuation).toBe(true)
    // A genuine new owner request is a new chain, with its own one correction.
    f.add('user', 'Different request'); f.add('assistant', reply())
    await restarted.tick(); expect(admit).toHaveBeenCalledTimes(2)
  })
})

describe('owned open work starts without the owner asking', () => {
  it('done + owned item without a handle stays working and starts exactly one continuation', async () => {
    const e = evidence(), { worker, admit } = controller(() => e)
    const projected = projectOwnedOpenWork({ wizard_attention: e.status, status: 'completed' }, e)
    expect(projected.status).toBe('running'); expect(projected.wizard_waiting_on).toBe('owned_work')
    expect(projected.wizard_attention).toEqual({ ...status(), state: 'fyi', ask: 'Starting the follow-up work it listed.' })
    await worker.tick(); await worker.tick()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(admit.mock.calls[0][1]).toContain(OWNED_WORK_PREFIX)
    expect(admit.mock.calls[0][1]).toContain('Archimedes: run the next checks')
  })
  it('one successful wizard_schedule handle keeps done and issues no continuation', async () => {
    const e = evidence(reply(), { handleCount: countDispatchHandles(events('wizard_schedule')) }), { worker, admit } = controller(() => e)
    expect(guardOwnedOpenWork(e.status, e)).toBe(e.status)
    await worker.tick(); expect(admit).not.toHaveBeenCalled()
  })
  it.each(['James: approve the price', 'You: choose the colour', 'Owner: approve the price', 'Yours: decide', 'Follow-up checks remain'])('does not claim owner-only or ambiguous items: %s', async item => {
    const e = evidence(reply(item)), { worker, admit } = controller(() => e)
    expect(e.ownedCount).toBe(0); expect(guardOwnedOpenWork(e.status, e)).toBe(e.status)
    await worker.tick(); expect(admit).not.toHaveBeenCalled()
  })
  it('catches an inline say-the-word offer in Still open', async () => {
    const e = evidence('**Still open:** say the word if you want them queued'), { worker, admit } = controller(() => e)
    expect(e.ownedCount).toBe(1); expect(guardOwnedOpenWork(e.status, e).state).toBe('fyi')
    await worker.tick(); expect(admit).toHaveBeenCalledTimes(1)
  })
  it('other agents remain byte-for-byte untouched', async () => {
    const e = evidence(reply(), { agentId: 'philosopher' }), { worker, admit } = controller(() => e)
    expect(guardOwnedOpenWork(e.status, e)).toBe(e.status)
    await worker.tick(); expect(admit).not.toHaveBeenCalled()
  })
  it('persists per-run/per-reply markers, and never prompts its continuation reply', async () => {
    let e = evidence()
    const { worker, admit, options } = controller(() => e)
    await Promise.all([worker.tick(), worker.tick()])
    const restarted = createOwnedWorkFollowThrough(options); cleanup.push(() => restarted.close())
    await restarted.tick()
    e = { ...e, messageId: 'rewritten-reply' }; await restarted.tick()
    e = { ...e, runId: 'rewritten-run', messageId: '2' }; await restarted.tick()
    expect(admit).toHaveBeenCalledTimes(1)
    e = evidence(reply(), { runId: '3', messageId: '4', continuation: true })
    await restarted.tick(); expect(admit).toHaveBeenCalledTimes(1)
    const projected = projectOwnedOpenWork({ wizard_attention: status(), status: 'completed' }, e)
    expect(projected.status).toBe('completed')
    expect(projected.wizard_attention).toEqual({ ...status(), state: 'fyi' })
  })
  it('a reply without Still open is not an obligation', async () => {
    const e = evidence('I can queue it. Say the word.'), { worker, admit } = controller(() => e)
    expect(e.ownedCount).toBe(0); expect(guardOwnedOpenWork(e.status, e)).toBe(e.status)
    await worker.tick(); expect(admit).not.toHaveBeenCalled()
  })
  it.each(['needs_you', 'check'])('preserves owner decisions: %s', async state => {
    const e = evidence(reply(), { status: status(state) }), { worker, admit } = controller(() => e)
    expect(guardOwnedOpenWork(e.status, e)).toBe(e.status)
    await worker.tick(); expect(admit).not.toHaveBeenCalled()
  })
  it('adds the contract to Hermes only, leaving the routed prompt untouched', () => {
    expect(WIZARD_RUN_INSTRUCTIONS).toContain(OWNED_OPEN_WORK_INSTRUCTIONS)
    const routed = readFileSync(new URL('../server/agents-http.mjs', import.meta.url), 'utf8')
    expect(routed).not.toContain('OWNED_OPEN_WORK_INSTRUCTIONS')
    expect(routed).not.toContain(OWNED_OPEN_WORK_INSTRUCTIONS)
  })
  it('stops a failed admission without claiming that work is running or retrying', async () => {
    const e = evidence(), { worker, admit } = controller(() => e)
    admit.mockRejectedValueOnce(new Error('not available'))
    await worker.tick(); await worker.tick()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(worker.evidenceFor('wizard_owned')!.continuation).toBe(true)
  })
})

describe('owned work evidence', () => {
  it.each(['mine', 'me', 'I', "I’ll", 'Archimedes', 'agent', '(owner: Archimedes)', 'want me to', 'shall I', 'if you want me to queue', 'I can queue'])('recognizes %s', owner => {
    expect(ownedOpenItems(reply(`${owner}: run checks`))).toHaveLength(1)
  })
  it('stops at the next bold label/status marker and counts each offer once', () => {
    expect(ownedOpenItems('**Still open:**\n- James: price\n**What I did:**\n- Mine: fix')).toEqual([])
    expect(ownedOpenItems(reply('Mine: say the word'))).toHaveLength(1)
  })
  it.each(['wizard_schedule', 'wizard_heavy_submit', 'delegate_task', 'kanban_create', 'supervisor_build'])('counts successful handle creation only: %s', tool => {
    expect(countDispatchHandles(events(tool))).toBe(1)
    expect(countDispatchHandles(events(tool, {}, { error: 'denied', id: 'not_live' }))).toBe(0)
    expect(countDispatchHandles(events(tool, {}, { success: false }))).toBe(0)
    expect(countDispatchHandles(events(tool).slice(0, 1))).toBe(0)
  })
  it('excludes list/cancel/steer/stop, counts cron create, and dedupes tool IDs', () => {
    for (const tool of ['wizard_schedule_list', 'wizard_schedule_cancel']) expect(countDispatchHandles(events(tool))).toBe(0)
    for (const action of ['list', 'steer', 'stop']) expect(countDispatchHandles(events('delegate_task', { action }))).toBe(0)
    expect(countDispatchHandles(events('cronjob', { action: 'create' }))).toBe(1)
    expect(countDispatchHandles(events('cronjob', { action: 'list' }))).toBe(0)
    expect(countDispatchHandles([...events('wizard_schedule'), ...events('wizard_schedule')])).toBe(1)
  })
  it('counts wrapper calls individually, never crediting failed/mismatched siblings', () => {
    const wrapped = events('functions.tool_call', { calls: [
      { name: 'wizard_schedule', arguments: {} }, { name: 'wizard_heavy_submit', arguments: {} }, { name: 'wizard_schedule_list', arguments: {} },
    ] }, { results: [{ name: 'wizard_schedule', result: { id: 's1' } }, { name: 'wizard_heavy_submit', result: { error: 'no', id: 'j1' } }, { result: { id: 'list' } }] })
    expect(countDispatchHandles(wrapped)).toBe(1)
    expect(countDispatchHandles(events('wizard_schedule', {}, { id: 's1', status: 'failed' }))).toBe(0)
  })
  it('scopes handles to the triggering user, pairs results by ID, and refuses incomplete schemas', () => {
    const f = transcript()
    f.add('user', 'previous request'); f.add('assistant', '', { tool_calls: [call('wizard_schedule')] })
    f.add('tool', '{"id":"old_handle"}', { tool_call_id: 't1' }); f.add('assistant', 'Previous done')
    f.add('user', 'Current request'); f.add('assistant', reply())
    expect(readOwnedOpenWork(f.path, 'wizard_owned')!.handleCount).toBe(0)
    expect(findOwnedOpenWork(f.path)).toHaveLength(1)
    f.add('user', 'New turn'); f.add('assistant', '', { tool_calls: [call('wizard_schedule')] })
    f.add('tool', '{"id":"new_handle"}', { tool_call_id: 't1' }); f.add('assistant', reply())
    expect(readOwnedOpenWork(f.path, 'wizard_owned')!.handleCount).toBe(1)
    f.db.exec('ALTER TABLE messages DROP COLUMN tool_call_id')
    expect(readOwnedOpenWork(f.path, 'wizard_owned')).toBeNull()
  })
  it('revalidates current reply, new owner turns, live leases, age, and continuation suppression', async () => {
    const f = transcript(); f.add('user', 'fix it'); f.add('assistant', reply())
    const e = readOwnedOpenWork(f.path, 'wizard_owned')
    const token = { ...e, kind: 'owned-open-work', agent_id: 'hermes' }
    expect(() => requireOwnedWorkContinuation(f.path, token)).not.toThrow()
    f.db.prepare('INSERT INTO session_turn_leases VALUES(?,?)').run('wizard_owned', Date.now()/1000 + 60)
    expect(() => requireOwnedWorkContinuation(f.path, token)).toThrow('still holds')
    f.db.exec('DELETE FROM session_turn_leases')
    expect(() => requireOwnedWorkContinuation(f.path, token, Date.now()+3*3600_000)).toThrow('no longer current')
    f.add('user', 'New owner request')
    expect(readOwnedOpenWork(f.path, 'wizard_owned')).toBeNull()
    expect(() => requireOwnedWorkContinuation(f.path, token)).toThrow('no longer current')
    f.add('user', `${OWNED_WORK_PREFIX}\n- mine: checks`); f.add('assistant', reply())
    expect(readOwnedOpenWork(f.path, 'wizard_owned')!.continuation).toBe(true)
  })
})

// Real service session-list decoration + private admission + durable queue. No
// model/provider, owner DB, external network, or deployed release is accessed.
describe('owned-work service wiring', () => {
  async function service(enabled = true, heavy = false) {
    const f = transcript(), sent: any[] = []
    let scan = false
    f.db.prepare('INSERT INTO sessions(id,title,source,started_at) VALUES(?,?,?,?)').run('wizard_owned', 'Synthetic checks', 'wizard-mobile', Date.now()/1000)
    const fetchImpl = async (url: string, init: any = {}) => {
      const path = new URL(url).pathname
      const json = (data: any, code = 200) => new Response(JSON.stringify(data), { status: code, headers: { 'Content-Type': 'application/json' } })
      if (path === '/api/sessions') return json({ data: [{ id: 'wizard_owned', source: 'wizard-mobile', title: 'Synthetic checks', message_count: f.db.prepare('SELECT count(*) n FROM messages').get()?.n ?? 0, last_active: Date.now()/1000 }] })
      if (path.endsWith('/messages')) return json({ data: f.db.prepare('SELECT * FROM messages ORDER BY id').all() })
      if (path === '/api/sessions/wizard_owned') return json({ session: { id: 'wizard_owned', title: 'Synthetic checks' } })
      if (path === '/v1/capabilities') return json({ features: { run_instructions: true } })
      if (path === '/v1/runs' && init.method === 'POST') {
        const body = JSON.parse(String(init.body)); sent.push(body); f.add('user', body.input)
        return json({ run_id: 'synthetic_run', status: 'running' }, 202)
      }
      if (path.startsWith('/v1/runs/')) return json({ run_id: 'synthetic_run', status: 'running' })
      return json({ data: [] })
    }
    const server: any = createWizardServer({ fetchImpl, upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'synthetic-key', requireAccess: false,
      hermesStatePath: f.path, runQueueStatePath: join(f.root, 'queue.db'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [],
      dispatchHealthReader: () => true, followThrough: enabled, followThroughFinder: async () => [], joinedDelegation: 'off',
      ownedOpenWorkFinder: async () => scan ? findOwnedOpenWork(f.path) : [], ownedOpenWorkIntervalMs: 3600_000,
      ...(heavy ? { heavyStatePath: join(f.root, 'heavy.db'), heavyToken: 'fixture-heavy-token-'.repeat(3),
        heavyTransport: async (p: any) => ({ job_id: p.job_id, state: 'queued' }) } : {}),
      archivedSessionReader: () => [], pendingFirstSendReader: () => [], wizardOsHome: join(f.root, 'os') })
    const address = await listen(server)
    cleanup.push(async () => { await new Promise<void>(r => server.close(() => r())); await server.drained })
    const list = async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/wizard/hermes/api/sessions?limit=100`)
      expect(response.status).toBe(200)
      return (await response.json()).data.find((s: any) => s.id === 'wizard_owned')
    }
    return { ...f, server, sent, list, enableScan: () => { scan = true } }
  }
  it('the actual session list shows owned_work and dispatches a hidden service continuation once', async () => {
    const f = await service(); f.add('user', 'Fix the problem'); f.add('assistant', reply())
    f.enableScan()
    await f.server.ownedOpenWork.tick()
    // Once admitted, the continuation's own run owns the row; green done never shows.
    const before = await f.list()
    expect(before.status).toBe('running'); expect(before.wizard_attention?.state).not.toBe('done')
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    expect(f.sent[0].input).toContain(OWNED_WORK_PREFIX)
    expect(f.sent[0].instructions).toContain(OWNED_OPEN_WORK_INSTRUCTIONS)
    const history = await fetch(`http://127.0.0.1:${f.server.address().port}/wizard/hermes/api/sessions/wizard_owned/messages?view=wizard`).then(r => r.json())
    const machineTurn = history.data.find((row: any) => row.run_context?.original?.startsWith(OWNED_WORK_PREFIX))
    expect(machineTurn).toMatchObject({ role: 'system', display_kind: 'run_context', content: '', shareable: false })
    expect(machineTurn.run_context.from).toBe('Wizard follow-through')
    expect(history.data.filter((row: any) => row.role === 'user').map((row: any) => row.content)).toEqual(['Fix the problem'])
    f.add('assistant', reply())
    await f.server.ownedOpenWork.tick(); await f.server.ownedOpenWork.tick()
    expect(f.sent).toHaveLength(1)
    const after = await f.list()
    expect(after.wizard_attention.state).toBe('fyi')
    expect(after.wizard_attention.ask).toBe(status().ask)
  })
  it('started follow-up does not hold done', async () => {
    const f = await service(false, true)
    f.db.exec(`ALTER TABLE messages ADD COLUMN finish_reason TEXT DEFAULT 'stop'; ALTER TABLE sessions ADD COLUMN model_config TEXT;
      CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY,origin_session_id TEXT,parent_session_id TEXT,origin_ui_session_id TEXT,state TEXT,dispatched_at REAL,completed_at REAL,task_json TEXT,delivery_state TEXT,result_json TEXT);`)
    f.add('user', 'Fix the bug')
    for (const [tool, id] of [['wizard_heavy_submit', 'heavy_followup'], ['delegate_task', 'deleg_followup'], ['wizard_schedule', 'schedule_followup']]) {
      f.add('assistant', '', { tool_calls: [call(tool, {}, id)] }); f.add('tool', JSON.stringify({ job_id: id }), { tool_call_id: id })
    }
    const text = reply('Archimedes: started optional follow-up checks: heavy_followup and deleg_followup running now; schedule_followup scheduled for 22:00').replace('The fix works.', 'The fix is verified.')
    f.add('assistant', text)
    const e = readOwnedOpenWork(f.path, 'wizard_owned')!
    const ids = new Set(e.followUpIds)
    expect([...ids]).toEqual(['heavy_followup', 'deleg_followup', 'schedule_followup'])
    const heavyJob = { job_id: 'heavy_followup', sessionId: 'wizard_owned', agent_id: 'hermes', state: 'running', resume: '', created_at: Date.now() }
    expect(guardHeavyStatus(status(), { sessionId: 'wizard_owned', jobs: [heavyJob], nonHoldingIds: ids })).toEqual(status())
    expect(guardHeavyStatus(status(), { sessionId: 'wizard_owned', jobs: [heavyJob, { ...heavyJob, job_id: 'required_build' }], nonHoldingIds: ids }).state).toBe('fyi')
    // Routed agents still use the original false-done guard, even with exemptions supplied.
    expect(guardHeavyStatus(status(), { agentId: 'philosopher', sessionId: 'wizard_owned', jobs: [{ ...heavyJob, agent_id: 'philosopher' }], nonHoldingIds: ids }).state).toBe('fyi')
    const heavyDb = new DatabaseSync(join(f.root, 'heavy.db'))
    heavyDb.prepare('INSERT INTO heavy_jobs(id,session,origin,key,hash,data,agent_id) VALUES(?,?,?,?,?,?,?)')
      .run(heavyJob.job_id, 'wizard_owned', 'wizardq_origin', 'fixture', 'hash', JSON.stringify(heavyJob), 'hermes'); heavyDb.close()
    const t = Date.now()/1000
    f.db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)').run('deleg_followup', 'wizard_owned', null, '', 'running', t-1, null, '{"goals":["Optional check"]}', 'pending', '{}')
    expect(readHelperStatuses(f.path, ['wizard_owned']).size).toBe(0)
    expect(readHermesSessionTruth(f.path, ['wizard_owned']).get('wizard_owned')?.helpersRunning ?? 0).toBe(0)
    const done = await f.list()
    expect(done.status).not.toBe('running'); expect(done.wizard_attention.state).toBe('done')
    expect(done.wizard_waiting_on).toBeUndefined(); expect(done.wizard_helper_status).toBeUndefined()
    f.db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)').run('deleg_required', 'wizard_owned', null, '', 'running', t-1, null, '{"goals":["Required result"]}', 'pending', '{}')
    expect(readHelperStatuses(f.path, ['wizard_owned']).get('wizard_owned')?.pending).toBe(1)
    expect(readHermesSessionTruth(f.path, ['wizard_owned']).get('wizard_owned')?.helpersRunning).toBe(1)
    f.db.exec("DELETE FROM async_delegations WHERE delegation_id='deleg_required'")
    // A terminal but undelivered optional helper must not turn the already fixed request back to Working.
    f.db.prepare("UPDATE async_delegations SET state='completed',completed_at=?,result_json=?").run(t, '{"results":[{"task_index":0,"status":"completed","summary":"Optional result"}]}')
    expect(readHermesSessionTruth(f.path, ['wizard_owned']).get('wizard_owned')?.helperResultUnanswered).not.toBe(true)
    // No marker/background handoff is NOT completion, even if its prose calls work optional.
    f.add('assistant', 'Optional follow-up heavy_followup is running now. Waiting for its required result.')
    expect(readOwnedOpenWork(f.path, 'wizard_owned')!.followUpIds).toEqual([])
    const holding = await f.list(); expect(holding.status).toBe('running')
    const handles = dispatchHandles(events('wizard_heavy_submit', {}, { job_id: 'heavy_followup' }))
    expect(nonHoldingFollowUpIds(text, status('check'), handles)).toEqual([])
    expect(nonHoldingFollowUpIds(text.replace('heavy_followup', 'heavy_followup_other'), status(), handles)).toEqual([])
    expect(nonHoldingFollowUpIds(text, status('fyi'), handles)).toEqual(['heavy_followup'])
  })
  it('followThrough:false leaves shared Hermes sessions untouched', async () => {
    const f = await service(false); f.add('user', 'Fix'); f.add('assistant', reply())
    expect((await f.list()).wizard_attention.state).toBe('done'); expect(f.sent).toHaveLength(0)
    expect(f.server.ownedOpenWork).toBeUndefined()
  })
})

describe('owned open work scan stays cheap on large transcripts', () => {
  it('scans only rows after the previous high-water id', async () => {
    const { scanOwnedOpenWork } = await import('../server/owned-open-work-follow-through.mjs')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const path = join(mkdtempSync(join(tmpdir(), 'owned-scan-')), 'state.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL, active INTEGER DEFAULT 1, display_kind TEXT, message_uid TEXT)`)
    const now = Date.now()
    const add = (session, role, content) => db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run(session, role, content, now / 1000)
    add('wizard_a', 'user', 'go')
    add('wizard_a', 'assistant', '**Done.**\n\n**Still open:**\n- Mine: run the soak\n[WIZARD_STATUS_V1]{"state":"done","ask":"x","subject":"Wizard OS","title":"A · B"}[/WIZARD_STATUS_V1]')
    const first = scanOwnedOpenWork(path, { now })
    expect(first.evidence.map(e => e.sessionId)).toEqual(['wizard_a'])
    const second = scanOwnedOpenWork(path, { now, afterId: first.lastId })
    expect(second.evidence).toEqual([])
    db.close()
  })
})

describe('owned open work restated from an earlier turn', () => {
  it('credits "already scheduled" only against a real earlier handle in the same thread', async () => {
    const { readOwnedOpenWork } = await import('../server/owned-open-work-follow-through.mjs')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const make = (withEarlierHandle: boolean) => {
      const path = join(mkdtempSync(join(tmpdir(), 'owned-prior-')), 'state.db')
      const db = new DatabaseSync(path)
      db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL, active INTEGER DEFAULT 1, display_kind TEXT, message_uid TEXT)`)
      const add = (role: string, content: string, extra: any = {}) => db.prepare('INSERT INTO messages(session_id,role,content,tool_calls,tool_call_id,timestamp) VALUES(?,?,?,?,?,?)')
        .run('wizard_p', role, content, extra.tool_calls ?? null, extra.tool_call_id ?? null, Date.now() / 1000)
      add('user', 'queue the rest')
      if (withEarlierHandle) {
        add('assistant', '', { tool_calls: JSON.stringify([{ id: 'c1', function: { name: 'wizard_schedule', arguments: '{}' } }]) })
        add('tool', JSON.stringify({ id: 'sched_1', nextRun: 'tonight' }), { tool_call_id: 'c1' })
      }
      add('assistant', 'Scheduled.')
      add('user', 'anything else?')
      add('assistant', '**Nothing else.**\n\n**Still open:**\n- The rebase runs tonight around 03:40. That is mine, and it is already scheduled.\n[WIZARD_STATUS_V1]{"state":"fyi","ask":"x","subject":"Wizard OS","title":"A · B"}[/WIZARD_STATUS_V1]')
      db.close()
      return readOwnedOpenWork(path, 'wizard_p')!
    }
    const credited = make(true)
    expect(credited.ownedCount).toBe(1); expect(credited.handleCount).toBe(1)
    const unpaid = make(false)
    expect(unpaid.ownedCount).toBe(1); expect(unpaid.handleCount).toBe(0)
  })
})

describe('owned open work waits for a busy thread', () => {
  it('starts the follow-up once the owner turn releases, without a fresh scan hit', async () => {
    const { createOwnedWorkFollowThrough, OWNED_WORK_PREFIX: prefix } = await import('../server/owned-open-work-follow-through.mjs')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const root = mkdtempSync(join(tmpdir(), 'owned-busy-'))
    const path = join(root, 'state.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL, active INTEGER DEFAULT 1, display_kind TEXT, message_uid TEXT)`)
    const add = (role: string, content: string) => db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('wizard_busy', role, content, Date.now() / 1000)
    add('user', 'fix it')
    add('assistant', '**Fixed.**\n\n**Still open:**\n- Mine: run the soak tonight\n[WIZARD_STATUS_V1]{"state":"done","ask":"x","subject":"Wizard OS","title":"A · B"}[/WIZARD_STATUS_V1]')
    let busy = true
    const inputs: string[] = []
    const worker = createOwnedWorkFollowThrough({ sessionDbPath: path, statePath: join(root, 'claims.db'), busy: async () => busy,
      validate: async () => undefined, admit: async (_s: string, text: string) => { inputs.push(text) } })
    await worker.tick(); expect(inputs).toHaveLength(0)
    busy = false
    await worker.tick(); await worker.tick()
    expect(inputs).toHaveLength(1); expect(inputs[0].startsWith(prefix)).toBe(true)
    worker.close(); db.close()
  })
})

describe('one good reply per thread', () => {
  it('automatic owned-work nudges stay off unless explicitly enabled', async () => {
    const { readFileSync } = await import('node:fs')
    const index = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')
    expect(index).toContain("ownedOpenWork: process.env.WIZARD_OWNED_OPEN_WORK === 'on'")
  })
})
