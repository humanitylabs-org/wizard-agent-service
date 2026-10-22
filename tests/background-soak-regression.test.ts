import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackgroundResults } from '../server/background-results.mjs'
import { startDelegationFollowThrough } from '../server/delegation-follow-through.mjs'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const flush = () => new Promise<void>(r => setImmediate(r))

describe('background soak regressions', () => {
  it('defers a busy receipt without consuming it or making repeated admission attempts', async () => {
    let held = true
    const admit = vi.fn(async () => ({})), log = vi.fn()
    const watcher = startDelegationFollowThrough({
      find: () => [{ agent_id: 'hermes', session_id: 'wizard_busy', sessionId: 'wizard_busy', messageId: 1, at: Date.now() / 1000 }],
      enabled: async () => true, busySession: async () => held, admit, log, intervalMs: 60_000,
    })
    try {
      await watcher.tick(); await watcher.tick(); await watcher.tick()
      expect(admit).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled()
      held = false
      await watcher.tick(); await watcher.tick()
      expect(admit).toHaveBeenCalledTimes(1)
    } finally { await watcher.stop() }
  })

  it('revalidates after a busy admission race, retaining exactly-once identity', async () => {
    const keys: string[] = []
    let attempts = 0
    const watcher = startDelegationFollowThrough({
      find: () => [{ agent_id: 'hermes', session_id: 'wizard_race', sessionId: 'wizard_race', messageId: 2, at: Date.now() / 1000 }], enabled: async () => true,
      admit: async (_id: string, _input: string, key: string) => {
        keys.push(key)
        if (!attempts++) throw Object.assign(new Error('Agent already active'), { code: 'helper_session_busy' })
      }, intervalMs: 60_000,
    })
    try {
      await watcher.tick(); await watcher.tick(); await watcher.tick()
      expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1])
    } finally { await watcher.stop() }
  })

  it('finishes a >40-second catalog in bounded slices, including a falsely final full page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('read deadline', 'TimeoutError')), ms)
      return controller.signal
    })
    const began = Date.now(), offsets: number[] = []
    const bg = createBackgroundResults({ queue: () => null, request: async (path: string, init: any) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 4000)
        init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason) }, { once: true })
      })
      if (path.includes('/messages?')) return { data: [
        { id: 1, role: 'user', content: 'Finish the task', timestamp: began / 1000 - 11000 },
        { id: 2, role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_tail] saved', timestamp: began / 1000 - 10800 },
      ] }
      const offset = Number(new URL(path, 'http://fixture').searchParams.get('offset'))
      offsets.push(offset)
      return { has_more: false, data: offset < 2400
        ? Array.from({ length: 200 }, (_, i) => ({ id: `cron_${offset + i}` }))
        : [{ id: 'wizard_tail', message_count: 2, last_active: began / 1000 - 10800 }] }
    } })
    let result: any
    for (let n = 0; n < 80; n++) {
      result = await bg.list()
      if (!result.scanning) break
      await vi.advanceTimersByTimeAsync(4000)
    }
    expect(Date.now() - began).toBeGreaterThan(40_000)
    expect(offsets).toContain(2400)
    expect(offsets.filter(x => x === 0)).toHaveLength(1)
    expect(result.available).toBe(true); expect(result.scan_complete).toBe(true)
    expect(result.results.map((r: any) => r.session_id)).toEqual(['wizard_tail'])
  })

  it('retries a transient read deadline once, but exposes a persistent catalog failure', async () => {
    let attempts = 0
    const request = vi.fn(async () => {
      if (!attempts++) throw new DOMException('busy upstream', 'TimeoutError')
      return { data: [] }
    })
    const bg = createBackgroundResults({ queue: () => null, request })
    await bg.list(); await flush(); await bg.list(); await flush()
    expect((await bg.list()).scan_complete).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failed = createBackgroundResults({ queue: () => null, request: async () => { throw new DOMException('still busy', 'TimeoutError') } })
    await failed.list(); await flush()
    expect((await failed.list()).available).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })
})
