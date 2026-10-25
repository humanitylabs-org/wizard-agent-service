import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadSeenStore } from '../server/thread-seen.mjs'
import { scene } from '../qa/agent-parity/fixture.mjs'

const roots = []
const record = (seenAt: number, unreadAt?: number, sessionId = 'ready-thread') => ({
  agent_id: 'hermes',
  session_id: sessionId,
  updatedAt: '2026-10-23T12:00:00.000Z',
  previewFingerprint: 'readythread',
  messageCount: 2,
  status: 'completed',
  seenAt,
  ...(unreadAt === undefined ? {} : { unreadAt }),
})

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
})

describe('thread seen HTTP batch qualification', () => {
  it('drops retired agents, merges valid marks, and treats an all-retired batch as a no-op', async () => {
    const s = await scene('main')
    const put = (body: unknown) => s.raw('/wizard/thread-seen', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const retired = { ...record(100, undefined, 'nonexistent-probe'), agent_id: 'quick' }
      const result = await put({ initializedAt: 1, threads: {
        'agent/quick/nonexistent-probe': retired,
        'direct:ready-thread': record(200, 300),
      } })
      expect(result.status).toBe(200)
      expect((await result.json()).state.threads).toEqual({ 'direct:ready-thread': record(200, 300) })
      // Exact incident repro: the discarded mark need not carry valid mark fields or initializedAt.
      const noop = await put({ threads: { 'agent/quick/nonexistent-probe': {
        agent_id: 'quick', session_id: 'nonexistent-probe', seenAt: '2026-10-25T00:00:00Z',
      } } })
      expect(noop.status).toBe(200)
      await s.restart()
      const saved = (await (await s.raw('/wizard/thread-seen')).json()).state
      expect(saved.threads).toEqual({ 'direct:ready-thread': record(200, 300) })
      // Invalid visible records and pair mismatches still reject the batch, rather than being swallowed.
      expect((await put({ initializedAt: 1, threads: { 'direct:ready-thread': record(1.5) } })).status).toBe(400)
      expect((await put({ initializedAt: 1, threads: { 'agent/quick/nonexistent-probe': record(100) } })).status).toBe(400)
      expect((await put({ threads: {} })).status).toBe(400)
    } finally { await s.close() }
  })
})

describe('thread seen manual unread state', () => {
  it('persists an unread mark, then resolves it with a newer seen mark', () => {
    const root = mkdtempSync(join(tmpdir(), 'wizard-thread-unread-'))
    roots.push(root)
    const statePath = join(root, 'thread-seen.json')
    const store = new ThreadSeenStore(statePath)

    store.merge('owner', { initializedAt: 1, threads: { 'direct:ready-thread': record(100) } })
    const unread = store.merge('owner', { initializedAt: 1, threads: { 'direct:ready-thread': record(100, 200) } })
    expect(Object.values(unread.threads)[0]).toMatchObject({ seenAt: 100, unreadAt: 200 })

    const reloaded = new ThreadSeenStore(statePath)
    expect(Object.values(reloaded.get('owner').threads)[0]).toMatchObject({ seenAt: 100, unreadAt: 200 })

    const seenAgain = reloaded.merge('owner', { initializedAt: 1, threads: { 'direct:ready-thread': record(300) } })
    expect(Object.values(seenAgain.threads)[0]).toMatchObject({ seenAt: 300, unreadAt: 200 })
  })

  it('restores unread markers after an older service rewrites the main state without them', () => {
    const root = mkdtempSync(join(tmpdir(), 'wizard-thread-unread-rollback-'))
    roots.push(root)
    const statePath = join(root, 'thread-seen.json')
    const store = new ThreadSeenStore(statePath)
    store.merge('owner', { initializedAt: 1, threads: {
      'direct:ready-thread': record(100, 200),
      'direct:read-during-rollback': record(100, 200, 'read-during-rollback'),
    } })

    const oldVersionRewrite = JSON.parse(readFileSync(statePath, 'utf8'))
    for (const state of Object.values(oldVersionRewrite.scopes) as any[]) {
      for (const saved of Object.values(state.threads) as any[]) delete saved.unreadAt
      state.threads['direct:read-during-rollback'].seenAt = 300
    }
    writeFileSync(statePath, JSON.stringify(oldVersionRewrite))

    const upgraded = new ThreadSeenStore(statePath)
    expect(upgraded.get('owner').threads['direct:ready-thread']).toMatchObject({ seenAt: 100, unreadAt: 200 })
    expect(upgraded.get('owner').threads['direct:read-during-rollback']).toMatchObject({ seenAt: 300, unreadAt: 200 })
  })

  it('rejects fractional and implausibly future read-state timestamps', () => {
    const store = new ThreadSeenStore()
    const future = Date.now() + 24 * 60 * 60 * 1000 + 1000
    for (const candidate of [
      record(1.5),
      record(Number.MAX_VALUE),
      record(future),
      record(100, 1.5),
      record(100, Number.MAX_VALUE),
      record(100, future),
    ]) {
      expect(() => store.merge('owner', { initializedAt: 1, threads: { 'direct:ready-thread': candidate } })).toThrow('Invalid Wizard thread seen state')
    }
  })
})
