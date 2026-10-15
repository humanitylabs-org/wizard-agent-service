import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen, readSessionArchived } from '../server/service.mjs'

const servers: ReturnType<typeof createServer>[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

// James, 14 Oct 2026: a reply (or follow-through) sent into a thread that was already in Archive
// ran, but its result stayed in Archive, so he never saw it. Every admitted turn re-opens the thread.
describe('a new turn in an archived thread', () => {
  it('reads the archived flag for one session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-archived-flag-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'state.db')
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, archived INTEGER); INSERT INTO sessions VALUES ('wizard_a', 1), ('wizard_b', 0)")
    db.close()
    expect(readSessionArchived(path, 'wizard_a')).toBe(true)
    expect(readSessionArchived(path, 'wizard_b')).toBe(false)
    expect(readSessionArchived(path, 'wizard_missing')).toBe(false)
    expect(readSessionArchived(join(directory, 'absent.db'), 'wizard_a')).toBe(false)
  })

  it('un-archives the thread when the run is admitted, and leaves live threads alone', async () => {
    const archived = new Set(['wizard_archived'])
    const patches: { id: string; body: unknown }[] = []
    let admissions = 0
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString('utf8')
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const value = JSON.parse(raw)
        admissions += 1
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'run', run_id: `actual_${admissions}`, session_id: value.session_id, status: 'running' }))
        return
      }
      const patch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (req.method === 'GET' && patch) {
        const id = decodeURIComponent(patch[1])
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'hermes.session', session: { id, archived: archived.has(id) } }))
        return
      }
      if (req.method === 'PATCH' && patch) {
        const body = JSON.parse(raw)
        patches.push({ id: decodeURIComponent(patch[1]), body })
        if (body.archived === false) archived.delete(decodeURIComponent(patch[1]))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'hermes.session', session: { id: patch[1], archived: false } }))
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
    const directory = await mkdtemp(join(tmpdir(), 'wizard-reply-unarchive-'))
    temporaryDirectories.push(directory)
    const statePath = join(directory, 'state.db')
    const state = new DatabaseSync(statePath)
    state.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
      INSERT INTO sessions VALUES ('wizard_archived', 1), ('wizard_live', 2);
    `)
    state.close()
    const wizard = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'fixture-key',
      requireAccess: false,
      hermesStatePath: statePath,
      canonicalSessionReader: () => [],
      runQueueStatePath: join(directory, 'queue.sqlite3'),
      runQueueMaxActive: 4,
      runQueuePollIntervalMs: 0,
      activeSessionReader: async () => [],
      dispatchHealthReader: () => true,
    })
    servers.push(wizard)
    const wizardAddress = await listen(wizard)
    const origin = `http://127.0.0.1:${wizardAddress.port}`
    const admit = (sessionId: string, key: string) => fetch(`${origin}/wizard/hermes/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ session_id: sessionId, input: 'Please draft the email.' }),
    })

    const reply = await admit('wizard_archived', 'reply-archived')
    expect(reply.status).toBe(202)
    expect(admissions).toBe(1)
    expect(patches).toEqual([{ id: 'wizard_archived', body: { archived: false } }])
    expect(archived.has('wizard_archived')).toBe(false)

    const live = await admit('wizard_live', 'reply-live')
    expect(live.status).toBe(202)
    expect(admissions).toBe(2)
    expect(patches).toHaveLength(1)
  })

  it('still runs the turn when the un-archive write fails', async () => {
    let admissions = 0
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      for await (const _ of req) { /* drain */ }
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        admissions += 1
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'run', run_id: `actual_${admissions}`, status: 'running' }))
        return
      }
      if (req.method === 'PATCH') { res.writeHead(500); res.end(); return }
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return }
      res.writeHead(404); res.end()
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const directory = await mkdtemp(join(tmpdir(), 'wizard-reply-unarchive-fail-'))
    temporaryDirectories.push(directory)
    const statePath = join(directory, 'state.db')
    const state = new DatabaseSync(statePath)
    state.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
      INSERT INTO sessions VALUES ('wizard_archived', 1);
    `)
    state.close()
    const wizard = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'fixture-key',
      requireAccess: false,
      hermesStatePath: statePath,
      canonicalSessionReader: () => [],
      sessionArchivedReader: () => true,
      runQueueStatePath: join(directory, 'queue.sqlite3'),
      runQueueMaxActive: 4,
      runQueuePollIntervalMs: 0,
      activeSessionReader: async () => [],
      dispatchHealthReader: () => true,
    })
    servers.push(wizard)
    const wizardAddress = await listen(wizard)
    const reply = await fetch(`http://127.0.0.1:${wizardAddress.port}/wizard/hermes/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'reply-fail' },
      body: JSON.stringify({ session_id: 'wizard_archived', input: 'hello' }),
    })
    expect(reply.status).toBe(202)
    expect((await reply.json()).status).toBe('running')
    expect(admissions).toBe(1)
  })
})
