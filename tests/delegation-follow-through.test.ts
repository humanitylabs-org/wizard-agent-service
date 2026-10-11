import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { findPendingFollowThroughs, startDelegationFollowThrough, FOLLOW_THROUGH_PREFIX } from '../server/delegation-follow-through.mjs'

function db() {
  const path = join(mkdtempSync(join(tmpdir(), 'wizard-ft-')), 'state.db')
  const d = new DatabaseSync(path)
  d.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1);
          CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);`)
  return { path, d }
}

describe('delegation follow-through (stock Hermes)', () => {
  it('finds Wizard threads whose newest message is a background completion with no live turn', () => {
    const { path, d } = db()
    const now = Date.now() / 1000
    const add = d.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
    add.run('wizard_a', 'user', 'do it', now - 60)
    add.run('wizard_a', 'assistant', 'subagent is working', now - 50)
    add.run('wizard_a', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_1] results`, now - 5)
    add.run('wizard_b', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_2] results`, now - 5)
    add.run('wizard_b', 'assistant', 'answered', now - 1)
    add.run('wizard_c', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_3] results`, now - 5)
    d.prepare('INSERT INTO session_turn_leases VALUES (?, ?)').run('wizard_c', now + 60)
    add.run('telegram_d', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_4] results`, now - 5)
    add.run('wizard-assistant-e', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_5] results`, now - 5)
    d.close()
    expect(findPendingFollowThroughs(path).map((p) => p.sessionId).sort()).toEqual(['wizard-assistant-e', 'wizard_a'])
  })

  it('admits exactly one continuation per completion row, and stays off when the agent joins', async () => {
    const { path, d } = db()
    const now = Date.now() / 1000
    d.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('wizard_a', 'user', `${FOLLOW_THROUGH_PREFIX} — x]`, now)
    d.close()
    const admitted: string[] = []
    let on = false
    const w = startDelegationFollowThrough({ sessionDbPath: path, enabled: async () => on, admit: async (id, _i, key) => { admitted.push(`${id}|${key}`) }, intervalMs: 60_000 })
    await w.tick(); expect(admitted).toEqual([])
    on = true
    await w.tick(); await w.tick()
    w.stop()
    expect(admitted).toHaveLength(1)
    expect(admitted[0]).toMatch(/^wizard_a\|wizard-follow-through-wizard_a-1$/)
  })
})
