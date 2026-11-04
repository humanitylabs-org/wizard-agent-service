import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { guardOwnerThreadWrite, isAgentToAgentRequest, OWNER_THREAD_WRITE_MESSAGE, withoutAgentToAgentTurns } from '../server/owner-thread-write.mjs'
import { latestVisibleSessionMessages } from '../server/service.mjs'
import { readHermesSessionTruth, visibleUserRequest } from '../server/session-truth.mjs'
import { runCheck } from '../qa/agent-parity/checks.mjs'

describe('owner-thread write admission', () => {
  it.each([
    '[Agent-to-agent test] ping', ' \n[Agent-to-agent follow-up] ping',
    'Clearance: NOT a James message; ask owner',
    [{ role: 'user', content: [{ type: 'text', text: '[Agent-to-agent test] ping' }] }],
    [{ type: 'text', text: 'NOT a James message' }],
  ])('recognizes explicit agent-to-agent text: %j', input => {
    expect(isAgentToAgentRequest(input)).toBe(true)
  })
  it.each(['Hello', 'Explain the [Agent-to-agent prefix', '', null, {},
    [{ role: 'assistant', content: '[Agent-to-agent test]' }],
    [{ type: 'image_url', image_url: { url: 'NOT a James message' } }],
    // A Supervisor builder's completion report that quotes the marker must still reach its review thread.
    '[supervisor update]\n{"report":{"what_happened":"resolved the legacy \'NOT a James message\' finding"}}',
  ])('does not block ordinary/non-user/non-text input: %j', input => {
    expect(isAgentToAgentRequest(input)).toBe(false)
  })
  it('allows a new session, an unknown supplied session ID, and ordinary existing-session input', async () => {
    let checks = 0
    const sessionExists = async (id: string) => { checks++; return id === 'existing' }
    for (const body of [{ input: '[Agent-to-agent test] ping' }, { session_id: 'new', input: '[Agent-to-agent test] ping' }, { session_id: 'existing', input: 'Hello' }]) {
      await expect(guardOwnerThreadWrite({ method: 'POST', upstreamPath: '/v1/runs', body, sessionExists })).resolves.toBeUndefined()
    }
    expect(checks).toBe(1)
  })
  it.each(['/v1/runs', '/v1/runs/real-run/steer', '/api/sessions/existing/chat', '/api/sessions/existing/chat/stream'])('rejects %s with the exact 409 contract', async upstreamPath => {
    await expect(guardOwnerThreadWrite({ method: 'POST', upstreamPath, body: Buffer.from(JSON.stringify({ session_id: 'existing', input: '[Agent-to-agent test] ping', message: '[Agent-to-agent test] ping' })), sessionExists: async () => true }))
      .rejects.toMatchObject({ status: 409, payload: { error: { code: 'agent_to_agent_thread_write', message: OWNER_THREAD_WRITE_MESSAGE } } })
  })
  it.each(['main', 'host-profile', 'container', 'restricted'])('HTTP admission is guarded for %s (all routes, normal send unaffected)', async kind => {
    const result = await runCheck(kind, 'owner-thread-agent-write-guard')
    expect(result.status, result.reason).toBe('pass')
  }, 20000)
})

describe('internal turn preview defense', () => {
  const rows = [
    { role: 'user', content: 'Real owner request', timestamp: 10 },
    { role: 'assistant', content: 'Real answer', timestamp: 11, finish_reason: 'stop' },
    { role: 'user', content: '  [Agent-to-agent owner clearance] ping', timestamp: 12 },
    { role: 'assistant', content: '{"decisions":[]}', timestamp: 13, finish_reason: 'stop' },
  ]
  it('excludes internal user requests from visible request truth', () => {
    expect(visibleUserRequest(rows[2].content)).toBe(false)
  })
  it('skips assistant replies triggered by an internal user, including descending pages', () => {
    expect(withoutAgentToAgentTurns(rows)).toEqual(rows.slice(0, 2))
    expect(withoutAgentToAgentTurns([...rows].reverse())).toEqual(rows.slice(0, 2).reverse())
    const result = latestVisibleSessionMessages({ data: rows })
    expect(result.latest.content).toBe('Real answer')
    expect(result.lastUser.content).toBe('Real owner request')
    expect(result.latestAssistantAt).toBe(11)
  })
  it('resumes preview projection at the next real owner request', () => {
    const result = latestVisibleSessionMessages({ data: [...rows, { role: 'user', content: 'Next real request', timestamp: 14 }, { role: 'assistant', content: 'Next real answer', timestamp: 15 }] })
    expect(result.latest.content).toBe('Next real answer')
    expect(result.lastUser.content).toBe('Next real request')
  })
  it('keeps internal replies out of SQLite list truth without changing canonical rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owner-thread-truth-'))
    const path = join(dir, 'state.db'), db = new DatabaseSync(path)
    try {
      db.exec('CREATE TABLE sessions (id TEXT, started_at REAL); INSERT INTO sessions VALUES (\'s\', 1); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, finish_reason TEXT, active INTEGER, display_kind TEXT)')
      db.exec('CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL)')
      const put = db.prepare('INSERT INTO messages (session_id,role,content,timestamp,finish_reason,active,display_kind) VALUES (?,?,?,?,?,1,?)')
      for (const row of rows) put.run('s', row.role, row.content, row.timestamp, row.finish_reason ?? null, '')
      const truth = readHermesSessionTruth(path, ['s']).get('s')
      expect(truth?.activityAt).toBe(11)
      expect(truth?.lastUserAt).toBe(10)
      expect(truth?.lastAssistantAt).toBe(11)
      expect(db.prepare('SELECT count(*) AS n FROM messages').get()?.n).toBe(4)
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
