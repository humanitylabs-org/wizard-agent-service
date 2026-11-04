import { describe, expect, it } from 'vitest'
import { startDelegationFollowThrough, FOLLOW_THROUGH_PREFIX } from '../server/delegation-follow-through.mjs'
import { createFollowThroughFinder } from '../server/hermes-http-readers.mjs'

// Fake stock Hermes: GET /api/sessions and GET /api/sessions/<id>/messages?order=latest&limit=1.
function hermes(now: number) {
  const sessions: Record<string, { last_active: number, messages: Array<Record<string, unknown>>, root?: string }> = {}
  const add = (id: string, role: string, content: string, at: number, extra: Record<string, unknown> = {}) => {
    const s = (sessions[id] ??= { last_active: 0, messages: [] })
    s.messages.push({ id: Object.values(sessions).reduce((n, x) => n + x.messages.length, 0) + 1, role, content, timestamp: at, ...extra })
    s.last_active = at
  }
  const reads: string[] = []
  const request = async (path: string) => {
    reads.push(path)
    const url = new URL(path, 'http://hermes')
    if (url.pathname === '/api/sessions') {
      return { object: 'list', data: Object.entries(sessions).map(([id, s]) => ({ id, last_active: s.last_active, message_count: s.messages.length, ...(s.root ? { _lineage_root_id: s.root } : {}) })) }
    }
    const id = decodeURIComponent(url.pathname.split('/')[3])
    return { object: 'list', data: sessions[id].messages.slice(-Number(url.searchParams.get('limit'))) }
  }
  return { sessions, add, request, reads, now }
}

describe('delegation follow-through (stock Hermes, over HTTP)', () => {
  it('finds Wizard threads whose newest message is a background completion with no live turn', async () => {
    const now = Date.now()
    const h = hermes(now)
    const t = now / 1000
    h.add('wizard_a', 'user', 'do it', t - 60)
    h.add('wizard_a', 'assistant', 'subagent is working', t - 50)
    h.add('wizard_a', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_1] results`, t - 5, { display_kind: 'async_delegation_complete' })
    h.add('wizard_b', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_2] results`, t - 5)
    h.add('wizard_b', 'assistant', 'answered', t - 1)
    h.add('wizard_c', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_3] results`, t - 5)
    h.add('telegram_d', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_4] results`, t - 5)
    h.add('wizard_old', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_5] results`, t - 3 * 3600)
    // A compressed thread: Hermes lists the live tip under its root id.
    h.add('tip_e', 'user', `${FOLLOW_THROUGH_PREFIX} — deleg_6] results`, t - 5)
    h.sessions.tip_e.root = 'wizard_e'
    const find = createFollowThroughFinder({ request: h.request, prefix: FOLLOW_THROUGH_PREFIX, busy: (id: string) => id === 'wizard_c' })
    expect((await find(now)).map((p) => p.sessionId)).toEqual(['wizard_a', 'wizard_e'])
    // Unchanged threads that are not pending are not re-read on the next tick.
    const before = h.reads.length
    await find(now)
    expect(h.reads.slice(before).filter((r) => r.includes('wizard_b'))).toEqual([])
  })

  it('admits exactly one continuation per completion row, and stays off when the agent joins', async () => {
    const admitted: string[] = []
    let on = false
    const find = async () => [{ sessionId: 'wizard_a', messageId: 1, at: 0 }]
    const w = startDelegationFollowThrough({ find, enabled: async () => on, admit: async (id: string, _i: string, key: string) => { admitted.push(`${id}|${key}`) }, intervalMs: 60_000 })
    await w.tick(); expect(admitted).toEqual([])
    on = true
    await w.tick(); await w.tick()
    w.stop()
    expect(admitted).toHaveLength(1)
    expect(admitted[0]).toMatch(/^wizard_a\|wizard-follow-through-wizard_a-1$/)
  })
})
