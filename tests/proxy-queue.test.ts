import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen, readActiveHumanSessionIds, WIZARD_RUN_INSTRUCTIONS, wizardDispatchHealthy } from '../server/service.mjs'

const servers: ReturnType<typeof createServer>[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function request(origin: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${origin}${path}`, init)
  const text = await response.text()
  const json = text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null
  return { response, text, json }
}

describe('Wizard proxy capacity queue', () => {
  it('uses canonical live-session evidence and pauses dispatch under CPU pressure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-active-sessions-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'state.db')
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT, hidden INTEGER, parent_session_id TEXT,
        message_count INTEGER, started_at REAL, last_activity_at REAL, last_activity_description TEXT
      );
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
    `)
    const now = Date.now() / 1000
    const insert = database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run('leased', 'webui', 0, null, 2, now - 600, now - 600, '')
    insert.run('wizard_recent', 'api_server', 0, null, 2, now - 10, now - 10, 'Tool running')
    insert.run('wizard-assistant-external', 'api_server', 0, null, 2, now - 10, now - 10, 'Tool running')
    insert.run('idle', 'webui', 0, null, 2, now - 10, now - 10, '')
    insert.run('child', 'webui', 0, 'leased', 2, now - 10, now - 10, 'Tool running')
    database.prepare('INSERT INTO session_turn_leases VALUES (?, ?)').run('leased', now + 60)
    database.close()
    expect(new Set(readActiveHumanSessionIds(path))).toEqual(new Set(['leased', 'wizard_recent', 'wizard-assistant-external']))
    expect(wizardDispatchHealthy({ cpuCount: 8, oneMinuteLoad: 4, pressureText: 'some avg10=10.00 avg60=0.00 avg300=0.00 total=0' })).toBe(true)
    expect(wizardDispatchHealthy({ cpuCount: 8, oneMinuteLoad: 18, pressureText: 'some avg10=10.00 avg60=0.00 avg300=0.00 total=0' })).toBe(false)
    expect(wizardDispatchHealthy({ cpuCount: 8, oneMinuteLoad: 4, pressureText: 'some avg10=82.00 avg60=0.00 avg300=0.00 total=0' })).toBe(false)
  })

  it('caps admission, projects FIFO queue state, drains automatically, and preserves the public run identity in SSE', async () => {
    const sessions = ['wizard_one', 'wizard_two', 'wizard_three', 'wizard_four'].map((id) => ({
      id,
      source: 'api_server',
      title: id,
      message_count: 1,
      hidden: false,
      archived: false,
      updated_at: new Date().toISOString(),
    }))
    const upstreamRuns = new Map<string, { sessionId: string; status: string; input: string; instructions: string; delegationDelivery: string; output?: string }>()
    let admissions = 0
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        admissions += 1
        const runId = `actual_${admissions}`
        upstreamRuns.set(runId, {
          sessionId: value.session_id,
          status: 'running',
          input: value.input,
          instructions: value.instructions,
          delegationDelivery: value.delegation_delivery,
        })
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'run', run_id: runId, session_id: value.session_id, status: 'running' }))
        return
      }
      const event = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/)
      if (req.method === 'GET' && event) {
        const run = upstreamRuns.get(event[1])
        if (!run) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(`event: message.delta\ndata: ${JSON.stringify({ run_id: event[1], delta: 'live' })}\n\n`)
        return
      }
      const detail = url.pathname.match(/^\/v1\/runs\/([^/]+)$/)
      if (req.method === 'GET' && detail) {
        const run = upstreamRuns.get(detail[1])
        if (!run) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'run', run_id: detail[1], session_id: run.sessionId, status: run.status, ...(run.output ? { output: run.output } : {}) }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: sessions }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(404); res.end()
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const directory = await mkdtemp(join(tmpdir(), 'wizard-proxy-queue-'))
    temporaryDirectories.push(directory)
    const statePath = join(directory, 'state.db')
    const state = new DatabaseSync(statePath)
    state.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages (
        session_id TEXT, role TEXT, finish_reason TEXT, content TEXT,
        display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1
      );
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
      INSERT INTO sessions VALUES
        ('wizard_one', 1), ('wizard_two', 2), ('wizard_three', 3), ('wizard_four', 4);
    `)
    state.close()
    const wizard = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'fixture-key',
      requireAccess: false,
      hermesStatePath: statePath,
      canonicalSessionReader: () => sessions,
      runQueueStatePath: join(directory, 'queue.sqlite3'),
      runQueueMaxActive: 2,
      runQueuePollIntervalMs: 0,
      activeSessionReader: async () => [],
      dispatchHealthReader: () => true,
    })
    servers.push(wizard)
    const wizardAddress = await listen(wizard)
    const origin = `http://127.0.0.1:${wizardAddress.port}`
    const admit = (sessionId: string, key: string) => request(origin, '/wizard/hermes/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ session_id: sessionId, input: sessionId }),
    })

    const first = await admit('wizard_one', 'queue-one')
    const second = await admit('wizard_two', 'queue-two')
    const third = await admit('wizard_three', 'queue-three')
    const fourth = await admit('wizard_four', 'queue-four')
    expect(first.response.status).toBe(202)
    expect(first.json.status).toBe('running')
    expect(second.json.status).toBe('running')
    expect(third.json).toMatchObject({ status: 'queued', queue_position: 1 })
    expect(fourth.json).toMatchObject({ status: 'queued', queue_position: 2 })
    expect(admissions).toBe(2)

    const steered = await request(origin, `/wizard/hermes/v1/runs/${encodeURIComponent(third.json.run_id)}/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Use the compact implementation.' }),
    })
    expect(steered.json).toMatchObject({ accepted: true, status: 'queued', queue_position: 1 })
    const stopped = await request(origin, `/wizard/hermes/v1/runs/${encodeURIComponent(fourth.json.run_id)}/stop`, { method: 'POST' })
    expect(stopped.json.status).toBe('cancelled')

    const replay = await admit('wizard_three', 'queue-three')
    expect(replay.response.headers.get('idempotency-replayed')).toBe('true')
    expect(replay.json.run_id).toBe(third.json.run_id)
    expect(admissions).toBe(2)

    const projected = await request(origin, '/wizard/hermes/api/sessions?limit=20&offset=0&include_children=false')
    expect(projected.json.data.find((item: { id: string }) => item.id === 'wizard_three')).toMatchObject({ status: 'queued', queue_position: 1 })

    const secondStartedAt = Date.now() / 1000
    const newerTurnState = new DatabaseSync(statePath)
    newerTurnState.prepare("INSERT INTO messages VALUES (?, 'assistant', 'stop', ?, 'final', ?, 1)")
      .run('wizard_two', 'The previous turn is complete.', secondStartedAt + 10)
    newerTurnState.prepare("INSERT INTO messages VALUES (?, 'user', NULL, ?, '', ?, 1)")
      .run('wizard_two', 'Keep working on this newer turn.', secondStartedAt + 20)
    newerTurnState.close()
    const liveLatestTurn = await request(origin, '/wizard/hermes/api/sessions?limit=20&offset=0&include_children=false')
    expect(liveLatestTurn.json.data.find((item: { id: string }) => item.id === 'wizard_two')).toMatchObject({
      status: 'running',
      wizard_run_id: second.json.run_id,
    })

    const completedState = new DatabaseSync(statePath)
    completedState.prepare("INSERT INTO messages VALUES (?, 'assistant', 'stop', ?, 'final', ?, 1)")
      .run('wizard_two', 'The exact latest turn is complete.', secondStartedAt + 30)
    completedState.close()
    const staleProjection = await request(origin, '/wizard/hermes/api/sessions?limit=20&offset=0&include_children=false')
    expect(staleProjection.json.data.find((item: { id: string }) => item.id === 'wizard_two')?.status).toBeUndefined()
    expect(staleProjection.json.data.find((item: { id: string }) => item.id === 'wizard_two')?.wizard_run_id).toBeUndefined()
    expect(staleProjection.json.data.find((item: { id: string }) => item.id === 'wizard_one')?.status).toBe('running')
    expect(staleProjection.json.data.find((item: { id: string }) => item.id === 'wizard_three')?.status).toBe('queued')

    const events = await request(origin, `/wizard/hermes/v1/runs/${encodeURIComponent(first.json.run_id)}/events`)
    expect(events.response.status).toBe(200)
    expect(events.text).toContain(first.json.run_id)
    expect(events.text).not.toContain('actual_1')

    upstreamRuns.get('actual_1')!.status = 'completed'
    let thirdStatus = third.json
    for (let attempt = 0; attempt < 8 && thirdStatus.status === 'queued'; attempt += 1) {
      thirdStatus = (await request(origin, `/wizard/hermes/v1/runs/${encodeURIComponent(third.json.run_id)}`)).json
      if (thirdStatus.status === 'queued') await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(thirdStatus.status).toBe('running')
    expect(admissions).toBe(3)
    expect(upstreamRuns.get('actual_3')?.input).toContain('Guidance added while queued:\nUse the compact implementation.')
    expect(upstreamRuns.get('actual_3')).toMatchObject({
      instructions: WIZARD_RUN_INSTRUCTIONS,
      delegationDelivery: 'join',
    })

    const health = await request(origin, '/wizard/health')
    expect(health.json.queue).toMatchObject({ max_active: 2, active: 2, queued: 0, dispatch_paused: false })

    upstreamRuns.get('actual_2')!.status = 'completed'
    upstreamRuns.get('actual_2')!.output = 'accidentally echoed fixture-key'
    const blockedSecret = await request(origin, `/wizard/hermes/v1/runs/${encodeURIComponent(second.json.run_id)}`)
    expect(blockedSecret.response.status).toBe(502)
    expect(blockedSecret.json).toEqual({ error: 'upstream_unavailable' })
    const blockedSse = await request(origin, `/wizard/hermes/v1/runs/${encodeURIComponent(second.json.run_id)}/events`)
    expect(blockedSse.response.status).toBe(502)
    expect(blockedSse.json).toEqual({ error: 'upstream_unavailable' })
  })

  it('steers a reopened Operator session through its public run identity to the live worker', async () => {
    const operatorSessionId = 'wizardop_user_steering'
    const ackRunId = 'private-ack-run'
    const workerRunId = 'private-worker-run'
    const trustedPath = '/srv/wizard-inbox/drop_steering/context.txt'
    let workerSessionId = ''
    let workerStatus = 'running'
    let admissions = 0
    const steers: Array<{ url: string; body: Record<string, unknown> }> = []
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      res.setHeader('Content-Type', 'application/json')
      const sessionDetail = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (req.method === 'GET' && sessionDetail) { res.writeHead(404).end('{}'); return }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        workerSessionId = body.id
        res.writeHead(201).end(JSON.stringify({ session: { id: workerSessionId } })); return
      }
      if (req.method === 'PATCH' && sessionDetail) { res.end('{}'); return }
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        admissions += 1
        const runId = body.session_id === workerSessionId ? workerRunId : ackRunId
        res.writeHead(202).end(JSON.stringify({ run_id: runId, session_id: body.session_id, status: 'running' })); return
      }
      if (req.method === 'GET' && url.pathname === `/v1/runs/${ackRunId}`) {
        res.end(JSON.stringify({ run_id: ackRunId, session_id: operatorSessionId, status: 'completed', output: 'Delegated to GLM-5.3.' })); return
      }
      if (req.method === 'GET' && url.pathname === `/v1/runs/${workerRunId}`) {
        res.end(JSON.stringify({ run_id: workerRunId, session_id: workerSessionId, status: workerStatus })); return
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        res.end(JSON.stringify({ data: [{
          id: operatorSessionId,
          source: 'api_server',
          title: 'Reopened Operator work',
          message_count: 2,
          status: 'completed',
          wizard_run_id: ackRunId,
        }] })); return
      }
      if (req.method === 'POST' && url.pathname === `/v1/runs/${workerRunId}/steer`) {
        steers.push({ url: url.pathname, body })
        if (workerStatus !== 'running') {
          res.writeHead(409).end(JSON.stringify({ error: 'run_terminal', run_id: workerRunId, ack_run_id: ackRunId, worker_session_id: workerSessionId })); return
        }
        res.writeHead(202).end(JSON.stringify({ accepted: true, run_id: workerRunId, session_id: workerSessionId, status: 'running' })); return
      }
      res.writeHead(404).end('{}')
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const inbox = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/v1/internal/files/drop_steering') {
        res.end(JSON.stringify({ file: {
          id: 'drop_steering', filename: 'context.txt', mime: 'text/plain', bytes: 7,
          sha256: 'a'.repeat(64), note: '', duplicate_of: null, created_at: '2026-09-10T00:00:00Z',
          source: 'test', status: 'RECEIVED', trusted_path: trustedPath,
        } })); return
      }
      res.writeHead(404).end('{}')
    })
    servers.push(inbox)
    const inboxAddress = await listen(inbox)
    const directory = await mkdtemp(join(tmpdir(), 'wizard-operator-steering-'))
    temporaryDirectories.push(directory)
    const wizard = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'fixture-key',
      requireAccess: false,
      operatorWorkerModel: 'glm-5-3',
      operatorWorkerStatePath: join(directory, 'workers.json'),
      runQueueStatePath: join(directory, 'queue.sqlite3'),
      runQueueMaxActive: 2,
      runQueuePollIntervalMs: 0,
      activeSessionReader: async () => [],
      dispatchHealthReader: () => true,
      inboxOrigin: `http://127.0.0.1:${inboxAddress.port}`,
      inboxToken: 'inbox-key',
      inboxTrustedRoots: ['/srv/wizard-inbox'],
    })
    servers.push(wizard)
    const address = await listen(wizard)
    const origin = `http://127.0.0.1:${address.port}`

    const admitted = await request(origin, '/wizard/operator/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operator-steering-one' },
      body: JSON.stringify({ session_id: operatorSessionId, input: 'Research this fully.' }),
    })
    const publicRunId = admitted.json.run_id as string
    expect(publicRunId).toMatch(/^wizardq_[0-9a-f]{32}$/)
    expect(admissions).toBe(2)

    await request(origin, `/wizard/operator/v1/runs/${encodeURIComponent(publicRunId)}`)
    const projected = await request(origin, '/wizard/operator/api/sessions?limit=20&offset=0&include_children=false')
    const session = projected.json.data.find((item: { id: string }) => item.id === operatorSessionId)
    expect(session).toMatchObject({ status: 'running', wizard_run_id: publicRunId })
    expect(JSON.stringify(session)).not.toMatch(/private-(?:ack|worker)-run/)

    const steered = await request(origin, `/wizard/operator/v1/runs/${encodeURIComponent(publicRunId)}/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Use this new evidence.', wizard_file_ids: ['drop_steering'] }),
    })
    expect(steered.response.status).toBe(202)
    expect(steered.json).toMatchObject({ accepted: true, run_id: publicRunId, session_id: operatorSessionId, status: 'running' })
    expect(steers).toHaveLength(1)
    expect(steers[0]?.url).toBe(`/v1/runs/${workerRunId}/steer`)
    expect(JSON.stringify(steers[0]?.body)).toContain(trustedPath)
    expect(JSON.stringify(steered.json)).not.toMatch(/private-(?:ack|worker)-run|wizardopw_/)
    expect(admissions).toBe(2)

    workerStatus = 'completed'
    const terminal = await request(origin, `/wizard/operator/v1/runs/${encodeURIComponent(publicRunId)}/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Too late.' }),
    })
    expect(terminal.response.status).toBe(409)
    expect(terminal.json).toMatchObject({ error: 'run_terminal', run_id: publicRunId, ack_run_id: publicRunId, worker_session_id: operatorSessionId })
    expect(JSON.stringify(terminal.json)).not.toMatch(/private-(?:ack|worker)-run|wizardopw_/)
    expect(admissions).toBe(2)
  })

  it('replays a deterministic Operator worker after an admission retry', async () => {
    const sessions = new Set<string>()
    const idempotentRuns = new Map<string, string>()
    let workerAdmissions = 0
    let ackAttempts = 0
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      res.setHeader('Content-Type', 'application/json')
      const sessionDetail = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (req.method === 'GET' && sessionDetail) {
        if (!sessions.has(sessionDetail[1])) { res.writeHead(404).end('{}'); return }
        res.end(JSON.stringify({ session: { id: sessionDetail[1] } })); return
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        if (sessions.has(body.id)) { res.writeHead(409).end('{}'); return }
        sessions.add(body.id); res.writeHead(201).end(JSON.stringify({ session: { id: body.id } })); return
      }
      if (req.method === 'PATCH' && sessionDetail) { res.end('{}'); return }
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const key = String(req.headers['idempotency-key'] ?? '')
        if (String(body.session_id).startsWith('wizardopw_')) {
          let runId = idempotentRuns.get(key)
          if (!runId) { runId = 'worker-run'; idempotentRuns.set(key, runId); workerAdmissions += 1 }
          res.writeHead(202).end(JSON.stringify({ run_id: runId, session_id: body.session_id, status: 'running' })); return
        }
        ackAttempts += 1
        if (ackAttempts === 1) { res.writeHead(503).end('{}'); return }
        res.writeHead(202).end(JSON.stringify({ run_id: 'ack-run', session_id: body.session_id, status: 'running' })); return
      }
      const runDetail = url.pathname.match(/^\/v1\/runs\/([^/]+)$/)
      if (req.method === 'GET' && runDetail) {
        res.end(JSON.stringify({ run_id: runDetail[1], status: 'running' })); return
      }
      res.writeHead(404).end('{}')
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const directory = await mkdtemp(join(tmpdir(), 'wizard-operator-queue-'))
    temporaryDirectories.push(directory)
    const wizard = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'fixture-key',
      requireAccess: false,
      operatorWorkerModel: 'glm-5-3',
      operatorWorkerStatePath: join(directory, 'workers.json'),
      runQueueStatePath: join(directory, 'queue.sqlite3'),
      runQueueMaxActive: 2,
      runQueuePollIntervalMs: 0,
      runQueueRetryDelayMs: 50,
      activeSessionReader: async () => [],
      dispatchHealthReader: () => true,
    })
    servers.push(wizard)
    const address = await listen(wizard)
    const origin = `http://127.0.0.1:${address.port}`
    const admitted = await request(origin, '/wizard/operator/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operator-queue-one' },
      body: JSON.stringify({ session_id: 'wizardop_user_one', input: 'Research this fully.' }),
    })
    expect(admitted.json.status).toBe('queued')
    await new Promise((resolve) => setTimeout(resolve, 60))
    const retried = await request(origin, `/wizard/operator/v1/runs/${encodeURIComponent(admitted.json.run_id)}`)
    expect(retried.json.status).toBe('running')
    expect(workerAdmissions).toBe(1)
    expect(sessions.size).toBe(1)
    expect(ackAttempts).toBe(2)
  })
})
