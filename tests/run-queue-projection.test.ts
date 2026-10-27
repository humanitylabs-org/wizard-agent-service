import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { createBackgroundResults } from '../server/background-results.mjs'

const owned: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); while (owned.length) owned.pop()!() })
function fixture(agentId = 'hermes') {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-queue-projection-'))
  const queue = new DurableRunQueue({ statePath: join(dir, 'queue.db'), agentId, pollIntervalMs: 0,
    launch: vi.fn(), lookup: vi.fn(), canDispatch: () => false })
  owned.push(() => { queue.close(); rmSync(dir, { recursive: true, force: true }) })
  return queue
}
function insert(queue: DurableRunQueue, id: string, session: string, status = 'completed', at = 1, input: unknown = 'Saved request') {
  const body = JSON.stringify({ input, provider: 'openai-codex', attachment: 'A'.repeat(128 * 1024) })
  queue.database.prepare(`INSERT INTO wizard_run_queue
    (public_run_id,runtime,session_id,idempotency_key,request_hash,body,status,created_at,updated_at,agent_id)
    VALUES (?,'direct',?,?,?,?,?,?,?,?)`).run(id, session, `key-${id}`, queueRequestHash('direct', body), body, status, at, at, queue.agentId)
}
function forbidBodyReads(queue: DurableRunQueue) {
  const prepare = queue.database.prepare.bind(queue.database)
  return vi.spyOn(queue.database, 'prepare').mockImplementation((sql: string) => {
    expect(sql).not.toMatch(/\bbody\b|SELECT\s+(?:\w+\.)?\*/i)
    return prepare(sql)
  })
}

describe('Chats run queue hot projections', () => {
  it.each(['hermes', 'host-profile', 'container', 'restricted'])('chats list projection does not reload run request bodies for finished runs (%s)', agentId => {
    const queue = fixture(agentId)
    insert(queue, 'finished', 'wizard_finished', 'completed', 1, [
      { content: '  First line' }, { content: [{ type: 'text', text: 'Second line  ' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ])
    const first = queue.latestProjections(['wizard_finished'])
    expect(first[0].preview).toBe('First line\nSecond line')
    forbidBodyReads(queue)
    expect(queue.latestProjections(['wizard_finished'])).toEqual(first)
    // Status/payload changes do not change the saved input or evict its preview.
    queue.database.prepare("UPDATE wizard_run_queue SET status='failed',payload_json=? WHERE public_run_id='finished'")
      .run(JSON.stringify({ error: 'HTTP 401', safe_error: 'Previous failure' }))
    expect(queue.latestProjections(['wizard_finished'])[0]).toMatchObject({
      preview: 'First line\nSecond line', status: 'failed',
      // Main now renders the diagnosed sign-in through reconnect, not a duplicate safe-error bubble.
      safeError: '',
      reconnect: { kind: 'provider_signed_out', provider: 'chatgpt', app_id: 'wizard-chatgpt', run_id: 'finished' },
    })
  })

  it('queued positions and every busy status use no request bodies and preserve unknown and tie ordering', () => {
    const queue = fixture()
    const statuses = ['queued', 'launching', 'running', 'waiting_for_approval', 'stopping', 'unknown', 'completed', 'failed', 'cancelled', 'interrupted']
    for (const status of statuses) insert(queue, status, `wizard_${status}`, status)
    insert(queue, 'older-unknown', 'wizard_fenced', 'unknown', 1)
    insert(queue, 'newer-completed', 'wizard_fenced', 'completed', 2)
    insert(queue, 'tie-a', 'wizard_tie', 'running', 3)
    insert(queue, 'tie-b', 'wizard_tie', 'completed', 3)
    const expected = queue.latestProjections()
    forbidBodyReads(queue)
    for (const projection of expected) expect(queue.latestStatus(projection.sessionId)).toBe(projection.status)
    expect(queue.latestStatus('missing')).toBeNull()
    expect(queue.latestStatus('wizard_fenced')).toBe('unknown')
    expect(queue.latestStatus('wizard_tie')).toBe('completed')
    expect(queue.latestProjections()).toEqual(expected)
    expect(queue._position('queued')).toBe(1)
    expect(queue._position('missing')).toBe(0)
  })

  it('busy checks use the covering session index instead of scanning attachment-bearing rows', () => {
    const queue = fixture()
    const plan = queue.database.prepare(`EXPLAIN QUERY PLAN SELECT status FROM wizard_run_queue WHERE session_id = ?
      ORDER BY CASE WHEN status='unknown' THEN 0 ELSE 1 END, created_at DESC, public_run_id DESC LIMIT 1`).all('wizard_finished')
    expect(plan.map(row => row.detail).join('\n')).toContain('USING COVERING INDEX wizard_run_queue_session_latest')
  })

  it('refreshes cached previews after queued guidance, provider edits and writes from another connection', async () => {
    const queue = fixture()
    // Guidance uses normal admission ids and does not change the original idempotency request hash.
    const body = JSON.stringify({ input: 'Original', provider: 'openai-codex' })
    const { record } = queue._admitRow({ runtime: 'direct', sessionId: 'wizard_edit', idempotencyKey: 'edit', requestHash: queueRequestHash('direct', body), body })
    if (!record) throw new Error('fixture admission missing')
    expect(queue.latestProjections()[0].preview).toBe('Original')
    await queue.appendGuidance(record.publicRunId, 'More guidance')
    expect(queue.latestProjections()[0].preview).toBe('Original\n\nGuidance added while queued:\nMore guidance')
    queue._update(record.publicRunId, { body: JSON.stringify({ input: 'Edited', provider: 'anthropic' }), status: 'failed', payload: { error: 'HTTP 401' } })
    expect(queue.latestProjections()[0]).toMatchObject({ preview: 'Edited', reconnect: { provider: 'claude' } })
    const other = new DatabaseSync(queue.statePath)
    try { other.prepare('UPDATE wizard_run_queue SET body=? WHERE public_run_id=?').run(JSON.stringify({ input: 'External edit', provider: 'openai-codex' }), record.publicRunId) }
    finally { other.close() }
    expect(queue.latestProjections()[0]).toMatchObject({ preview: 'External edit', reconnect: { provider: 'chatgpt' } })
  })

  it('bounds the input cache and retains no attachment bytes or full input', () => {
    const queue = fixture()
    insert(queue, 'first', 'wizard_first')
    queue.latestProjections()
    expect(JSON.stringify([...queue.projectionInputs.values()])).not.toContain('A'.repeat(1024))
    for (let n = 1; n < 2048; n++) queue.projectionInputs.set(`dummy-${n}`, { preview: 'small' })
    insert(queue, 'next', 'wizard_next')
    queue.latestProjections(['wizard_next'])
    expect(queue.projectionInputs.size).toBe(2048)
    expect(queue.projectionInputs.has('first')).toBe(false)
    expect(queue.latestProjections(['wizard_first'])[0].preview).toBe('Saved request')
  })

  it('background result discovery checks only the latest status, never a full projection', async () => {
    const queue = fixture()
    insert(queue, 'finished', 'wizard_finished')
    vi.spyOn(queue, 'latestProjections').mockImplementation(() => { throw new Error('busy check must not project request bodies') })
    forbidBodyReads(queue)
    const status = vi.spyOn(queue, 'latestStatus')
    const results = createBackgroundResults({ queue: () => queue, request: async (path: string) => path.startsWith('/api/sessions?')
      ? { data: [{ id: 'wizard_finished', message_count: 1 }] } : { data: [] } })
    // Settle the finite catalog/history scan without admitting any work.
    for (let n = 0; n < 5; n++) { await results.list(); await new Promise(resolve => setImmediate(resolve)) }
    expect(status).toHaveBeenCalledWith('wizard_finished')
  })
})
