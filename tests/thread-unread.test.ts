import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadSeenStore } from '../server/thread-seen.mjs'

const roots = []
const record = (seenAt, unreadAt) => ({
  agent_id: 'hermes',
  session_id: 'ready-thread',
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
})
