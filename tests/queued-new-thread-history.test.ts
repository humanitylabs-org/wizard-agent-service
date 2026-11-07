import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen, queuedOwnerHistory } from '../server/service.mjs'

// Real shape (7 Nov 2026): a brand-new voice-note thread whose first message waited in the run queue for ~28 min.
// Hermes had no session yet, so GET /api/sessions/<id>/messages answered 404 and the shell said
// "This thread is no longer here". The thread is real: its queued owner turn must be served instead.
const servers: ReturnType<typeof createServer>[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const history = (origin: string, sid: string) => fetch(`${origin}/wizard/hermes/api/sessions/${sid}/messages?order=oldest&limit=500&offset=0&include_compacted=true&view=wizard`)

describe('history of a thread whose first message is still queued', () => {
  it('serves the queued owner message (200) instead of 404; unknown sessions still 404', async () => {
    const upstream = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(Buffer.from(c)))
        req.on('end', () => { const b = JSON.parse(Buffer.concat(chunks).toString()); res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ run_id: `actual_${b.session_id}`, session_id: b.session_id, status: 'running' })) })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return }
      if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'run', run_id: url.pathname.split('/')[3], status: 'running' })); return }
      if (req.method === 'GET' && url.pathname === '/api/sessions') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [] })); return }
      // Hermes answers 404 for a session it has never created (real body).
      if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Session not found: ${url.pathname.split('/')[3]}`, type: 'invalid_request_error', param: null, code: 'session_not_found' } }))
        return
      }
      res.writeHead(404); res.end()
    })
    servers.push(upstream)
    const up = await listen(upstream)
    const directory = await mkdtemp(join(tmpdir(), 'wizard-queued-history-'))
    dirs.push(directory)
    const statePath = join(directory, 'state.db')
    const state = new DatabaseSync(statePath)
    state.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);`)
    state.close()
    const wizard = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${up.port}`,
      hermesKey: 'fixture-key', requireAccess: false, hermesStatePath: statePath, wizardOsHome: directory,
      canonicalSessionReader: () => [], runQueueStatePath: join(directory, 'queue.sqlite3'),
      runQueueMaxActive: 1, runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
    })
    servers.push(wizard)
    const origin = `http://127.0.0.1:${(await listen(wizard)).port}`
    const admit = (sessionId: string, key: string, input: unknown) => fetch(`${origin}/wizard/hermes/v1/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ session_id: sessionId, input }),
    }).then((r) => r.json())

    // One other thread holds the only slot, so the new thread's first message waits with waiting_reason "capacity".
    expect((await admit('wizard_1794036340706_7a4a6d366ae1', 'busy', 'working')).status).toBe('running')
    const SID = 'wizard_1794059002425_da1966b95ef0'
    const queued = await admit(SID, 'voice-1', 'Can we stop the automatic summaries?')
    expect(JSON.stringify(queued)).toContain('queued')

    const res = await history(origin, SID)
    expect(res.status).toBe(200)
    const body = await res.json()
    const users = body.data.filter((r: any) => r.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ session_id: SID, content: 'Can we stop the automatic summaries?' })
    expect(users[0].display_kind).toBeUndefined()

    // A machine-tagged input queued for a session never becomes an owner bubble, but the thread still opens (200, empty).
    await admit('wizard_github_activity', 'machine-1', '[Wizard follow-through] Recovered helper receipt deleg_3d7accbb')
    const machine = await history(origin, 'wizard_github_activity')
    expect(machine.status).toBe(200)
    expect((await machine.json()).data).toEqual([])

    // A session with no queue rows and no Hermes session is genuinely unknown.
    expect((await history(origin, 'wizard_1700000000000_000000000000')).status).toBe(404)
  })
})

describe('queuedOwnerHistory (real queue row shapes)', () => {
  const SID = 'wizard_1794059002425_da1966b95ef0'
  // Row copied from the live queue: string input with a voice-file block, direct runtime, queued for capacity.
  const voice = 'I am not sure what the orb notes are.\n\n[WIZARD_FILES_V1]\n[{"id":"drop_b116d5b06aca4f819f1cca899f4e30dd","filename":"wizard-voice-2026-11-07T13-43-34-206Z.webm","mime":"audio/webm","bytes":280247}]'
  const rec = (publicRunId: string, input: unknown, extra: object = {}) => ({ publicRunId, sessionId: SID, status: 'queued', upstreamRunId: '', createdAt: 1794059006.955, body: JSON.stringify({ session_id: SID, input, ...extra }), payload: {}, ...extra })
  const queue = (rows: object[]) => ({ queuedForSession: (runtime: string, sid: string) => (runtime === 'direct' && sid === SID ? rows : []) })

  it('turns queued owner rows into user messages and drops machine strings', () => {
    const out = JSON.parse(queuedOwnerHistory(queue([
      rec('wizardq_1eefa5e56ee4441394a9eda52356a866', voice),
      rec('wizardq_2', '[Wizard follow-through] Recovered helper receipt deleg_3d7accbb'),
      rec('wizardq_3', [{ role: 'user', content: [{ type: 'text', text: 'second message' }] }]),
    ]), SID)!.toString())
    expect(out.data.map((r: any) => [r.role, r.content])).toEqual([['user', voice], ['user', 'second message']])
    expect(out.data[0]).toMatchObject({ id: 'queue-wizardq_1eefa5e56ee4441394a9eda52356a866', session_id: SID, timestamp: 1794059006.955 })
  })
  it('shows a retried attempt once, and returns null for a session with no queue rows', () => {
    const a = rec('wizardq_a', 'same words', { status: 'interrupted' })
    const b = rec('wizardq_b', 'same words', { retrySourceId: 'wizardq_a' })
    expect(JSON.parse(queuedOwnerHistory(queue([a, b]), SID)!.toString()).data).toHaveLength(1)
    expect(queuedOwnerHistory(queue([]), SID)).toBeNull()
    expect(queuedOwnerHistory(null, SID)).toBeNull()
  })
})
