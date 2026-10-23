import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadSeenStore } from '../server/thread-seen.mjs'

const roots = []
const record = (seenAt, unreadAt, sessionId = 'ready-thread') => ({
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
