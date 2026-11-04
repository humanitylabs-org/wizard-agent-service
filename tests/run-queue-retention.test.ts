// 21 Oct 2026: the 7-day retention DELETE ran on every 1.5 s queue tick and scanned every saved
// request body (terminal_at sits after it) under a write lock: ~70 ms a tick, ~20% of a core.
// It now runs at most once a minute through a terminal_at index. Same rows go.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DurableRunQueue as RunQueue } from '../server/run-queue.mjs'

describe('run queue retention', () => {
  it('prunes finished runs older than 7 days beyond the newest 128, via the index, once a minute', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'retention-queue-'))
    try {
      const queue: any = new RunQueue({ statePath: join(dir, 'q.sqlite3'), launch: async () => ({}), lookup: async () => ({}),
        activeSessionIds: async () => [], canDispatch: async () => false })
      const insert = queue.database.prepare(`INSERT INTO wizard_run_queue (public_run_id, runtime, session_id, idempotency_key,
        request_hash, body, trusted_paths_json, status, payload_json, created_at, updated_at, terminal_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      const now = Date.now() / 1000
      const old = (i: number) => now - 8 * 86400 - i
      for (let i = 0; i < 140; i++) insert.run(`wizardq_old${i}`, 'hermes', `s${i}`, `k${i}`, 'h', '{}', '[]', 'completed', '{}', old(i), old(i), old(i))
      insert.run('wizardq_recent', 'hermes', 'sr', 'kr', 'h', '{}', '[]', 'completed', '{}', now, now, now)
      insert.run('wizardq_live', 'hermes', 'sl', 'kl', 'h', '{}', '[]', 'running', '{}', old(0), old(0), null)
      const ids = () => queue.database.prepare('SELECT public_run_id FROM wizard_run_queue').all().map((r: any) => r.public_run_id)

      const plan = queue.database.prepare(`EXPLAIN QUERY PLAN SELECT public_run_id FROM wizard_run_queue INDEXED BY wizard_run_queue_terminal
        WHERE terminal_at IS NOT NULL AND terminal_at < ? ORDER BY terminal_at DESC LIMIT -1 OFFSET 128`).all(now).map((r: any) => r.detail).join(' ')
      expect(plan).toContain('wizard_run_queue_terminal')
      expect(plan).not.toContain('TEMP B-TREE')

      queue._pruneTerminal()
      const kept = ids()
      expect(kept).toHaveLength(130)
      expect(kept).toContain('wizardq_recent')
      expect(kept).toContain('wizardq_live')
      expect(kept).toContain('wizardq_old0')        // newest of the old ones stay
      expect(kept).not.toContain('wizardq_old139')  // oldest go

      insert.run('wizardq_extra', 'hermes', 'sx', 'kx', 'h', '{}', '[]', 'completed', '{}', old(0) - 1000, old(0), old(0) - 1000)
      queue._pruneTerminal()
      expect(ids()).toContain('wizardq_extra')      // throttled: not again within a minute
      queue._pruneTerminal(true)
      expect(ids()).not.toContain('wizardq_extra')
      queue.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a running reply whose status did not change is not rewritten every tick; a change is', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'refresh-queue-'))
    try {
      let payload: any = { status: 'running', output: 'one' }
      const queue: any = new RunQueue({ statePath: join(dir, 'q.sqlite3'), launch: async () => ({}),
        lookup: async () => ({ payload: { ...payload } }), activeSessionIds: async () => [], canDispatch: async () => false })
      const now = Date.now() / 1000
      queue.database.prepare(`INSERT INTO wizard_run_queue (public_run_id, runtime, session_id, idempotency_key, request_hash, body,
        trusted_paths_json, status, upstream_run_id, payload_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run('wizardq_0123456789abcdef0123456789abcdef', 'hermes', 's', 'k', 'h', 'x'.repeat(2_000_000), '[]', 'running', 'run_up', JSON.stringify(payload), now - 5, now - 5)
      const changes = () => queue.database.prepare('SELECT total_changes() AS n').get().n
      const before = changes()
      const same = await queue._refresh(queue.get('wizardq_0123456789abcdef0123456789abcdef'), true)
      expect(same.status).toBe('running')
      expect(changes()).toBe(before)                          // nothing changed: no write
      payload = { status: 'running', output: 'one two' }
      const moved = await queue._refresh(queue.get('wizardq_0123456789abcdef0123456789abcdef'), true)
      expect(moved.payload.output).toBe('one two')
      expect(changes()).toBe(before + 1)
      payload = { status: 'completed', output: 'done' }
      const done = await queue._refresh(queue.get('wizardq_0123456789abcdef0123456789abcdef'), true)
      expect(done.status).toBe('completed')
      expect(done.terminalAt).not.toBeNull()
      queue.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
