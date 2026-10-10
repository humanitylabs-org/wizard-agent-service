import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: Array<ReturnType<typeof createServer>> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

// The status backfill used to reach only the first page's preview window (threads whose history the list
// reads). Older threads further down the list, and every thread on later pages, kept no status at all.
describe('status backfill across the whole session list', () => {
  it('applies to threads past the preview window and on later pages, only for the classified reply', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-backfill-list-'))
    directories.push(directory)
    const base = 1_790_000_000
    // 60 threads: more than the preview window. Each has one user turn then one final reply.
    const ids = Array.from({ length: 60 }, (_, i) => `wizard_bf_${String(i).padStart(2, '0')}`)
    const replyAt = (i: number) => base + 1000 - i
    const sessions = ids.map((id, i) => ({ id, source: 'wizard-mobile', title: id, message_count: 2, started_at: base - i, last_active: replyAt(i) }))

    const statePath = join(directory, 'state.db')
    const state = new DatabaseSync(statePath)
    state.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
    `)
    const addSession = state.prepare('INSERT INTO sessions VALUES (?, ?)')
    const addMessage = state.prepare('INSERT INTO messages (session_id, role, finish_reason, content, display_kind, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    ids.forEach((id, i) => {
      addSession.run(id, base - i)
      addMessage.run(id, 'user', null, 'Ask', null, replyAt(i) - 60)
      addMessage.run(id, 'assistant', 'stop', 'Answer', 'final', replyAt(i))
    })
    // wizard_bf_58: James replied after the classified answer, so its old status must not apply.
    addMessage.run('wizard_bf_58', 'user', null, 'Follow-up', null, replyAt(58) + 30)
    state.close()

    const backfillPath = join(directory, 'backfill.json')
    await writeFile(backfillPath, JSON.stringify({ threads: {
      wizard_bf_55: { state: 'check', ask: 'Try the new list', subject: 'Wizard OS', assistant_at: replyAt(55) },
      wizard_bf_58: { state: 'needs_you', ask: 'Pick a layout', subject: 'Wizard OS', assistant_at: replyAt(58) },
      wizard_bf_59: { state: 'fyi', ask: 'Answered the licence question', subject: 'Research', assistant_at: replyAt(59) },
      wizard_bf_57: { state: 'done', ask: 'Old reply', subject: 'Wizard OS', assistant_at: replyAt(57) - 500 },
    } }))

    const upstream = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (url.pathname === '/api/sessions') {
        const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 100)
        const page = sessions.slice(offset, offset + limit)
        res.end(JSON.stringify({ object: 'list', data: page, has_more: offset + limit < sessions.length }))
        return
      }
      const history = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
      if (history) {
        const i = ids.indexOf(decodeURIComponent(history[1]))
        res.end(JSON.stringify({ data: [
          { role: 'assistant', content: 'Answer', display_kind: 'final', timestamp: replyAt(i) },
          { role: 'user', content: 'Ask', timestamp: replyAt(i) - 60 },
        ] }))
        return
      }
      res.end('{}')
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'fixture-key',
      requireAccess: false,
      hermesStatePath: statePath,
      threadStatusBackfillPath: backfillPath,
      archivedSessionReader: () => [],
      runQueueStatePath: join(directory, 'queue.sqlite3'),
      runQueuePollIntervalMs: 0,
      activeSessionReader: async () => [],
      dispatchHealthReader: () => true,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)
    const list = async (offset: number, limit: number) => {
      const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions?limit=${limit}&offset=${offset}`)
      if (response.status !== 200) throw new Error(`status ${response.status}: ${await response.text()}`)
      const body = await response.json() as { data: Array<{ id: string; wizard_attention?: unknown }> }
      return Object.fromEntries(body.data.map((s) => [s.id, s.wizard_attention ?? null]))
    }

    // One page of 60: 55 and 59 sit past the preview window.
    const whole = await list(0, 100)
    expect(whole.wizard_bf_55).toEqual({ state: 'check', ask: 'Try the new list', subject: 'Wizard OS' })
    expect(whole.wizard_bf_59).toEqual({ state: 'fyi', ask: 'Answered the licence question', subject: 'Research' })
    expect(whole.wizard_bf_58).toBeNull() // James replied after it
    expect(whole.wizard_bf_57).toBeNull() // classified a different (older) reply
    expect(whole.wizard_bf_10).toBeNull() // never backfilled

    // Second page of a paged walk gets the same statuses.
    const second = await list(50, 50)
    expect(second.wizard_bf_55).toEqual({ state: 'check', ask: 'Try the new list', subject: 'Wizard OS' })
    expect(second.wizard_bf_59).toEqual({ state: 'fyi', ask: 'Answered the licence question', subject: 'Research' })
    expect(second.wizard_bf_58).toBeNull()
  })
})
